// HTTP bridge — plugin polls this server for queued operations
// Supports long polling, multi-instance sessions, and connection resilience
import http from "node:http";

export const CONFIG = {
  PORT: parseInt(process.env.FIGMA_MCP_PORT || "38451", 10),
  PORT_RANGE: parseInt(process.env.FIGMA_MCP_PORT_RANGE || "10", 10),
  HOST: null,
  OP_TIMEOUT_MS: 60_000,
  MAX_BODY_BYTES: 5_000_000,
  MAX_QUEUE: 50,
  HEALTH_TTL_MS: 86400000,
  LONG_POLL_MS: 8_000,       // short for Figma iframe compat (some envs limit fetch ~10s)
  SESSION_EXPIRE_MS: 86400000, // remove idle sessions after 5 min
};

// Operation-specific timeouts
const OP_TIMEOUTS = {
  screenshot: 90_000, scan_design: 90_000, export_image: 90_000,
  export_svg: 60_000, get_design: 60_000, batch: 90_000,
};

// Per-session state for multi-instance support
class Session {
  constructor(id, fileName) {
    this.id = id;
    this.fileName = fileName || "unknown";
    this.queue = [];
    this.pending = new Map();   // opId -> { resolve, reject, timer, startMs }
    this.lastPollAt = 0;
    this.longPoll = null;       // { res, timer }
    this.stats = { ops: 0, avgLatencyMs: 0 };
  }
  isConnected() {
    return this.lastPollAt > 0 && Date.now() - this.lastPollAt < CONFIG.HEALTH_TTL_MS;
  }
}

export class BridgeServer {
  #sessions = new Map();      // sessionId -> Session
  #opToSession = new Map();   // opId -> sessionId (global reverse lookup)
  #server = null;
  #actualPort = CONFIG.PORT;
  #globalStats = { ops: 0, avgLatencyMs: 0, reconnects: 0 };

  static DEFAULT_SESSION = "_default";

  // ── Public getters (backward compat) ──────────────────────────────────────

