// Recruiting System: applicant form -> Dograh AI voice screen -> scoring -> recruiter dashboard.
// Run: node --experimental-sqlite server.js   (no npm dependencies)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { scoreCandidate, parseAnswer, QUESTIONS, evaluate, CRITERIA, resumeProbes, evidenceOf } from './scoring.js';
import { createLLM } from './llm.js';
import { migrate, createSuite, callAllowed } from './suite.js';
import { createSettings } from './settings.js';
import { seedDemo } from './demo-seed.js';
import { createEngine, trace } from './engine.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// .env loader (KEY=VALUE lines), real env wins
if (existsSync(path.join(ROOT, '.env'))) {
  for (const line of readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) { let val = m[2].trim(); if (!/^["']/.test(val)) val = val.replace(/\s+#.*$/, ''); process.env[m[1]] = val.replace(/^["']|["']$/g, ''); }
  }
}

const PORT = Number(process.env.PORT || 4870);
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'recruiting.db');
const envStr = k => String(process.env[k] || '');
const DOGRAH = {
  get base() { return envStr('DOGRAH_BASE_URL').replace(/\/+$/, '').replace(/\/api\/v1$/, ''); },
  get apiKey() { return envStr('DOGRAH_API_KEY'); },
  get agentUuid() { return envStr('DOGRAH_AGENT_UUID'); }, // workflow uuid for phone screens
  get refAgentUuid() { return envStr('DOGRAH_REFERENCE_AGENT_UUID'); }, // reference-check agent
  get reminderAgentUuid() { return envStr('DOGRAH_REMINDER_AGENT_UUID'); }, // interview reminder / no-show / joining agent
  get rejectionAgentUuid() { return envStr('DOGRAH_REJECTION_AGENT_UUID'); }, // rejection call agent
  get embedToken() { return envStr('DOGRAH_EMBED_TOKEN'); }, // web widget token
  get webhookSecret() { return envStr('WEBHOOK_SECRET'); },
  get workflowId() { return Number(process.env.DOGRAH_WORKFLOW_ID || 1); },
  get rejectionWorkflowId() { return Number(process.env.DOGRAH_REJECTION_WORKFLOW_ID || 0); },
};
const dograhPhoneReady = () => Boolean(DOGRAH.base && DOGRAH.apiKey && DOGRAH.agentUuid);

