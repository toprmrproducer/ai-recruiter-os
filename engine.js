// Engine room: read-only visibility into what the backend is doing (Dograh wiring, resume compaction, outgoing call
// payloads, incoming webhooks, event feed). No secrets are ever returned (keys are masked).
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { resumeProbes } from './scoring.js';

const TRACE = []; // newest first, in memory
export function trace(kind, detail) { TRACE.unshift({ at: new Date().toISOString(), kind, ...detail }); TRACE.length = Math.min(TRACE.length, 100); }

const mask = k => (k ? `${String(k).slice(0, 4)}...${'*'.repeat(6)}` : '(not set)');
const host = u => { try { return new URL(u).host; } catch { return u || ''; } };

export function createEngine({ root, DOGRAH, db, jobRow, screeningContext, llmStatus, send, body, ready }) {
  const promptFile = f => { const p = path.join(root, 'dograh', f); return existsSync(p) ? readFileSync(p, 'utf8') : ''; };
  const systemPrompt = f => { const t = promptFile(f); const i = t.indexOf('## System prompt'); if (i < 0) return '';
    const rest = t.slice(i + 16); const j = rest.search(/\n## (?!Resume-driven)/); return (j < 0 ? rest : rest.slice(0, j)).trim(); };
  // Renders both the flat Dograh style {{var | fallback:text}} and the older {{initial_context.var}} style.
  const render = (tpl, ctx) => tpl.replace(/\{\{\s*(?:initial_context\.)?(\w+)\s*(?:\|\s*fallback:([^}]*))?\}\}/g, (_, k, fb) => (ctx[k] !== undefined && ctx[k] !== '' ? ctx[k] : (fb !== undefined ? fb.trim() : `(empty)`)));
  const screenerPrompt = () => promptFile('screener-prompt.txt').trim();

  return async function route(req, res, p, m) {
    if (p === '/api/engine/overview' && m === 'GET') {
      const count = t => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
      return send(res, 200, {
        now: new Date().toISOString(),
        dograh: {
          base_url: DOGRAH.base || '(not set)', host: host(DOGRAH.base), api_key: mask(DOGRAH.apiKey), screener_agent_uuid: DOGRAH.agentUuid || '(not set)',
          reference_agent_uuid: DOGRAH.refAgentUuid || '(not set)', reminder_agent_uuid: DOGRAH.reminderAgentUuid || '(not set)', embed_token: mask(DOGRAH.embedToken),
          webhook_secret: DOGRAH.webhookSecret ? 'set' : '(not set, webhook is open)', phone_ready: ready.phone(), web_ready: ready.web(),
          webhook_path: '/api/webhooks/dograh',
        },
        llm: llmStatus(),
        counts: { candidates: count('candidates'), screenings: count('screenings'), events: count('events'), jobs: count('jobs') },
        prompts: { screener: screenerPrompt(), reference: systemPrompt('reference-agent-prompt.md'), reminder: systemPrompt('reminder-agent-prompt.md') },
      });
    }
    if (p === '/api/engine/trace' && m === 'GET') {
      const events = db.prepare(`SELECT e.id, e.at, e.kind, e.detail, c.name FROM events e LEFT JOIN candidates c ON c.id=e.candidate_id ORDER BY e.id DESC LIMIT 60`).all();
      return send(res, 200, { trace: TRACE, events });
    }
    if (p === '/api/engine/preview' && m === 'POST') {
      const b = await body(req);
      const text = String(b.resume_text || '').slice(0, 20000);
      const jobs = db.prepare('SELECT id FROM jobs ORDER BY created_at').all();
      // A clean production database has no fictional job records. The lab can still
      // demonstrate resume interrogation with a non-persisted role supplied by the user.
      const selectedJobId = b.job_id && jobs.some(j => j.id === b.job_id) ? b.job_id : jobs[0]?.id;
      const job = selectedJobId ? jobRow(selectedJobId) : null || {
        id: 'preview-software-engineer', title: String(b.job_title || 'Software Engineer'), company: String(b.company || process.env.BRAND_NAME || 'Your Company'),
        location: String(b.job_location || 'Pune or remote'), min_years: Number(b.min_years) || 1,
        max_salary: Number(b.max_salary) || 0, locations: ['pune', 'remote'],
        must_skills: Array.isArray(b.must_skills) && b.must_skills.length ? b.must_skills : ['javascript', 'python', 'backend systems'],
        max_notice_days: Number(b.max_notice_days) || 90, custom_questions: 'Explain a production failure you owned|Describe how you would protect candidate data',
      };
      const cand = { id: 'preview', name: String(b.name || 'Preview Candidate'), city: String(b.city || 'Pune'), years: Number(b.years) || 3, notice_days: Number(b.notice_days) || 30,
        expected_salary: Number(b.expected_salary) || 50000, skills: String(b.skills || ''), resume_text: text, resume_summary: null, phone: String(b.phone || '+910000000000') };
      const probes = resumeProbes(text);
      const context = screeningContext(cand, job);
      const url = `${DOGRAH.base || 'https://<your-dograh-host>'}/api/v1/public/agent/workflow/${DOGRAH.agentUuid || '<screener-agent-uuid>'}`;
      return send(res, 200, {
        stage_1_resume_text: { chars: text.length, text: text.slice(0, 3000) },
        stage_2_compaction: { gaps: probes.gaps, skills: probes.skills, probes: probes.probes, summary: probes.summary },
        stage_3_initial_context: context,
        stage_4_dograh_request: { method: 'POST', url, headers: { 'Content-Type': 'application/json', 'X-API-Key': mask(DOGRAH.apiKey) }, body: { phone_number: cand.phone, initial_context: context },
          would_send: ready.phone() ? 'yes, Dograh is configured' : 'NO: Dograh is not configured, this is a dry run' },
        stage_5_agent_prompt_rendered: render(screenerPrompt(), context),
        job: { title: job.title, company: job.company },
      });
    }
    return false;
  };
}
