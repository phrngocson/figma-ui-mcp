#!/usr/bin/env node
// Tests for v2.5.21: BUG-01 (textStyles async), BUG-02 (VECTOR gradient),
// BUG-03 (query parentId+limit), BUG-04 (Material→Ionicons hint)
import { executeCode } from "../server/code-executor.js";

let passed = 0, failed = 0;
function assert(label, condition, detail = "") {
  if (condition) { console.log("  ✓", label); passed++; }
  else { console.error("  ✗", label, detail ? `— ${detail}` : ""); failed++; }
}
function makeBridge(overrides = {}) {
  return { sendOperation: async (op, params) => {
    if (overrides[op]) return overrides[op](params);
    throw new Error("Unexpected op: " + op);
  }};
}

// ── BUG-02: VECTOR fill accepts gradient object ───────────────────────────
console.log("\nBUG-02: VECTOR fill — gradient object forwarded");
{
  let captured = null;
  const bridge = makeBridge({
    create: (p) => { captured = p; return { id: "v:1", type: "VECTOR", name: "area", width: p.width, height: p.height }; }
  });
  const r = await executeCode(`
    return await figma.create({
      type: "VECTOR", width: 200, height: 100,
      d: "M 0 100 L 0 50 L 100 60 L 200 30 L 200 100 Z",
      fill: { type: "LINEAR_GRADIENT", angle: 180, stops: [
        { pos: 0, color: "#15803d30" },
        { pos: 1, color: "#15803d00" }
      ]}
    });
  `, bridge);
  assert("VECTOR with gradient fill succeeds", r.success, r.error);
  assert("gradient fill object forwarded", captured && captured.fill && captured.fill.type === "LINEAR_GRADIENT");
  assert("gradient stops forwarded", captured && captured.fill && Array.isArray(captured.fill.stops) && captured.fill.stops.length === 2);
}

// ── BUG-02 regression: VECTOR with hex fill still works ───────────────────
console.log("\nBUG-02 regression: VECTOR with hex fill still works");
{
  let captured = null;
  const bridge = makeBridge({
    create: (p) => { captured = p; return { id: "v:2", type: "VECTOR" }; }
  });
  const r = await executeCode(`
    return await figma.create({ type: "VECTOR", width: 50, height: 50, d: "M 0 0 L 50 50", fill: "#FF0000" });
  `, bridge);
  assert("VECTOR with hex fill succeeds", r.success, r.error);
  assert("hex fill forwarded", captured && captured.fill === "#FF0000");
}

// ── BUG-03: query with parentId param forwarded ───────────────────────────
console.log("\nBUG-03: query parentId param forwarded to bridge");
{
  let captured = null;
  const bridge = makeBridge({
    query: (p) => { captured = p; return [{ id: "n:1", type: "FRAME", name: "Card" }]; }
  });
  const r = await executeCode(`
    return await figma.query({ type: "FRAME", parentId: "1:1" });
  `, bridge);
  assert("query with parentId succeeds", r.success, r.error);
  assert("parentId forwarded", captured && captured.parentId === "1:1");
  assert("type forwarded", captured && captured.type === "FRAME");
}

// ── BUG-03: query with custom limit ───────────────────────────────────────
console.log("\nBUG-03: query limit param forwarded");
{
  let captured = null;
  const bridge = makeBridge({
    query: (p) => { captured = p; return []; }
  });
  await executeCode(`return await figma.query({ name: "btn", limit: 1000 });`, bridge);
  assert("limit param forwarded", captured && captured.limit === 1000);
}

// ── BUG-04: Material Icons name → suggest Ionicons ────────────────────────
console.log("\nBUG-04: Material Icons name suggests Ionicons");
{
  // loadIcon will fail because httpFetch can't reach unpkg (no network in tests, or fake URLs)
  // We just want to verify the error message contains hint about Ionicons
  const bridge = makeBridge({});
  const r = await executeCode(`
    try {
      await figma.loadIcon("local_cafe", { parentId: "1:1" });
      return { caught: false };
    } catch (e) {
      return { caught: true, msg: e.message };
    }
  `, bridge);
  assert("loadIcon with bad name throws", r.success && r.result.caught, JSON.stringify(r));
  assert("error message suggests 'cafe'",
    r.result && r.result.msg && r.result.msg.indexOf("cafe") !== -1,
    "msg=" + (r.result && r.result.msg));
}

// ── BUG-04: snake_case hint when not in map ───────────────────────────────
console.log("\nBUG-04: snake_case name → kebab-case hint");
{
  const bridge = makeBridge({});
  const r = await executeCode(`
    try {
      await figma.loadIcon("unknown_thing_xyz", { parentId: "1:1" });
      return { caught: false };
    } catch (e) {
      return { caught: true, msg: e.message };
    }
  `, bridge);
  assert("unknown snake_case name throws", r.success && r.result.caught);
  assert("error mentions kebab-case alternative",
    r.result && r.result.msg && r.result.msg.indexOf("unknown-thing-xyz") !== -1,
    "msg=" + (r.result && r.result.msg));
}

// ── Regression: query without parentId still works ───────────────────────
console.log("\nRegression: query without parentId");
{
  let captured = null;
  const bridge = makeBridge({
    query: (p) => { captured = p; return [{ id: "1:1", type: "FRAME" }]; }
  });
  const r = await executeCode(`return await figma.query({ name: "Card" });`, bridge);
  assert("simple query still works", r.success, r.error);
  assert("name forwarded", captured && captured.name === "Card");
  assert("no parentId in params", captured && captured.parentId === undefined);
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
