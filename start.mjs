// One command to run everything: `npm start` (or `npm run dev` to also open the browser, `npm run demo` to start with demo roles).
// This file only checks your setup and explains problems in plain words, then starts the app.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync, mkdirSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const say = (...a) => console.log(...a);
const fail = msg => { console.error(`\n  Cannot start: ${msg}\n`); process.exit(1); };

// 1. Node version (the app uses Node's built-in SQLite, so no database to install)
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) fail(`Node.js ${process.versions.node} is too old (versions before 22.13 have a database bug that corrupts results). Install Node.js 22.13 or newer from https://nodejs.org (or run: nvm install 22), then run this again.`);

// 2. PORT from .env or environment (same rule the server uses)
let PORT = Number(process.env.PORT || 0);
if (!PORT && existsSync(path.join(ROOT, '.env'))) { const m = readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^\s*PORT\s*=\s*(\d+)/m); if (m) PORT = Number(m[1]); }
PORT = PORT || 4870;

// 3. Can we write the database next to the code?
try { const dbDir = process.env.DB_PATH ? path.dirname(path.resolve(process.env.DB_PATH)) : ROOT; mkdirSync(dbDir, { recursive: true }); accessSync(dbDir, constants.W_OK); } catch { fail('The folder is read only, so the database cannot be created. Move the project to a folder you own.'); }

// 4. Optional tools: warn, never block
const hasPdf = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pdftotext'], { stdio: 'ignore' }).status === 0;

// 5. Is the port free?
await new Promise(resolve => {
  const probe = createServer().once('error', e => { if (e.code === 'EADDRINUSE') fail(`Port ${PORT} is already in use. Close the other program, or pick another port: PORT=4999 npm start (Windows PowerShell: $env:PORT=4999; npm start).`); resolve(); }).once('listening', () => probe.close(resolve)).listen(PORT);
});

say('');
say('  AI Recruiter OS');
say('  ----------------');
if (!existsSync(path.join(ROOT, 'recruiting.db')) && !process.env.DB_PATH) say('  First run: creating the database.');
if (!hasPdf) say('  Note: PDF resume upload needs pdftotext (macOS: brew install poppler, Ubuntu: sudo apt install poppler-utils). Everything else works without it.');
say(`  Dashboard:  http://localhost:${PORT}/dashboard   (open Settings to connect your voice engine, phone provider and keys)`);
say(`  Careers:    http://localhost:${PORT}/`);
say('  Stop with Ctrl+C.');
say('');

const env = { ...process.env, PORT: String(PORT) };
if (args.has('--demo')) env.SEED_DEMO_ROLES = '1';
const child = spawn(process.execPath, ['--experimental-sqlite', '--no-warnings', path.join(ROOT, 'server.js')], { stdio: 'inherit', env, cwd: ROOT });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', code => process.exit(code ?? 0));

if (args.has('--open')) {
  setTimeout(() => {
    const url = `http://localhost:${PORT}/dashboard`;
    const [cmd, a] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
    try { spawn(cmd, a, { stdio: 'ignore', detached: true }).unref(); } catch {}
  }, 1500);
}
