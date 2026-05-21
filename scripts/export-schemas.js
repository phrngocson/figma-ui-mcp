import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TOOLS } from '../server/tool-definitions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');

if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

TOOLS.forEach(tool => {
  const filePath = path.join(targetDir, `${tool.name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(tool, null, 2));
  console.log(`Exported schema: ${tool.name}.json`);
});
