// End-to-end tests. Run: node --experimental-sqlite test.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import net from 'node:net';
import { parseAnswer, QUESTIONS, scoreCandidate, evaluate } from './scoring.js';

let pass = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('ok  ', name); } catch (e) { console.error('FAIL', name, '\n    ', e.message); process.exitCode = 1; } };
const Q = k => QUESTIONS.find(q => q.key === k);

// ---------- unit: parsing
await t('parse notice periods', () => {
  assert.equal(parseAnswer(Q('notice_days'), 'one month'), 30);
  assert.equal(parseAnswer(Q('notice_days'), '2 weeks'), 14);
  assert.equal(parseAnswer(Q('notice_days'), 'immediately'), 0);
  assert.equal(parseAnswer(Q('notice_days'), '45 days'), 45);
});
await t('parse salaries', () => {
  assert.equal(parseAnswer(Q('expected_salary'), '55k'), 55000);
  assert.equal(parseAnswer(Q('expected_salary'), '6 LPA'), 50000);
  assert.equal(parseAnswer(Q('expected_salary'), '1.2 lakh per month'), 120000);
  assert.equal(parseAnswer(Q('expected_salary'), '10 lakhs'), 83333); // bare lakhs = yearly
  assert.equal(parseAnswer(Q('expected_salary'), '90'), 750000); // bare small number = LPA
  assert.equal(parseAnswer(Q('expected_salary'), '90 LPS'), 750000);
  assert.equal(parseAnswer(Q('expected_salary'), 'around 48,000 per month'), 48000);
});
await t('parse yes/no and years', () => {
  assert.equal(parseAnswer(Q('relocation_ok'), 'Yes, I already live there'), true);
  assert.equal(parseAnswer(Q('relocation_ok'), "No, I can't move"), false);
  assert.equal(parseAnswer(Q('years_experience'), 'about three years'), 3);
  assert.equal(parseAnswer(Q('years_experience'), '18 months'), 1.5);
});
const JOB = { title: 'Inside Sales Executive', min_years: 2, max_salary: 60000, max_notice_days: 30, locations: ['pune'], must_skills: ['crm', 'cold calling', 'english'] };
await t('strong candidate scores Strong', () => {
  const r = scoreCandidate({ years: 3, expected_salary: 50000, notice_days: 15, city: 'Pune', skills: 'CRM, cold calling, English' }, JOB,
    { years_experience: 3, expected_salary: 50000, notice_days: 15, relocation_ok: true, skill_example: 'I made 80 cold calls a day in HubSpot CRM and booked 22 demos last quarter, the top number on my team of 9.' });
  assert.equal(r.verdict, 'Strong'); assert.ok(r.total >= 75, r.total);
});
await t('knockouts force Reject', () => {
  const r = scoreCandidate({ years: 3, expected_salary: 50000, notice_days: 15, city: 'Delhi', skills: 'crm' }, JOB, { years_experience: 3, expected_salary: 95000, relocation_ok: false, skill_example: 'x' });
  assert.equal(r.verdict, 'Reject'); assert.ok(r.flags.some(f => /Salary/.test(f.text))); assert.ok(r.flags.some(f => /location/.test(f.text)));
});
await t('form vs call mismatch is flagged', () => {
  const r = scoreCandidate({ years: 5, city: 'Pune' }, JOB, { years_experience: 1, skill_example: 'I did sales calls every day for a year at a startup.' });
  assert.ok(r.flags.some(f => /Form says 5/.test(f.text)));
});
await t('evaluate gives pros, cons, outliers and a blocker', () => {
  const c = { years: 3, expected_salary: 95000, notice_days: 15, city: 'Delhi', skills: 'crm' };
  const ans = { years_experience: 9, expected_salary: 95000, relocation_ok: false, skill_example: 'x' };
  const r = scoreCandidate(c, JOB, ans);
  const e = evaluate(r, c, ans, [{ years: 3, expected_salary: 50000, total: 80 }, { years: 2, expected_salary: 55000, total: 70 }, { years: 3, expected_salary: 52000, total: 75 }]);
  assert.ok(e.pros.some(x => /Experience/.test(x))); assert.ok(e.cons.some(x => /Salary/.test(x)));
  assert.ok(e.outliers.some(o => o.good && /Experience/.test(o.text))); assert.ok(e.outliers.some(o => !o.good && /Salary/.test(o.text)));
  assert.match(e.blocker, /Salary expectation/); assert.equal(e.hire_score, r.total);
});
await t('no blocker for a strong candidate, no outliers with a tiny pool', () => {
  const c = { years: 3, expected_salary: 50000, notice_days: 15, city: 'Pune', skills: 'CRM, cold calling, English' };
  const ans = { years_experience: 3, expected_salary: 50000, relocation_ok: true, skill_example: 'I made 80 cold calls a day in HubSpot CRM and booked 22 demos last quarter, top of 9.' };
  const e = evaluate(scoreCandidate(c, JOB, ans), c, ans, [{ years: 1, expected_salary: 1, total: 1 }]);
  assert.equal(e.blocker, null); assert.equal(e.outliers.length, 0);
});
await t('unscreened candidate is Pending', () => assert.equal(scoreCandidate({ years: 3, city: 'Pune' }, JOB, null).verdict, 'Pending screen'));

