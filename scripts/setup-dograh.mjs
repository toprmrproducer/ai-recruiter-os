// Creates the AI screening agent in your Dograh and prints (or writes) the values this app needs.
// Usage: npm run setup:dograh            (prints)
//        npm run setup:dograh -- --write-env   (also fills DOGRAH_AGENT_UUID in .env)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
}
const base = String(process.env.DOGRAH_BASE_URL || '').replace(/\/+$/, '').replace(/\/api\/v1$/, '');
const key = process.env.DOGRAH_API_KEY, pub = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
if (!base || !key) { console.error('Set DOGRAH_BASE_URL and DOGRAH_API_KEY in .env first (Dograh dashboard > Settings > API keys).'); process.exit(1); }
if (!pub || /localhost|127\.0\.0\.1/.test(pub)) console.warn(`Warning: PUBLIC_BASE_URL is ${pub || 'empty'}. Dograh can only post call results back if this address is reachable from your Dograh server (use your domain or a tunnel).`);

const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-API-Key': key }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = { raw: t }; }
  if (!r.ok) throw new Error(`${method} ${p} failed (${r.status}): ${t.slice(0, 300)}`);
  return d;
};

const AGENTS = [
  // Dograh ends every call after 5 minutes unless the workflow says otherwise, so set the limit explicitly.
  { file: 'workflow.json', suffix: 'Recruiting Screener', envKey: 'DOGRAH_AGENT_UUID', label: 'screening agent', config: { max_call_duration: 900, max_user_idle_timeout: 15 } },
  { file: 'rejection-workflow.json', suffix: 'Rejection Call', envKey: 'DOGRAH_REJECTION_AGENT_UUID', label: 'rejection call agent', config: { max_call_duration: 480, max_user_idle_timeout: 15 } },
];
const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7);
const brand = process.env.BRAND_NAME ? `${process.env.BRAND_NAME} ` : '';
const written = [];
for (const ag of AGENTS.filter(a => !only || a.file.startsWith(only))) {
  const wf = JSON.parse(readFileSync(path.join(ROOT, 'dograh', ag.file), 'utf8'));
  for (const n of wf.nodes) if (n.type === 'webhook') n.data.endpoint_url = `${pub}/api/webhooks/dograh`;
  const name = `${brand}${ag.suffix}`;
  const created = await call('POST', '/api/v1/workflow/create/definition', { name, workflow_definition: wf });
  // Save the call length limits as a new version and publish it.
  await call('POST', `/api/v1/workflow/${created.id}/create-draft`);
  await call('PUT', `/api/v1/workflow/${created.id}`, { name, workflow_definition: wf, workflow_configurations: ag.config });
  try { await call('POST', `/api/v1/workflow/${created.id}/publish`); } catch (e) { if (!/No draft to publish/i.test(String(e.message))) throw e; }
  const full = await call('GET', `/api/v1/workflow/fetch/${created.id}`);
  const uuid = full.workflow_uuid || created.workflow_uuid;
  if (!uuid) throw new Error(`Created "${name}" but could not read its UUID. Copy it from the Dograh dashboard into ${ag.envKey}.`);
  console.log(`Created and published the ${ag.label}: "${name}" (workflow ${created.id}).`);
  written.push([ag.envKey, uuid]);
}
console.log('\nPut this in your .env:\n');
for (const [k, v] of written) console.log(`${k}=${v}`);
if (process.argv.includes('--write-env') && existsSync(envFile)) {
  let s = readFileSync(envFile, 'utf8');
  for (const [k, v] of written) s = new RegExp(`^${k}=.*$`, 'm').test(s) ? s.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : s + `\n${k}=${v}\n`;
  writeFileSync(envFile, s); console.log('(written to .env)');
}
console.log('\nNext: in Dograh set Settings > Models (voice model) and Settings > Telephony (phone provider), then restart this app.');
