// LLM router for the recruiting suite. Cheap by design:
//  - free / low-cost providers first (Groq, Z.ai GLM flash, Pollinations, any custom OpenAI-compatible URL, then Grok, then Claude Haiku)
//  - response cache, daily call cap, per-provider cooldown after failures
//  - personal data (emails, phone numbers) is stripped from every prompt before it leaves this machine
//  - every feature in suite.js has a rules-based fallback, so no key or no quota never breaks the app
import { createHash } from 'node:crypto';

const env = (k, d = '') => process.env[k] || d;

const PROVIDERS = {
  groq: { kind: 'openai', keyEnv: 'GROQ_API_KEY', url: () => 'https://api.groq.com/openai/v1/chat/completions', key: () => env('GROQ_API_KEY'), model: () => env('GROQ_MODEL', 'llama-3.1-8b-instant') },
  zai: { kind: 'openai', keyEnv: 'ZAI_API_KEY', url: () => env('ZAI_BASE_URL', 'https://api.z.ai/api/paas/v4/chat/completions'), key: () => env('ZAI_API_KEY'), model: () => env('ZAI_MODEL', 'glm-4.5-flash'), extra: { thinking: { type: 'disabled' } } },
  pollinations: { kind: 'openai', keyEnv: 'POLLINATIONS_API_KEY (optional)', keyless: true, url: () => env('POLLINATIONS_BASE_URL', 'https://text.pollinations.ai/openai'), key: () => env('POLLINATIONS_API_KEY'), model: () => env('POLLINATIONS_MODEL', 'mistral') },
  custom: { kind: 'openai', keyEnv: 'LLM_CUSTOM_URL + LLM_CUSTOM_MODEL (+ LLM_CUSTOM_KEY)', keyless: true, url: () => env('LLM_CUSTOM_URL'), key: () => env('LLM_CUSTOM_KEY'), model: () => env('LLM_CUSTOM_MODEL', 'default') },
  xai: { kind: 'openai', keyEnv: 'XAI_API_KEY', url: () => 'https://api.x.ai/v1/chat/completions', key: () => env('XAI_API_KEY'), model: () => env('XAI_MODEL', 'grok-3-mini') },
  anthropic: { kind: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY', url: () => env('ANTHROPIC_API_URL', 'https://api.anthropic.com') + '/v1/messages', key: () => env('ANTHROPIC_API_KEY'), model: () => env('ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001') },
};

// Pollinations is only used when explicitly switched on, because it is an anonymous public service.
function chain() {
  if (env('LLM_DISABLE') === '1') return [];
  const names = env('LLM_CHAIN', 'groq,zai,pollinations,custom,xai,anthropic').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return names
    .filter(n => PROVIDERS[n])
    .map(n => ({ name: n, ...PROVIDERS[n] }))
    .filter(p => p.url() && (p.key() || (p.keyless && (p.name !== 'pollinations' || env('POLLINATIONS_ENABLED') === '1'))));
}

const redact = s => String(s)
  .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
  .replace(/\+?\d[\d\s().-]{8,}\d/g, m => (m.replace(/\D/g, '').length >= 10 ? '[phone]' : m));
const strip = t => String(t).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

export function extractJSON(text) {
  const t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  for (const [a, b] of [['{', '}'], ['[', ']']]) {
    const i = t.indexOf(a), j = t.lastIndexOf(b);
    if (i !== -1 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch { /* try next */ } }
  }
  return null;
}

export function createLLM(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_cache (k TEXT PRIMARY KEY, text TEXT, provider TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS llm_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT, task TEXT, provider TEXT, model TEXT, ok INTEGER, cached INTEGER, ms INTEGER, in_chars INTEGER, out_chars INTEGER, error TEXT, at TEXT DEFAULT (datetime('now')));
  `);
  const cool = new Map();
  const today = () => new Date().toISOString().slice(0, 10);
  const log = (task, provider, model, ok, cached, ms, inC, outC, error) =>
    db.prepare('INSERT INTO llm_usage (day,task,provider,model,ok,cached,ms,in_chars,out_chars,error) VALUES (?,?,?,?,?,?,?,?,?,?)').run(today(), task, provider, model, ok, cached, ms, inC, outC, error);
  const used = () => db.prepare('SELECT COUNT(*) n FROM llm_usage WHERE day=? AND cached=0').get(today()).n;

  async function callProvider(p, { system, prompt, maxTokens, temperature }) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), Number(env('LLM_TIMEOUT_MS', '30000')));
    try {
      let res;
      if (p.kind === 'anthropic') {
        res = await fetch(p.url(), {
          method: 'POST', signal: ctl.signal,
          headers: { 'content-type': 'application/json', 'x-api-key': p.key(), 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: p.model(), max_tokens: maxTokens, temperature, system, messages: [{ role: 'user', content: prompt }] }),
        });
      } else {
        const headers = { 'content-type': 'application/json' };
        if (p.key()) headers.authorization = `Bearer ${p.key()}`;
        res = await fetch(p.url(), {
          method: 'POST', signal: ctl.signal, headers,
          body: JSON.stringify({ model: p.model(), max_tokens: maxTokens, temperature, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], ...(p.extra || {}) }),
        });
      }
      const raw = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`);
      let data;
      try { data = JSON.parse(raw); } catch { if (raw.trim()) return raw.trim(); throw new Error('non-JSON response'); }
      const text = p.kind === 'anthropic' ? (data.content || []).map(c => c.text || '').join('') : data.choices?.[0]?.message?.content;
      if (!text || !String(text).trim()) throw new Error('empty response');
      return String(text);
    } finally { clearTimeout(to); }
  }

  async function ask({ task = 'general', system = '', prompt, maxTokens = 400, temperature = 0.2, cache = false }) {
    const clean = redact(prompt);
    const key = createHash('sha256').update(`${task}\n${system}\n${clean}`).digest('hex');
    if (cache) {
      const hit = db.prepare('SELECT text, provider FROM llm_cache WHERE k=?').get(key);
      if (hit) { log(task, hit.provider, '', 1, 1, 0, clean.length, hit.text.length, ''); return { ok: true, text: hit.text, provider: hit.provider, cached: true }; }
    }
    const all = chain();
    if (!all.length) return { ok: false, error: 'no LLM provider configured (see .env.example)' };
    const cap = Number(env('LLM_DAILY_CAP', '400'));
    if (used() >= cap) return { ok: false, error: `daily LLM cap of ${cap} calls reached` };
    const live = all.filter(p => !(cool.get(p.name) > Date.now()));
    let lastErr = 'no provider answered';
    for (const p of live.length ? live : all) {
      const t0 = Date.now();
      try {
        const text = strip(await callProvider(p, { system, prompt: clean, maxTokens, temperature }));
        if (!text) throw new Error('empty after cleaning');
        log(task, p.name, p.model(), 1, 0, Date.now() - t0, clean.length, text.length, '');
        if (cache) db.prepare('INSERT OR REPLACE INTO llm_cache (k,text,provider) VALUES (?,?,?)').run(key, text, p.name);
        return { ok: true, text, provider: p.name, cached: false };
      } catch (e) {
        lastErr = `${p.name}: ${e.message}`;
        cool.set(p.name, Date.now() + 2 * 60000);
        log(task, p.name, p.model(), 0, 0, Date.now() - t0, clean.length, 0, String(e.message).slice(0, 200));
      }
    }
    return { ok: false, error: lastErr };
  }

  async function askJSON(o) {
    const r = await ask({ ...o, system: `${o.system || ''}\nReply with one valid JSON object only. No markdown, no commentary.` });
    if (!r.ok) return r;
    const json = extractJSON(r.text);
    return json ? { ...r, json } : { ok: false, error: 'model did not return valid JSON', text: r.text };
  }

  function status() {
    const day = today();
    const live = chain();
    const rows = db.prepare('SELECT provider, COUNT(*) n, SUM(ok) ok FROM llm_usage WHERE day=? AND cached=0 GROUP BY provider').all(day);
    return {
      chain: live.map(p => ({ name: p.name, model: p.model() })),
      providers: Object.entries(PROVIDERS).map(([name, p]) => ({ name, configured: live.some(l => l.name === name), needs: p.keyEnv, model: p.model() })),
      calls_today: rows.reduce((s, r) => s + r.n, 0),
      cap: Number(env('LLM_DAILY_CAP', '400')),
      cached_today: db.prepare('SELECT COUNT(*) n FROM llm_usage WHERE day=? AND cached=1').get(day).n,
      by_provider: rows,
      disabled: env('LLM_DISABLE') === '1',
      note: 'Personal data is stripped from prompts. Without a provider every feature falls back to rules.',
    };
  }

  return { ask, askJSON, status, chain };
}