// ---------- mock Dograh
const dograhCalls = [];
let catalogOff = false; // flip to pretend this Dograh is a standard build without per-agent voices
const mock = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  dograhCalls.push({ url: req.url, key: req.headers['x-api-key'], body: raw ? JSON.parse(raw) : null });
  if (req.url === '/api/v1/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ status: 'ok', version: '9.9.9-mock' })); } // Dograh's health check needs no key
  if (req.headers['x-api-key'] !== 'dgr_test') { res.writeHead(401); return res.end('{"detail":"Unauthorized"}'); }
  if (req.url === '/api/v1/user/configurations/voices/realtime-catalog') { if (catalogOff) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"detail":"Not Found"}'); } res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('[]'); }
  const wfDef = { nodes: [{ id: 'start', type: 'startCall', data: { name: 'S', prompt: 'hi' } }, { id: 'trig', type: 'trigger', data: { name: 'T', trigger_path: 'abc' } }], edges: [] };
  const jsonOut = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  let m;
  if ((m = req.url.match(/^\/api\/v1\/workflow\/fetch\/(\d+)$/))) return jsonOut({ id: Number(m[1]), workflow_uuid: m[1] === '55' ? 'role-uuid-55' : `base-uuid-${m[1]}`, workflow_definition: wfDef });
  if (req.url === '/api/v1/workflow/create/definition') return jsonOut({ id: 55, workflow_uuid: null });
  if (/^\/api\/v1\/workflow\/55(\/create-draft|\/publish)?$/.test(req.url)) return jsonOut({ ok: true });
  if (req.url === '/api/v1/workflow/summary') return jsonOut([{ id: 1, name: 'Agent' }]);
  if (req.method === 'POST' && req.url === '/api/v1/organizations/telephony-configs') return jsonOut({ id: 7, name: 'Twilio', provider: 'twilio' });
  if (req.method === 'POST' && req.url === '/api/v1/organizations/telephony-configs/7/phone-numbers') return jsonOut({ id: 1 });
  if (req.method === 'GET' && req.url === '/api/v1/organizations/telephony-configs') return jsonOut({ configurations: [{ id: 7, name: 'Twilio', provider: 'twilio', phone_number_count: 1, is_default_outbound: true }] });
  if (req.url === '/api/v1/user/configurations/user') return jsonOut({ realtime: { provider: 'google_realtime', voice: 'Zephyr', api_key: '****abcd' }, is_realtime: true });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'initiated', workflow_run_id: 9001, workflow_run_name: 'WR-TEST' }));
});
await new Promise(r => mock.listen(0, r));
const MOCK = `http://127.0.0.1:${mock.address().port}`;

// ---------- mock SMTP server (captures messages, speaks AUTH LOGIN)
const mails = [];
const smtp = net.createServer(sock => {
  let state = 'cmd', data = '', cur = { rcpt: '' };
  const w = s => sock.write(s + '\r\n'); w('220 mock ESMTP');
  let buf = '';
  sock.on('data', d => {
    buf += d.toString();
    for (;;) {
      if (state === 'data') { const i = buf.indexOf('\r\n.\r\n'); if (i < 0) return; data = buf.slice(0, i); buf = buf.slice(i + 5); const parts = [...data.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/g)].map(m => Buffer.from(m[1].replace(/\s+/g, ''), 'base64').toString('utf8')); mails.push({ ...cur, raw: data, decoded: parts[0] || '', html: parts[1] || '' }); state = 'cmd'; w('250 2.0.0 queued'); continue; }
      const i = buf.indexOf('\r\n'); if (i < 0) return; const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (state === 'user') { state = 'pass'; w('334 UGFzc3dvcmQ6'); }
      else if (state === 'pass') { state = 'cmd'; w(Buffer.from(line, 'base64').toString() === 'p' ? '235 ok' : '535 bad'); }
      else if (/^EHLO/i.test(line)) { sock.write('250-mock\r\n250 AUTH LOGIN\r\n'); }
      else if (/^AUTH LOGIN/i.test(line)) { state = 'user'; w('334 VXNlcm5hbWU6'); }
      else if (/^MAIL FROM/i.test(line)) { cur = { from: line.slice(10).replace(/[<>]/g, ''), rcpt: '' }; w('250 ok'); }
      else if (/^RCPT TO/i.test(line)) { cur.rcpt = line.slice(8).replace(/[<>]/g, ''); w('250 ok'); }
      else if (/^DATA/i.test(line)) { state = 'data'; w('354 go'); }
      else if (/^QUIT/i.test(line)) { w('221 bye'); sock.end(); }
      else w('250 ok');
    }
  });
});
await new Promise(r => smtp.listen(0, r));
const SMTP_PORT = smtp.address().port;


// ---------- boot app
const dir = mkdtempSync(path.join(tmpdir(), 'rs-'));
const PORT = 4990 + Math.floor(Math.random() * 9);
const app = spawn(process.execPath, ['--experimental-sqlite', '--no-warnings', 'server.js'], {
  cwd: path.dirname(new URL(import.meta.url).pathname),
  env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 't.db'), DOGRAH_BASE_URL: MOCK, DOGRAH_API_KEY: 'dgr_test', DOGRAH_AGENT_UUID: 'agent-uuid-1', DOGRAH_WORKFLOW_ID: '1', DOGRAH_CAPS_TTL_MS: '0', DOGRAH_EMBED_TOKEN: 'emb_test', LLM_DISABLE: '1', SPOT_CHECK_RATE: '0', SEED_DEMO_DATA: '1', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(SMTP_PORT), SMTP_SECURE: '0', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'hr@example.com', MAIL_FROM_NAME: 'Test HR', MAIL_ALLOWLIST: 'allowed@example.com', IMPORT_CALL_ALLOWLIST: '+910000000001,+910000000055,+910000000099' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((res, rej) => { app.stdout.on('data', d => /Recruiting System on/.test(d) && res()); setTimeout(() => rej(new Error('server did not start')), 8000); });
const B = `http://127.0.0.1:${PORT}`;
const req = async (p, method = 'GET', body) => {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null), text: r.headers.get('content-type') };
};
const applicant = { consent: true, job_id: 'inside-sales', name: 'Riya Sharma', email: 'riya@example.com', phone: '00000 00001', city: 'Pune', years: 3, notice_days: 15, expected_salary: 52000, skills: 'CRM, cold calling, English', why: 'I love outbound.' };

