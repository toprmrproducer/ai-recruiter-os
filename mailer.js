// Minimal SMTP sender with zero dependencies (node:net + node:tls).
// Supports implicit TLS (port 465) and STARTTLS (port 587), AUTH LOGIN/PLAIN, UTF-8 subjects and
// multipart/alternative bodies. Good enough for transactional mail like rejection emails.
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const wrap = s => s.replace(/(.{76})/g, '$1\r\n');
const encWord = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const addr = (name, email) => (name ? `${encWord(name)} <${email}>` : email);
const clean = s => String(s).replace(/[\r\n]+/g, ' ').trim();

export const mailConfig = (env = process.env) => ({
  host: env.SMTP_HOST || '', port: Number(env.SMTP_PORT || 465), secure: String(env.SMTP_SECURE ?? '1') !== '0',
  user: env.SMTP_USER || '', pass: env.SMTP_PASS || '',
  from: env.MAIL_FROM || env.SMTP_USER || '', fromName: env.MAIL_FROM_NAME || '', replyTo: env.MAIL_REPLY_TO || '',
});
export const mailReady = (c = mailConfig()) => Boolean(c.host && c.user && c.pass && c.from);

// Reads SMTP replies (including multi-line "250-..." replies) from a socket.
function reader(sock) {
  let buf = '', waiting = null; const queue = [];
  const flush = () => {
    for (;;) {
      const lines = buf.split('\r\n'); if (lines.length < 2) return;
      let end = -1; for (let i = 0; i < lines.length - 1; i++) if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) { end = i; break; }
      if (end < 0) return;
      const reply = lines.slice(0, end + 1); buf = lines.slice(end + 1).join('\r\n');
      const r = { code: Number(reply[end].slice(0, 3)), text: reply.join('\n') };
      if (waiting) { const w = waiting; waiting = null; w.resolve(r); } else queue.push(r);
    }
  };
  sock.on('data', d => { buf += d.toString('utf8'); flush(); });
  const fail = e => { if (waiting) { const w = waiting; waiting = null; w.reject(e); } };
  sock.on('error', fail); sock.on('close', () => fail(new Error('connection closed')));
  return { next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => { waiting = { resolve, reject }; })), swap: s => { sock = s; s.on('data', d => { buf += d.toString('utf8'); flush(); }); s.on('error', fail); s.on('close', () => fail(new Error('connection closed'))); } };
}

async function session(c, fn, timeoutMs = 25000) {
  const opts = { host: c.host, port: c.port, servername: c.host, rejectUnauthorized: true };
  let sock = await new Promise((resolve, reject) => { const s = (c.secure ? tls.connect(opts) : net.connect(opts)); s.setTimeout(timeoutMs, () => { s.destroy(new Error('SMTP timeout')); }); s.once(c.secure ? 'secureConnect' : 'connect', () => resolve(s)); s.once('error', reject); });
  const rd = reader(sock);
  const send = line => sock.write(line + '\r\n');
  const expect = async (ok, line) => { if (line !== undefined) send(line); const r = await rd.next(); if (!ok.includes(r.code)) throw new Error(`SMTP ${r.code}: ${r.text.split('\n').pop()}`.slice(0, 240)); return r; };
  try {
    await expect([220]);
    let ehlo = await expect([250], `EHLO ${'recruiter.local'}`);
    if (!c.secure && /STARTTLS/i.test(ehlo.text)) {
      await expect([220], 'STARTTLS');
      sock = await new Promise((resolve, reject) => { const s = tls.connect({ socket: sock, servername: c.host }); s.once('secureConnect', () => resolve(s)); s.once('error', reject); });
      rd.swap(sock); ehlo = await expect([250], 'EHLO recruiter.local');
    }
    if (c.user) {
      if (/AUTH[^\n]*PLAIN/i.test(ehlo.text) && !/AUTH[^\n]*LOGIN/i.test(ehlo.text)) await expect([235], `AUTH PLAIN ${b64(`\0${c.user}\0${c.pass}`)}`);
      else { await expect([334], 'AUTH LOGIN'); await expect([334], b64(c.user)); await expect([235], b64(c.pass)); }
    }
    const out = await fn({ expect, send });
    try { send('QUIT'); } catch {}
    sock.end(); return out;
  } catch (e) { sock.destroy(); throw e; }
}

// Checks host, TLS and login without sending anything.
export const verifyMail = (c = mailConfig()) => session(c, async () => true);

export function buildMessage({ from, fromName, to, replyTo, subject, text, html, domain }) {
  const id = `<${randomBytes(12).toString('hex')}@${domain || from.split('@')[1] || 'localhost'}>`;
  const alt = `----=_alt_${randomBytes(8).toString('hex')}`;
  const head = [
    `From: ${addr(clean(fromName), from)}`, `To: ${to}`, replyTo ? `Reply-To: ${replyTo}` : null, `Subject: ${encWord(clean(subject))}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`, `Message-ID: ${id}`, 'MIME-Version: 1.0', 'Auto-Submitted: auto-generated',
    `Content-Type: multipart/alternative; boundary="${alt}"`,
  ].filter(Boolean);
  const part = (type, body) => `--${alt}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(b64(body))}\r\n`;
  return head.join('\r\n') + '\r\n\r\n' + part('text/plain', text) + (html ? part('text/html', html) : '') + `--${alt}--\r\n`;
}

export async function sendMail(c, { to, subject, text, html }) {
  if (!mailReady(c)) throw new Error('Email is not set up. Add SMTP_HOST, SMTP_USER and SMTP_PASS to .env.');
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) throw new Error('That is not a valid email address.');
  const msg = buildMessage({ from: c.from, fromName: c.fromName, to, replyTo: c.replyTo, subject, text, html });
  return session(c, async ({ expect, send }) => {
    await expect([250], `MAIL FROM:<${c.from}>`);
    await expect([250, 251], `RCPT TO:<${to}>`);
    await expect([354], 'DATA');
    send(msg.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..') + '\r\n.');
    const r = await expect([250]); return { ok: true, response: r.text.split('\n').pop() };
  });
}
