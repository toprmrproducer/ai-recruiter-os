// Settings stored in the database so nobody has to edit environment variables or .env files.
// - Secrets (API keys, passwords) are encrypted at rest with AES-256-GCM. The key lives next to the database
//   (data key file, mode 600) or comes from the SETTINGS_KEY environment variable.
// - Values saved here override the same names from .env / the environment. Clearing a value restores the .env one.
// - Secret values are never returned by the API, only a masked hint.
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';

export const GROUPS = [
  { id: 'brand', title: 'Your brand', help: 'What applicants and the AI see.' },
  { id: 'voice', title: 'Voice engine (Dograh)', help: 'Dograh places the phone calls. Create the account, then paste the address and API key here.' },
  { id: 'safety', title: 'Who can be called and emailed', help: 'Safety locks. Until you switch to production, only the numbers and addresses listed here can be contacted.' },
  { id: 'email', title: 'Email (rejection emails)', help: 'Any SMTP mailbox works: Hostinger, Google Workspace, Microsoft 365, Zoho, Mailgun.' },
  { id: 'ai', title: 'AI writing and analysis (optional)', help: 'Job drafts, resume analysis, message drafts. Leave empty and the built-in rules are used instead.' },
  { id: 'security', title: 'Dashboard security', help: 'Protect the dashboard before you put it on the internet.' },
];

