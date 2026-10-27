// Loads two demo roles and sample leads. Usage: npm run seed (start the app once first so the database exists).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../suite.js';
import { seedDemo } from '../demo-seed.js';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(path.join(ROOT, '.env'))) for (const line of readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
}
const db = new DatabaseSync(process.env.DB_PATH || path.join(ROOT, 'recruiting.db'));
try { migrate(db); } catch { console.error('Start the app once first (npm start), then run npm run seed. Or just run: npm run demo'); process.exit(1); }
const made = seedDemo(db, ROOT);
console.log(made.length ? `Created: ${made.join(', ')}` : 'Demo roles already exist.');
