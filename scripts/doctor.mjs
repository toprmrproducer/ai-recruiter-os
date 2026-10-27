// `npm run doctor`: checks everything the app needs and tells you what to fix.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
if (existsSync(path.join(ROOT, '.env'))) for (const l of readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, ''); }
const rows = []; const add = (ok, what, fix = '') => rows.push([ok, what, fix]);
const [maj, min] = process.versions.node.split('.').map(Number);
add(maj > 22 || (maj === 22 && min >= 13), `Node.js ${process.versions.node}`, 'Install Node.js 22.13 or newer from https://nodejs.org (older versions have a database bug)');
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }
add(sqlite, 'Built-in SQLite (node:sqlite)', 'Needs Node.js 22.13 or newer');
add(spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pdftotext'], { stdio: 'ignore' }).status === 0, 'pdftotext (PDF resume upload)', 'Optional. macOS: brew install poppler. Ubuntu: sudo apt install poppler-utils');
for (const f of ['server.js', 'suite.js', 'scoring.js', 'settings.js', 'mailer.js', 'dograh/workflow.json', 'dograh/rejection-workflow.json', 'public/dashboard.html', 'public/apply.html']) add(existsSync(path.join(ROOT, f)), `File ${f}`, 'Re-download the project, a file is missing');
if (env.DOGRAH_BASE_URL) { try { const r = await fetch(`${env.DOGRAH_BASE_URL.replace(/\/+$/, '')}/api/v1/health`, { signal: AbortSignal.timeout(5000) }); add(r.ok, `Dograh reachable at ${env.DOGRAH_BASE_URL}`, 'Is Dograh running? Check the address in Settings'); } catch { add(false, `Dograh reachable at ${env.DOGRAH_BASE_URL}`, 'Is Dograh running? Check the address in Settings'); } }
else add(true, 'Dograh address (not set yet: do it in the dashboard under Settings)');
for (const [ok, what, fix] of rows) console.log(`${ok ? '  OK  ' : ' FIX  '} ${what}${ok || !fix ? '' : `\n        -> ${fix}`}`);
process.exit(rows.some(r => !r[0] && !/pdftotext/.test(r[1])) ? 1 : 0);