// type: text | secret | number | toggle | select | textarea
export const FIELDS = [
  { key: 'BRAND_NAME', group: 'brand', label: 'Company or brand name', type: 'text', placeholder: 'e.g. Acme Staffing', help: 'Shown in the dashboard header and used when a role has no company.' },
  { key: 'AGENT_NAME', group: 'brand', label: 'Default AI recruiter name', type: 'text', placeholder: 'Priya', help: 'The first name the AI introduces itself with. Each role can override it.' },
  { key: 'PUBLIC_BASE_URL', group: 'brand', label: 'This server\'s public address', type: 'text', placeholder: 'https://recruit.yourdomain.com', help: 'Dograh posts call results back to this address, so it must be reachable from the internet (a domain or a tunnel). http://localhost works only for browser-only testing.' },
  { key: 'CAREERS_URL', group: 'brand', label: 'Public careers page address (optional)', type: 'text', placeholder: 'https://careers.yourdomain.com', help: 'Used for the Copy apply link buttons. Leave empty to use this server.' },

  { key: 'DOGRAH_BASE_URL', group: 'voice', label: 'Dograh address', type: 'text', placeholder: 'http://localhost:8000', help: 'Where your Dograh runs.' },
  { key: 'DOGRAH_API_KEY', group: 'voice', label: 'Dograh API key', type: 'secret', placeholder: 'dgr_... or oss_sk_...', help: 'Dograh dashboard > Settings > API keys.' },
  { key: 'DOGRAH_AGENT_UUID', group: 'voice', label: 'Screening agent ID', type: 'text', help: 'Filled in by the Create the AI agents button below.' },
  { key: 'DOGRAH_WORKFLOW_ID', group: 'voice', label: 'Screening agent number', type: 'number', help: 'Filled in automatically. Needed for per-role voices.' },
  { key: 'DOGRAH_REJECTION_AGENT_UUID', group: 'voice', label: 'Rejection call agent ID (optional)', type: 'text', help: 'Filled in by the Create the AI agents button.' },
  { key: 'DOGRAH_REJECTION_WORKFLOW_ID', group: 'voice', label: 'Rejection call agent number (optional)', type: 'number', help: 'Filled in automatically.' },
  { key: 'DOGRAH_EMBED_TOKEN', group: 'voice', label: 'Browser voice token (optional)', type: 'secret', help: 'Only for browser voice screens.' },
  { key: 'WEBHOOK_SECRET', group: 'voice', label: 'Webhook secret (optional)', type: 'secret', help: 'If set, Dograh must send it as X-Webhook-Secret.' },

  { key: 'IMPORT_CALL_ALLOWLIST', group: 'safety', label: 'Phone numbers that may be called', type: 'textarea', placeholder: '+919876543210, +14155550123', help: 'Comma or line separated, full international format. Put your own number here to test.' },
  { key: 'IMPORT_CALL_ANY', group: 'safety', label: 'Production calling: allow calls to any applicant', type: 'toggle', help: 'Turn on only when every applicant has consented to a call and you have checked do-not-call rules for your country.' },
  { key: 'MAIL_ALLOWLIST', group: 'safety', label: 'Email addresses that may receive rejection emails', type: 'textarea', placeholder: 'you@yourdomain.com, @yourdomain.com', help: 'Addresses or whole @domains, comma or line separated.' },
  { key: 'MAIL_SEND_ANY', group: 'safety', label: 'Production email: allow emails to any candidate', type: 'toggle', help: 'Turn on only when you are ready to email real candidates.' },

  { key: 'SMTP_HOST', group: 'email', label: 'SMTP host', type: 'text', placeholder: 'smtp.hostinger.com' },
  { key: 'SMTP_PORT', group: 'email', label: 'SMTP port', type: 'number', placeholder: '465', help: '465 for SSL/TLS, 587 for STARTTLS.' },
  { key: 'SMTP_SECURE', group: 'email', label: 'Connection type', type: 'select', options: [['1', 'SSL/TLS (port 465)'], ['0', 'STARTTLS (port 587)']] },
  { key: 'SMTP_USER', group: 'email', label: 'Mailbox login', type: 'text', placeholder: 'you@yourdomain.com' },
  { key: 'SMTP_PASS', group: 'email', label: 'Mailbox password', type: 'secret' },
  { key: 'MAIL_FROM', group: 'email', label: 'From address (optional)', type: 'text', help: 'Defaults to the mailbox login.' },
  { key: 'MAIL_FROM_NAME', group: 'email', label: 'From name', type: 'text', placeholder: 'Acme Talent Team' },
  { key: 'MAIL_REPLY_TO', group: 'email', label: 'Reply-to address (optional)', type: 'text' },
  { key: 'MAIL_SIGNATURE_NAME', group: 'email', label: 'Signed as (optional)', type: 'text', placeholder: 'The Acme Talent Team' },

  { key: 'GROQ_API_KEY', group: 'ai', label: 'Groq API key (free tier available)', type: 'secret', help: 'console.groq.com' },
  { key: 'ZAI_API_KEY', group: 'ai', label: 'Z.ai API key (free flash model)', type: 'secret' },
  { key: 'ANTHROPIC_API_KEY', group: 'ai', label: 'Anthropic API key', type: 'secret' },
  { key: 'XAI_API_KEY', group: 'ai', label: 'xAI API key', type: 'secret' },
  { key: 'LLM_CUSTOM_URL', group: 'ai', label: 'Any OpenAI-compatible endpoint (optional)', type: 'text', placeholder: 'https://openrouter.ai/api/v1/chat/completions', help: 'Ollama, OpenRouter, LM Studio and similar.' },
  { key: 'LLM_CUSTOM_KEY', group: 'ai', label: 'Key for that endpoint', type: 'secret' },
  { key: 'LLM_CUSTOM_MODEL', group: 'ai', label: 'Model name for that endpoint', type: 'text' },
  { key: 'LLM_DAILY_CAP', group: 'ai', label: 'Maximum AI calls per day', type: 'number', placeholder: '400' },
  { key: 'LLM_DISABLE', group: 'ai', label: 'Switch all AI writing off', type: 'toggle' },

  { key: 'ADMIN_PASSWORD', group: 'security', label: 'Dashboard password', type: 'secret', help: 'Everyone who opens the dashboard must enter this. Set it before going online.' },
];
const BY_KEY = Object.fromEntries(FIELDS.map(f => [f.key, f]));