// ---------------------------------------------------------------- one agent per role (own voice), built and kept in sync automatically
async function dograhApi(method, p, body) {
  const r = await fetch(`${DOGRAH.base}${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-API-Key': DOGRAH.apiKey }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  const t = await r.text(); const d = J(t, { detail: t });
  if (!r.ok) throw new Error(`Dograh ${method} ${p} failed (${r.status}): ${typeof d?.detail === 'string' ? d.detail : JSON.stringify(d?.detail || d)}`.slice(0, 300));
  return d;
}

// Creates the screening and rejection agents in Dograh and remembers their ids. This is what `npm run setup:dograh` does, as a button.
async function createAgents({ force = false } = {}) {
  if (!DOGRAH.base || !DOGRAH.apiKey) throw new Error('Save the Dograh address and API key first.');
  const pub = envStr('PUBLIC_BASE_URL').replace(/\/+$/, '');
  if (!pub) throw new Error('Save this server\'s public address first: Dograh posts call results back to it.');
  const brand = envStr('BRAND_NAME') ? `${envStr('BRAND_NAME')} ` : '';
  const KINDS_TO_MAKE = [
    { file: 'workflow.json', suffix: 'Recruiting Screener', uuidKey: 'DOGRAH_AGENT_UUID', widKey: 'DOGRAH_WORKFLOW_ID', cfg: { max_call_duration: 900, max_user_idle_timeout: 15 } },
    { file: 'rejection-workflow.json', suffix: 'Rejection Call', uuidKey: 'DOGRAH_REJECTION_AGENT_UUID', widKey: 'DOGRAH_REJECTION_WORKFLOW_ID', cfg: { max_call_duration: 480, max_user_idle_timeout: 15 } },
  ];
  const result = [];
  for (const k of KINDS_TO_MAKE) {
    if (!force && envStr(k.uuidKey)) { result.push({ agent: k.suffix, status: 'already set up' }); continue; }
    const file = path.join(ROOT, 'dograh', k.file);
    if (!existsSync(file)) throw new Error(`Missing ${k.file} in the dograh folder.`);
    const wf = JSON.parse(readFileSync(file, 'utf8'));
    for (const n of wf.nodes) if (n.type === 'webhook') n.data.endpoint_url = `${pub}/api/webhooks/dograh`;
    const name = `${brand}${k.suffix}`;
    const created = await dograhApi('POST', '/api/v1/workflow/create/definition', { name, workflow_definition: wf });
    await dograhApi('POST', `/api/v1/workflow/${created.id}/create-draft`).catch(() => {});
    await dograhApi('PUT', `/api/v1/workflow/${created.id}`, { name, workflow_definition: wf, workflow_configurations: k.cfg });
    await dograhApi('POST', `/api/v1/workflow/${created.id}/publish`).catch(e => { if (!/No draft to publish/i.test(String(e.message))) throw e; });
    const full = await dograhApi('GET', `/api/v1/workflow/fetch/${created.id}`);
    const uuid = full.workflow_uuid || created.workflow_uuid;
    if (!uuid) throw new Error(`Created "${name}" but Dograh did not return its ID. Copy it from the Dograh dashboard.`);
    settings.put(k.uuidKey, uuid); settings.put(k.widKey, created.id);
    result.push({ agent: k.suffix, status: 'created', name, id: created.id });
  }
  return result;
}

const KINDS = {
  screener: { uuid: () => DOGRAH.agentUuid, wid: () => DOGRAH.workflowId, cfg: { max_call_duration: 900, max_user_idle_timeout: 15 }, uuidCol: 'agent_uuid', widCol: 'agent_wid', label: 'Screener' },
  rejection: { uuid: () => DOGRAH.rejectionAgentUuid, wid: () => DOGRAH.rejectionWorkflowId, cfg: { max_call_duration: 480, max_user_idle_timeout: 15 }, uuidCol: 'rej_agent_uuid', widCol: 'rej_wid', label: 'Rejection' },
};
// What does this Dograh support? Standard Dograh has one voice for everything; the voice-engine build adds a per-agent voice setting.
let capCache = { at: 0, v: null };
async function dograhCaps(force = false) {
  const ttl = Number(process.env.DOGRAH_CAPS_TTL_MS ?? 600000);
  if (!force && capCache.v && Date.now() - capCache.at < ttl) return capCache.v;
  const caps = { reachable: false, version: null, voice_override: false };
  if (DOGRAH.base) {
    try { const h = await fetch(`${DOGRAH.base}/api/v1/health`, { signal: AbortSignal.timeout(6000) }).then(r => r.json()); caps.reachable = true; caps.version = h.version || null; } catch {}
    if (caps.reachable && DOGRAH.apiKey) { try { await dograhApi('GET', '/api/v1/user/configurations/voices/realtime-catalog'); caps.voice_override = true; } catch {} }
  }
  capCache = { at: Date.now(), v: caps }; return caps;
}
// Returns the Dograh agent uuid to use for this role. No voice chosen = the shared default agent.
// A voice = a copy of the default agent with that voice, created on first use and refreshed when the default agent or the voice changes.
async function roleAgent(job, kind = 'screener') {
  const K = KINDS[kind], voice = String(job.voice || '').trim();
  if (!voice || !K.wid() || !K.uuid()) return K.uuid();
  if (!(await dograhCaps()).voice_override) return K.uuid(); // this Dograh has one voice for all agents: use it, do not build copies that would ignore the voice
  try {
    const base = await dograhApi('GET', `/api/v1/workflow/fetch/${K.wid()}`);
    const def = JSON.parse(JSON.stringify(base.workflow_definition));
    for (const n of def.nodes) if (n.type === 'trigger' && n.data) delete n.data.trigger_path;
    const hash = createHash('sha256').update(JSON.stringify(def) + '|' + voice).digest('hex').slice(0, 16);
    const row = db.prepare('SELECT agent_sync, agent_uuid, agent_wid, rej_agent_uuid, rej_wid FROM jobs WHERE id=?').get(job.id) || {};
    const sync = J(row.agent_sync, {}); let uuid = row[K.uuidCol], wid = row[K.widCol];
    if (uuid && wid && sync[kind] === hash) return uuid;
    const name = `${job.title} (${voice}) ${K.label}`.slice(0, 80);
    const configs = { ...K.cfg, model_voice_override: { voice } };
    if (!wid) {
      const created = await dograhApi('POST', '/api/v1/workflow/create/definition', { name, workflow_definition: def });
      wid = created.id;
    }
    await dograhApi('POST', `/api/v1/workflow/${wid}/create-draft`).catch(() => {});
    await dograhApi('PUT', `/api/v1/workflow/${wid}`, { name, workflow_definition: def, workflow_configurations: configs });
    await dograhApi('POST', `/api/v1/workflow/${wid}/publish`).catch(e => { if (!/No draft to publish/i.test(String(e.message))) throw e; });
    if (!uuid) uuid = (await dograhApi('GET', `/api/v1/workflow/fetch/${wid}`)).workflow_uuid;
    sync[kind] = hash;
    db.prepare(`UPDATE jobs SET ${K.uuidCol}=?, ${K.widCol}=?, agent_sync=? WHERE id=?`).run(uuid, wid, JSON.stringify(sync), job.id);
    trace('role_agent_synced', { job: job.id, kind, voice, workflow: wid });
    return uuid;
  } catch (e) {
    trace('role_agent_failed', { job: job.id, kind, voice, error: String(e.message || e).slice(0, 200) });
    return K.uuid(); // never block a call because a voice copy could not be built: use the default agent
  }
}
async function syncRoleAgents(job) { const a = await roleAgent(job, 'screener'); if (DOGRAH.rejectionAgentUuid) await roleAgent(job, 'rejection'); return a; }

const dograhWebReady = () => Boolean(DOGRAH.base && DOGRAH.embedToken);
async function dograhApiReachable() {
  if (!DOGRAH.base) return false;
  try {
    const response = await fetch(`${DOGRAH.base}/api/v1/health`, { signal: AbortSignal.timeout(2500) });
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- database
export const db = new DatabaseSync(DB_PATH);
const settings = createSettings(db, DB_PATH); // saved settings override .env and the environment
db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, title TEXT, company TEXT, location TEXT,
  min_years REAL, max_salary REAL, locations TEXT, must_skills TEXT, max_notice_days REAL,
  description TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY, job_id TEXT, name TEXT, email TEXT, phone TEXT, city TEXT,
  years REAL, notice_days REAL, expected_salary REAL, skills TEXT, why TEXT,
  stage TEXT DEFAULT 'applied', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS screenings (
  id TEXT PRIMARY KEY, candidate_id TEXT, mode TEXT, status TEXT, run_id TEXT,
  transcript TEXT, answers TEXT, raw TEXT, started_at TEXT DEFAULT (datetime('now')), ended_at TEXT);
CREATE TABLE IF NOT EXISTS scores (
  candidate_id TEXT PRIMARY KEY, total REAL, verdict TEXT, breakdown TEXT, flags TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY, candidate_id TEXT, helpful INTEGER, note TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS recruiters (id TEXT PRIMARY KEY, name TEXT, role TEXT);
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY, candidate_id TEXT, recruiter_id TEXT, kind TEXT, text TEXT, rating REAL, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id TEXT, kind TEXT, detail TEXT, at TEXT DEFAULT (datetime('now')));
`);

migrate(db);

// Demo fixtures are opt-in. A production database must open clean instead of
// silently inventing candidates, jobs, recruiters or performance metrics.
if (process.env.SEED_DEMO_ROLES === '1' && !db.prepare('SELECT COUNT(*) n FROM jobs').get().n) { try { console.log('Demo roles:', seedDemo(db, ROOT, process.env.BRAND_NAME || 'Your Company').join(', ')); } catch (e) { console.error('Could not load demo roles:', e.message); } }
if (process.env.SEED_DEMO_DATA === '1' && !db.prepare('SELECT COUNT(*) n FROM jobs').get().n) {
  const ins = db.prepare(`INSERT INTO jobs (id,title,company,location,min_years,max_salary,locations,must_skills,max_notice_days,description)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  ins.run('inside-sales', 'Inside Sales Executive', 'Northwind Talent', 'Pune (on-site)', 2, 60000,
    JSON.stringify(['pune', 'mumbai', 'remote-no']), JSON.stringify(['crm', 'cold calling', 'english']), 30,
    'Own outbound calling for B2B SaaS leads, book demos, keep the CRM clean. Target 60 dials a day.');
  ins.run('support-lead', 'Customer Support Lead', 'Northwind Talent', 'Bengaluru (hybrid)', 4, 90000,
    JSON.stringify(['bengaluru', 'bangalore']), JSON.stringify(['team lead', 'zendesk', 'sla']), 45,
    'Lead a 10-person support pod, own SLA and CSAT, run weekly QA reviews.');
}

if (process.env.SEED_DEMO_DATA === '1' && !db.prepare('SELECT COUNT(*) n FROM recruiters').get().n) {
  const ins = db.prepare('INSERT INTO recruiters (id,name,role) VALUES (?,?,?)');
  ins.run('ananya', 'Ananya Rao', 'Lead recruiter'); ins.run('rohit', 'Rohit Kulkarni', 'Recruiter'); ins.run('sana', 'Sana Shaikh', 'Recruiter');
}
function addActivity(cid, rid, kind, text, rating = null) {
  db.prepare('INSERT INTO activities (id,candidate_id,recruiter_id,kind,text,rating) VALUES (?,?,?,?,?,?)').run(randomUUID(), cid, rid || null, kind, text, rating);
}
const recruiterOk = rid => !rid || db.prepare('SELECT id FROM recruiters WHERE id=?').get(rid);

const J = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const logEvent = (cid, kind, detail) => db.prepare('INSERT INTO events (candidate_id,kind,detail) VALUES (?,?,?)').run(cid, kind, detail);

function jobRow(id) {
  const j = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  if (!j) return null;
  return { ...j, locations: J(j.locations, []), must_skills: J(j.must_skills, []) };
}

function latestAnswers(cid) {
  const scr = db.prepare("SELECT answers FROM screenings WHERE candidate_id=? AND status='completed' ORDER BY ended_at DESC LIMIT 1").get(cid);
  return scr ? J(scr.answers, {}) : null;
}
function evaluationFor(c) {
  const job = jobRow(c.job_id);
  const answers = latestAnswers(c.id);
  const result = scoreCandidate(c, job, answers);
  const pool = db.prepare("SELECT c.id, c.years, c.expected_salary, s.total FROM candidates c LEFT JOIN scores s ON s.candidate_id=c.id WHERE c.job_id=? AND c.id<>?").all(c.job_id, c.id)
    .map(p => { const a = latestAnswers(p.id) || {}; return { years: a.years_experience ?? p.years, expected_salary: a.expected_salary ?? p.expected_salary, total: p.total }; });
  return evaluate(result, c, answers, pool);
}

function candidateFull(id) {
  const c = db.prepare('SELECT * FROM candidates WHERE id=?').get(id);
  if (!c) return null;
  const s = db.prepare('SELECT * FROM scores WHERE candidate_id=?').get(id);
  const scr = db.prepare('SELECT * FROM screenings WHERE candidate_id=? ORDER BY started_at DESC').all(id)
    .map(x => ({ ...x, transcript: J(x.transcript, []), answers: J(x.answers, {}), raw: undefined }));
  const fb = db.prepare('SELECT * FROM feedback WHERE candidate_id=? ORDER BY created_at DESC').all(id);
  const ev = db.prepare('SELECT * FROM events WHERE candidate_id=? ORDER BY id').all(id);
  const acts = db.prepare('SELECT a.*, r.name recruiter_name FROM activities a LEFT JOIN recruiters r ON r.id=a.recruiter_id WHERE candidate_id=? ORDER BY a.created_at DESC').all(id);
  const doneScr = scr.find(x => x.status === 'completed');
  const highlights = doneScr?.answers?.evidence_text ? evidenceOf(doneScr.answers.evidence_text) : null;
  return { ...c, highlights, evaluation: evaluationFor(c), activities: acts, job: jobRow(c.job_id), score: s ? { ...s, breakdown: J(s.breakdown, []), flags: J(s.flags, []) } : null, screenings: scr, feedback: fb, events: ev };
}

function rescore(cid) {
  const c = db.prepare('SELECT * FROM candidates WHERE id=?').get(cid);
  const job = jobRow(c.job_id);
  const scr = db.prepare("SELECT * FROM screenings WHERE candidate_id=? AND status='completed' ORDER BY ended_at DESC LIMIT 1").get(cid);
  const result = scoreCandidate(c, job, scr ? J(scr.answers, {}) : null);
  db.prepare(`INSERT INTO scores (candidate_id,total,verdict,breakdown,flags,updated_at) VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(candidate_id) DO UPDATE SET total=excluded.total, verdict=excluded.verdict, breakdown=excluded.breakdown, flags=excluded.flags, updated_at=excluded.updated_at`)
    .run(cid, result.total, result.verdict, JSON.stringify(result.breakdown), JSON.stringify(result.flags));
  if (scr) {
    const stage = result.verdict === 'Strong' ? 'shortlisted' : result.verdict === 'Maybe' ? 'review' : 'rejected';
    db.prepare("UPDATE candidates SET stage=? WHERE id=? AND stage IN ('applied','screening','screened','review','shortlisted','rejected')").run(stage, cid);
  }
  return result;
}

// ---------------------------------------------------------------- dograh
async function dograhTriggerPhone(candidate, job) {
  const agent = await roleAgent(job, 'screener');
  const url = `${DOGRAH.base}/api/v1/public/agent/workflow/${encodeURIComponent(agent)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': DOGRAH.apiKey },
    body: JSON.stringify({ phone_number: candidate.phone, initial_context: screeningContext(candidate, job) }),
  });
  const text = await res.text();
  const data = J(text, { detail: text });
  trace('dograh_call_out', { to: candidate.name, url, status: res.status, ok: res.ok, response: text.slice(0, 300), context_keys: Object.keys(screeningContext(candidate, job)) });
  if (!res.ok) throw new Error(`Dograh trigger failed (${res.status}): ${data?.detail ? JSON.stringify(data.detail) : text}`);
  return data; // {status, workflow_run_id, workflow_run_name}
}

async function dograhCall(agentUuid, phone, initial_context) {
  const res = await fetch(`${DOGRAH.base}/api/v1/public/agent/workflow/${encodeURIComponent(agentUuid)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': DOGRAH.apiKey },
    body: JSON.stringify({ phone_number: phone, initial_context }),
  });
  const text = await res.text();
  const data = J(text, { detail: text });
  if (!res.ok) throw new Error(`Dograh call failed (${res.status}): ${data?.detail ? JSON.stringify(data.detail) : text}`);
  return data;
}


// Salary negotiation settings ride into the call. Budget and stretch are monthly rupees; the agent speaks in lakhs per year.
function negotiationContext(job) {
  const budget = Number(job.max_salary) || 0;
  const pct = Number.isFinite(Number(job.stretch_pct)) ? Number(job.stretch_pct) : 10;
  const stretch = Math.round(budget * (1 + pct / 100));
  const lpa = m => (m * 12 / 100000).toFixed(1).replace(/\.0$/, '');
  return {
    negotiation_enabled: job.negotiable && budget ? 'yes' : 'no',
    job_budget_monthly: String(budget || ''), job_stretch_monthly: String(budget ? stretch : ''),
    job_budget_lpa: budget ? lpa(budget) : '', job_stretch_lpa: budget ? lpa(stretch) : '',
    negotiation_notes: String(job.negotiation_notes || ''),
  };
}

export function screeningContext(c, job) {
  // Resume compaction rides into the call so the agent can ask gap and
  // curveball questions. Parsed v2 summary (if any) is merged over the
  // rules-based one.
  const probes = resumeProbes(c.resume_text);
  const parsed = J(c.resume_summary, null);
  const resume_summary = [
    parsed?.summary || '', parsed?.skills?.length ? `Parsed skills: ${parsed.skills.join(', ')}` : '',
    parsed?.current_company ? `Current company: ${parsed.current_company}` : '',
    probes.summary,
  ].filter(Boolean).join('. ').slice(0, 900);
  return {
    candidate_id: c.id, candidate_name: c.name, candidate_first_name: String(c.name || '').trim().split(/\s+/)[0], candidate_city: c.city,
    form_years_experience: String(c.years ?? ''), form_notice_days: String(c.notice_days ?? ''),
    form_expected_salary: String(c.expected_salary ?? ''), form_skills: c.skills || '',
    job_title: job.title, company_name: job.company, job_location: job.location,
    job_min_years: String(job.min_years), job_must_skills: job.must_skills.join(', '),
    job_custom_questions: (() => { try { return JSON.parse(job.custom_questions || '[]').join(' | '); } catch { return ''; } })(),
    has_resume: c.resume_text ? 'yes' : 'no',
    resume_summary,
    resume_text: String(c.resume_text || '').slice(0, 6000),
    applied_date: new Date(String(c.created_at || '').replace(' ', 'T') + 'Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' }),
    resume_probes: probes.probes.join(' | '),
    ...negotiationContext(job),
    agent_name: job.agent_name || process.env.AGENT_NAME || 'Priya',
  };
}

// Map a Dograh webhook payload onto our answer keys.
export function answersFromDograh(body) {
  const g = body.gathered_context || body.extracted_variables || {};
  const pick = (...k) => { for (const x of k) if (g[x] !== undefined && g[x] !== null && g[x] !== '') return g[x]; return undefined; };
  const a = {
    years_experience: pick('years_experience', 'experience_years', 'years'),
    notice_days: pick('notice_period_days', 'notice_days', 'notice_period'),
    expected_salary: pick('expected_salary', 'expected_salary_monthly', 'salary_expectation'),
    relocation_ok: pick('relocation_ok', 'location_ok', 'can_work_from_location'),
    skill_example: pick('skill_example', 'role_example', 'experience_example'),
    availability: pick('interview_availability', 'availability'),
    negotiation_outcome: pick('negotiation_outcome'),
    agreed_salary: pick('agreed_salary'),
  };
  for (const q of QUESTIONS) if (a[q.key] !== undefined && typeof a[q.key] === 'string') a[q.key] = parseAnswer(q, a[q.key]);
  if (typeof a.agreed_salary === 'string') a.agreed_salary = parseAnswer({ type: 'salary' }, a.agreed_salary);
  if (typeof a.negotiation_outcome === 'string') {
    const o = a.negotiation_outcome.toLowerCase().trim();
    a.negotiation_outcome = /^(accepted|declined|not_needed|not_discussed)$/.test(o) ? o : (/(agree|fine|work|okay|ok|yes|accept|sounds)/.test(o) && !/(not|n't|no)\b/.test(o) ? 'accepted' : (/(no|not|too|less|low)/.test(o) ? 'declined' : 'not_discussed'));
  }
  return Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined));
}

function transcriptFromDograh(body) {
  const t = body.transcript || body.messages || [];
  if (!Array.isArray(t)) return [];
  return t.map(m => ({
    role: /assistant|agent|bot/i.test(m.role || m.speaker || '') ? 'agent' : 'candidate',
    text: m.content || m.text || m.message || '',
  })).filter(m => m.text);
}

// ---------------------------------------------------------------- http helpers
const send = (res, code, obj, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(obj));
};
async function body(req) {
  let raw = '';
  for await (const ch of req) { raw += ch; if (raw.length > 1e6) throw new Error('payload too large'); }
  return raw ? JSON.parse(raw) : {};
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

function validateApplication(b) {
  const errs = [];
  const need = ['job_id', 'name', 'email', 'phone', 'city'];
  for (const k of need) if (!String(b[k] || '').trim()) errs.push(`${k} is required`);
  if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) errs.push('email is invalid');
  if (b.phone && !/^\+?[0-9 ()-]{8,20}$/.test(b.phone)) errs.push('phone is invalid');
  for (const k of ['years', 'notice_days', 'expected_salary']) if (b[k] !== undefined && b[k] !== '' && !Number.isFinite(Number(b[k]))) errs.push(`${k} must be a number`);
  if (b.job_id && !jobRow(b.job_id)) errs.push('job not found');
  return errs;
}
const e164 = p => { const d = String(p).replace(/[^\d+]/g, ''); return d.startsWith('+') ? d : d.length === 10 ? `+91${d}` : `+${d}`; };

// ---------------------------------------------------------------- suite (LLM router, jobs, interviews, offers, automation queue)
const llm = createLLM(db);
const engine = createEngine({ root: ROOT, DOGRAH, db, jobRow: id => jobRow(id), screeningContext: (c, j) => screeningContext(c, j), llmStatus: () => llm.status(), send, body, ready: { phone: dograhPhoneReady, web: dograhWebReady } });
const suite = createSuite({
  db, send, body, J, jobRow, candidateFull, logEvent, addActivity, rescore, latestAnswers,
  scoreCandidate, screeningContext, llm, dograhCall,
  dograh: { roleAgent, syncRoleAgents, phoneReady: dograhPhoneReady, get agentUuid() { return DOGRAH.agentUuid; }, get refAgentUuid() { return DOGRAH.refAgentUuid; }, get reminderAgentUuid() { return DOGRAH.reminderAgentUuid; }, get rejectionAgentUuid() { return DOGRAH.rejectionAgentUuid; } },
  settings, dograhApi, createAgents, dograhCaps,
});

// ---------------------------------------------------------------- routes
async function route(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const m = req.method;
  // Requests that arrive through a public tunnel (Cloudflare adds cf-connecting-ip) may only reach the Dograh webhook and health.
  // Everything else (candidate data, dashboard, engine room) stays local-only.
  if (req.headers['cf-connecting-ip'] && !['/api/webhooks/dograh', '/api/health'].includes(p)) return send(res, 403, { error: 'not available over the public tunnel' });
  if (await suite.route(req, res, u)) return;
  if (p.startsWith('/api/engine/') && (await engine(req, res, p, m)) !== false) return;

  // PDF resume -> plain text (pdftotext). Raw PDF body, max 5 MB. The text then goes through the normal resume flow.
  if (p === '/api/resume/pdf' && m === 'POST') {
    const chunks = []; let size = 0;
    for await (const ch of req) { size += ch.length; if (size > 5e6) return send(res, 413, { error: 'PDF too large (max 5 MB)' }); chunks.push(ch); }
    const buf = Buffer.concat(chunks);
    if (buf.length < 100 || buf.subarray(0, 5).toString() !== '%PDF-') return send(res, 400, { error: 'that file is not a PDF' });
    const tmp = path.join(tmpdir(), `resume-${randomUUID()}.pdf`); writeFileSync(tmp, buf);
    let text = '';
    try { text = execFileSync(existsSync('/opt/homebrew/bin/pdftotext') ? '/opt/homebrew/bin/pdftotext' : 'pdftotext', ['-layout', tmp, '-'], { encoding: 'utf8', timeout: 15000 }); }
    catch { return send(res, 500, { error: 'could not read this PDF (pdftotext failed or is not installed)' }); }
    finally { try { unlinkSync(tmp); } catch { /* already gone */ } }
    text = text.replace(/\f/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length < 40) return send(res, 422, { error: 'no readable text in this PDF (scanned image?). Paste the text instead.' });
    return send(res, 200, { text: text.slice(0, 20000), truncated: text.length > 20000 });
  }

  if (p === '/api/health') return send(res, 200, { ok: true, dograh: { phone: dograhPhoneReady(), web: dograhWebReady() } });

  if (p === '/api/config' && m === 'GET') {
    const dograh_api_live = await dograhApiReachable();
    return send(res, 200, { careers_url: process.env.CAREERS_URL || '', brand: process.env.BRAND_NAME || 'Recruit OS', agent_name: process.env.AGENT_NAME || 'Priya', dograh_web: dograhWebReady(), dograh_phone: dograhPhoneReady(), dograh_api_live, dograh_base: DOGRAH.base || null, embed_token: dograhWebReady() ? DOGRAH.embedToken : null, questions: QUESTIONS, criteria: CRITERIA });
  }

  if (p === '/api/jobs' && m === 'GET') return send(res, 200, db.prepare('SELECT id FROM jobs ORDER BY created_at').all().map(r => jobRow(r.id)));

  if (p === '/api/applications' && m === 'POST') {
    const b = await body(req);
    const errs = validateApplication(b);
    if (errs.length) return send(res, 400, { error: errs.join('; ') });
    const id = randomUUID();
    db.prepare(`INSERT INTO candidates (id,job_id,name,email,phone,city,years,notice_days,expected_salary,skills,why) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, b.job_id, b.name.trim(), b.email.trim(), e164(b.phone), b.city.trim(),
        b.years === '' || b.years == null ? null : Number(b.years), b.notice_days === '' || b.notice_days == null ? null : Number(b.notice_days),
        b.expected_salary === '' || b.expected_salary == null ? null : Number(b.expected_salary), (b.skills || '').trim(), (b.why || '').trim());
    logEvent(id, 'applied', `Applied for ${jobRow(b.job_id).title}`);
    db.prepare('UPDATE candidates SET source=?, resume_text=?, consent_at=? WHERE id=?')
      .run(String(b.source || 'careers').slice(0, 40), String(b.resume || '').trim().slice(0, 20000) || null, b.consent === true ? new Date().toISOString() : null, id);
    rescore(id);
    suite.afterApply(id);
    const c = db.prepare('SELECT * FROM candidates WHERE id=?').get(id);
    return send(res, 201, { id, context: screeningContext(c, jobRow(b.job_id)) });
  }

  // start a screening: mode = phone | web | simulator
  let mm;
  if ((mm = p.match(/^\/api\/candidates\/([\w-]+)\/screenings$/)) && m === 'POST') {
    const cid = mm[1];
    const c = db.prepare('SELECT * FROM candidates WHERE id=?').get(cid);
    if (!c) return send(res, 404, { error: 'candidate not found' });
    const { mode = 'simulator' } = await body(req);
    if (!['phone', 'web', 'simulator'].includes(mode)) return send(res, 400, { error: 'mode must be phone, web or simulator' });
    const sid = randomUUID();
    let run_id = null;
    if (mode === 'phone') {
      if (!dograhPhoneReady()) return send(res, 409, { error: 'Dograh phone screening is not configured (DOGRAH_BASE_URL, DOGRAH_API_KEY, DOGRAH_AGENT_UUID).' });
      // The public form must never be a way to ring strangers: consent, an allowlist (until production), and no repeat calls.
      if (!c.consent_at) return send(res, 403, { error: 'We need your consent to call you. Please tick the consent box on the application form.' });
      if (!callAllowed(c.phone)) return send(res, 409, { error: 'Phone screening is limited to approved numbers in this demo. Ask the team to add your number.' });
      const recent = db.prepare("SELECT 1 FROM screenings WHERE candidate_id=? AND mode='phone' AND started_at > datetime('now','-10 minutes')").get(cid);
      if (recent) return send(res, 429, { error: 'A call to this number was just started. Please wait a few minutes before trying again.' });
      try {
        const r = await dograhTriggerPhone(c, jobRow(c.job_id));
        run_id = String(r.workflow_run_id);
      } catch (e) {
        logEvent(cid, 'error', e.message);
        return send(res, 502, { error: e.message });
      }
    }
    if (mode === 'web' && !dograhWebReady()) return send(res, 409, { error: 'Dograh web widget is not configured (DOGRAH_BASE_URL, DOGRAH_EMBED_TOKEN).' });
    db.prepare("INSERT INTO screenings (id,candidate_id,mode,status,run_id,transcript,answers) VALUES (?,?,?,'in_progress',?,'[]','{}')").run(sid, cid, mode, run_id);
    db.prepare("UPDATE candidates SET stage='screening' WHERE id=?").run(cid);
    logEvent(cid, 'screening_started', `${mode} screening started${run_id ? ` (Dograh run ${run_id})` : ''}`);
    return send(res, 201, { screening_id: sid, run_id, questions: mode === 'simulator' ? QUESTIONS : undefined });
  }

  // simulator: submit answers for a screening
  if ((mm = p.match(/^\/api\/screenings\/([\w-]+)\/complete$/)) && m === 'POST') {
    const s = db.prepare('SELECT * FROM screenings WHERE id=?').get(mm[1]);
    if (!s) return send(res, 404, { error: 'screening not found' });
    if (s.status === 'completed') return send(res, 409, { error: 'screening already completed' });
    const b = await body(req);
    const transcript = Array.isArray(b.transcript) ? b.transcript.slice(0, 200) : [];
    const answers = {};
    for (const q of QUESTIONS) {
      const raw = b.answers?.[q.key];
      if (raw !== undefined && raw !== '') answers[q.key] = parseAnswer(q, String(raw));
    }
    db.prepare("UPDATE screenings SET status='completed', transcript=?, answers=?, ended_at=datetime('now') WHERE id=?").run(JSON.stringify(transcript), JSON.stringify(answers), s.id);
    logEvent(s.candidate_id, 'screening_completed', `${s.mode} screening completed`);
    const score = rescore(s.candidate_id);
    logEvent(s.candidate_id, 'scored', `${score.total}/100, ${score.verdict}`);
    suite.afterScreen(s.candidate_id);
    return send(res, 200, { score });
  }

  // Dograh webhook (configure a Webhook node in the Dograh workflow to POST here)
  if (p === '/api/webhooks/dograh' && m === 'POST') {
    if (DOGRAH.webhookSecret && req.headers['x-webhook-secret'] !== DOGRAH.webhookSecret) return send(res, 401, { error: 'bad secret' });
    const b = await body(req);
    // Dograh's Jinja renderer JSON-stringifies dict variables, so accept both
    // nested objects and their stringified forms.
    for (const k of ['initial_context', 'gathered_context', 'extracted_variables']) {
      if (typeof b[k] === 'string') { try { b[k] = JSON.parse(b[k]); } catch { b[k] = {}; } }
    }
    const ic = b.initial_context || {};
    trace('dograh_webhook_in', { candidate_id: ic.candidate_id || null, run_id: String(b.workflow_run_id ?? b.run_id ?? b.id ?? ''), turns: Array.isArray(b.transcript) ? b.transcript.length : 0, gathered: Object.keys(b.gathered_context || b.extracted_variables || {}) });
    if (ic.kind === 'reference') return send(res, 200, await suite.referenceWebhook(b));
    if (ic.kind === 'rejection') return send(res, 200, await suite.rejectionWebhook(b));
    const runId = String(b.workflow_run_id ?? b.run_id ?? b.id ?? req.headers['x-dograh-workflow-run-id'] ?? '');
    let s = runId ? db.prepare('SELECT * FROM screenings WHERE run_id=?').get(runId) : null;
    const cid = s?.candidate_id || ic.candidate_id || b.candidate_id;
    if (!cid || !db.prepare('SELECT id FROM candidates WHERE id=?').get(cid)) return send(res, 404, { error: 'no matching candidate for this run' });
    if (!s) {
      s = db.prepare("SELECT * FROM screenings WHERE candidate_id=? AND mode='web' AND status='in_progress' ORDER BY started_at DESC").get(cid);
      if (!s) {
        const sid = randomUUID();
        db.prepare("INSERT INTO screenings (id,candidate_id,mode,status,run_id,transcript,answers) VALUES (?,?,?,'in_progress',?,'[]','{}')").run(sid, cid, ic.source === 'web' ? 'web' : 'phone', runId || null);
        s = db.prepare('SELECT * FROM screenings WHERE id=?').get(sid);
      }
    }
    // Re-read the run from Dograh itself: real transcript and real duration, and no blind trust in the posted payload.
    let durationSec = null;
    if (runId && DOGRAH.base && DOGRAH.apiKey) {
      try {
        const wid = encodeURIComponent(String(b.workflow_id || process.env.DOGRAH_WORKFLOW_ID || 1));
        const rr = await fetch(`${DOGRAH.base}/api/v1/workflow/${wid}/runs/${encodeURIComponent(runId)}`, { headers: { 'X-API-Key': DOGRAH.apiKey }, signal: AbortSignal.timeout(8000) });
        if (rr.ok) {
          const run = await rr.json();
          durationSec = run?.cost_info?.call_duration_seconds ?? null;
          const evs = (run?.logs?.realtime_feedback_events || []).filter(e => e.type === 'rtf-bot-text' || e.type === 'rtf-user-transcription')
            .sort((x, y) => String(x.timestamp).localeCompare(String(y.timestamp)));
          const turns = [];
          for (const e of evs) {
            const role = e.type === 'rtf-bot-text' ? 'assistant' : 'user';
            const text = String(e.payload?.text || '').trim();
            if (!text) continue;
            const last = turns[turns.length - 1];
            if (last && last.role === role) last.content += ' ' + text; else turns.push({ role, content: text });
          }
          if (turns.length) b.transcript = turns;
        }
      } catch (e) { trace('dograh_run_fetch_failed', { run_id: runId, error: String(e.message || e).slice(0, 120) }); }
    }
    const answers = answersFromDograh(b);
    const transcript = transcriptFromDograh(b);
    // everything the candidate said, for the evidence score and the highlights
    answers.evidence_text = transcript.filter(t => t.role === 'candidate').map(t => t.text).join(' ').slice(0, 8000);
    const candidateTurns = transcript.filter(t => t.role === 'candidate').length;
    const incomplete = candidateTurns === 0 || (durationSec !== null && durationSec < 15);
    db.prepare(`UPDATE screenings SET status=?, run_id=COALESCE(run_id,?), transcript=?, answers=?, raw=?,
        ended_at=${durationSec !== null ? "datetime(started_at, '+' || CAST(? AS INTEGER) || ' seconds')" : "datetime('now')"} WHERE id=?`)
      .run(...[incomplete ? 'incomplete' : 'completed', runId || null, JSON.stringify(transcript), JSON.stringify(answers), JSON.stringify(b).slice(0, 200000), ...(durationSec !== null ? [durationSec] : []), s.id]);
    if (incomplete) {
      logEvent(cid, 'screening_incomplete', `Dograh ${s.mode} screening ended without a conversation${runId ? ` (run ${runId})` : ''}`);
      return send(res, 200, { ok: true, candidate_id: cid, incomplete: true });
    }
    logEvent(cid, 'screening_completed', `Dograh ${s.mode} screening completed${runId ? ` (run ${runId})` : ''}`);
    const score = rescore(cid);
    logEvent(cid, 'scored', `${score.total}/100, ${score.verdict}`);
    suite.afterScreen(cid);
    return send(res, 200, { ok: true, candidate_id: cid, score });
  }

  if (p === '/api/candidates' && m === 'GET') {
    const rows = db.prepare(`SELECT c.*, j.title job_title, s.total, s.verdict, s.flags,
      (SELECT helpful FROM feedback f WHERE f.candidate_id=c.id ORDER BY created_at DESC LIMIT 1) helpful
      FROM candidates c JOIN jobs j ON j.id=c.job_id LEFT JOIN scores s ON s.candidate_id=c.id ORDER BY c.created_at DESC`).all();
    return send(res, 200, rows.map(r => { const e = evaluationFor(r); return { ...r, flags: J(r.flags, []), blocker: e.blocker, outliers: e.outliers }; }));
  }

  if ((mm = p.match(/^\/api\/candidates\/([\w-]+)$/)) && m === 'GET') {
    const c = candidateFull(mm[1]);
    return c ? send(res, 200, c) : send(res, 404, { error: 'candidate not found' });
  }

  if ((mm = p.match(/^\/api\/candidates\/([\w-]+)\/stage$/)) && m === 'POST') {
    const { stage, recruiter_id } = await body(req);
    if (!recruiterOk(recruiter_id)) return send(res, 400, { error: 'unknown recruiter' });
    const ok = ['applied', 'screening', 'review', 'shortlisted', 'interview', 'hired', 'rejected'];
    if (!ok.includes(stage)) return send(res, 400, { error: `stage must be one of ${ok.join(', ')}` });
    const r = db.prepare('UPDATE candidates SET stage=? WHERE id=?').run(stage, mm[1]);
    if (!r.changes) return send(res, 404, { error: 'candidate not found' });
    logEvent(mm[1], 'stage', `Moved to ${stage}`);
    addActivity(mm[1], recruiter_id, 'stage', `Moved to ${stage}`);
    return send(res, 200, { ok: true });
  }

  if ((mm = p.match(/^\/api\/candidates\/([\w-]+)\/feedback$/)) && m === 'POST') {
    const { helpful, note = '', recruiter_id } = await body(req);
    if (!recruiterOk(recruiter_id)) return send(res, 400, { error: 'unknown recruiter' });
    if (typeof helpful !== 'boolean') return send(res, 400, { error: 'helpful must be true or false' });
    if (!db.prepare('SELECT id FROM candidates WHERE id=?').get(mm[1])) return send(res, 404, { error: 'candidate not found' });
    db.prepare('INSERT INTO feedback (id,candidate_id,helpful,note) VALUES (?,?,?,?)').run(randomUUID(), mm[1], helpful ? 1 : 0, String(note).slice(0, 1000));
    addActivity(mm[1], recruiter_id, 'feedback', `AI screen ${helpful ? 'helpful' : 'not helpful'}${note ? `: ${note}` : ''}`);
    logEvent(mm[1], 'feedback', `Recruiter marked the AI screen ${helpful ? 'helpful' : 'not helpful'}${note ? `: ${note}` : ''}`);
    return send(res, 201, { ok: true });
  }

  if (p === '/api/recruiters' && m === 'GET') return send(res, 200, db.prepare('SELECT * FROM recruiters ORDER BY name').all());

  if ((mm = p.match(/^\/api\/candidates\/([\w-]+)\/activities$/)) && m === 'POST') {
    const { recruiter_id, kind, text = '', rating = null } = await body(req);
    if (!recruiter_id || !recruiterOk(recruiter_id)) return send(res, 400, { error: 'recruiter_id is required' });
    if (!['note', 'call', 'interview'].includes(kind)) return send(res, 400, { error: 'kind must be note, call or interview' });
    if (kind === 'interview' && !(Number(rating) >= 1 && Number(rating) <= 5)) return send(res, 400, { error: 'interview needs a rating from 1 to 5' });
    if (!String(text).trim() && kind !== 'interview') return send(res, 400, { error: 'text is required' });
    if (!db.prepare('SELECT id FROM candidates WHERE id=?').get(mm[1])) return send(res, 404, { error: 'candidate not found' });
    addActivity(mm[1], recruiter_id, kind, String(text).slice(0, 4000), kind === 'interview' ? Number(rating) : null);
    logEvent(mm[1], kind, `${db.prepare('SELECT name FROM recruiters WHERE id=?').get(recruiter_id).name} logged ${kind === 'interview' ? `an interview (${rating}/5)` : `a ${kind}`}`);
    return send(res, 201, { ok: true });
  }

  if (p === '/api/calls' && m === 'GET') {
    const rows = db.prepare(`SELECT x.id, x.candidate_id, x.mode, x.status, x.run_id, x.started_at, x.ended_at, x.transcript,
      c.name, c.phone, j.title job_title, s.total, s.verdict,
      CAST((julianday(x.ended_at) - julianday(x.started_at)) * 86400 AS INTEGER) duration_sec
      FROM screenings x JOIN candidates c ON c.id=x.candidate_id JOIN jobs j ON j.id=c.job_id LEFT JOIN scores s ON s.candidate_id=c.id
      ORDER BY x.started_at DESC`).all();
    return send(res, 200, rows.map(r => ({ ...r, turns: J(r.transcript, []).length, transcript: undefined })));
  }

  if (p === '/api/team' && m === 'GET') {
    const team = db.prepare('SELECT * FROM recruiters ORDER BY name').all().map(r => {
      const acts = db.prepare('SELECT * FROM activities WHERE recruiter_id=?').all(r.id);
      const count = k => acts.filter(a => a.kind === k).length;
      const fb = acts.filter(a => a.kind === 'feedback');
      const ratings = acts.filter(a => a.kind === 'interview').map(a => a.rating);
      const candidates = new Set(acts.map(a => a.candidate_id)).size;
      const last = acts.map(a => a.created_at).sort().at(-1) || null;
      return { ...r, actions: acts.length, candidates, notes: count('note'), calls: count('call'), interviews: count('interview'), stage_moves: count('stage'),
        reviews: fb.length, agree_with_ai: fb.length ? Math.round(fb.filter(a => a.text.startsWith('AI screen helpful')).length / fb.length * 100) : null,
        avg_interview_rating: ratings.length ? Math.round(ratings.reduce((x, y) => x + y, 0) / ratings.length * 10) / 10 : null, last_active: last };
    });
    const acts = team.map(t => t.actions), med = [...acts].sort((a, b) => a - b)[acts.length >> 1] || 0;
    for (const t of team) t.outlier = med && t.actions >= med * 1.5 ? 'high output' : t.actions === 0 || (med && t.actions <= med * 0.5) ? 'low output' : null;
    return send(res, 200, team);
  }

  if (p === '/api/stats' && m === 'GET') {
    const one = sql => db.prepare(sql).get();
    const total = one('SELECT COUNT(*) n FROM candidates').n;
    const screened = one("SELECT COUNT(DISTINCT candidate_id) n FROM screenings WHERE status='completed'").n;
    const strong = one("SELECT COUNT(*) n FROM scores s JOIN screenings x ON x.candidate_id=s.candidate_id AND x.status='completed' WHERE verdict='Strong'").n;
    const avg = one("SELECT AVG(total) a FROM scores WHERE candidate_id IN (SELECT candidate_id FROM screenings WHERE status='completed')").a;
    const fb = one('SELECT SUM(helpful) y, COUNT(*) n FROM feedback');
    const byStage = db.prepare('SELECT stage, COUNT(*) n FROM candidates GROUP BY stage').all();
    const minutesSaved = screened * 18; // assumption: 18 recruiter minutes per manual phone screen
    return send(res, 200, { total, screened, strong, avg_score: avg ? Math.round(avg) : null, helpful_yes: fb.y || 0, feedback_count: fb.n, by_stage: byStage, minutes_saved: minutesSaved });
  }

  // static
  if (m === 'GET') {
    let f = p === '/' ? '/apply.html' : p === '/dashboard' ? '/dashboard.html' : p;
    const full = path.join(ROOT, 'public', path.normalize(f).replace(/^(\.\.[/\\])+/, ''));
    if (full.startsWith(path.join(ROOT, 'public')) && existsSync(full)) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      return res.end(await readFile(full));
    }
  }
  send(res, 404, { error: 'not found' });
}

export const server = http.createServer((req, res) => {
  route(req, res).catch(e => send(res, e instanceof SyntaxError ? 400 : 500, { error: e instanceof SyntaxError ? 'invalid JSON' : e.message }));
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  suite.startWorker();
  server.listen(PORT, () => console.log(`Recruiting System on http://localhost:${PORT}  (dashboard: /dashboard)  Dograh phone:${dograhPhoneReady()} web:${dograhWebReady()}`));
}