try {
  await t('pages serve', async () => {
    assert.match((await req('/')).text, /html/); assert.match((await req('/dashboard')).text, /html/);
  });
  await t('config reports Dograh ready', async () => {
    const r = await req('/api/config'); assert.equal(r.data.dograh_phone, true); assert.equal(r.data.dograh_web, true); assert.equal(r.data.questions.length, 6);
  });
  await t('validation rejects bad applications', async () => {
    const r = await req('/api/applications', 'POST', { ...applicant, email: 'nope', job_id: 'x' });
    assert.equal(r.status, 400); assert.match(r.data.error, /email is invalid/); assert.match(r.data.error, /job not found/);
    assert.equal((await req('/api/applications', 'POST', {})).status, 400);
  });
  await t('invalid JSON returns 400', async () => {
    const r = await fetch(B + '/api/applications', { method: 'POST', body: '{bad' }); assert.equal(r.status, 400);
  });

  // simulator path
  let simId;
  await t('apply -> simulator screen -> scored Strong -> shortlisted', async () => {
    const a = await req('/api/applications', 'POST', applicant);
    assert.equal(a.status, 201); simId = a.data.id;
    assert.equal(a.data.context.candidate_name, 'Riya Sharma'); assert.equal(a.data.context.job_title, 'Inside Sales Executive');
    const s = await req(`/api/candidates/${simId}/screenings`, 'POST', { mode: 'simulator' });
    assert.equal(s.status, 201); assert.equal(s.data.questions.length, 6);
    const done = await req(`/api/screenings/${s.data.screening_id}/complete`, 'POST', {
      transcript: [{ role: 'agent', text: 'How many years?' }, { role: 'candidate', text: '3 years' }],
      answers: { years_experience: '3 years', skill_example: 'I made 80 cold calls a day in Salesforce CRM and booked 25 demos last quarter, best on a team of 10.', notice_days: '2 weeks', expected_salary: '50k', relocation_ok: 'yes, I live in Pune', availability: 'Thursday 4pm' },
    });
    assert.equal(done.status, 200); assert.equal(done.data.score.verdict, 'Strong');
    const c = await req(`/api/candidates/${simId}`);
    assert.equal(c.data.stage, 'shortlisted'); assert.equal(c.data.screenings[0].answers.notice_days, 14);
    assert.equal((await req(`/api/screenings/${s.data.screening_id}/complete`, 'POST', {})).status, 409);
  });

  // phone path through mock Dograh + webhook
  await t('phone screen triggers Dograh with form context, webhook scores it', async () => {
    const a = await req('/api/applications', 'POST', { ...applicant, name: 'Arjun Mehta', email: 'arjun@example.com', city: 'Nagpur', expected_salary: 58000 });
    const id = a.data.id;
    const s = await req(`/api/candidates/${id}/screenings`, 'POST', { mode: 'phone' });
    assert.equal(s.status, 201, JSON.stringify(s.data)); assert.equal(s.data.run_id, '9001');
    const call = dograhCalls.at(-1);
    assert.equal(call.url, '/api/v1/public/agent/workflow/agent-uuid-1'); assert.equal(call.key, 'dgr_test');
    assert.equal(call.body.phone_number, '+910000000001'); assert.equal(call.body.initial_context.candidate_id, id);
    assert.equal(call.body.initial_context.form_expected_salary, '58000');
    const wh = await req('/api/webhooks/dograh', 'POST', {
      workflow_run_id: 9001, initial_context: { candidate_id: id },
      gathered_context: { years_experience: '2', notice_period_days: 'one month', expected_salary: '95k', relocation_ok: 'no', skill_example: 'Some calling.' },
      transcript: [{ role: 'assistant', content: 'Hi Arjun' }, { role: 'user', content: 'Hello' }],
    });
    assert.equal(wh.status, 200, JSON.stringify(wh.data)); assert.equal(wh.data.score.verdict, 'Reject');
    const c = await req(`/api/candidates/${id}`);
    assert.equal(c.data.stage, 'rejected'); assert.equal(c.data.screenings[0].transcript[0].role, 'agent');
    assert.equal(c.data.screenings[0].answers.notice_days, 30);
  });

  await t('web screen webhook matches by candidate_id in initial_context', async () => {
    const a = await req('/api/applications', 'POST', { ...applicant, name: 'Meera Iyer', email: 'meera@example.com' });
    const s = await req(`/api/candidates/${a.data.id}/screenings`, 'POST', { mode: 'web' });
    assert.equal(s.status, 201);
    const wh = await req('/api/webhooks/dograh', 'POST', { id: 777, initial_context: { candidate_id: a.data.id, source: 'web' }, gathered_context: { years_experience: 4, skill_example: 'I built our outbound CRM process and cut lead response time by 40 percent. We grew qualified demos from 20 to 55 a month in six months and saved the team 15 hours a week. I led a team of 8 reps and ran 60 dials a day.', relocation_ok: true, expected_salary: 55000, notice_days: 20 }, transcript: [{ role: 'assistant', content: 'Hi Meera' }, { role: 'user', content: 'Hello, yes I applied.' }] });
    assert.equal(wh.status, 200); assert.equal(wh.data.score.verdict, 'Strong');
    const c = await req(`/api/candidates/${a.data.id}`);
    assert.equal(c.data.screenings.length, 1); assert.equal(c.data.screenings[0].mode, 'web');
  });

  await t('resume text flows into call context as summary and probes', async () => {
    const a = await req('/api/applications', 'POST', {
      ...applicant, name: 'Devika Rao', email: 'devika@example.com',
      resume: 'Sales Executive, Acme Corp 2019-2021. Team Lead, Beta Ltd 2023-Present. Skills: Node.js, CRM, Salesforce.',
    });
    assert.equal(a.status, 201, JSON.stringify(a.data));
    const s = await req(`/api/candidates/${a.data.id}/screenings`, 'POST', { mode: 'phone' });
    const call = dograhCalls.at(-1);
    assert.equal(call.body.initial_context.has_resume, 'yes');
    assert.match(call.body.initial_context.resume_summary, /Gaps: 2021-2023/);
    assert.match(call.body.initial_context.resume_probes, /work until 2021 and then nothing until 2023/);
    assert.match(call.body.initial_context.resume_probes, /You claim Node\.js/);
  });

  await t('no resume means no probes in call context', async () => {
    const a = await req('/api/applications', 'POST', { ...applicant, name: 'Kiran Jain', email: 'kiran@example.com' });
    await req(`/api/candidates/${a.data.id}/screenings`, 'POST', { mode: 'phone' });
    const call = dograhCalls.at(-1);
    assert.equal(call.body.initial_context.has_resume, 'no');
    assert.equal(call.body.initial_context.resume_probes, '');
  });

  await t('webhook with unknown candidate is 404', async () => assert.equal((await req('/api/webhooks/dograh', 'POST', { initial_context: { candidate_id: 'nope' } })).status, 404));
  await t('bad screening mode is 400', async () => assert.equal((await req(`/api/candidates/${simId}/screenings`, 'POST', { mode: 'fax' })).status, 400));

  await t('recruiter feedback + stage + stats', async () => {
    assert.equal((await req(`/api/candidates/${simId}/feedback`, 'POST', { helpful: 'yes' })).status, 400);
    assert.equal((await req(`/api/candidates/${simId}/feedback`, 'POST', { helpful: true, note: 'Spot on' })).status, 201);
    assert.equal((await req(`/api/candidates/${simId}/stage`, 'POST', { stage: 'interview' })).status, 200);
    assert.equal((await req(`/api/candidates/${simId}/stage`, 'POST', { stage: 'moon' })).status, 400);
    const st = await req('/api/stats');
    assert.equal(st.data.total, 5); assert.equal(st.data.screened, 3); assert.equal(st.data.strong, 2); assert.equal(st.data.helpful_yes, 1);
    const list = await req('/api/candidates');
    assert.equal(list.data.find(c => c.id === simId).helpful, 1);
  });
  await t('candidate detail carries the evaluation', async () => {
    const c = await req(`/api/candidates/${simId}`);
    assert.ok(Array.isArray(c.data.evaluation.pros)); assert.equal(c.data.evaluation.blocker, null); assert.equal(c.data.evaluation.hire_score, c.data.score.total);
    const list = await req('/api/candidates');
    const arjun = list.data.find(x => x.name === 'Arjun Mehta'); assert.match(arjun.blocker, /Salary|location/);
  });
  await t('recruiters log work, bad input rejected', async () => {
    assert.equal((await req('/api/recruiters')).data.length, 3);
    assert.equal((await req(`/api/candidates/${simId}/activities`, 'POST', { kind: 'note', text: 'x' })).status, 400);
    assert.equal((await req(`/api/candidates/${simId}/activities`, 'POST', { recruiter_id: 'ghost', kind: 'note', text: 'x' })).status, 400);
    assert.equal((await req(`/api/candidates/${simId}/activities`, 'POST', { recruiter_id: 'rohit', kind: 'interview', text: 'good' })).status, 400);
    assert.equal((await req(`/api/candidates/${simId}/activities`, 'POST', { recruiter_id: 'rohit', kind: 'interview', text: 'Sharp, clear on numbers', rating: 4 })).status, 201);
    assert.equal((await req(`/api/candidates/${simId}/activities`, 'POST', { recruiter_id: 'rohit', kind: 'call', text: 'Confirmed Thursday slot' })).status, 201);
    assert.equal((await req(`/api/candidates/${simId}/feedback`, 'POST', { helpful: false, recruiter_id: 'sana', note: 'Missed notice nuance' })).status, 201);
    assert.equal((await req(`/api/candidates/nope/activities`, 'POST', { recruiter_id: 'rohit', kind: 'note', text: 'x' })).status, 404);
    const c = await req(`/api/candidates/${simId}`);
    assert.equal(c.data.activities.filter(a => a.recruiter_name === 'Rohit Kulkarni').length, 2);
  });
  await t('team metrics and outliers', async () => {
    const team = (await req('/api/team')).data;
    const rohit = team.find(x => x.id === 'rohit'), sana = team.find(x => x.id === 'sana'), ananya = team.find(x => x.id === 'ananya');
    assert.equal(rohit.interviews, 1); assert.equal(rohit.avg_interview_rating, 4); assert.equal(rohit.calls, 1);
    assert.equal(sana.reviews, 1); assert.equal(sana.agree_with_ai, 0);
    assert.equal(rohit.outlier, 'high output'); assert.equal(ananya.outlier, 'low output');
  });
  await t('calls log lists every screen', async () => {
    const calls = (await req('/api/calls')).data;
    assert.equal(calls.length, 5); assert.ok(calls.some(c => c.mode === 'phone' && c.run_id === '9001')); assert.ok(calls.every(c => typeof c.turns === 'number'));
  });
  await t('PDF resume upload returns text, rejects non-PDF', async () => {
    const { readFileSync } = await import('node:fs');
    const r = await fetch(`${B}/api/resume/pdf`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: readFileSync(new URL('./demo/sample-resume.pdf', import.meta.url)) });
    const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j));
    assert.match(j.text, /Rohan Mehta/); assert.match(j.text, /Acme Realty/);
    const bad = await fetch(`${B}/api/resume/pdf`, { method: 'POST', body: Buffer.from('not a pdf, just some plain text that is long enough to pass the size check '.repeat(3)) });
    assert.equal(bad.status, 400);
  });
  await t('PDF text flows through application into call probes (gap found)', async () => {
    const { readFileSync } = await import('node:fs');
    const pdf = await (await fetch(`${B}/api/resume/pdf`, { method: 'POST', body: readFileSync(new URL('./demo/sample-resume.pdf', import.meta.url)) })).json();
    const a = await req('/api/applications', 'POST', { ...applicant, name: 'Rohan Mehta', email: 'rohan@example.com', resume: pdf.text });
    assert.equal(a.status, 201, JSON.stringify(a.data));
    await req(`/api/candidates/${a.data.id}/screenings`, 'POST', { mode: 'phone' });
    const ctx = dograhCalls.at(-1).body.initial_context;
    assert.equal(ctx.has_resume, 'yes'); assert.ok(ctx.resume_probes.length > 20, 'expected probes from the PDF resume');
  });
  await t('engine room: overview masks keys, preview shows compaction and request, trace records a call', async () => {
    const o = (await req('/api/engine/overview')).data;
    assert.equal(o.dograh.phone_ready, true); assert.ok(!JSON.stringify(o).includes('dgr_test'), 'API key must be masked');
    assert.match(o.prompts.screener, /recruiting coordinator/);
    const p = (await req('/api/engine/preview', 'POST', { resume_text: 'Sales Executive, Acme Corp 2019-2021. Team Lead, Beta Ltd 2023-Present. Skills: CRM, Salesforce.' })).data;
    assert.equal(p.stage_2_compaction.gaps.length, 1); assert.ok(p.stage_2_compaction.probes.length >= 1);
    assert.equal(p.stage_4_dograh_request.headers['X-API-Key'].includes('dgr_test'), false);
    assert.match(p.stage_5_agent_prompt_rendered, /Walk me through|resume_probes|gap|nothing until 2023/i);
    const tr = (await req('/api/engine/trace')).data;
    assert.ok(tr.trace.some(x => x.kind === 'dograh_call_out'), 'outgoing Dograh call is traced');
    assert.ok(tr.trace.some(x => x.kind === 'dograh_webhook_in'), 'incoming webhook is traced');
  });
  await t('tunnel requests can only reach the webhook and health, not candidate data', async () => {
    const hit = p => fetch(`${B}${p}`, { headers: { 'cf-connecting-ip': '203.0.113.9' } });
    assert.equal((await hit('/api/candidates')).status, 403); assert.equal((await hit('/api/engine/overview')).status, 403); assert.equal((await hit('/dashboard')).status, 403);
    assert.equal((await hit('/api/health')).status, 200);
    assert.equal((await fetch(`${B}/api/candidates`)).status, 200);
  });
  await t('CSV import maps Naukri-style columns, skips duplicates and bad rows', async () => {
    const csv = 'Name,Email ID,Mobile,Current Location,Total Experience,Key Skills,Notice Period,Expected CTC (LPA)\nAsha Rao,asha@example.com,+910000000021,Pune,3 Yrs 6 Months,"Sales, CRM",2 Months,9\nAsha Rao,asha@example.com,+910000000021,Pune,3 Yrs,CRM,30 days,9\nNo Phone,np@example.com,,Pune,1 Yr,CRM,Immediate,4\n';
    const r = await req('/api/import/csv', 'POST', { job_id: 'inside-sales', label: 'testsheet', csv });
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.created, 1); assert.equal(r.data.skipped, 2);
    const list = await req('/api/candidates'); const asha = list.data.find(c => c.name === 'Asha Rao');
    assert.equal(asha.years, 3.5); assert.equal(asha.notice_days, 60); assert.equal(asha.source, 'csv:testsheet'); assert.match(asha.resume_text, /Key skills/);
    assert.equal((await req('/api/import/csv', 'POST', { job_id: 'inside-sales', csv: 'Foo,Bar\n1,2\n' })).status, 400);
  });
  await t('call queue is locked: strangers are skipped unless allowlisted or IMPORT_CALL_ANY=1', async () => {
    const csv = 'Name,Mobile\nStranger One,+919000000077\n';
    await req('/api/import/csv', 'POST', { job_id: 'inside-sales', label: 'locktest', csv });
    const r = await req('/api/import/call', 'POST', { source: 'csv:locktest', limit: 5, confirm: true, force: true });
    assert.equal(r.status, 200); assert.equal(r.data.queued, 0); assert.equal(r.data.skippedLocked, 1);
    assert.equal((await req('/api/import/call', 'POST', { source: 'csv:locktest' })).status, 400);
  });
  await t('negotiated salary replaces the ask in the score and is flagged', async () => {
    const sc = await import('./scoring.js');
    const job = { min_years: 0, max_salary: 150000, locations: ['pune'], must_skills: ['python'], max_notice_days: 90 };
    const cand = { years: 3, city: 'Pune', skills: 'Python', notice_days: 30, resume_text: 'x' };
    const base = { years_experience: 3, notice_days: 30, expected_salary: 200000, relocation_ok: true, skill_example: 'Built a recruiting system with python workers for several clients over two years.' };
    assert.equal(sc.scoreCandidate(cand, job, base).verdict, 'Reject');
    const neg = sc.scoreCandidate(cand, job, { ...base, negotiation_outcome: 'accepted', agreed_salary: 160000 });
    assert.ok(neg.total > sc.scoreCandidate(cand, job, base).total); assert.ok(neg.flags.some(f => /Negotiated/.test(f.text)));
    assert.equal(sc.parseAnswer({ type: 'salary' }, '90 LPA'), 750000); assert.equal(sc.parseAnswer({ type: 'salary' }, '2 lakh per month'), 200000);
  });
  await t('rejection call: only for rejected candidates, honours the lock, sends kind facts, webhook logs the outcome', async () => {
    const a = await req('/api/applications', 'POST', { ...applicant, name: 'Kavya Nair', email: 'kavya@example.com', phone: '+910000000099' });
    assert.equal((await req(`/api/candidates/${a.data.id}/rejection-call`, 'POST', { confirm: true })).status, 409);
    await req(`/api/candidates/${a.data.id}/stage`, 'POST', { stage: 'rejected' });
    assert.equal((await req(`/api/candidates/${a.data.id}/rejection-call`, 'POST', {})).status, 400);
    const r = await req(`/api/candidates/${a.data.id}/rejection-call`, 'POST', { confirm: true, force: true });
    assert.equal(r.status, 409); assert.match(r.data.error, /not set up|dialable|allowlist/);
    const wh = await req('/api/webhooks/dograh', 'POST', { workflow_run_id: 4242, initial_context: { kind: 'rejection', candidate_id: a.data.id }, gathered_context: { stay_in_talent_pool: true, reaction: 'positive' } });
    assert.equal(wh.status, 200); assert.equal(wh.data.ok, true);
    const c = await req(`/api/candidates/${a.data.id}`); assert.ok(c.data.events.some(e => /Rejection call finished/.test(e.detail)));
    const sc = await import('./suite.js'); const f = sc.rejectionFacts(JSON.stringify([{ label: 'Experience', points: 25, max: 25 }, { label: 'Salary fit', points: 0, max: 20 }]));
    assert.match(f.reason_short, /salary/); assert.match(f.strength_short, /experience/);
  });
  await t('rejection email: personal draft, allowlist lock, real SMTP send, duplicate guard, bulk', async () => {
    const mk = async (name, email) => { const a = await req('/api/applications', 'POST', { ...applicant, name, email, phone: '+910000000055' }); await req(`/api/candidates/${a.data.id}/stage`, 'POST', { stage: 'rejected' }); return a.data.id; };
    const okId = await mk('Meera Kapoor', 'allowed@example.com'), lockedId = await mk('Locked Person', 'locked@example.com');
    const prev = await req(`/api/candidates/${okId}/rejection-email`);
    assert.match(prev.data.text, /^Hi Meera,/); assert.equal(prev.data.allowed, true); assert.ok(!/—/.test(prev.data.text)); assert.match(prev.data.subject, /^Your application for/);
    assert.equal((await req(`/api/candidates/${lockedId}/rejection-email`)).data.allowed, false);
    assert.equal((await req(`/api/candidates/${lockedId}/rejection-email`, 'POST', { confirm: true })).status, 409);
    assert.equal((await req(`/api/candidates/${okId}/rejection-email`, 'POST', {})).status, 400);
    const s = await req(`/api/candidates/${okId}/rejection-email`, 'POST', { confirm: true }); assert.equal(s.status, 200, JSON.stringify(s.data));
    assert.equal(mails.length, 1); assert.equal(mails[0].rcpt, 'allowed@example.com'); assert.equal(mails[0].from, 'hr@example.com');
    assert.match(mails[0].decoded, /Hi Meera,/); assert.match(mails[0].raw, /Subject: Your application for/); assert.match(mails[0].html, /<p /);
    assert.equal((await req(`/api/candidates/${okId}/rejection-email`, 'POST', { confirm: true })).status, 409);
    const bulk = await req('/api/rejection-emails/send', 'POST', { confirm: true }); assert.equal(bulk.status, 200); assert.ok(bulk.data.locked >= 1 && bulk.data.already >= 1); assert.equal(mails.length, 1);
    const c = await req(`/api/candidates/${okId}`); assert.ok(c.data.events.some(e => /Rejection email sent/.test(e.detail)));
    const notRej = (await req('/api/applications', 'POST', { ...applicant, name: 'Still Open', email: 'allowed@example.com', phone: '+910000000056' })).data.id;
    assert.equal((await req(`/api/candidates/${notRej}/rejection-email`, 'POST', { confirm: true, resend: true })).status, 409);
  });
  await t('specifics beat vague claims, and the public form cannot ring strangers', async () => {
    const sc = await import('./scoring.js');
    const job = { min_years: 2, max_salary: 60000, locations: ['pune'], must_skills: ['crm'], max_notice_days: 30 };
    const cand = { years: 3, city: 'Pune', skills: 'CRM', notice_days: 20 };
    const base = { years_experience: 3, notice_days: 20, expected_salary: 50000, relocation_ok: true };
    const vague = sc.scoreCandidate(cand, job, { ...base, evidence_text: 'I built a CRM. It was good and the company liked it a lot.' });
    const specific = sc.scoreCandidate(cand, job, { ...base, evidence_text: 'I built a CRM for a logistics company. It saved them 12 lakhs a year. It cut order entry time by 60 percent in four months. We had 300 users on it. I led a team of 5.' });
    assert.ok(specific.total >= vague.total + 10, `${specific.total} vs ${vague.total}`);
    assert.ok(vague.flags.some(f => /Vague/.test(f.text))); assert.ok(specific.flags.some(f => /Specific/.test(f.text)));
    assert.ok(sc.evidenceOf('I saved 12 lakhs and cut time by 60 percent. We had 300 users.').proof.length >= 1);
    // public form guards
    const mkc = async (extra) => (await req('/api/applications', 'POST', { ...applicant, email: `g${Math.random().toString(36).slice(2, 7)}@example.com`, ...extra })).data.id;
    assert.equal((await req(`/api/candidates/${await mkc({ consent: false })}/screenings`, 'POST', { mode: 'phone' })).status, 403);
    assert.equal((await req(`/api/candidates/${await mkc({ phone: '+919000000123' })}/screenings`, 'POST', { mode: 'phone' })).status, 409);
    const ok = await mkc({ phone: '+910000000099' });
    assert.equal((await req(`/api/candidates/${ok}/screenings`, 'POST', { mode: 'phone' })).status, 201);
    assert.equal((await req(`/api/candidates/${ok}/screenings`, 'POST', { mode: 'phone' })).status, 429);
  });
  await t('per-role voice: a role with a voice gets its own agent and name, other roles use the default, bad voices are ignored', async () => {
    const j = await req('/api/jobs', 'POST', { title: 'IT Consultant', company: 'Acme', location: 'Pune', voice: 'Kore', agent_name: 'Riya', must_skills: 'sales', locations: 'pune', description: 'Client facing.' });
    assert.equal(j.status, 201); assert.equal(j.data.agent_ready, true);
    assert.equal(dograhCalls.filter(c => c.url === '/api/v1/workflow/create/definition').length, 1);
    const put = dograhCalls.find(c => c.url === '/api/v1/workflow/55' && c.body?.workflow_configurations);
    assert.equal(put.body.workflow_configurations.model_voice_override.voice, 'Kore'); assert.equal(put.body.workflow_configurations.max_call_duration, 900);
    assert.ok(!put.body.workflow_definition.nodes.find(n => n.type === 'trigger').data.trigger_path, 'the copy must not reuse the base trigger path');
    const a = await req('/api/applications', 'POST', { ...applicant, job_id: j.data.id, name: 'Consult Candidate', email: 'cc@example.com' });
    assert.equal((await req(`/api/candidates/${a.data.id}/screenings`, 'POST', { mode: 'phone' })).status, 201);
    const last = () => dograhCalls.filter(c => /public\/agent\/workflow/.test(c.url)).pop();
    assert.ok(last().url.endsWith('/role-uuid-55')); assert.equal(last().body.initial_context.job_title, 'IT Consultant'); assert.equal(last().body.initial_context.agent_name, 'Riya');
    const a2 = await req('/api/applications', 'POST', { ...applicant, name: 'Default Candidate', email: 'dc@example.com' });
    await req(`/api/candidates/${a2.data.id}/screenings`, 'POST', { mode: 'phone' });
    assert.ok(last().url.endsWith('/agent-uuid-1')); assert.equal(last().body.initial_context.agent_name, 'Priya');
    const vc = (await req('/api/voices')).data; assert.equal(vc.supported, true); assert.ok(vc.voices.some(v => v.id === 'Kore'));
    const bad = await req('/api/jobs', 'POST', { title: 'Bad Voice Role', voice: 'Hacker' }); assert.equal(bad.status, 201);
    const row = (await req('/api/jobs')).data.find(x => x.id === bad.data.id); assert.ok(!row.voice);
    const before = dograhCalls.filter(c => c.url === '/api/v1/workflow/create/definition').length;
    await req('/api/jobs/' + j.data.id, 'PUT', { voice: 'Puck' });
    assert.equal(dograhCalls.filter(c => c.url === '/api/v1/workflow/create/definition').length, before, 'changing the voice updates the same agent');
    assert.equal(dograhCalls.filter(c => c.url === '/api/v1/workflow/55' && c.body?.workflow_configurations?.model_voice_override?.voice === 'Puck').length, 1);
  });
  await t('standard Dograh (no per-agent voices): voice choices are not faked, calls use the default agent, and the UI is told why', async () => {
    catalogOff = true;
    try {
      const copies = dograhCalls.filter(c => c.url === '/api/v1/workflow/create/definition').length;
      const j = await req('/api/jobs', 'POST', { title: 'Standard Build Role', voice: 'Kore', agent_name: 'Riya', must_skills: 'x', locations: 'pune', description: 'x' });
      assert.equal(j.status, 201); assert.equal(j.data.agent_ready, true); // nothing to build, default agent is used
      assert.equal(dograhCalls.filter(c => c.url === '/api/v1/workflow/create/definition').length, copies, 'no useless copies are created');
      const a = await req('/api/applications', 'POST', { ...applicant, job_id: j.data.id, name: 'Std Candidate', email: 'std@example.com' });
      assert.equal((await req(`/api/candidates/${a.data.id}/screenings`, 'POST', { mode: 'phone' })).status, 201);
      const last = dograhCalls.filter(c => /public\/agent\/workflow/.test(c.url)).pop();
      assert.ok(last.url.endsWith('/agent-uuid-1')); assert.equal(last.body.initial_context.agent_name, 'Riya', 'the name still applies');
      const v = (await req('/api/voices')).data; assert.equal(v.supported, false); assert.match(v.note, /one voice/);
      assert.equal((await req('/api/app-settings/voice-model', 'POST', { provider: 'google_realtime', api_key: 'k' })).status, 409);
      assert.equal((await req('/api/app-settings/dograh-status')).data.build, 'standard');
    } finally { catalogOff = false; }
  });
  await t('settings page: secrets encrypted and masked, brand applies live, blank keeps, clear restores, locked when public without a password', async () => {
    const s1 = await req('/api/app-settings'); assert.equal(s1.status, 200); assert.equal(s1.data.can_manage, true);
    assert.ok(s1.data.fields.find(f => f.key === 'DOGRAH_API_KEY').type === 'secret');
    const secret = 'gsk_supersecretvalue1234';
    const put = await req('/api/app-settings', 'PUT', { values: { BRAND_NAME: 'Acme Staffing', GROQ_API_KEY: secret, LLM_DAILY_CAP: '55' } });
    assert.equal(put.status, 200); assert.deepEqual(put.data.changed.sort(), ['BRAND_NAME', 'GROQ_API_KEY', 'LLM_DAILY_CAP']);
    const s2 = await req('/api/app-settings'); const raw = JSON.stringify(s2.data);
    assert.ok(!raw.includes(secret), 'the secret must never be sent back'); assert.equal(s2.data.fields.find(f => f.key === 'GROQ_API_KEY').hint, '••••1234');
    assert.equal(s2.data.fields.find(f => f.key === 'BRAND_NAME').source, 'settings');
    assert.equal((await req('/api/config')).data.brand, 'Acme Staffing');
    const { DatabaseSync } = await import('node:sqlite'); const rawDb = new DatabaseSync(path.join(dir, 't.db'));
    const row = rawDb.prepare("SELECT value, secret FROM app_settings WHERE key='GROQ_API_KEY'").get();
    assert.equal(row.secret, 1); assert.ok(row.value.startsWith('v1:') && !row.value.includes(secret), 'stored encrypted'); rawDb.close();
    assert.equal((await req('/api/app-settings', 'PUT', { values: { GROQ_API_KEY: '' } })).data.changed.length, 0);
    assert.equal((await req('/api/app-settings')).data.fields.find(f => f.key === 'GROQ_API_KEY').hint, '••••1234');
    await req('/api/app-settings', 'PUT', { values: { BRAND_NAME: null } });
    assert.equal((await req('/api/config')).data.brand, 'Recruit OS');
    assert.equal((await req('/api/app-settings', 'PUT', { values: { NOT_A_SETTING: 'x' } })).status, 400);
    assert.equal((await req('/api/app-settings', 'PUT', { values: { LLM_DAILY_CAP: 'lots' } })).status, 400);
    const pub = await fetch(`${B}/api/app-settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.5' }, body: JSON.stringify({ values: { BRAND_NAME: 'Hacked' } }) });
    assert.equal(pub.status, 403, 'public dashboard without a password cannot change secrets');
  });
  await t('settings tests and helpers: mailbox login, voice engine connection, create agents, phone provider, voice model', async () => {
    await req('/api/app-settings', 'PUT', { values: { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(SMTP_PORT), SMTP_SECURE: '0', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'hr@example.com' } });
    assert.equal((await req('/api/app-settings/test', 'POST', { what: 'email' })).data.ok, true);
    await req('/api/app-settings', 'PUT', { values: { SMTP_PASS: 'wrong' } });
    assert.equal((await req('/api/app-settings/test', 'POST', { what: 'email' })).data.ok, false);
    const dg = await req('/api/app-settings/test', 'POST', { what: 'dograh' }); assert.equal(dg.data.ok, true); assert.match(dg.data.message, /9\.9\.9-mock/);
    assert.equal((await req('/api/app-settings/create-agents', 'POST', {})).status, 502, 'needs the public address first');
    await req('/api/app-settings', 'PUT', { values: { PUBLIC_BASE_URL: 'https://recruit.example.com' } });
    const made = await req('/api/app-settings/create-agents', 'POST', {}); assert.equal(made.status, 200, JSON.stringify(made.data));
    assert.ok(made.data.agents.some(a => a.status === 'already set up') && made.data.agents.some(a => a.status === 'created'));
    assert.equal((await req('/api/app-settings')).data.fields.find(f => f.key === 'DOGRAH_REJECTION_AGENT_UUID').value, 'role-uuid-55');
    const hook = dograhCalls.filter(c => c.url === '/api/v1/workflow/55' && c.body?.workflow_definition).pop().body.workflow_definition.nodes.find(n => n.type === 'webhook');
    assert.equal(hook?.data.endpoint_url, 'https://recruit.example.com/api/webhooks/dograh', 'results are posted back to this server');
    const st = await req('/api/app-settings/dograh-status'); assert.equal(st.data.phone_providers[0].numbers, 1); assert.equal(st.data.voice_model.key_set, true);
    assert.equal((await req('/api/app-settings/phone-provider', 'POST', { account_sid: 'nope', auth_token: 'x', phone_number: '+14155550123' })).status, 400);
    assert.equal((await req('/api/app-settings/phone-provider', 'POST', { account_sid: 'AC' + 'a'.repeat(32), auth_token: 'tok', phone_number: '123' })).status, 400);
    const ph = await req('/api/app-settings/phone-provider', 'POST', { account_sid: 'AC' + 'a'.repeat(32), auth_token: 'tok', phone_number: '+14155550123' }); assert.equal(ph.status, 200, JSON.stringify(ph.data));
    const sent = dograhCalls.filter(c => c.url === '/api/v1/organizations/telephony-configs' && c.body?.config?.account_sid); assert.equal(sent.length, 1); assert.equal(sent[0].body.config.auth_token, 'tok');
    assert.ok(!JSON.stringify((await req('/api/app-settings')).data).includes('"tok"'), 'the Twilio token is not stored here');
    assert.equal((await req('/api/app-settings/voice-model', 'POST', { provider: 'bogus', api_key: 'k' })).status, 400);
    assert.equal((await req('/api/app-settings/voice-model', 'POST', { provider: 'google_realtime', api_key: 'k123' })).status, 200);
    assert.ok(dograhCalls.some(c => c.url === '/api/v1/user/configurations/user' && c.body?.realtime?.provider === 'google_realtime'));
  });
} finally {
  app.kill(); mock.close(); smtp.close();
}
console.log(`\n${pass} passed${process.exitCode ? ', SOME FAILED' : ''}`);