  get port() { return this.#actualPort; }

  get lastPollAt() {
    let latest = 0;
    for (let s of this.#sessions.values()) if (s.lastPollAt > latest) latest = s.lastPollAt;
    return latest;
  }

  get queueLength() {
    let n = 0;
    for (let s of this.#sessions.values()) n += s.queue.length;
    return n;
  }

  get pendingCount() { return this.#opToSession.size; }

  get stats() {
    return Object.assign({}, this.#globalStats, { sessions: this.#sessions.size });
  }

  // ── Session management ────────────────────────────────────────────────────

  #getSession(id) {
    let sid = id || BridgeServer.DEFAULT_SESSION;
    let s = this.#sessions.get(sid);
    if (!s) { s = new Session(sid); this.#sessions.set(sid, s); }
    return s;
  }

  // Find best session: prefer given id, then session with active long-poll,
  // then most recently polled connected session, finally default
  #resolveSession(sessionId) {
    if (sessionId) {
      let s = this.#sessions.get(sessionId);
      if (s && s.isConnected()) return s;
    }
    // Prefer session with active long-poll waiter (ready to receive work NOW)
    let bestLongPoll = null;
    let bestConnected = null;
    for (let s of this.#sessions.values()) {
      if (s.longPoll && s.isConnected()) {
        if (!bestLongPoll || s.lastPollAt > bestLongPoll.lastPollAt) bestLongPoll = s;
      }
      if (s.isConnected()) {
        if (!bestConnected || s.lastPollAt > bestConnected.lastPollAt) bestConnected = s;
      }
    }
    if (bestLongPoll) return bestLongPoll;
    if (bestConnected) return bestConnected;
    return this.#getSession(BridgeServer.DEFAULT_SESSION);
  }

  getSessions() {
    let list = [];
    for (let s of this.#sessions.values()) {
      list.push({
        id: s.id, fileName: s.fileName, connected: s.isConnected(),
        lastPollAgoMs: s.lastPollAt ? Date.now() - s.lastPollAt : null,
        queueLength: s.queue.length, ops: s.stats.ops,
      });
    }
    return list;
  }

  isPluginConnected(sessionId) {
    if (sessionId) {
      let s = this.#sessions.get(sessionId);
      return s ? s.isConnected() : false;
    }
    for (let s of this.#sessions.values()) if (s.isConnected()) return true;
    return false;
  }

  // Remove expired sessions periodically
  #cleanupSessions() {
    let now = Date.now();
    for (let [id, s] of this.#sessions) {
      if (!s.isConnected() && s.queue.length === 0 && s.pending.size === 0 && now - s.lastPollAt > CONFIG.SESSION_EXPIRE_MS) {
        this.#sessions.delete(id);
      }
    }
  }

  // ── Core operations ───────────────────────────────────────────────────────

  async sendOperation(operation, params, sessionId) {
    let session = this.#resolveSession(sessionId);
    if (session.queue.length >= CONFIG.MAX_QUEUE) {
      throw new Error("Queue full — is the Figma plugin running?");
    }

    let timeout = OP_TIMEOUTS[operation] || CONFIG.OP_TIMEOUT_MS;
    let opId = Date.now() + "-" + Math.random().toString(36).slice(2, 7);

    // CRITICAL: set pending BEFORE queue+flush, so respondPoll filter sees the opId
    let self = this;
    return new Promise(function(resolve, reject) {
      let timer = setTimeout(function() {
        session.pending.delete(opId);
        session.queue = session.queue.filter(function(r) { return r.id !== opId; });
        reject(new Error("Operation \"" + operation + "\" timed out after " + timeout + "ms"));
      }, timeout);
      session.pending.set(opId, { resolve: resolve, reject: reject, timer: timer, startMs: Date.now() });

      // Now push to queue and flush — pending is already set
      session.queue.push({ id: opId, operation: operation, params: params || {} });
      self.#opToSession.set(opId, session.id);
      self.#flushLongPoll(session);
    });
  }

  #flushLongPoll(session) {
    if (!session.longPoll) return;
    let w = session.longPoll;
    session.longPoll = null;
    clearTimeout(w.timer);
    this.#respondPoll(session, w.res);
  }

  #respondPoll(session, res) {
    session.lastPollAt = Date.now();
    let alive = session.queue.filter(function(r) { return session.pending.has(r.id); });
    session.queue.length = 0;
    if (alive.length) process.stderr.write("[bridge] poll → session=" + session.id + " delivering " + alive.length + " ops: " + alive.map(function(r) { return r.operation; }).join(",") + "\n");
    res.writeHead(200);
    res.end(JSON.stringify({ requests: alive, mode: "ready", sessionId: session.id }));
  }

  #settle(response) {
    let sessionId = this.#opToSession.get(response.id);
    if (!sessionId) {
      process.stderr.write("[bridge] settle ORPHAN response id=" + response.id + " (no matching session)\n");
      return;
    }
    this.#opToSession.delete(response.id);

    let session = this.#sessions.get(sessionId);
    if (!session) return;

    let p = session.pending.get(response.id);
    if (!p) return;
    clearTimeout(p.timer);
    session.pending.delete(response.id);

    // Track latency
    if (p.startMs) {
      let latency = Date.now() - p.startMs;
      session.stats.ops++;
      session.stats.avgLatencyMs = Math.round(session.stats.avgLatencyMs * 0.9 + latency * 0.1);
      this.#globalStats.ops++;
      this.#globalStats.avgLatencyMs = Math.round(this.#globalStats.avgLatencyMs * 0.9 + latency * 0.1);
    }
    response.success ? p.resolve(response.data) : p.reject(new Error(response.error || "Plugin error"));
  }

  clearQueue(sessionId) {
    let cleared = 0;
    let sessions = sessionId ? [this.#sessions.get(sessionId)].filter(Boolean) : Array.from(this.#sessions.values());
    for (let s of sessions) {
      cleared += s.queue.length + s.pending.size;
      for (let [id, p] of s.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("Queue cleared manually"));
        this.#opToSession.delete(id);
      }
      s.pending.clear();
      s.queue.length = 0;
    }
    return cleared;
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────

  #readJson(req) {
    return new Promise(function(resolve, reject) {
      let raw = "", size = 0;
      req.on("data", function(chunk) {
        size += chunk.length;
        if (size > CONFIG.MAX_BODY_BYTES) { req.destroy(); return reject(new Error("Body too large")); }
        raw += chunk;
      });
      req.on("end", function() { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error("Invalid JSON")); } });
      req.on("error", reject);
    });
  }

  #headers(res) {
    res.setHeader("Access-Control-Allow-Origin",  "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Session-Id");
    res.setHeader("Content-Type",                 "application/json");
    res.setHeader("X-Content-Type-Options",       "nosniff");
  }

  #route(req, res) {
    this.#headers(res);
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    let url = new URL(req.url, "http://localhost:" + CONFIG.PORT);
    let path = url.pathname;
    // Session ID from query param or header (backward compat: absent = default)
    let sessionId = url.searchParams.get("sessionId") || req.headers["x-session-id"] || null;
    let fileName = url.searchParams.get("fileName") || null;

    // Root
    if (path === "/" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify({
        server: "figma-ui-mcp", version: "2.4.5", port: this.#actualPort,
        pluginConnected: this.isPluginConnected(),
        sessions: this.getSessions(),
        queueLength: this.queueLength,
        endpoints: ["/health", "/poll", "/response", "/exec", "/clear", "/sessions"],
      }));
      return;
    }

    // Sessions list
    if (path === "/sessions" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify({ sessions: this.getSessions() }));
      return;
    }

    // Plugin poll (long polling, session-aware)
    if (path === "/poll" && req.method === "GET") {
      let session = this.#getSession(sessionId);
      if (fileName) session.fileName = fileName;
      session.lastPollAt = Date.now();

      // Has work? respond immediately
      if (session.queue.some(function(r) { return session.pending.has(r.id); })) {
        this.#respondPoll(session, res);
        return;
      }
      // Long poll: hold until work or timeout
      if (session.longPoll) {
        clearTimeout(session.longPoll.timer);
        this.#respondPoll(session, session.longPoll.res);
      }
      let self = this;
      session.longPoll = {
        res: res,
        timer: setTimeout(function() {
          session.longPoll = null;
          self.#respondPoll(session, res);
        }, CONFIG.LONG_POLL_MS),
      };
      req.on("close", function() {
        if (session.longPoll && session.longPoll.res === res) {
          clearTimeout(session.longPoll.timer);
          session.longPoll = null;
        }
      });
      return;
    }

    // Plugin response
    if (path === "/response" && req.method === "POST") {
      let self = this;
      this.#readJson(req)
        .then(function(body) { self.#settle(body); res.writeHead(200); res.end(JSON.stringify({ ok: true })); })
        .catch(function(err) { res.writeHead(400); res.end(JSON.stringify({ error: err.message })); });
      return;
    }

    // Direct exec
    if (path === "/exec" && req.method === "POST") {
      let self = this;
      this.#readJson(req)
        .then(async function(body) {
          if (!self.isPluginConnected(sessionId)) {
            res.writeHead(503); res.end(JSON.stringify({ error: "Plugin not connected" })); return;
          }
          try {
            let data = await self.sendOperation(body.operation, body.params || {}, sessionId);
            res.writeHead(200); res.end(JSON.stringify({ success: true, data: data }));
          } catch (e) {
            res.writeHead(200); res.end(JSON.stringify({ success: false, error: e.message }));
          }
        })
        .catch(function(err) { res.writeHead(400); res.end(JSON.stringify({ error: err.message })); });
      return;
    }

    // Health
    if (path === "/health" && req.method === "GET") {
      this.#cleanupSessions();
      let lp = this.lastPollAt;
      res.writeHead(200);
      res.end(JSON.stringify({
        pluginConnected: this.isPluginConnected(),
        queueLength: this.queueLength,
        pendingCount: this.pendingCount,
        lastPollAgoMs: lp ? Date.now() - lp : null,
        sessions: this.getSessions(),
        stats: this.stats,
      }));
      return;
    }

    // Clear queue
    if (path === "/clear" && (req.method === "POST" || req.method === "GET")) {
      let cleared = this.clearQueue(sessionId);
      res.writeHead(200);
      res.end(JSON.stringify({ cleared: cleared, queueLength: 0, pendingCount: 0 }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async #killStaleBridges() {
    let port = CONFIG.PORT;
    try {
      let isZombie = await new Promise(function(resolve) {
        let req = http.get({ hostname: "127.0.0.1", port: port, path: "/health", timeout: 800 }, function(res) {
          let data = "";
          res.on("data", function(c) { data += c; });
          res.on("end", function() {
            try { let j = JSON.parse(data); resolve(j.pluginConnected === undefined); }
            catch(e) { resolve(true); }
          });
        });
        req.on("error", function() { resolve(false); });
        req.on("timeout", function() { req.destroy(); resolve(false); });
      });
      if (isZombie) {
        try {
          let m = await import("node:child_process");
          let pid = m.execSync("lsof -ti tcp:" + port + " 2>/dev/null", { encoding: "utf8" }).trim();
          if (pid) {
            m.execSync("kill " + pid + " 2>/dev/null");
            process.stderr.write("[figma-ui-mcp] Killed zombie on port " + port + " (PID " + pid + ")\n");
            await new Promise(function(r) { setTimeout(r, 200); });
          }
        } catch(e) { /* ignore */ }
      }
    } catch(e) { /* ignore */ }
  }

  start() {
    let self = this;
    return new Promise(async function(resolve) {
      await self.#killStaleBridges();

      let tryPort = function(port, attempt) {
        if (attempt >= CONFIG.PORT_RANGE) {
          process.stderr.write("[figma-ui-mcp] All ports " + CONFIG.PORT + "-" + (CONFIG.PORT + CONFIG.PORT_RANGE - 1) + " in use.\n");
          resolve(self);
          return;
        }
        self.#server = http.createServer(function(req, res) { self.#route(req, res); });
        self.#server.once("error", function(err) {
          if (err.code === "EADDRINUSE") {
            process.stderr.write("[figma-ui-mcp] Port " + port + " in use — trying " + (port + 1) + "...\n");
            tryPort(port + 1, attempt + 1);
          } else {
            process.stderr.write("[figma-ui-mcp bridge] " + err.message + "\n");
            resolve(self);
          }
        });
        self.#server.once("listening", function() {
          self.#actualPort = port;
          resolve(self);
        });
        self.#server.listen(port, CONFIG.HOST);
      };
      tryPort(CONFIG.PORT, 0);
    });
  }

  stop() {
    if (this.#server) { this.#server.close(); this.#server = null; }
    for (let [id, sid] of this.#opToSession) {
      let s = this.#sessions.get(sid);
      if (s) {
        let p = s.pending.get(id);
        if (p) { clearTimeout(p.timer); p.reject(new Error("Bridge shutting down")); }
      }
    }
    this.#opToSession.clear();
    this.#sessions.clear();
  }
}