export function createSettings(db, dbPath) {
  db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, secret INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime(\'now\')))');
  const original = {}; for (const f of FIELDS) original[f.key] = process.env[f.key]; // what .env / the real environment said

  // ---- encryption key: env var, else a key file next to the database (created on first use, readable only by you)
  const keyFile = `${dbPath}.key`;
  const masterKey = () => {
    if (process.env.SETTINGS_KEY) return createHash('sha256').update(process.env.SETTINGS_KEY).digest();
    if (!existsSync(keyFile)) { writeFileSync(keyFile, randomBytes(32).toString('base64'), { mode: 0o600 }); try { chmodSync(keyFile, 0o600); } catch {} }
    return createHash('sha256').update(readFileSync(keyFile, 'utf8').trim()).digest();
  };
  const encrypt = plain => { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', masterKey(), iv); const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]); return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`; };
  const decrypt = blob => { const [v, iv, tag, data] = String(blob).split(':'); if (v !== 'v1') throw new Error('unknown format'); const d = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64')); d.setAuthTag(Buffer.from(tag, 'base64')); return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8'); };

  const stored = () => Object.fromEntries(db.prepare('SELECT key, value, secret FROM app_settings').all().map(r => {
    try { return [r.key, r.secret ? decrypt(r.value) : r.value]; } catch { return [r.key, undefined]; } // wrong key or damaged row: ignore it, never crash
  }));

  // Put saved values into process.env so every part of the app that reads the environment sees them.
  function apply() {
    const s = stored();
    for (const f of FIELDS) {
      if (s[f.key] !== undefined && s[f.key] !== '') process.env[f.key] = String(s[f.key]);
      else if (original[f.key] === undefined) delete process.env[f.key];
      else process.env[f.key] = original[f.key];
    }
    return s;
  }
  const mask = v => { const t = String(v); return t.length <= 4 ? '••••' : `••••${t.slice(-4)}`; };

  function view() {
    const s = stored();
    return FIELDS.map(f => {
      const fromUi = s[f.key] !== undefined && s[f.key] !== '';
      const current = process.env[f.key];
      const set = current !== undefined && current !== '';
      const out = { key: f.key, group: f.group, label: f.label, type: f.type, help: f.help || '', placeholder: f.placeholder || '', options: f.options || null, is_set: set, source: fromUi ? 'settings' : (set ? 'environment' : 'unset') };
      if (f.type === 'secret') out.hint = set ? mask(current) : '';
      else out.value = set ? String(current) : '';
      return out;
    });
  }

  // values: { KEY: 'new value' }. Empty string on a secret keeps it; null clears it (back to .env / unset). Unknown keys are rejected.
  function save(values) {
    const changed = [];
    for (const [k, raw] of Object.entries(values || {})) {
      const f = BY_KEY[k]; if (!f) throw new Error(`unknown setting ${k}`);
      if (raw === null) { db.prepare('DELETE FROM app_settings WHERE key=?').run(k); changed.push(k); continue; }
      const v = String(raw).trim();
      if (f.type === 'secret' && v === '') continue;            // blank secret field = leave as it is
      if (v === '') { db.prepare('DELETE FROM app_settings WHERE key=?').run(k); changed.push(k); continue; }
      if (f.type === 'number' && !Number.isFinite(Number(v))) throw new Error(`${f.label} must be a number`);
      if (f.type === 'toggle' && !['0', '1'].includes(v)) throw new Error(`${f.label} must be on or off`);
      if (f.type === 'select' && !f.options.some(o => o[0] === v)) throw new Error(`${f.label} has an invalid choice`);
      if (v.length > 4000) throw new Error(`${f.label} is too long`);
      db.prepare('INSERT INTO app_settings (key, value, secret, updated_at) VALUES (?,?,?,datetime(\'now\')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, secret=excluded.secret, updated_at=excluded.updated_at')
        .run(k, f.type === 'secret' ? encrypt(v) : v, f.type === 'secret' ? 1 : 0);
      changed.push(k);
    }
    apply();
    return changed;
  }
  // used by the app itself to remember ids it created (agent ids and so on)
  const put = (k, v) => save({ [k]: String(v) });

  apply();
  return { apply, view, save, put, encrypt, decrypt, mask };
}
