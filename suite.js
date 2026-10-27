// Recruiting suite: everything around the AI voice screen.
// Jobs + AI job drafting, resume parsing, AI analysis, interview scheduling + scorecards, reference checks,
// offers, onboarding, candidate messages, talent pool, analytics, automation queue, login, assistant.
// Rule for every AI feature: it drafts or suggests, a person decides. Every AI feature has a rules-based fallback.
import { randomUUID, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { parseAnswer } from './scoring.js';
import { readFileSync } from 'node:fs';
import { mailConfig, mailReady, sendMail, verifyMail } from './mailer.js';
import { GROUPS } from './settings.js';

const IST = 5.5 * 3600 * 1000;
const DAY = 86400000;
const sqlTime = d => new Date(d).toISOString().slice(0, 19).replace('T', ' ');
const parseSql = s => new Date(String(s).replace(' ', 'T') + 'Z').getTime();
const first = n => String(n || '').trim().split(/\s+/)[0] || 'there';
const noDash = s => String(s).replace(/\s*[\u2014\u2013]\s*/g, ', ');
const arr = x => (Array.isArray(x) ? x : typeof x === 'string' && x.trim() ? x.split(/[,\n]/) : []).map(s => String(s).trim()).filter(Boolean);
const num = v => (v === '' || v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : NaN);
const median = xs => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fmtDay = iso => { const d = new Date(new Date(String(iso).replace(' ', 'T') + (String(iso).includes('Z') ? '' : 'Z')).getTime() + 5.5 * 3600 * 1000); return `${d.getUTCDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]}`; };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtIST(iso) {
  const d = new Date(new Date(iso).getTime() + IST);
  let h = d.getUTCHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}, ${h}:${String(d.getUTCMinutes()).padStart(2, '0')} ${ap} IST`;
}
const callHours = () => { const h = new Date(Date.now() + IST).getUTCHours(); return h >= 9 && h < 21; };
function nextCallWindow() {
  const d = new Date(Date.now() + IST);
  let start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (d.getUTCHours() >= 21) start += DAY;
  return start + 9 * 3600000 - IST;
}

const DEFAULTS = { auto_call: '0', auto_analyze: '1', auto_draft_messages: '1', spot_check_rate: '0.1', reminder_hours: '24', workday_start: '10', workday_end: '18', slot_minutes: '30' };
const INTERVIEW_DIMS = ['role_skills', 'communication', 'problem_solving', 'motivation', 'culture_add'];
const REC = ['strong_yes', 'yes', 'no', 'strong_no'];
const ONBOARDING = [
  ['Signed offer letter', 'doc', -7], ['ID proof (Aadhaar or passport)', 'doc', -5], ['PAN card', 'doc', -5], ['Bank account details', 'doc', -5],
  ['Education certificates', 'doc', -5], ['Relieving letter from last employer', 'doc', -2], ['Last 3 payslips', 'doc', -5],
  ['Laptop and accounts set up', 'task', -1], ['Day 1 welcome call', 'call', 0], ['Day 7 check-in call', 'call', 7], ['Day 30 review', 'call', 30],
];


// ------------------------------------------------------------ CSV lead import (Naukri / Indeed / any export)
export function parseCsv(text) {
  const t = String(text || '').replace(/^﻿/, '');
  const first = t.split(/\r?\n/, 1)[0] || '';
  const sep = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(x => x.trim() !== '')) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some(x => x.trim() !== '')) rows.push(row);
  return rows;
}
const HDR = {
  name: ['name', 'candidatename', 'fullname', 'applicantname'],
  email: ['email', 'emailid', 'emailaddress', 'mail'],
  phone: ['mobile', 'mobilenumber', 'phone', 'phonenumber', 'contact', 'contactnumber', 'mobileno', 'phoneno'],
  city: ['location', 'currentlocation', 'city', 'currentcity', 'preferredlocation'],
  years: ['experience', 'totalexperience', 'totalexp', 'yearsofexperience', 'exp', 'years'],
  notice: ['noticeperiod', 'notice', 'availabilitytojoin'],
  salary: ['expectedctc', 'expectedsalary', 'expectedctclpa', 'expectedsalarylpa', 'expectation'],
  skills: ['keyskills', 'skills', 'skillset', 'technicalskills'],
  company: ['currentcompany', 'currentemployer', 'company', 'employer'],
  title: ['currentdesignation', 'designation', 'currenttitle', 'jobtitle', 'currentrole'],
  edu: ['education', 'qualification', 'highestqualification'],
  resume: ['resume', 'resumetext', 'profilesummary', 'summary', 'resumesummary'],
};
const norm = h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function mapLeadRows(rows) {
  const head = rows[0].map(norm);
  const idx = {}; for (const [k, names] of Object.entries(HDR)) { const i = head.findIndex(h => names.includes(h)); if (i >= 0) idx[k] = i; }
  const missing = ['name', 'phone'].filter(k => idx[k] === undefined);
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const g = k => (idx[k] === undefined ? '' : String(rows[r][idx[k]] ?? '').trim());
    out.push({ line: r + 1, name: g('name'), email: g('email'), phone: g('phone'), city: g('city'), years: g('years'), notice: g('notice'), salary: g('salary'), skills: g('skills'), company: g('company'), title: g('title'), edu: g('edu'), resume: g('resume') });
  }
  return { missing, leads: out, columns: Object.keys(idx) };
}
export const toE164 = p => { const d = String(p || '').replace(/[^\d+]/g, ''); if (!d) return ''; if (d.startsWith('+')) return d; if (d.startsWith('0') && d.length === 11) return `+91${d.slice(1)}`; if (d.length === 12 && d.startsWith('91')) return `+${d}`; return d.length === 10 ? `+91${d}` : `+${d}`; };
export const dialable = p => /^\+91[6-9]\d{9}$/.test(p);
function yearsOf(v) {
  const s = String(v || '').toLowerCase(); if (!s) return null;
  const y = s.match(/(\d+(?:\.\d+)?)\s*(?:y|yr)/), m = s.match(/(\d+)\s*(?:m|mo)/);
  if (y) return Math.round((Number(y[1]) + (m ? Number(m[1]) / 12 : 0)) * 10) / 10;
  const n = Number(s.replace(/[^\d.]/g, '')); return Number.isFinite(n) && s.replace(/[^\d.]/g, '') !== '' ? n : null;
}
export function leadToCandidate(l) {
  const resume = l.resume || [
    `${l.name}.`, l.title && l.company ? `Currently ${l.title} at ${l.company}.` : l.title ? `Current role: ${l.title}.` : l.company ? `Currently at ${l.company}.` : '',
    l.years ? `Total experience: ${l.years}.` : '', l.skills ? `Key skills: ${l.skills}.` : '', l.edu ? `Education: ${l.edu}.` : '',
  ].filter(Boolean).join(' ');
  return {
    name: l.name, email: l.email, phone: toE164(l.phone), city: l.city, years: yearsOf(l.years),
    notice_days: l.notice ? parseAnswer({ type: 'days' }, l.notice) : null,
    expected_salary: l.salary ? parseAnswer({ type: 'salary' }, l.salary) : null,
    skills: l.skills, resume_text: resume.slice(0, 20000),
  };
}
const callQueue = { items: [], running: false, log: [], total: 0 };
// Safety lock: the queue only dials numbers on IMPORT_CALL_ALLOWLIST (comma separated, E.164) unless IMPORT_CALL_ANY=1 (production, with consent).
const allowFile = new URL('./call-allowlist.txt', import.meta.url);
export const callAllowed = p => {
  if (process.env.IMPORT_CALL_ANY === '1') return true;
  let fileList = ''; try { fileList = readFileSync(allowFile, 'utf8'); } catch {}
  return `${process.env.IMPORT_CALL_ALLOWLIST || ''}\n${fileList}`.split(/[\s,]+/).filter(Boolean).includes(p);
};
const inHours = () => { const h = new Date(Date.now() + IST).getUTCHours(); return h >= 9 && h < 19; };
async function pumpCalls() {
  if (callQueue.running) return; callQueue.running = true;
  while (callQueue.items.length) {
    const it = callQueue.items.shift();
    try {
      const r = await fetch(`http://127.0.0.1:${process.env.PORT || 4870}/api/candidates/${it.id}/screenings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'phone' }) });
      const t = await r.text(); callQueue.log.unshift({ id: it.id, name: it.name, at: new Date().toISOString(), ok: r.ok, note: r.ok ? 'call started' : t.slice(0, 140) });
    } catch (e) { callQueue.log.unshift({ id: it.id, name: it.name, at: new Date().toISOString(), ok: false, note: String(e.message).slice(0, 140) }); }
    callQueue.log.length = Math.min(callQueue.log.length, 60);
    if (callQueue.items.length) await new Promise(r => setTimeout(r, it.gap * 1000));
  }
  callQueue.running = false;
}


// ------------------------------------------------------------ rejection call: reason and strength in plain, kind words
const REJ_REASON = {
  Experience: 'your years of experience are below what this role needs right now',
  'Salary fit': 'the salary you are looking for is above the budget for this role',
  'Notice period': 'the notice period is longer than the team can wait for this role',
  Location: 'this role needs someone based at or near the work location',
  'Must-have skills': 'some of the must-have skills for this role did not come through clearly',
  'Answer quality': 'we could not get enough detail about your recent work on the call',
};
const REJ_STRENGTH = {
  Experience: 'your hands-on experience', 'Salary fit': 'your realistic expectations', 'Notice period': 'how quickly you could join',
  Location: 'that you are based close to the work', 'Must-have skills': 'the skills on your resume', 'Answer quality': 'how clearly you explained your work',
};
export function rejectionFacts(breakdownJson) {
  let b = []; try { b = JSON.parse(breakdownJson || '[]'); } catch {}
  if (!b.length) return { reason_short: 'we are moving ahead with candidates whose experience is a closer match for this role', strength_short: 'your time and interest in the role' };
  const ratio = x => (x.max ? x.points / x.max : 1);
  const worst = [...b].sort((x, y) => ratio(x) - ratio(y))[0], best = [...b].sort((x, y) => ratio(y) - ratio(x))[0];
  return { reason_short: REJ_REASON[worst.label] || 'we are moving ahead with candidates whose experience is a closer match for this role', strength_short: ratio(best) >= 0.6 ? (REJ_STRENGTH[best.label] || 'your time and interest in the role') : 'your time and interest in the role' };
}


// ------------------------------------------------------------ rejection email (personal, human-triggered, locked until you allow it)
const mailAllowFile = new URL('./mail-allowlist.txt', import.meta.url);
const mailAllowed = to => {
  if (process.env.MAIL_SEND_ANY === '1') return true;
  let f = ''; try { f = readFileSync(mailAllowFile, 'utf8'); } catch {}
  const list = `${process.env.MAIL_ALLOWLIST || ''}\n${f}`.split(/[\s,]+/).filter(Boolean).map(x => x.toLowerCase());
  const t = String(to || '').toLowerCase();
  return list.includes(t) || list.includes('@' + t.split('@')[1]);
};
const escHtml = x => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function composeRejectionEmail({ name, role, company, facts, agent, screenedOn, sender }) {
  const f = first(name);
  const text = [
    `Hi ${f},`,
    `Thank you for applying for the ${role} role at ${company}${screenedOn ? `, and for taking the time to speak with ${agent || 'our team'} on ${screenedOn}` : ''}. I wanted to write to you personally rather than leave you wondering.`,
    `After reviewing your application, we have decided not to move forward with it for this role. The main reason is that ${facts.reason_short}. This is about fit for this particular role, not a judgement of you as a person.`,
    `What stood out to us was ${facts.strength_short}.`,
    `We would like to keep your details on file and get in touch if a role comes up that matches your background. If you would rather we did not, just reply "please remove my details" and we will delete them.`,
    `If you would like written feedback, reply to this email and a member of the team will respond.`,
    `Thank you again for your time and effort. We wish you the very best.`,
    `Warm regards,\n${sender}\n${company}`,
  ].join('\n\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#111">${text.split('\n\n').map(p => `<p style="margin:0 0 14px">${escHtml(p).replace(/\n/g, '<br>')}</p>`).join('')}</div>`;
  return { subject: `Your application for ${role} at ${company}`, text, html };
}


// ------------------------------------------------------------ AI voices a recruiter can pick per role (Gemini Live voices)
export const VOICES = [
  { id: 'Zephyr', gender: 'female', style: 'bright and energetic' }, { id: 'Kore', gender: 'female', style: 'firm and confident' },
  { id: 'Leda', gender: 'female', style: 'youthful and friendly' }, { id: 'Aoede', gender: 'female', style: 'breezy and relaxed' },
  { id: 'Sulafat', gender: 'female', style: 'warm and reassuring' }, { id: 'Laomedeia', gender: 'female', style: 'upbeat and lively' },
  { id: 'Puck', gender: 'male', style: 'upbeat and quick' }, { id: 'Charon', gender: 'male', style: 'calm and informative' },
  { id: 'Fenrir', gender: 'male', style: 'excitable and bold' }, { id: 'Orus', gender: 'male', style: 'firm and steady' },
  { id: 'Achird', gender: 'male', style: 'friendly and approachable' }, { id: 'Algieba', gender: 'male', style: 'smooth and polished' },
];
const VOICE_IDS = new Set(VOICES.map(v => v.id));

export function migrate(db) {
  const cols = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  const add = (t, c, def) => { if (!cols(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
  add('jobs', 'status', "TEXT DEFAULT 'open'"); add('jobs', 'headcount', 'INTEGER DEFAULT 1'); add('jobs', 'custom_questions', 'TEXT');
  add('jobs', 'voice', 'TEXT'); add('jobs', 'agent_name', 'TEXT'); add('jobs', 'agent_uuid', 'TEXT'); add('jobs', 'agent_wid', 'INTEGER'); add('jobs', 'rej_agent_uuid', 'TEXT'); add('jobs', 'rej_wid', 'INTEGER'); add('jobs', 'agent_sync', 'TEXT');
  add('jobs', 'negotiable', 'INTEGER DEFAULT 0'); add('jobs', 'stretch_pct', 'INTEGER DEFAULT 10'); add('jobs', 'negotiation_notes', 'TEXT');
  add('candidates', 'source', "TEXT DEFAULT 'careers'"); add('candidates', 'resume_text', 'TEXT'); add('candidates', 'resume_summary', 'TEXT');
  add('candidates', 'ai_analysis', 'TEXT'); add('candidates', 'consent_at', 'TEXT'); add('candidates', 'spot_check', 'INTEGER DEFAULT 0'); add('candidates', 'hired_at', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, kind TEXT, candidate_id TEXT, payload TEXT, run_at TEXT, status TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0, result TEXT, created_at TEXT DEFAULT (datetime('now')), done_at TEXT);
    CREATE TABLE IF NOT EXISTS interviews (id TEXT PRIMARY KEY, candidate_id TEXT, recruiter_id TEXT, starts_at TEXT, duration_min INTEGER, meet_link TEXT, status TEXT DEFAULT 'scheduled', booked_by TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS scorecards (id TEXT PRIMARY KEY, interview_id TEXT, candidate_id TEXT, recruiter_id TEXT, ratings TEXT, recommendation TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS refs (id TEXT PRIMARY KEY, candidate_id TEXT, name TEXT, phone TEXT, relation TEXT, company TEXT, status TEXT DEFAULT 'pending', run_id TEXT, answers TEXT, transcript TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS offers (id TEXT PRIMARY KEY, candidate_id TEXT, salary REAL, joining_date TEXT, status TEXT DEFAULT 'draft', letter TEXT, warning TEXT, provider TEXT, created_at TEXT DEFAULT (datetime('now')), decided_at TEXT);
    CREATE TABLE IF NOT EXISTS onboarding (id TEXT PRIMARY KEY, candidate_id TEXT, title TEXT, kind TEXT, status TEXT DEFAULT 'pending', due TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, candidate_id TEXT, channel TEXT, kind TEXT, body TEXT, status TEXT DEFAULT 'draft', provider TEXT, created_at TEXT DEFAULT (datetime('now')));
  `);
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
  for (const [k, v] of Object.entries(DEFAULTS)) ins.run(k, v);
}

const BIAS_GUARD = 'Judge only job-related evidence. Never use or infer age, gender, religion, caste, marital status, family plans, health, disability, nationality, accent or name. If such details appear, ignore them.';
const MSG_SYSTEM = `You write short candidate messages for a recruiter in India (WhatsApp or email). Plain, warm, professional, max 80 words. No em dashes, no emojis. Keep the tokens {NAME}, {ROLE}, {COMPANY}, {LINK}, {TIME}, {MEET}, {DOCS}, {DATE} exactly as written, and do not invent facts, times, links or salary. Never mention age, gender, religion, caste, health or family. Never promise a job. ${BIAS_GUARD}`;

const TEMPLATES = {
  shortlist: 'Hi {NAME}, thanks for taking the screening call for the {ROLE} role at {COMPANY}. You are shortlisted for the next step, a 30-minute interview. Please pick a slot here: {LINK}',
  reject: 'Hi {NAME}, thank you for your time and for applying for {ROLE} at {COMPANY}. We are moving ahead with candidates whose experience matches this role more closely. We will keep your details for future openings. Wishing you the best.',
  interview_confirm: 'Hi {NAME}, your interview for {ROLE} at {COMPANY} is confirmed for {TIME}. Join here: {MEET}. Reply here if you need to reschedule.',
  reminder: 'Hi {NAME}, a reminder that your {ROLE} interview at {COMPANY} is on {TIME}. Join here: {MEET}.',
  no_show: 'Hi {NAME}, we missed you at your {ROLE} interview. Happy to find another time. Pick a new slot here: {LINK}',
  offer: 'Hi {NAME}, we are pleased to share your offer for {ROLE} at {COMPANY}. The details have been sent to you. Please review and reply with any questions.',
  docs: 'Hi {NAME}, to complete your joining formalities for {ROLE}, please send these documents: {DOCS}. Reply here with photos or PDFs.',
  followup: 'Hi {NAME}, checking in on your application for {ROLE} at {COMPANY}. Let us know if you are still interested and we will take it forward.',
  joining: 'Hi {NAME}, looking forward to welcoming you on {DATE} for {ROLE} at {COMPANY}. Please confirm you are all set to join.',
};

export function createSuite(ctx) {
  const { db, send, body, J, jobRow, candidateFull, logEvent, addActivity, rescore, latestAnswers, scoreCandidate, screeningContext, llm, dograhCall, dograh, settings, dograhApi, createAgents, dograhCaps } = ctx;

  // ------------------------------------------------------------ helpers
  const getS = k => (k === 'spot_check_rate' && process.env.SPOT_CHECK_RATE !== undefined) ? process.env.SPOT_CHECK_RATE : db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
  const setS = (k, v) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
  const on = k => getS(k) === '1';
  const cand = id => db.prepare('SELECT * FROM candidates WHERE id=?').get(id);
  const publicBase = () => (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4870}`).replace(/\/+$/, '');
  const fill = (text, v) => String(text).replace(/\{([A-Z]+)\}/g, (all, k) => (v[k] !== undefined ? v[k] : all));
  const recruiterOk = rid => rid && db.prepare('SELECT id FROM recruiters WHERE id=?').get(rid);

  function enqueue(kind, candidateId, payload = {}, runAt = Date.now()) {
    const id = randomUUID();
    db.prepare('INSERT INTO tasks (id,kind,candidate_id,payload,run_at) VALUES (?,?,?,?,?)').run(id, kind, candidateId, JSON.stringify(payload), sqlTime(runAt));
    return id;
  }

  // ------------------------------------------------------------ auth (optional: set ADMIN_PASSWORD)
  const sessionToken = () => {
    const pw = process.env.ADMIN_PASSWORD;
    return pw ? createHmac('sha256', process.env.SESSION_SECRET || pw).update('rs-session-v1').digest('hex') : null;
  };
  const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(a => a[0]).map(([k, ...v]) => [k, v.join('=')]));
  const safeEq = (a, b) => { const x = createHash('sha256').update(String(a)).digest(), y = createHash('sha256').update(String(b)).digest(); return timingSafeEqual(x, y); };
  const authed = req => { const t = sessionToken(); if (!t) return true; const c = cookies(req).rs_auth; return Boolean(c) && safeEq(c, t); };
  function isPublic(m, p) {
    if (['/api/health', '/api/config', '/api/login', '/api/logout', '/api/me', '/api/webhooks/dograh'].includes(p)) return true;
    if (m === 'GET' && p === '/api/jobs') return true;
    if (m === 'POST' && p === '/api/applications') return true;
    if (m === 'POST' && /^\/api\/candidates\/[\w-]+\/screenings$/.test(p)) return true;
    if (m === 'POST' && /^\/api\/screenings\/[\w-]+\/complete$/.test(p)) return true;
    if (m === 'POST' && p === '/api/resume/pdf') return true; // applicants upload their resume on the careers form (5 MB cap, PDF check, rate limited)
    return p.startsWith('/api/public/');
  }
  const hits = new Map();
  const limited = req => {
    const ip = req.socket.remoteAddress || 'x', now = Date.now();
    const a = (hits.get(ip) || []).filter(t => now - t < 60000); a.push(now); hits.set(ip, a);
    return a.length > 30;
  };

  // ------------------------------------------------------------ messages
  async function draftMessage(cid, kind, extra = {}) {
    const c = cand(cid); if (!c) throw new Error('candidate not found');
    if (!TEMPLATES[kind]) throw new Error(`unknown message kind ${kind}`);
    const job = jobRow(c.job_id);
    const vars = { NAME: first(c.name), ROLE: job.title, COMPANY: job.company, LINK: `${publicBase()}/book.html?c=${c.id}`, TIME: extra.time ? fmtIST(extra.time) : '', MEET: extra.meet || '', DOCS: extra.docs || '', DATE: extra.date || '' };
    const base = TEMPLATES[kind];
    let text = base, provider = 'template';
    const r = await llm.ask({ task: 'message', system: MSG_SYSTEM, maxTokens: 220, prompt: `Message type: ${kind.replace('_', ' ')}. Improve this draft for tone and clarity. Keep every token and every fact.\n\nDRAFT:\n${base}` });
    if (r.ok && r.text.length > 20 && r.text.length < 900) {
      const wanted = [...base.matchAll(/\{[A-Z]+\}/g)].map(x => x[0]);
      if (wanted.every(t => r.text.includes(t))) { text = noDash(r.text.replace(/^["']|["']$/g, '')); provider = r.provider; }
    }
    const id = randomUUID();
    db.prepare('INSERT INTO messages (id,candidate_id,channel,kind,body,provider) VALUES (?,?,?,?,?,?)').run(id, cid, extra.channel || 'whatsapp', kind, fill(text, vars), provider);
    logEvent(cid, 'message', `Drafted ${kind.replace('_', ' ')} message (${provider})`);
    return db.prepare('SELECT * FROM messages WHERE id=?').get(id);
  }

  // ------------------------------------------------------------ jobs
  async function generateJob({ title, company, location, notes }) {
    const fallback = {
      description: `${company || 'Our company'} is hiring a ${title}${location ? ` in ${location}` : ''}. ${notes || ''}`.trim(),
      must_skills: arr(notes).slice(0, 5).map(s => s.toLowerCase()), min_years: 2, max_salary: null,
      questions: [`What is the most relevant work you have done for a ${title} role, and what was the result?`, 'What is your notice period and expected monthly salary?', 'Can you work from the job location?'],
    };
    const r = await llm.askJSON({
      task: 'job', cache: true, maxTokens: 500,
      system: `You are a recruiting assistant writing for the Indian job market. Never include age, gender, religion, caste or marital status requirements. ${BIAS_GUARD}`,
      prompt: `Role title: ${title}\nCompany: ${company || 'the company'}\nLocation: ${location || 'not given'}\nNotes from the hiring manager: ${notes || 'none'}\n\nReturn JSON: {"description":"2 to 3 plain sentences","must_skills":["3 to 5 lowercase skills"],"min_years":number,"max_salary_monthly_inr":number or null,"screening_questions":["3 role specific questions answerable on a phone call"]}`,
    });
    if (r.ok && r.json && r.json.description) {
      const j = r.json;
      return { description: noDash(String(j.description)), must_skills: arr(j.must_skills).map(s => s.toLowerCase()).slice(0, 6), min_years: Number.isFinite(Number(j.min_years)) ? Number(j.min_years) : 2, max_salary: Number.isFinite(Number(j.max_salary_monthly_inr)) ? Number(j.max_salary_monthly_inr) : null, questions: arr(j.screening_questions).slice(0, 4).map(noDash), provider: r.provider };
    }
    return { ...fallback, provider: 'rules', note: r.error };
  }

  function jobFields(b, existing = {}) {
    const out = { ...existing };
    if (b.title !== undefined) out.title = String(b.title).trim();
    if (b.company !== undefined) out.company = String(b.company).trim() || process.env.BRAND_NAME || 'Your Company';
    if (b.location !== undefined) out.location = String(b.location).trim();
    for (const k of ['min_years', 'max_salary', 'max_notice_days', 'headcount']) if (b[k] !== undefined && num(b[k]) !== null) out[k] = num(b[k]);
    if (b.locations !== undefined) out.locations = arr(b.locations).map(s => s.toLowerCase());
    if (b.must_skills !== undefined) out.must_skills = arr(b.must_skills).map(s => s.toLowerCase());
    if (b.description !== undefined) out.description = String(b.description).trim();
    if (b.custom_questions !== undefined) out.custom_questions = arr(b.custom_questions);
    if (b.status !== undefined) out.status = b.status;
    if (b.voice !== undefined) out.voice = VOICE_IDS.has(String(b.voice).trim()) ? String(b.voice).trim() : '';
    if (b.agent_name !== undefined) out.agent_name = String(b.agent_name).replace(/[^\p{L} .'-]/gu, '').trim().slice(0, 30);
    if (b.negotiable !== undefined) out.negotiable = (b.negotiable === true || b.negotiable === 1 || b.negotiable === '1' || b.negotiable === 'true') ? 1 : 0;
    if (b.stretch_pct !== undefined && num(b.stretch_pct) !== null) out.stretch_pct = Math.max(0, Math.min(50, Math.round(num(b.stretch_pct))));
    if (b.negotiation_notes !== undefined) out.negotiation_notes = String(b.negotiation_notes).trim().slice(0, 800);
    return out;
  }
  function jobErrors(j) {
    const e = [];
    if (!j.title) e.push('title is required');
    for (const k of ['min_years', 'max_salary', 'max_notice_days', 'headcount']) if (Number.isNaN(j[k])) e.push(`${k} must be a number`);
    if (j.status && !['open', 'closed'].includes(j.status)) e.push('status must be open or closed');
    return e;
  }

  // ------------------------------------------------------------ resume + analysis
  const SKILLS = ['crm', 'cold calling', 'excel', 'sql', 'python', 'java', 'javascript', 'react', 'node', 'sales', 'support', 'zendesk', 'salesforce', 'hubspot', 'sla', 'team lead', 'english', 'hindi', 'marketing', 'seo', 'accounting', 'tally', 'customer service', 'communication'];
  async function parseResume(cid) {
    const c = cand(cid); if (!c || !c.resume_text) return 'skipped: no resume';
    const job = jobRow(c.job_id);
    const text = c.resume_text.slice(0, 6000);
    const yrs = [...text.matchAll(/(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years|yrs)/gi)].map(m => Number(m[1]));
    const low = text.toLowerCase();
    const fallback = { years_experience: yrs.length ? Math.max(...yrs) : null, skills: [...new Set([...SKILLS, ...job.must_skills].filter(s => low.includes(s)))], current_company: '', education: '', summary: text.slice(0, 160).replace(/\s+/g, ' ') };
    const r = await llm.askJSON({
      task: 'resume', cache: true, maxTokens: 350,
      system: `You extract facts from resumes. ${BIAS_GUARD}`,
      prompt: `Extract from this resume text. Return JSON {"years_experience":number or null,"skills":["lowercase skills"],"current_company":"","education":"","summary":"max 40 words, job-related only"}\n\nRESUME:\n${text}`,
    });
    const out = r.ok && r.json ? { years_experience: Number.isFinite(Number(r.json.years_experience)) ? Number(r.json.years_experience) : fallback.years_experience, skills: arr(r.json.skills).map(s => s.toLowerCase()).slice(0, 25), current_company: String(r.json.current_company || ''), education: String(r.json.education || ''), summary: noDash(String(r.json.summary || fallback.summary)), provider: r.provider } : { ...fallback, provider: 'rules' };
    db.prepare('UPDATE candidates SET resume_summary=? WHERE id=?').run(JSON.stringify(out), cid);
    if (c.years == null && out.years_experience != null) db.prepare('UPDATE candidates SET years=? WHERE id=?').run(out.years_experience, cid);
    if (!String(c.skills || '').trim() && out.skills.length) db.prepare('UPDATE candidates SET skills=? WHERE id=?').run(out.skills.join(', '), cid);
    rescore(cid);
    logEvent(cid, 'resume', `Resume parsed (${out.provider})`);
    return `parsed via ${out.provider}`;
  }

  async function analyze(cid) {
    const full = candidateFull(cid); if (!full) throw new Error('candidate not found');
    const scr = full.screenings.find(s => s.status === 'completed');
    const ev = full.evaluation;
    const transcript = (scr?.transcript || []).map(m => `${m.role}: ${m.text}`).join('\n').slice(0, 3500);
    const verdict = full.score?.verdict || 'Pending screen';
    const fallback = {
      summary: `${verdict}, ${ev.hire_score}/100. ${ev.pros.slice(0, 2).join('; ') || 'No clear strengths yet'}. ${ev.cons.length ? `Concerns: ${ev.cons.slice(0, 2).join('; ')}.` : ''}`.trim(),
      strengths: ev.pros.slice(0, 4), concerns: ev.cons.slice(0, 4), red_flags: (full.score?.flags || []).filter(f => f.level === 'red').map(f => f.text),
      next_step: verdict === 'Strong' ? 'advance' : verdict === 'Maybe' ? 'hold' : verdict === 'Reject' ? 'reject' : 'hold', confidence: 0.5, follow_up_questions: [],
    };
    const r = await llm.askJSON({
      task: 'analyze', cache: true, maxTokens: 550,
      system: `You are a screening analyst for a recruiter. You only suggest, a human decides. ${BIAS_GUARD}`,
      prompt: `Role: ${full.job.title}. Requirements: ${full.job.min_years}+ years, skills ${full.job.must_skills.join(', ')}, budget Rs ${full.job.max_salary}/month, notice up to ${full.job.max_notice_days} days.\nRule based score: ${ev.hire_score}/100, verdict ${verdict}. Pros: ${ev.pros.join('; ') || 'none'}. Cons: ${ev.cons.join('; ') || 'none'}.\nResume summary: ${full.resume_summary || 'none'}\nScreening transcript:\n${transcript || '(no transcript)'}\n\nReturn JSON {"summary":"max 60 words","strengths":["max 4"],"concerns":["max 4"],"red_flags":["only real ones"],"next_step":"advance"|"hold"|"reject","confidence":0 to 1,"follow_up_questions":["max 3 to ask in the interview"]}`,
    });
    let out;
    if (r.ok && r.json && r.json.summary) {
      const j = r.json;
      out = { summary: noDash(String(j.summary)), strengths: arr(j.strengths).map(noDash).slice(0, 4), concerns: arr(j.concerns).map(noDash).slice(0, 4), red_flags: arr(j.red_flags).map(noDash).slice(0, 4), next_step: ['advance', 'hold', 'reject'].includes(j.next_step) ? j.next_step : fallback.next_step, confidence: Math.min(1, Math.max(0, Number(j.confidence) || 0.5)), follow_up_questions: arr(j.follow_up_questions).map(noDash).slice(0, 3), provider: r.provider };
    } else out = { ...fallback, provider: 'rules' };
    out.at = new Date().toISOString();
    db.prepare('UPDATE candidates SET ai_analysis=? WHERE id=?').run(JSON.stringify(out), cid);
    logEvent(cid, 'analysis', `AI analysis: suggests ${out.next_step} (${out.provider})`);
    return out;
  }

  async function interviewKit(cid) {
    const full = candidateFull(cid); if (!full) throw new Error('candidate not found');
    const gaps = full.evaluation.cons.concat(full.evaluation.outliers.filter(o => !o.good).map(o => o.text));
    const fallback = { questions: [...gaps.slice(0, 3).map(g => ({ q: `Tell me about this: ${g}`, why: 'Gap found in the screen' })), ...full.job.must_skills.slice(0, 3).map(s => ({ q: `Describe a real situation where you used ${s}. What was the result?`, why: 'Must-have skill' }))].slice(0, 6) };
    const r = await llm.askJSON({
      task: 'kit', cache: true, maxTokens: 500,
      system: `You prepare structured interview questions. ${BIAS_GUARD}`,
      prompt: `Role: ${full.job.title}. Must-have skills: ${full.job.must_skills.join(', ')}. Gaps from the phone screen: ${gaps.join('; ') || 'none'}. Strengths: ${full.evaluation.pros.join('; ') || 'none'}.\nReturn JSON {"questions":[{"q":"","why":""}]} with 6 behavioural or role questions that probe the gaps and confirm the strengths.`,
    });
    if (r.ok && Array.isArray(r.json?.questions) && r.json.questions.length) return { questions: r.json.questions.slice(0, 8).map(x => ({ q: noDash(String(x.q || '')), why: noDash(String(x.why || '')) })).filter(x => x.q), provider: r.provider };
    return { ...fallback, provider: 'rules' };
  }

  // ------------------------------------------------------------ interviews
  function freeSlots(days = 7) {
    const start = Number(getS('workday_start')) || 10, end = Number(getS('workday_end')) || 18, mins = Number(getS('slot_minutes')) || 30;
    const nRec = Math.max(db.prepare('SELECT COUNT(*) n FROM recruiters').get().n, 1);
    const booked = db.prepare("SELECT starts_at FROM interviews WHERE status='scheduled'").all();
    const now = Date.now(), ist = new Date(now + IST), out = [];
    for (let d = 0; d < days; d++) {
      const day = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + d);
      const dow = new Date(day).getUTCDay(); if (dow === 0 || dow === 6) continue;
      for (let mm = start * 60; mm + mins <= end * 60; mm += mins) {
        const t = day + mm * 60000 - IST;
        if (t < now + 2 * 3600000) continue;
        const iso = new Date(t).toISOString();
        if (booked.filter(b => b.starts_at === iso).length < nRec) out.push(iso);
      }
    }
    return out;
  }
  function pickRecruiter(iso, pref) {
    const busy = new Set(db.prepare("SELECT recruiter_id FROM interviews WHERE status='scheduled' AND starts_at=?").all(iso).map(r => r.recruiter_id));
    const free = db.prepare('SELECT id FROM recruiters').all().filter(r => !busy.has(r.id));
    if (!free.length) return null;
    if (pref && free.some(r => r.id === pref)) return pref;
    const load = id => db.prepare("SELECT COUNT(*) n FROM interviews WHERE recruiter_id=? AND status='scheduled'").get(id).n;
    return free.sort((a, b) => load(a.id) - load(b.id))[0].id;
  }
  async function bookInterview(cid, iso, { recruiterId = null, by = 'recruiter' } = {}) {
    const c = cand(cid); if (!c) throw new Error('candidate not found');
    if (!freeSlots().includes(new Date(iso).toISOString())) throw new Error('that slot is no longer available');
    const rid = pickRecruiter(new Date(iso).toISOString(), recruiterId);
    if (!rid) throw new Error('no recruiter is free at that time');
    db.prepare("UPDATE interviews SET status='cancelled' WHERE candidate_id=? AND status='scheduled'").run(cid);
    const id = randomUUID(), start = new Date(iso).toISOString();
    const meet = `https://meet.jit.si/rs-${id.slice(0, 12)}`;
    db.prepare('INSERT INTO interviews (id,candidate_id,recruiter_id,starts_at,duration_min,meet_link,booked_by) VALUES (?,?,?,?,?,?,?)').run(id, cid, rid, start, Number(getS('slot_minutes')) || 30, meet, by);
    db.prepare("UPDATE candidates SET stage='interview' WHERE id=?").run(cid);
    const rname = db.prepare('SELECT name FROM recruiters WHERE id=?').get(rid).name;
    logEvent(cid, 'interview', `Interview booked for ${fmtIST(start)} with ${rname} (${by})`);
    addActivity(cid, rid, 'note', `Interview scheduled for ${fmtIST(start)}`);
    const hrs = Number(getS('reminder_hours')) || 24;
    for (const [before, label] of [[hrs * 3600000, `in ${hrs} hours`], [2 * 3600000, 'in 2 hours']]) {
      const at = new Date(start).getTime() - before;
      if (at > Date.now()) enqueue('interview_reminder', cid, { interview_id: id, label }, at);
    }
    await draftMessage(cid, 'interview_confirm', { time: start, meet });
    return db.prepare('SELECT * FROM interviews WHERE id=?').get(id);
  }

  function hireSignal(cid) {
    const parts = [];
    const screened = db.prepare("SELECT 1 x FROM screenings WHERE candidate_id=? AND status='completed'").get(cid);
    const screen = db.prepare('SELECT total FROM scores WHERE candidate_id=?').get(cid)?.total;
    if (screened && screen != null) parts.push({ label: 'AI screen', value: screen, weight: 0.4 });
    const cards = db.prepare('SELECT * FROM scorecards WHERE candidate_id=?').all(cid).map(s => ({ ...s, ratings: J(s.ratings, {}) }));
    if (cards.length) {
      const means = cards.map(s => { const v = Object.values(s.ratings).map(Number).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }).filter(x => x != null);
      if (means.length) parts.push({ label: 'Interviews', value: (means.reduce((a, b) => a + b, 0) / means.length) * 20, weight: 0.4 });
    }
    const refs = db.prepare("SELECT answers FROM refs WHERE candidate_id=? AND status='completed'").all(cid).map(r => Number(J(r.answers, {}).rating)).filter(Number.isFinite);
    if (refs.length) parts.push({ label: 'References', value: (refs.reduce((a, b) => a + b, 0) / refs.length) * 20, weight: 0.2 });
    if (!parts.length) return { signal: null, band: 'No data yet', parts, veto: false };
    const w = parts.reduce((s, p) => s + p.weight, 0);
    const signal = Math.round(parts.reduce((s, p) => s + p.value * p.weight, 0) / w);
    const veto = cards.some(s => s.recommendation === 'strong_no');
    return { signal, band: veto ? 'Interviewer veto' : signal >= 80 ? 'Strong hire signal' : signal >= 65 ? 'Lean hire' : signal >= 50 ? 'Borderline' : 'Lean no', parts: parts.map(p => ({ ...p, value: Math.round(p.value) })), veto };
  }

  // ------------------------------------------------------------ offers + onboarding
  async function createOffer(cid, salary, joining) {
    const c = cand(cid), job = jobRow(c.job_id);
    const warning = salary > job.max_salary ? `Above the role budget of Rs ${job.max_salary.toLocaleString('en-IN')} (over by ${Math.round((salary / job.max_salary - 1) * 100)}%). Needs approval.` : null;
    const fallback = `Dear {NAME},\n\nWe are pleased to offer you the position of ${job.title} at ${job.company}, based in ${job.location}.\n\nMonthly gross salary: Rs ${salary.toLocaleString('en-IN')}.\nProposed joining date: ${joining}.\n\nThis offer is subject to document verification and satisfactory reference checks. Please reply to confirm your acceptance.\n\nRegards,\nHR Team, ${job.company}\n\nThis is a draft for recruiter review.`;
    let letter = fallback, provider = 'template';
    const r = await llm.ask({ task: 'offer', maxTokens: 450, system: 'You draft offer letters for an Indian company. Plain text only. Do not invent benefits, clauses, dates or amounts beyond the facts given. Keep the token {NAME}. No em dashes.', prompt: `Facts: role ${job.title}; company ${job.company}; location ${job.location}; monthly gross salary Rs ${salary}; joining date ${joining}.\nWrite a short offer letter (max 180 words): greeting with {NAME}, role and location, monthly gross salary, joining date, a line that it is subject to document verification and reference checks, how to accept, sign-off from HR Team. End with the line: This is a draft for recruiter review.` });
    if (r.ok && r.text.includes('{NAME}') && r.text.includes(String(salary.toLocaleString('en-IN'))) ) { letter = noDash(r.text); provider = r.provider; }
    const id = randomUUID();
    db.prepare('INSERT INTO offers (id,candidate_id,salary,joining_date,letter,warning,provider) VALUES (?,?,?,?,?,?,?)').run(id, cid, salary, joining, fill(letter, { NAME: first(c.name) }), warning, provider);
    logEvent(cid, 'offer', `Offer drafted: Rs ${salary.toLocaleString('en-IN')}/mo, joining ${joining}${warning ? ' (over budget)' : ''}`);
    return db.prepare('SELECT * FROM offers WHERE id=?').get(id);
  }
  function seedOnboarding(cid, joining) {
    if (db.prepare('SELECT 1 x FROM onboarding WHERE candidate_id=?').get(cid)) return;
    const j = new Date(`${joining}T00:00:00Z`).getTime();
    const ins = db.prepare('INSERT INTO onboarding (id,candidate_id,title,kind,due) VALUES (?,?,?,?,?)');
    for (const [title, kind, off] of ONBOARDING) ins.run(randomUUID(), cid, title, kind, new Date(j + off * DAY).toISOString().slice(0, 10));
    const remind = j - DAY + 10 * 3600000 - IST;
    if (remind > Date.now()) enqueue('joining_reminder', cid, { date: joining }, remind);
    enqueue('doc_chase', cid, {}, Date.now() + 60000);
  }
  const OFFER_FLOW = { draft: ['sent'], sent: ['accepted', 'declined', 'negotiating'], negotiating: ['sent', 'accepted', 'declined'], accepted: [], declined: [] };

  // ------------------------------------------------------------ talent pool
  function matches(jobId) {
    const job = jobRow(jobId); if (!job) return null;
    const applied = new Set(db.prepare('SELECT LOWER(email) e FROM candidates WHERE job_id=?').all(jobId).map(r => r.e));
    const out = [];
    for (const c of db.prepare("SELECT c.*, j.title job_title FROM candidates c JOIN jobs j ON j.id=c.job_id WHERE c.job_id<>? AND c.stage<>'hired'").all(jobId)) {
      if (applied.has(String(c.email).toLowerCase())) continue;
      const r = scoreCandidate(c, job, latestAnswers(c.id));
      if (r.knockout || r.total < 50) continue;
      out.push({ id: c.id, name: c.name, city: c.city, from_job: c.job_title, total: r.total, verdict: r.verdict, consent: !!c.consent_at });
    }
    return out.sort((a, b) => b.total - a.total).slice(0, 10);
  }

  // ------------------------------------------------------------ analytics
  function analytics() {
    const cands = db.prepare('SELECT c.*, j.title job_title FROM candidates c JOIN jobs j ON j.id=c.job_id').all();
    const screened = new Map(db.prepare("SELECT candidate_id, MIN(ended_at) at FROM screenings WHERE status='completed' GROUP BY candidate_id").all().map(r => [r.candidate_id, r.at]));
    const interviewed = new Set(db.prepare('SELECT DISTINCT candidate_id FROM interviews').all().map(r => r.candidate_id));
    const offered = new Set(db.prepare('SELECT DISTINCT candidate_id FROM offers').all().map(r => r.candidate_id));
    const funnel = [
      ['Applied', cands.length], ['AI screened', cands.filter(c => screened.has(c.id)).length],
      ['Shortlisted+', cands.filter(c => ['shortlisted', 'interview', 'hired'].includes(c.stage) || interviewed.has(c.id)).length],
      ['Interviewed', cands.filter(c => interviewed.has(c.id)).length], ['Offered', cands.filter(c => offered.has(c.id)).length], ['Hired', cands.filter(c => c.stage === 'hired').length],
    ].map(([label, n]) => ({ label, n }));
    const perJob = db.prepare('SELECT id, title FROM jobs').all().map(j => {
      const cs = cands.filter(c => c.job_id === j.id);
      return { job: j.title, applied: cs.length, screened: cs.filter(c => screened.has(c.id)).length, shortlisted: cs.filter(c => ['shortlisted', 'interview', 'hired'].includes(c.stage)).length, hired: cs.filter(c => c.stage === 'hired').length };
    });
    const sources = {}; for (const c of cands) sources[c.source || 'careers'] = (sources[c.source || 'careers'] || 0) + 1;
    const tts = median(cands.filter(c => screened.has(c.id)).map(c => (parseSql(screened.get(c.id)) - parseSql(c.created_at)) / 60000));
    const tth = median(cands.filter(c => c.hired_at).map(c => (parseSql(c.hired_at) - parseSql(c.created_at)) / DAY));
    const iv = db.prepare('SELECT status, COUNT(*) n FROM interviews GROUP BY status').all(); const ivn = s => iv.find(r => r.status === s)?.n || 0;
    const of = db.prepare('SELECT status, COUNT(*) n FROM offers GROUP BY status').all(); const ofn = s => of.find(r => r.status === s)?.n || 0;
    const scores = db.prepare("SELECT total FROM scores WHERE candidate_id IN (SELECT candidate_id FROM screenings WHERE status='completed')").all().map(r => r.total);
    const hist = [0, 20, 40, 60, 80].map(lo => ({ label: `${lo}-${lo === 80 ? 100 : lo + 19}`, n: scores.filter(s => s >= lo && (lo === 80 || s < lo + 20)).length }));
    const fb = db.prepare('SELECT SUM(helpful) y, COUNT(*) n FROM feedback').get();
    return {
      funnel, per_job: perJob, sources: Object.entries(sources).map(([k, n]) => ({ label: k, n })), score_hist: hist,
      median_minutes_to_screen: tts == null ? null : Math.round(tts), median_days_to_hire: tth == null ? null : Math.round(tth * 10) / 10,
      no_show_rate: ivn('completed') + ivn('no_show') ? Math.round(ivn('no_show') / (ivn('completed') + ivn('no_show')) * 100) : null,
      offer_accept_rate: ofn('accepted') + ofn('declined') ? Math.round(ofn('accepted') / (ofn('accepted') + ofn('declined')) * 100) : null,
      ai_helpful_rate: fb.n ? Math.round((fb.y || 0) / fb.n * 100) : null, spot_checks_open: db.prepare("SELECT COUNT(*) n FROM candidates WHERE spot_check=1 AND stage='review'").get().n,
      llm: llm.status(),
    };
  }

  // ------------------------------------------------------------ assistant
  async function assistant(question) {
    const rows = db.prepare(`SELECT c.name, c.stage, j.title job, s.total, s.verdict FROM candidates c JOIN jobs j ON j.id=c.job_id LEFT JOIN scores s ON s.candidate_id=c.id ORDER BY s.total DESC LIMIT 40`).all();
    const snap = rows.map((r, i) => `${i + 1}. ${r.name} | ${r.job} | ${r.stage} | ${r.total ?? '-'} ${r.verdict || ''}`).join('\n');
    const ans = await llm.ask({ task: 'assistant', maxTokens: 300, system: 'You are the assistant inside a recruiting dashboard. Answer only from the data given, max 120 words, plain sentences, no em dashes. You may recommend but never decide a hire or a rejection.', prompt: `DATA (candidate | role | stage | score):\n${snap || '(no candidates)'}\n\nQUESTION: ${question}` });
    if (ans.ok) return { answer: noDash(ans.text), provider: ans.provider };
    const q = question.toLowerCase();
    let answer;
    if (/top|best|strong/.test(q)) answer = rows.filter(r => r.total != null).slice(0, 3).map(r => `${r.name} (${r.job}, ${r.total})`).join('; ') || 'No scored candidates yet.';
    else if (/reject|knock/.test(q)) answer = rows.filter(r => r.stage === 'rejected').map(r => r.name).join(', ') || 'Nobody is rejected.';
    else answer = `${rows.length} candidates loaded. Add an LLM key (see .env.example) for open questions. Try asking for the top candidates or who is rejected.`;
    return { answer, provider: 'rules', note: ans.error };
  }

  // ------------------------------------------------------------ automation queue
  async function startPhoneScreen(cid) {
    const c = cand(cid); if (!c) throw new Error('candidate not found');
    if (!dograh.phoneReady()) return 'skipped: Dograh phone not configured';
    if (!c.consent_at) return 'skipped: no call consent recorded';
    if (db.prepare("SELECT 1 x FROM screenings WHERE candidate_id=? AND status IN ('in_progress','completed')").get(cid)) return 'skipped: already screened';
    const r = await dograhCall(dograh.agentUuid, c.phone, screeningContext(c, jobRow(c.job_id)));
    db.prepare("INSERT INTO screenings (id,candidate_id,mode,status,run_id,transcript,answers) VALUES (?,?,?,'in_progress',?,'[]','{}')").run(randomUUID(), cid, 'phone', String(r.workflow_run_id));
    db.prepare("UPDATE candidates SET stage='screening' WHERE id=?").run(cid);
    logEvent(cid, 'screening_started', `Auto phone screening started (Dograh run ${r.workflow_run_id})`);
    return `called, run ${r.workflow_run_id}`;
  }
  async function reminderCall(c, context) {
    if (!dograh.reminderAgentUuid || !dograh.phoneReady()) return 'message drafted, no reminder agent configured';
    const r = await dograhCall(dograh.reminderAgentUuid, c.phone, context);
    return `message drafted, reminder call run ${r.workflow_run_id}`;
  }
  async function runTask(t) {
    const p = J(t.payload, {});
    const c = cand(t.candidate_id);
    switch (t.kind) {
      case 'resume_parse': return parseResume(t.candidate_id);
      case 'analyze': await analyze(t.candidate_id); return 'analyzed';
      case 'screen_call': return startPhoneScreen(t.candidate_id);
      case 'draft_message': await draftMessage(t.candidate_id, p.kind, p.extra || {}); return `drafted ${p.kind}`;
      case 'interview_reminder': {
        const iv = db.prepare('SELECT * FROM interviews WHERE id=?').get(p.interview_id);
        if (!iv || iv.status !== 'scheduled') return 'skipped: interview not scheduled';
        await draftMessage(t.candidate_id, 'reminder', { time: iv.starts_at, meet: iv.meet_link });
        return reminderCall(c, { kind: 'reminder', candidate_name: c.name, job_title: jobRow(c.job_id).title, interview_time: fmtIST(iv.starts_at), meet_link: iv.meet_link });
      }
      case 'no_show_rescue': {
        await draftMessage(t.candidate_id, 'no_show');
        return reminderCall(c, { kind: 'no_show', candidate_name: c.name, job_title: jobRow(c.job_id).title, booking_link: `${publicBase()}/book.html?c=${c.id}` });
      }
      case 'doc_chase': {
        const pending = db.prepare("SELECT title FROM onboarding WHERE candidate_id=? AND kind='doc' AND status='pending'").all(t.candidate_id).map(r => r.title);
        if (!pending.length) return 'skipped: nothing pending';
        await draftMessage(t.candidate_id, 'docs', { docs: pending.join(', ') });
        return `drafted document request for ${pending.length} items`;
      }
      case 'joining_reminder': {
        await draftMessage(t.candidate_id, 'joining', { date: p.date });
        return reminderCall(c, { kind: 'joining', candidate_name: c.name, job_title: jobRow(c.job_id).title, joining_date: p.date });
      }
      default: throw new Error(`unknown task kind ${t.kind}`);
    }
  }
  const CALL_KINDS = new Set(['screen_call', 'interview_reminder', 'no_show_rescue', 'joining_reminder']);
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const due = db.prepare("SELECT * FROM tasks WHERE status='pending' AND run_at<=? ORDER BY run_at LIMIT 5").all(sqlTime(Date.now()));
      for (const t of due) {
        if (CALL_KINDS.has(t.kind) && !callHours()) { db.prepare('UPDATE tasks SET run_at=? WHERE id=?').run(sqlTime(nextCallWindow()), t.id); continue; }
        db.prepare("UPDATE tasks SET status='running', attempts=attempts+1 WHERE id=?").run(t.id);
        try {
          const result = await runTask(t);
          db.prepare("UPDATE tasks SET status='done', result=?, done_at=datetime('now') WHERE id=?").run(String(result || 'ok').slice(0, 500), t.id);
        } catch (e) {
          const again = t.attempts + 1 < 3;
          db.prepare('UPDATE tasks SET status=?, result=?, run_at=? WHERE id=?').run(again ? 'pending' : 'failed', String(e.message).slice(0, 500), sqlTime(Date.now() + 2 * 60000), t.id);
        }
      }
    } finally { ticking = false; }
  }

  function afterApply(cid) {
    const c = cand(cid); if (!c) return;
    if (c.resume_text) enqueue('resume_parse', cid, {}, Date.now() + 2000);
    if (on('auto_call') && dograh.phoneReady() && c.consent_at && callAllowed(c.phone)) enqueue('screen_call', cid, {}, Date.now() + 60000);
  }
  function afterScreen(cid) {
    if (on('auto_analyze')) enqueue('analyze', cid, {}, Date.now() + 1000);
    const s = db.prepare('SELECT verdict FROM scores WHERE candidate_id=?').get(cid);
    if (!s) return;
    if (s.verdict === 'Reject' && Math.random() < Number(getS('spot_check_rate'))) {
      db.prepare("UPDATE candidates SET spot_check=1, stage='review' WHERE id=?").run(cid);
      logEvent(cid, 'spot_check', 'Auto-reject sampled for human spot check');
    } else if (on('auto_draft_messages')) {
      if (s.verdict === 'Strong') enqueue('draft_message', cid, { kind: 'shortlist' }, Date.now() + 3000);
      if (s.verdict === 'Reject') enqueue('draft_message', cid, { kind: 'reject' }, Date.now() + 3000);
    }
  }

  async function rejectionWebhook(b) {
    const ic = b.initial_context || {}, g = b.gathered_context || b.extracted_variables || {};
    const cid = ic.candidate_id; if (!cid || !cand(cid)) return { ok: false, error: 'no matching candidate' };
    const pool = g.stay_in_talent_pool === true || String(g.stay_in_talent_pool).toLowerCase() === 'true';
    const reaction = String(g.reaction || 'no_answer').toLowerCase().trim();
    logEvent(cid, 'rejection_call_done', `Rejection call finished. Reaction: ${reaction}. ${pool ? 'Agreed to stay on file for future roles.' : 'Did not agree to stay on file.'}${String(g.asked_for_feedback).toLowerCase() === 'true' ? ' Asked for written feedback: please send it.' : ''}`);
    return { ok: true, candidate_id: cid };
  }
  async function referenceWebhook(b) {
    const ic = b.initial_context || {};
    const ref = db.prepare('SELECT * FROM refs WHERE id=?').get(ic.reference_id);
    if (!ref) return { ok: false, error: 'reference not found' };
    const g = b.gathered_context || b.extracted_variables || {};
    const bool = v => (typeof v === 'boolean' ? v : /^(y|yes|true)/i.test(String(v)) ? true : /^(n|no|false)/i.test(String(v)) ? false : null);
    const answers = { rehire: bool(g.would_rehire ?? g.rehire), rating: Number.isFinite(Number(g.performance_rating ?? g.rating)) ? Number(g.performance_rating ?? g.rating) : null, strengths: String(g.strengths || ''), concerns: String(g.concerns || ''), dates_match: bool(g.dates_match) };
    db.prepare("UPDATE refs SET status='completed', answers=?, transcript=?, run_id=COALESCE(run_id,?) WHERE id=?").run(JSON.stringify(answers), JSON.stringify(Array.isArray(b.transcript) ? b.transcript.slice(0, 200) : []), String(b.workflow_run_id ?? b.id ?? ''), ref.id);
    logEvent(ref.candidate_id, 'reference', `Reference check completed by ${ref.name}`);
    return { ok: true, candidate_id: ref.candidate_id, answers };
  }

  // ------------------------------------------------------------ routes
  async function route(req, res, u) {
    const p = u.pathname, m = req.method;
    let mm;
    const bad = (msg, code = 400) => { send(res, code, { error: msg }); return true; };
    const ok = (obj, code = 200) => { send(res, code, obj); return true; };

    if (p.startsWith('/api/') && !isPublic(m, p) && !authed(req)) return bad('login required', 401);
    if (m === 'POST' && (p === '/api/applications' || p === '/api/public/book') && limited(req)) return bad('too many requests, try again in a minute', 429);

    if (p === '/api/login' && m === 'POST') {
      const b = await body(req); const t = sessionToken();
      if (!t) return ok({ ok: true, auth: false });
      if (!safeEq(b.password || '', process.env.ADMIN_PASSWORD)) return bad('wrong password', 401);
      send(res, 200, { ok: true }, { 'Set-Cookie': `rs_auth=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}` }); return true;
    }
    if (p === '/api/logout' && m === 'POST') { send(res, 200, { ok: true }, { 'Set-Cookie': 'rs_auth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' }); return true; }
    if (p === '/api/me' && m === 'GET') return ok({ auth_required: Boolean(sessionToken()), logged_in: authed(req) });


    // ---- settings page: keys and options saved in the database, secrets encrypted, never sent back
    const loopback = r => { const a = r.socket.remoteAddress || ''; return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(a) && !r.headers['x-forwarded-for'] && !r.headers['cf-connecting-ip']; };
    const canManage = r => Boolean(process.env.ADMIN_PASSWORD) || loopback(r); // never edit secrets on an open, public dashboard
    const phoneBase = () => '/api/v1/organizations/telephony-configs';
    if (p === '/api/app-settings' && m === 'GET') {
      const caps = await dograhCaps();
      return ok({ caps, groups: GROUPS, fields: settings.view(), can_manage: canManage(req), password_set: Boolean(process.env.ADMIN_PASSWORD), phone_ready: dograh.phoneReady(), mail_ready: mailReady(), calls_locked: process.env.IMPORT_CALL_ANY !== '1', mail_locked: process.env.MAIL_SEND_ANY !== '1' });
    }
    if (p === '/api/app-settings' && m === 'PUT') {
      if (!canManage(req)) return bad('Set a dashboard password first (open this page on the computer running the app and save one under Dashboard security). Secrets are never edited on an open public dashboard.', 403);
      const b = await body(req);
      try { return ok({ ok: true, changed: settings.save(b.values || {}) }); } catch (e) { return bad(e.message); }
    }
    if (p === '/api/app-settings/test' && m === 'POST') {
      const b = await body(req);
      if (b.what === 'email') {
        if (!mailReady()) return ok({ ok: false, message: 'Save the SMTP host, login and password first.' });
        try { await verifyMail(mailConfig()); return ok({ ok: true, message: 'The mailbox accepted the login. Nothing was sent.' }); } catch (e) { return ok({ ok: false, message: `Login failed: ${e.message || 'could not connect'}` }); }
      }
      if (b.what === 'dograh') {
        const base = String(process.env.DOGRAH_BASE_URL || '').replace(/\/+$/, '').replace(/\/api\/v1$/, '');
        if (!base) return ok({ ok: false, message: 'Save the Dograh address first.' });
        let health; try { const r = await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(8000) }); health = await r.json(); } catch (e) { return ok({ ok: false, message: `Could not reach ${base}. Is Dograh running and is the address right?` }); }
        if (!process.env.DOGRAH_API_KEY) return ok({ ok: false, message: `Dograh is running (version ${health.version || 'unknown'}) but no API key is saved yet.` });
        try { const list = await dograhApi('GET', '/api/v1/workflow/summary'); const caps = await dograhCaps(true); return ok({ ok: true, message: `Connected to Dograh ${health.version || ''}. The API key works (${Array.isArray(list) ? list.length : 0} agents found). ${caps.voice_override ? 'Per-role voices and the voice model form are available.' : 'Standard Dograh: set the voice model in Dograh under Settings > Models. Per-role voices are not available.'}`, version: health.version || null, build: caps.voice_override ? 'voice-engine' : 'standard' }); }
        catch (e) { return ok({ ok: false, message: `Dograh is running but rejected the API key: ${e.message}` }); }
      }
      return bad('unknown test');
    }
    if (p === '/api/app-settings/create-agents' && m === 'POST') {
      if (!canManage(req)) return bad('Set a dashboard password first.', 403);
      const b = await body(req);
      try { return ok({ ok: true, agents: await createAgents({ force: b.force === true }) }); } catch (e) { return bad(e.message, 502); }
    }
    if (p === '/api/app-settings/dograh-status' && m === 'GET') {
      if (!process.env.DOGRAH_BASE_URL || !process.env.DOGRAH_API_KEY) return ok({ connected: false });
      const out = { connected: true, phone_providers: null, voice_model: null };
      try { const l = await dograhApi('GET', phoneBase()); const items = l.configurations || l.items || (Array.isArray(l) ? l : []); out.phone_providers = items.map(c => ({ id: c.id, name: c.name, provider: c.provider, numbers: c.phone_number_count ?? 0, default: c.is_default_outbound })); } catch (e) { out.phone_error = e.message; }
      const caps = await dograhCaps();
      out.build = caps.voice_override ? 'voice-engine' : 'standard'; out.version = caps.version;
      if (!caps.voice_override) return ok(out); // standard Dograh keeps its model settings in its own dashboard
      try { const c = await dograhApi('GET', '/api/v1/user/configurations/user'); const r = c.realtime || {}; out.voice_model = { provider: r.provider || null, voice: r.voice || null, key_set: Boolean(r.api_key), realtime: c.is_realtime ?? null }; } catch (e) { out.model_error = e.message; }
      return ok(out);
    }
    if (p === '/api/app-settings/phone-provider' && m === 'POST') {
      if (!canManage(req)) return bad('Set a dashboard password first.', 403);
      const b = await body(req); const sid = String(b.account_sid || '').trim(), tok = String(b.auth_token || '').trim(), num = String(b.phone_number || '').trim();
      if (!/^AC[0-9a-f]{32}$/i.test(sid)) return bad('That does not look like a Twilio Account SID (it starts with AC and has 34 characters).');
      if (!tok) return bad('Paste the Twilio Auth Token.');
      if (!/^\+\d{8,15}$/.test(num)) return bad('Enter the phone number calls come from in international format, like +14155550123.');
      try {
        const created = await dograhApi('POST', phoneBase(), { name: String(b.name || 'Twilio').slice(0, 64), is_default_outbound: true, config: { provider: 'twilio', account_sid: sid, auth_token: tok } });
        await dograhApi('POST', `${phoneBase()}/${created.id}/phone-numbers`, { address: num, is_default_caller_id: true, is_active: true });
        return ok({ ok: true, id: created.id, message: 'Phone provider connected in Dograh. The auth token was sent straight to Dograh and is not stored here.' });
      } catch (e) { return bad(`Dograh did not accept that: ${e.message}`, 502); }
    }
    if (p === '/api/app-settings/voice-model' && m === 'POST') {
      if (!canManage(req)) return bad('Set a dashboard password first.', 403);
      const b = await body(req); const provider = String(b.provider || ''), key = String(b.api_key || '').trim();
      if (!(await dograhCaps()).voice_override) return bad('This Dograh keeps its voice model in its own dashboard. Open Dograh, then Settings > Models.', 409);
      if (!['google_realtime', 'openai_realtime'].includes(provider)) return bad('Choose the voice model provider.');
      if (!key) return bad('Paste the API key for that provider.');
      const realtime = { provider, api_key: key }; if (b.voice) realtime.voice = String(b.voice).slice(0, 40);
      try { await dograhApi('PUT', '/api/v1/user/configurations/user', { realtime, is_realtime: true }); return ok({ ok: true, message: 'Voice model saved in Dograh. The key was sent straight to Dograh and is not stored here.' }); }
      catch (e) { return bad(`Dograh did not accept that: ${e.message}`, 502); }
    }
    // settings + status
    if (p === '/api/settings' && m === 'GET') return ok(Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value])));
    if (p === '/api/settings' && m === 'POST') {
      const b = await body(req), errs = [];
      const rules = { auto_call: v => ['0', '1'].includes(v), auto_analyze: v => ['0', '1'].includes(v), auto_draft_messages: v => ['0', '1'].includes(v), spot_check_rate: v => Number(v) >= 0 && Number(v) <= 1, reminder_hours: v => Number(v) >= 1 && Number(v) <= 168, workday_start: v => Number(v) >= 0 && Number(v) <= 22, workday_end: v => Number(v) >= 1 && Number(v) <= 23, slot_minutes: v => [15, 30, 45, 60].includes(Number(v)) };
      for (const [k, v] of Object.entries(b)) { const s = typeof v === 'boolean' ? (v ? '1' : '0') : String(v); if (!rules[k]) errs.push(`unknown setting ${k}`); else if (!rules[k](s)) errs.push(`invalid value for ${k}`); else b[k] = s; }
      if (errs.length) return bad(errs.join('; '));
      for (const [k, v] of Object.entries(b)) setS(k, v);
      return ok({ ok: true });
    }
    if (p === '/api/llm/status' && m === 'GET') return ok(llm.status());
    if (p === '/api/assistant' && m === 'POST') { const { question } = await body(req); if (!String(question || '').trim()) return bad('question is required'); return ok(await assistant(String(question).slice(0, 500))); }
    if (p === '/api/analytics' && m === 'GET') return ok(analytics());

    // tasks
    if (p === '/api/tasks' && m === 'GET') return ok(db.prepare('SELECT t.*, c.name candidate_name FROM tasks t LEFT JOIN candidates c ON c.id=t.candidate_id ORDER BY t.created_at DESC LIMIT 60').all().map(t => ({ ...t, payload: undefined })));
    if (p === '/api/tasks/run' && m === 'POST') { db.prepare("UPDATE tasks SET run_at=? WHERE status='pending'").run(sqlTime(Date.now() - 1000)); await tick(); return ok({ ok: true }); }
    if ((mm = p.match(/^\/api\/tasks\/([\w-]+)\/retry$/)) && m === 'POST') { const r = db.prepare("UPDATE tasks SET status='pending', attempts=0, run_at=? WHERE id=? AND status='failed'").run(sqlTime(Date.now()), mm[1]); return r.changes ? ok({ ok: true }) : bad('task not failed or not found', 404); }

    // jobs
    if (p === '/api/jobs' && m === 'GET') {
      const all = db.prepare('SELECT id FROM jobs ORDER BY created_at').all().map(r => jobRow(r.id)).map(j => ({ ...j, custom_questions: J(j.custom_questions, []) }));
      if (authed(req) && sessionToken()) return ok(all);
      if (!sessionToken()) return ok(all);
      return ok(all.filter(j => j.status !== 'closed').map(j => ({ id: j.id, title: j.title, company: j.company, location: j.location, min_years: j.min_years, description: j.description, status: j.status })));
    }
    if (p === '/api/jobs' && m === 'POST') {
      const j = jobFields(await body(req), { company: process.env.BRAND_NAME || 'Your Company', location: '', min_years: 2, max_salary: 60000, max_notice_days: 30, headcount: 1, locations: [], must_skills: [], description: '', custom_questions: [], status: 'open' });
      const errs = jobErrors(j); if (errs.length) return bad(errs.join('; '));
      const id = `${j.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)}-${randomUUID().slice(0, 4)}`;
      db.prepare('INSERT INTO jobs (id,title,company,location,min_years,max_salary,locations,must_skills,max_notice_days,description,status,headcount,custom_questions,voice,agent_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, j.title, j.company, j.location, j.min_years, j.max_salary, JSON.stringify(j.locations), JSON.stringify(j.must_skills), j.max_notice_days, j.description, j.status, j.headcount, JSON.stringify(j.custom_questions), j.voice || '', j.agent_name || '');
      let agent_ready = false; if (j.voice) { try { agent_ready = Boolean(await dograh.syncRoleAgents(jobRow(id))); } catch {} }
      return ok({ id, agent_ready }, 201);
    }
    // lead import (CSV from Naukri, Indeed or any export) + AI call queue
    if (p === '/api/import/csv' && m === 'POST') {
      const b = await body(req);
      const job = jobRow(String(b.job_id || '')); if (!job) return bad('choose a job to import these leads into');
      const rows = parseCsv(b.csv); if (rows.length < 2) return bad('the file has no data rows');
      const { missing, leads, columns } = mapLeadRows(rows);
      if (missing.length) return bad(`could not find a ${missing.join(' and ')} column. Columns seen: ${rows[0].join(', ')}`);
      const label = String(b.label || 'import').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'import';
      const source = `csv:${label}`;
      const dupe = db.prepare('SELECT id FROM candidates WHERE job_id=? AND (lower(email)=? OR phone=?)');
      const ins = db.prepare('INSERT INTO candidates (id,job_id,name,email,phone,city,years,notice_days,expected_salary,skills,why,source,resume_text) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
      let created = 0, skipped = 0, notDialable = 0; const problems = [];
      for (const l of leads) {
        if (!l.name) { problems.push({ line: l.line, reason: 'no name' }); skipped++; continue; }
        const c = leadToCandidate(l);
        if (!c.phone) { problems.push({ line: l.line, name: l.name, reason: 'no phone number' }); skipped++; continue; }
        if (dupe.get(job.id, String(c.email || '').toLowerCase(), c.phone)) { problems.push({ line: l.line, name: l.name, reason: 'already in this job (same email or phone)' }); skipped++; continue; }
        if (!dialable(c.phone)) notDialable++;
        const id = randomUUID();
        ins.run(id, job.id, c.name, c.email || '', c.phone, c.city || '', c.years, c.notice_days, c.expected_salary, c.skills || '', `Imported from ${label}`, source, c.resume_text);
        logEvent(id, 'applied', `Imported from CSV (${label}) for ${job.title}`);
        created++;
      }
      return ok({ source, created, skipped, notDialable, columns, problems: problems.slice(0, 30) });
    }
    if (p === '/api/import/batches' && m === 'GET') {
      const rows = db.prepare("SELECT source, count(*) n, min(created_at) at FROM candidates WHERE source LIKE 'csv:%' GROUP BY source ORDER BY at DESC").all();
      return ok(rows.map(r => {
        const ids = db.prepare('SELECT id, phone FROM candidates WHERE source=?').all(r.source);
        const called = db.prepare('SELECT count(DISTINCT candidate_id) n FROM screenings WHERE candidate_id IN (SELECT id FROM candidates WHERE source=?)').get(r.source).n;
        return { source: r.source, total: r.n, dialable: ids.filter(x => dialable(x.phone)).length, called };
      }));
    }
    if (p === '/api/import/call' && m === 'POST') {
      const b = await body(req);
      if (!b.confirm) return bad('confirmation required');
      if (!inHours() && !b.force) return bad('Calls only go out between 9 AM and 7 PM IST. Tick "ignore calling hours" if this is a demo.');
      const limit = Math.max(1, Math.min(200, Number(b.limit) || 5)), gap = Math.max(30, Math.min(900, Number(b.gap_seconds) || 180));
      const cands = db.prepare("SELECT id, name, phone FROM candidates WHERE source=? AND id NOT IN (SELECT candidate_id FROM screenings) ORDER BY created_at").all(String(b.source || ''));
      const queued = new Set(callQueue.items.map(i => i.id));
      const locked = cands.filter(c => dialable(c.phone) && !callAllowed(c.phone)).length;
      const pick = cands.filter(c => dialable(c.phone) && callAllowed(c.phone) && !queued.has(c.id)).slice(0, limit);
      for (const c of pick) callQueue.items.push({ id: c.id, name: c.name, gap });
      callQueue.total += pick.length; pumpCalls();
      return ok({ queued: pick.length, skippedNotDialable: cands.length - cands.filter(c => dialable(c.phone)).length, skippedLocked: locked });
    }
    if (p === '/api/import/queue' && m === 'GET') return ok({ waiting: callQueue.items.length, running: callQueue.running, recent: callQueue.log.slice(0, 15) });
    if (p === '/api/import/queue' && m === 'DELETE') { const n = callQueue.items.length; callQueue.items.length = 0; return ok({ cancelled: n }); }
    if (p === '/api/jobs/generate' && m === 'POST') {
      const b = await body(req); if (!String(b.title || '').trim()) return bad('title is required');
      return ok(await generateJob({ title: String(b.title).trim(), company: b.company, location: b.location, notes: b.notes }));
    }
    if ((mm = p.match(/^\/api\/jobs\/([\w-]+)$/)) && m === 'PUT') {
      const cur = jobRow(mm[1]); if (!cur) return bad('job not found', 404);
      const j = jobFields(await body(req), { ...cur, custom_questions: J(cur.custom_questions, []) });
      const errs = jobErrors(j); if (errs.length) return bad(errs.join('; '));
      db.prepare('UPDATE jobs SET title=?,company=?,location=?,min_years=?,max_salary=?,locations=?,must_skills=?,max_notice_days=?,description=?,status=?,headcount=?,custom_questions=?,negotiable=?,stretch_pct=?,negotiation_notes=?,voice=?,agent_name=? WHERE id=?')
        .run(j.title, j.company, j.location, j.min_years, j.max_salary, JSON.stringify(j.locations), JSON.stringify(j.must_skills), j.max_notice_days, j.description, j.status || 'open', j.headcount || 1, JSON.stringify(j.custom_questions), j.negotiable ? 1 : 0, j.stretch_pct ?? 10, j.negotiation_notes || '', j.voice || '', j.agent_name || '', mm[1]);
      let agent_ready = false; if (j.voice) { try { agent_ready = Boolean(await dograh.syncRoleAgents(jobRow(mm[1]))); } catch {} }
      return ok({ ok: true, agent_ready });
    }
    if (p === '/api/voices' && m === 'GET') { const c = await dograhCaps(); return ok({ supported: c.voice_override, voices: VOICES, note: c.voice_override ? '' : 'Your Dograh uses one voice for every agent, so each role speaks with the voice chosen in Dograh under Settings > Models. Per-role voices need the voice-engine build of Dograh.' }); }
    if ((mm = p.match(/^\/api\/jobs\/([\w-]+)\/matches$/)) && m === 'GET') { const r = matches(mm[1]); return r ? ok(r) : bad('job not found', 404); }
    if ((mm = p.match(/^\/api\/jobs\/([\w-]+)\/matches\/([\w-]+)\/apply$/)) && m === 'POST') {
      const job = jobRow(mm[1]), src = cand(mm[2]);
      if (!job || !src) return bad('job or candidate not found', 404);
      if (!src.consent_at) return bad('this candidate has not consented to be contacted about other roles', 403);
      const id = randomUUID();
      db.prepare('INSERT INTO candidates (id,job_id,name,email,phone,city,years,notice_days,expected_salary,skills,why,source,resume_text,resume_summary,consent_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, job.id, src.name, src.email, src.phone, src.city, src.years, src.notice_days, src.expected_salary, src.skills, src.why, 'talent-pool', src.resume_text, src.resume_summary, src.consent_at);
      logEvent(id, 'applied', `Added from talent pool for ${job.title} (previously applied for another role)`);
      rescore(id); afterApply(id);
      await draftMessage(id, 'followup');
      return ok({ id }, 201);
    }

    // candidate suite
    if ((mm = p.match(/^\/api\/candidates\/([\w-]+)\/suite$/)) && m === 'GET') {
      const c = cand(mm[1]); if (!c) return bad('candidate not found', 404);
      const interviews = db.prepare('SELECT i.*, r.name recruiter_name FROM interviews i LEFT JOIN recruiters r ON r.id=i.recruiter_id WHERE candidate_id=? ORDER BY starts_at DESC').all(c.id)
        .map(i => ({ ...i, scorecards: db.prepare('SELECT s.*, r.name recruiter_name FROM scorecards s LEFT JOIN recruiters r ON r.id=s.recruiter_id WHERE interview_id=?').all(i.id).map(s => ({ ...s, ratings: J(s.ratings, {}) })) }));
      return ok({
        phone: c.phone, source: c.source, consent: !!c.consent_at, spot_check: !!c.spot_check, stage: c.stage, has_resume: !!c.resume_text, resume: J(c.resume_summary), analysis: J(c.ai_analysis), signal: hireSignal(c.id), interviews,
        references: db.prepare('SELECT * FROM refs WHERE candidate_id=? ORDER BY created_at DESC').all(c.id).map(r => ({ ...r, answers: J(r.answers, null), transcript: undefined })),
        offers: db.prepare('SELECT * FROM offers WHERE candidate_id=? ORDER BY created_at DESC').all(c.id),
        onboarding: db.prepare('SELECT * FROM onboarding WHERE candidate_id=? ORDER BY due').all(c.id),
        messages: db.prepare('SELECT * FROM messages WHERE candidate_id=? ORDER BY created_at DESC LIMIT 20').all(c.id),
        dimensions: INTERVIEW_DIMS,
      });
    }
    if ((mm = p.match(/^\/api\/candidates\/([\w-]+)\/resume$/)) && m === 'POST') {
      const { text } = await body(req); const t = String(text || '').trim();
      if (t.length < 40) return bad('paste at least 40 characters of resume text');
      if (t.length > 20000) return bad('resume text is too long (max 20000 characters)');
      if (!cand(mm[1])) return bad('candidate not found', 404);
      db.prepare('UPDATE candidates SET resume_text=? WHERE id=?').run(t, mm[1]);
      return ok({ result: await parseResume(mm[1]) });
    }
    if ((mm = p.match(/^\/api\/candidates\/([\w-]+)\/analyze$/)) && m === 'POST') { if (!cand(mm[1])) return bad('candidate not found', 404); return ok(await analyze(mm[1])); }
    if ((mm = p.match(/^\/api\/candidates\/([\w-]+)\/kit$/)) && m === 'GET') { if (!cand(mm[1])) return bad('candidate not found', 404); return ok(await interviewKit(mm[1])); }
    if ((mm = p.match(/^\/api\/candidates\/([\w-]+)\/messages\/draft$/)) && m === 'POST') {
      const { kind, channel } = await body(req);
      if (!TEMPLATES[kind]) return bad(`kind must be one of ${Object.keys(TEMPLATES).join(', ')}`);
      if (!cand(mm[1])) return bad('candidate not found', 404);
      const extra = { channel: channel === 'email' ? 'email' : 'whatsapp' };
      if (kind === 'docs') { extra.docs = db.prepare("SELECT title FROM onboarding WHERE candidate_id=? AND kind='doc' AND status='pending'").all(mm[1]).map(r => r.title).join(', '); if (!extra.docs) return bad('no pending documents for this candidate'); }
      if (['reminder', 'interview_confirm'].includes(kind)) { const iv = db.prepare("SELECT * FROM interviews WHERE candidate_id=? AND status='scheduled' ORDER BY starts_at LIMIT 1").get(mm[1]); if (!iv) return bad('no scheduled interview'); extra.time = iv.starts_at; extra.meet = iv.meet_link; }
      if (kind === 'joining') { const o = db.prepare("SELECT joining_date FROM offers WHERE candidate_id=? AND status='accepted' LIMIT 1").get(mm[1]); if (!o) return bad('no accepted offer'); extra.date = o.joining_date; }
      return ok(await draftMessage(mm[1], kind, extra), 201);
    }
    if ((mm = p.match(/^\/api\/messages\/([\w-]+)\/status$/)) && m === 'POST') {
      const { status } = await body(req);
      if (!['sent', 'skipped'].includes(status)) return bad('status must be sent or skipped');
      const r = db.prepare("UPDATE messages SET status=? WHERE id=? AND status='draft'").run(status, mm[1]);
      if (!r.changes) return bad('message not found or already handled', 404);
      const row = db.prepare('SELECT * FROM messages WHERE id=?').get(mm[1]);
      logEvent(row.candidate_id, 'message', `Message ${status}: ${row.kind.replace('_', ' ')}`);
      return ok({ ok: true });
    }
    if ((mm = p.match(/^\/api\/candidates\/([\w-]+)$/)) && m === 'DELETE') {
      const id = mm[1]; if (!cand(id)) return bad('candidate not found', 404);
      for (const t of ['scores', 'screenings', 'feedback', 'activities', 'events', 'interviews', 'scorecards', 'refs', 'offers', 'onboarding', 'messages', 'tasks']) db.prepare(`DELETE FROM ${t} WHERE candidate_id=?`).run(id);
      db.prepare('DELETE FROM candidates WHERE id=?').run(id);
      return ok({ ok: true, erased: id });
    }

    // interviews
    if (p === '/api/interviews' && m === 'GET') {
      return ok(db.prepare(`SELECT i.*, c.name candidate_name, c.job_id, j.title job_title, r.name recruiter_name,
        (SELECT COUNT(*) FROM scorecards s WHERE s.interview_id=i.id) scorecards FROM interviews i JOIN candidates c ON c.id=i.candidate_id JOIN jobs j ON j.id=c.job_id LEFT JOIN recruiters r ON r.id=i.recruiter_id ORDER BY i.starts_at DESC LIMIT 100`).all());
    }
    if (p === '/api/public/slots' && m === 'GET') {
      const c = cand(u.searchParams.get('c') || ''); if (!c) return bad('unknown link', 404);
      const existing = db.prepare("SELECT starts_at, meet_link FROM interviews WHERE candidate_id=? AND status='scheduled' LIMIT 1").get(c.id) || null;
      return ok({ candidate: { first_name: first(c.name), job_title: jobRow(c.job_id).title, company: jobRow(c.job_id).company }, open: ['shortlisted', 'review', 'interview'].includes(c.stage), slots: freeSlots(), existing });
    }
    if (p === '/api/public/book' && m === 'POST') {
      const { candidate_id, starts_at } = await body(req);
      const c = cand(candidate_id || ''); if (!c) return bad('unknown link', 404);
      if (!['shortlisted', 'review', 'interview'].includes(c.stage)) return bad('interview booking is not open for this application yet', 403);
      if (Number.isNaN(new Date(starts_at).getTime())) return bad('starts_at is invalid');
      try { const iv = await bookInterview(c.id, starts_at, { by: 'candidate' }); return ok({ ok: true, starts_at: iv.starts_at, meet_link: iv.meet_link }, 201); } catch (e) { return bad(e.message, 409); }
    }
    if ((mm = p.match(/^\/api\/candidates\/([\w-]+)\/interviews$/)) && m === 'POST') {
      const { starts_at, recruiter_id } = await body(req);
      if (!cand(mm[1])) return bad('candidate not found', 404);
      if (Number.isNaN(new Date(starts_at).getTime())) return bad('starts_at is invalid');
      if (recruiter_id && !recruiterOk(recruiter_id)) return bad('unknown recruiter');
      try { return ok(await bookInterview(mm[1], starts_at, { recruiterId: recruiter_id, by: 'recruiter' }), 201); } catch (e) { return bad(e.message, 409); }
    }
    if ((mm = p.match(/^\/api\/interviews\/([\w-]+)\/status$/)) && m === 'POST') {
      const { status } = await body(req);
      if (!['completed', 'no_show', 'cancelled'].includes(status)) return bad('status must be completed, no_show or cancelled');
      const iv = db.prepare('SELECT * FROM interviews WHERE id=?').get(mm[1]); if (!iv) return bad('interview not found', 404);
      db.prepare('UPDATE interviews SET status=? WHERE id=?').run(status, iv.id);
      logEvent(iv.candidate_id, 'interview', `Interview marked ${status.replace('_', ' ')}`);
      if (status === 'no_show') { db.prepare("UPDATE candidates SET stage='shortlisted' WHERE id=? AND stage='interview'").run(iv.candidate_id); enqueue('no_show_rescue', iv.candidate_id, {}, Date.now() + 30 * 60000); }
      return ok({ ok: true });
    }
    if ((mm = p.match(/^\/api\/interviews\/([\w-]+)\/scorecard$/)) && m === 'POST') {
      const b = await body(req);
      const iv = db.prepare('SELECT * FROM interviews WHERE id=?').get(mm[1]); if (!iv) return bad('interview not found', 404);
      if (!recruiterOk(b.recruiter_id)) return bad('recruiter_id is required');
      if (!REC.includes(b.recommendation)) return bad(`recommendation must be one of ${REC.join(', ')}`);
      const ratings = {};
      for (const d of INTERVIEW_DIMS) { const v = Number(b.ratings?.[d]); if (!(v >= 1 && v <= 5)) return bad(`rating for ${d} must be 1 to 5`); ratings[d] = v; }
      db.prepare('INSERT INTO scorecards (id,interview_id,candidate_id,recruiter_id,ratings,recommendation,notes) VALUES (?,?,?,?,?,?,?)').run(randomUUID(), iv.id, iv.candidate_id, b.recruiter_id, JSON.stringify(ratings), b.recommendation, String(b.notes || '').slice(0, 2000));
      db.prepare("UPDATE interviews SET status='completed' WHERE id=? AND status='scheduled'").run(iv.id);
      const avg = Object.values(ratings).reduce((a, x) => a + x, 0) / INTERVIEW_DIMS.length;
      addActivity(iv.candidate_id, b.recruiter_id, 'interview', `Scorecard: ${avg.toFixed(1)}/5, ${b.recommendation.replace('_', ' ')}${b.notes ? `. ${String(b.notes).slice(0, 200)}` : ''}`, Math.round(avg * 10) / 10);
      logEvent(iv.candidate_id, 'scorecard', `Scorecard ${avg.toFixed(1)}/5, ${b.recommendation.replace('_', ' ')}`);
      return ok({ ok: true, signal: hireSignal(iv.candidate_id) }, 201);
    }

    // rejection call: a recruiter confirms, the AI phones the candidate with the decision
    if ((mm = p.match(/^\/api\/candidates\/([\w-]+)\/rejection-call$/)) && m === 'POST') {
      const b = await body(req);
      const c = cand(mm[1]); if (!c) return bad('candidate not found', 404);
      if (c.stage !== 'rejected') return bad('Move the candidate to Rejected first. A rejection call only goes to rejected candidates.', 409);
      if (!b.confirm) return bad('confirmation required');
      if (!dograh.rejectionAgentUuid || !dograh.phoneReady()) return bad('The rejection agent is not set up. Run npm run setup:dograh and set DOGRAH_REJECTION_AGENT_UUID.', 409);
      if (!dialable(c.phone)) return bad('This candidate has no dialable Indian mobile number.', 409);
      if (!callAllowed(c.phone)) return bad('Calling is locked to the demo allowlist. Add this number to IMPORT_CALL_ALLOWLIST or set IMPORT_CALL_ANY=1.', 409);
      if (!callHours() && !b.force) return bad('Calls are only placed between 9 AM and 9 PM IST. Tick the demo box to override.', 409);
      const facts = rejectionFacts(db.prepare('SELECT breakdown FROM scores WHERE candidate_id=?').get(c.id)?.breakdown);
      const job = jobRow(c.job_id);
      try {
        const out = await dograhCall(await dograh.roleAgent(job, 'rejection'), c.phone, { kind: 'rejection', candidate_id: c.id, candidate_first_name: first(c.name), job_title: job.title, company_name: job.company, agent_name: job.agent_name || process.env.AGENT_NAME || 'Priya', ...facts, talent_pool_ok: 'yes' });
        logEvent(c.id, 'rejection_call', `Rejection call started (run ${out.workflow_run_id}). Reason said: ${facts.reason_short}`);
        return ok({ ok: true, run_id: out.workflow_run_id, ...facts });
      } catch (e) { return bad(e.message, 502); }
    }
    // rejection email: preview, send one, send all rejected (max 25 per click)
    const rejDraft = c => {
      const job = jobRow(c.job_id);
      const facts = rejectionFacts(db.prepare('SELECT breakdown FROM scores WHERE candidate_id=?').get(c.id)?.breakdown);
      const scr = db.prepare("SELECT started_at FROM screenings WHERE candidate_id=? AND status='completed' ORDER BY started_at DESC").get(c.id);
      const sender = process.env.MAIL_SIGNATURE_NAME || process.env.MAIL_FROM_NAME || `The ${job.company} Talent Team`;
      return { facts, ...composeRejectionEmail({ name: c.name, role: job.title, company: job.company, facts, agent: job.agent_name || process.env.AGENT_NAME || 'Priya', screenedOn: scr ? fmtDay(scr.started_at) : '', sender }) };
    };
    const alreadyMailed = id => db.prepare("SELECT at FROM events WHERE candidate_id=? AND kind='rejection_email' ORDER BY at DESC").get(id);
    const sendRejection = async (c, over = {}) => {
      const d = rejDraft(c);
      const subject = String(over.subject || d.subject).slice(0, 200), text = String(over.text || d.text).slice(0, 8000);
      const html = over.text ? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#111">${text.split(/\n\n/).map(p => `<p style="margin:0 0 14px">${escHtml(p).replace(/\n/g, '<br>')}</p>`).join('')}</div>` : d.html;
      const out = await sendMail(mailConfig(), { to: c.email, subject, text, html });
      db.prepare('INSERT INTO messages (id,candidate_id,channel,kind,body,status,provider) VALUES (?,?,?,?,?,?,?)').run(randomUUID(), c.id, 'email', 'reject', text, 'sent', 'smtp');
      logEvent(c.id, 'rejection_email', `Rejection email sent to ${c.email}`);
      return out;
    };
    if ((mm = p.match(/^\/api\/candidates\/([\w-]+)\/rejection-email$/)) && m === 'GET') {
      const c = cand(mm[1]); if (!c) return bad('candidate not found', 404);
      const d = rejDraft(c), done = alreadyMailed(c.id);
      return ok({ to: c.email, subject: d.subject, text: d.text, configured: mailReady(), allowed: mailAllowed(c.email), sent_at: done?.at || null, stage: c.stage });
    }
    if ((mm = p.match(/^\/api\/candidates\/([\w-]+)\/rejection-email$/)) && m === 'POST') {
      const b = await body(req); const c = cand(mm[1]); if (!c) return bad('candidate not found', 404);
      if (c.stage !== 'rejected') return bad('Move the candidate to Rejected first. A rejection email only goes to rejected candidates.', 409);
      if (!b.confirm) return bad('confirmation required');
      if (!mailReady()) return bad('Email is not set up. Add SMTP_HOST, SMTP_USER and SMTP_PASS to .env.', 409);
      if (!mailAllowed(c.email)) return bad('Email sending is locked to the demo allowlist. Add this address to MAIL_ALLOWLIST, or set MAIL_SEND_ANY=1 for production.', 409);
      if (alreadyMailed(c.id) && !b.resend) return bad(`A rejection email was already sent (${alreadyMailed(c.id).at}). Tick resend to send again.`, 409);
      try { const out = await sendRejection(c, b); return ok({ ok: true, to: c.email, response: out.response }); } catch (e) { return bad(`Could not send: ${e.message}`, 502); }
    }
    if (p === '/api/rejection-emails/send' && m === 'POST') {
      const b = await body(req); if (!b.confirm) return bad('confirmation required');
      if (!mailReady()) return bad('Email is not set up. Add SMTP_HOST, SMTP_USER and SMTP_PASS to .env.', 409);
      const rows = db.prepare("SELECT * FROM candidates WHERE stage='rejected'" + (b.job_id ? ' AND job_id=?' : '') + ' ORDER BY created_at').all(...(b.job_id ? [b.job_id] : []));
      const res = { sent: 0, failed: 0, already: 0, locked: 0, no_email: 0, remaining: 0, errors: [] };
      for (const c of rows) {
        if (alreadyMailed(c.id)) { res.already++; continue; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email || '')) { res.no_email++; continue; }
        if (!mailAllowed(c.email)) { res.locked++; continue; }
        if (res.sent + res.failed >= 25) { res.remaining++; continue; }
        try { await sendRejection(c); res.sent++; } catch (e) { res.failed++; res.errors.push(`${c.name}: ${e.message}`.slice(0, 160)); }
        await new Promise(r => setTimeout(r, 700));
      }
      return ok(res);
    }
    // references
    if ((mm = p.match(/^\/api\/candidates\/([\w-]+)\/references$/)) && m === 'POST') {
      const b = await body(req); const errs = [];
      if (!cand(mm[1])) return bad('candidate not found', 404);
      if (!String(b.name || '').trim()) errs.push('name is required');
      if (!/^\+?[0-9 ()-]{8,20}$/.test(String(b.phone || ''))) errs.push('phone is invalid');
      if (errs.length) return bad(errs.join('; '));
      const digits = String(b.phone).replace(/[^\d+]/g, ''); const phone = digits.startsWith('+') ? digits : digits.length === 10 ? `+91${digits}` : `+${digits}`;
      const id = randomUUID();
      db.prepare('INSERT INTO refs (id,candidate_id,name,phone,relation,company) VALUES (?,?,?,?,?,?)').run(id, mm[1], String(b.name).trim(), phone, String(b.relation || '').trim(), String(b.company || '').trim());
      logEvent(mm[1], 'reference', `Reference added: ${String(b.name).trim()}`);
      return ok({ id }, 201);
    }
    if ((mm = p.match(/^\/api\/references\/([\w-]+)\/call$/)) && m === 'POST') {
      const r = db.prepare('SELECT * FROM refs WHERE id=?').get(mm[1]); if (!r) return bad('reference not found', 404);
      if (!dograh.refAgentUuid || !dograh.phoneReady()) return bad('Dograh reference agent is not configured (DOGRAH_REFERENCE_AGENT_UUID)', 409);
      if (!callHours()) return bad('calls are only placed between 9 AM and 9 PM IST', 409);
      const c = cand(r.candidate_id);
      try {
        const out = await dograhCall(dograh.refAgentUuid, r.phone, { kind: 'reference', reference_id: r.id, candidate_name: c.name, job_title: jobRow(c.job_id).title, referee_name: r.name, relation: r.relation, company: r.company });
        db.prepare("UPDATE refs SET status='calling', run_id=? WHERE id=?").run(String(out.workflow_run_id), r.id);
        logEvent(r.candidate_id, 'reference', `Reference call started for ${r.name} (run ${out.workflow_run_id})`);
        return ok({ ok: true, run_id: out.workflow_run_id });
      } catch (e) { return bad(e.message, 502); }
    }
    if ((mm = p.match(/^\/api\/references\/([\w-]+)\/complete$/)) && m === 'POST') {
      const b = await body(req);
      const r = db.prepare('SELECT * FROM refs WHERE id=?').get(mm[1]); if (!r) return bad('reference not found', 404);
      const rating = Number(b.rating); if (!(rating >= 1 && rating <= 5)) return bad('rating must be 1 to 5');
      db.prepare("UPDATE refs SET status='completed', answers=? WHERE id=?").run(JSON.stringify({ rehire: b.rehire === true, rating, strengths: String(b.strengths || '').slice(0, 1000), concerns: String(b.concerns || '').slice(0, 1000), dates_match: b.dates_match !== false }), r.id);
      logEvent(r.candidate_id, 'reference', `Reference check entered manually for ${r.name}`);
      return ok({ ok: true });
    }

    // offers + onboarding
    if ((mm = p.match(/^\/api\/candidates\/([\w-]+)\/offers$/)) && m === 'POST') {
      const b = await body(req); const c = cand(mm[1]); if (!c) return bad('candidate not found', 404);
      const salary = Number(b.salary);
      if (!(salary > 0)) return bad('salary must be a positive number (monthly, rupees)');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.joining_date || '')) || Number.isNaN(new Date(b.joining_date).getTime())) return bad('joining_date must be YYYY-MM-DD');
      if (db.prepare("SELECT 1 x FROM offers WHERE candidate_id=? AND status IN ('draft','sent','negotiating','accepted')").get(c.id)) return bad('this candidate already has an open offer', 409);
      return ok(await createOffer(c.id, salary, b.joining_date), 201);
    }
    if ((mm = p.match(/^\/api\/offers\/([\w-]+)\/status$/)) && m === 'POST') {
      const { status } = await body(req);
      const o = db.prepare('SELECT * FROM offers WHERE id=?').get(mm[1]); if (!o) return bad('offer not found', 404);
      if (!(OFFER_FLOW[o.status] || []).includes(status)) return bad(`cannot move an offer from ${o.status} to ${status}`);
      db.prepare("UPDATE offers SET status=?, decided_at=CASE WHEN ? IN ('accepted','declined') THEN datetime('now') ELSE decided_at END WHERE id=?").run(status, status, o.id);
      logEvent(o.candidate_id, 'offer', `Offer ${status}`);
      if (status === 'sent') await draftMessage(o.candidate_id, 'offer');
      if (status === 'accepted') {
        db.prepare("UPDATE candidates SET stage='hired', hired_at=datetime('now') WHERE id=?").run(o.candidate_id);
        seedOnboarding(o.candidate_id, o.joining_date);
      }
      if (status === 'declined') db.prepare("UPDATE candidates SET stage='rejected' WHERE id=?").run(o.candidate_id);
      return ok({ ok: true });
    }
    if (p === '/api/offers' && m === 'GET') return ok(db.prepare('SELECT o.*, c.name candidate_name, j.title job_title FROM offers o JOIN candidates c ON c.id=o.candidate_id JOIN jobs j ON j.id=c.job_id ORDER BY o.created_at DESC').all());
    if ((mm = p.match(/^\/api\/onboarding\/([\w-]+)\/toggle$/)) && m === 'POST') {
      const r = db.prepare("UPDATE onboarding SET status=CASE WHEN status='done' THEN 'pending' ELSE 'done' END WHERE id=?").run(mm[1]);
      return r.changes ? ok({ ok: true }) : bad('item not found', 404);
    }

    // export
    if (p === '/api/export/candidates.csv' && m === 'GET') {
      const rows = db.prepare('SELECT c.name, c.email, c.phone, c.city, j.title job, c.stage, c.source, s.total score, s.verdict, c.created_at FROM candidates c JOIN jobs j ON j.id=c.job_id LEFT JOIN scores s ON s.candidate_id=c.id ORDER BY c.created_at DESC').all();
      const cols = ['name', 'email', 'phone', 'city', 'job', 'stage', 'source', 'score', 'verdict', 'created_at'];
      const cell = v => { let s = v == null ? '' : String(v); if (/^[=+\-@]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="candidates.csv"' });
      res.end([cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n'));
      return true;
    }
    return false;
  }

  return { route, afterApply, afterScreen, referenceWebhook, rejectionWebhook, startWorker: () => setInterval(() => tick().catch(() => {}), 10000) };
}
