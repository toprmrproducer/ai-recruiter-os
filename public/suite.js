// Recruiting suite UI: extra dashboard tabs + the candidate drawer sections.
// Loaded after the dashboard script, so it can use its globals: $, esc, api, vclass, ring, open, show, load, me.
(() => {
  const q = s => document.querySelector(s);
  const IST = 5.5 * 3600 * 1000;
  const money = n => 'Rs ' + Number(n || 0).toLocaleString('en-IN');
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const parts = iso => new Date(new Date(iso).getTime() + IST);
  const dayOf = iso => { const d = parts(iso); return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
  const timeOf = iso => { const d = parts(iso); let h = d.getUTCHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${String(d.getUTCMinutes()).padStart(2, '0')} ${ap}`; };
  const when = iso => `${dayOf(iso)}, ${timeOf(iso)}`;
  const li = a => (a || []).map(x => `<li>${esc(x)}</li>`).join('') || '<li style="color:var(--mute)">None</li>';
  const chip = (t, style = '') => `<span class="chip" style="${style}">${esc(t)}</span>`;
  const run = async fn => { try { await fn(); } catch (e) { alert(e.message || e); } };
  const post = (p, body) => api(p, { method: 'POST', body: body || {} });
  const sec = (t, h) => `<div class="sec"><h4>${t}</h4>${h}</div>`;
  const input = 'background:#15161a;border:1px solid var(--line);color:var(--ink);border-radius:9px;padding:8px;font:inherit';
  // one field = one grid cell: label, input and an optional hint stay together
  const fld = (id, label, extra = '', hint = '') => `<div><label style="display:block;font-size:12px;font-weight:600;color:var(--ink);margin:0 0 4px">${label}</label><input id="${id}" style="${input};width:100%" ${extra}>${hint ? `<div style="font-size:11px;color:var(--mute);margin-top:3px">${hint}</div>` : ''}</div>`;
  const grp = t => `<div style="grid-column:1/-1;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);font-weight:700;margin-top:6px;border-bottom:1px solid var(--line);padding-bottom:4px">${t}</div>`;
  const sel = (id, opts, style = '') => `<select id="${id}" style="${input};${style}">${opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`;
  const btn = (label, onclick, cls = '') => `<button class="btn ${cls}" onclick="${onclick}">${label}</button>`;
  const bars = (rows, max) => { const m = max || Math.max(1, ...rows.map(r => r.n)); return rows.map(r => `<div class="bar" style="grid-template-columns:120px 1fr 44px"><span>${esc(r.label)}</span><div class="track"><b style="width:${r.n / m * 100}%"></b></div><span style="text-align:right">${r.n}</span></div>`).join(''); };
  const kpi = (a, v, s = '') => `<div class="kpi"><small>${a}</small><div class="v">${v}</div><div class="s">${s}</div></div>`;

  // ------------------------------------------------------------ nav + tabs
  const nav = q('#nav');
  nav.querySelector('a[data-v=jobs]')?.remove(); // the old read-only Jobs view stays in the DOM (hidden) because the dashboard script still fills it
  const TABS = [['jobs2', '◇', 'Roles and jobs'], ['import', '⇪', 'Import leads'], ['settings', '🔑', 'Keys and secrets'], ['guide', '?', 'How to use'], ['interviews', '◷', 'Interviews'], ['offers', '✎', 'Offers'], ['automation', '⚙', 'Automation'], ['analytics', '▤', 'Analytics'], ['assistant', '✦', 'Assistant']];
  const anchor = nav.querySelector('.navsec');
  let current = null;
  for (const [id, icon, label] of TABS) {
    const a = document.createElement('a'); a.dataset.s = id; a.innerHTML = `<i>${icon}</i>${label}`; nav.insertBefore(a, anchor);
    const v = document.createElement('div'); v.className = 'tabview'; v.id = 'v-' + id; q('main').appendChild(v);
    a.onclick = () => go(id);
  }
  document.querySelectorAll('#nav a[data-v]').forEach(a => a.addEventListener('click', () => { current = null; document.querySelectorAll('#nav a[data-s]').forEach(x => x.classList.remove('on')); }));
  const RENDER = { jobs2: renderJobs, import: renderImport, guide: renderGuide, settings: renderSettings, interviews: renderInterviews, offers: renderOffers, automation: renderAuto, analytics: renderAnalytics, assistant: renderAssistant };
  function go(id) {
    current = id;
    document.querySelectorAll('#nav a').forEach(x => x.classList.toggle('on', x.dataset.s === id));
    document.querySelectorAll('.tabview').forEach(t => t.classList.toggle('on', t.id === 'v-' + id));
    run(() => RENDER[id]());
  }
  setInterval(() => {
    if (!current || ['jobs2', 'assistant', 'import', 'guide', 'settings'].includes(current)) return;
    if (document.activeElement?.closest?.(`#v-${current} input, #v-${current} select, #v-${current} textarea`)) return;
    RENDER[current]().catch(() => {});
  }, 8000);

  // ------------------------------------------------------------ jobs
  async function renderJobs() {
    const v = q('#v-jobs2');
    const vres = await api('/api/voices'), voices = vres.voices;
    const voiceOpts = vres.supported ? [['', 'Default voice (set in Dograh)'], ...voices.map(x => [x.id, `${x.id}: ${x.gender}, ${x.style}`])] : [['', 'Dograh default voice']];
    const voiceNote = vres.supported ? '' : `<div style="font-size:11px;color:var(--amber);margin-top:3px">${esc(vres.note)}</div>`;
    const voiceSel = (id, cur = '') => sel(id, voiceOpts, 'width:100%;background:#fff;color:#111').replace(`value="${cur}"`, `value="${cur}" selected`);
    if (!v.dataset.built) {
      v.dataset.built = '1';
      v.innerHTML = `<div class="charts" id="jobCharts"></div><div id="jobList"></div><details class="jobcard" style="margin-top:6px"><summary style="cursor:pointer;font-size:16px;font-weight:600">+ Create a new role</summary>
        <p style="color:var(--mute);margin:8px 0 6px;max-width:760px">Fill in the role and click <b>Create job</b>. There is nothing else to set up: one AI recruiter handles every role and reads this role's details (title, location, skills, budget, your extra questions) when it phones each applicant.</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px 16px;max-width:900px">
          ${grp('1. The role')}
          ${fld('jTitle', 'Job title', 'placeholder="e.g. Mechanical Engineer, Factory"', 'Shown to applicants on the careers page.')}
          ${fld('jCompany', 'Company name', 'placeholder="e.g. Acme Manufacturing"', 'The company the AI says it is calling from.')}
          ${fld('jLoc', 'Work location', 'placeholder="e.g. Pune (Chakan plant) or Remote"', 'Where the person will actually work.')}
          ${fld('jCities', 'Cities that count as local', 'placeholder="e.g. pune, chakan, pimpri"', 'Comma separated. Applicants living here get full location marks.')}
          ${grp('2. Who you are looking for')}
          ${fld('jYears', 'Minimum experience (years)', 'type="number" value="2" min="0"', 'Used for the experience score.')}
          ${fld('jSkills', 'Must-have skills', 'placeholder="e.g. autocad, solidworks, cnc"', 'Comma separated. The AI checks for these and asks about them.')}
          ${grp('3. Pay and timing')}
          ${fld('jSalary', 'Budget per month (Rs)', 'type="number" value="60000" min="0"', 'The most you will pay. The AI uses it when negotiating.')}
          ${fld('jNotice', 'Longest acceptable notice period (days)', 'type="number" value="30" min="0"', 'Longer notice scores lower.')}
          ${grp('4. The AI recruiter for this role')}
          <div><label style="display:block;font-size:12px;font-weight:600;margin:0 0 4px">AI voice</label>${voiceSel('jVoice')}${voiceNote || '<div style="font-size:11px;color:var(--mute);margin-top:3px">The voice applicants hear on the call. Each role can have its own. Ready in a few seconds after you create the role.</div>'}</div>
          ${fld('jAgent', 'AI recruiter name', 'placeholder="e.g. Riya (leave empty for the default)"', 'The first name it introduces itself with. Match it to the voice.')}
          ${grp('5. Describe it')}
          <div style="grid-column:1/-1"><label style="display:block;font-size:12px;font-weight:600;margin:0 0 4px">Role description</label><textarea id="jDesc" rows="3" placeholder="What the person will do day to day." style="${input};width:100%"></textarea></div>
          <div style="grid-column:1/-1"><label style="display:block;font-size:12px;font-weight:600;margin:0 0 4px">Extra screening questions (optional)</label><textarea id="jQs" rows="3" placeholder="One per line, e.g. Have you worked rotating shifts?" style="${input};width:100%"></textarea><div style="font-size:11px;color:var(--mute);margin-top:3px">The AI asks these on the call, on top of its normal questions.</div></div>
          ${fld('jNotes', 'Notes for the AI draft (optional)', 'placeholder="e.g. night shifts, must know Siemens PLC"', 'Only used by the "AI draft" button to write the description and questions for you.')}
        </div>
        <div style="margin-top:10px;display:flex;gap:8px;align-items:center">${btn('AI draft the description and questions', 'window.sJobDraft()')}${btn('Create job', 'window.sJobCreate()', 'acc')}<span id="jMsg" style="color:var(--mute);font-size:12px"></span></div>
        <p style="color:var(--mute);font-size:12px;margin:10px 0 0">Track where applicants come from by adding ?src=linkedin (or any name) to the careers page link.</p></details>`;
    }
    const jobs = await api('/api/jobs');
    const allc = await api('/api/candidates');
    const perRole = jobs.map(j => ({ label: j.title, value: allc.filter(c => c.job_id === j.id).length }));
    const avgRole = jobs.map(j => { const s = allc.filter(c => c.job_id === j.id && c.total != null); return { label: j.title, value: s.length ? Math.round(s.reduce((a, c) => a + c.total, 0) / s.length) : 0, color: '#0f766e' }; });
    const stat = [{ label: 'Open', value: jobs.filter(j => j.status !== 'closed').length, color: '#0f766e' }, { label: 'Closed', value: jobs.filter(j => j.status === 'closed').length, color: '#94a3b8' }];
    if (!q('#jobCharts')) q('#jobList').insertAdjacentHTML('beforebegin', '<div class="charts" id="jobCharts"></div>');
    q('#jobCharts').innerHTML = donut('Roles', stat) + hbars('Applicants per role', perRole) + hbars('Average AI score per role', avgRole, '#0f766e');
    q('#jobList').innerHTML = jobs.map(j => `<div class="jobcard"><div style="display:flex;justify-content:space-between;gap:10px;align-items:center"><div><b style="font-size:15px">${esc(j.title)}</b> ${chip(j.status || 'open', j.status === 'closed' ? 'color:var(--red)' : 'color:var(--acc)')} ${chip(j.location)}</div>
      <div style="display:flex;gap:6px">${btn('Copy apply link', `sCopy('${(cfg.careers_url || location.origin)}/?role=${j.id}')`)}${btn('Talent pool matches', `sMatches('${j.id}')`)}${btn(j.status === 'closed' ? 'Reopen' : 'Close', `sJobStatus('${j.id}','${j.status === 'closed' ? 'open' : 'closed'}')`)}</div></div>
      <p style="color:var(--mute)">${esc(j.description)}</p><div class="stages">${chip(j.min_years + '+ yrs')}${chip('Budget ' + money(j.max_salary))}${chip('Notice <= ' + j.max_notice_days + 'd')}${(j.must_skills || []).map(s => chip(s)).join('')}${(j.custom_questions || []).length ? chip((j.custom_questions || []).length + ' extra questions') : ''}${chip(j.negotiable ? 'Negotiation on, +' + (j.stretch_pct ?? 10) + '%' : 'Negotiation off', j.negotiable ? 'color:var(--acc)' : '')}</div>
      <details style="margin-top:10px"><summary style="cursor:pointer;color:var(--acc)">Negotiation settings</summary><div style="display:grid;gap:8px;margin-top:8px;max-width:520px">
        <label>Budget per month (Rs) <input id="nb-${j.id}" type="number" value="${j.max_salary || ''}" style="width:100%"></label>
        <label><input id="nn-${j.id}" type="checkbox" ${j.negotiable ? 'checked' : ''}> Let the AI negotiate salary on the call</label>
        <label>Stretch above budget (%) <input id="ns-${j.id}" type="number" min="0" max="50" value="${j.stretch_pct ?? 10}" style="width:100%"></label>
        <label>Why the budget is tight (bandwidth, project budget, what the AI may say) <textarea id="nt-${j.id}" rows="3" style="width:100%">${esc(j.negotiation_notes || '')}</textarea></label>
        <div>${btn('Save negotiation settings', `sJobNeg('${j.id}')`, 'acc')}</div></div></details>
      <details style="margin-top:6px"><summary style="cursor:pointer;color:var(--acc)">Edit role details</summary><div style="display:grid;gap:8px;margin-top:8px;max-width:620px">
        <label>Job title <input id="et-${j.id}" value="${esc(j.title)}" style="width:100%"></label>
        <label>Company name (what the AI says it is calling from) <input id="ec-${j.id}" value="${esc(j.company)}" style="width:100%"></label>
        <label>Work location <input id="el-${j.id}" value="${esc(j.location)}" style="width:100%"></label>
        <label>Role description <textarea id="ed-${j.id}" rows="3" style="width:100%">${esc(j.description || '')}</textarea></label>
        <div>${btn('Save role details', `sJobEdit('${j.id}')`, 'acc')} <span id="em-${j.id}" style="font-size:12px;color:var(--mute)"></span></div></div></details>
      <details style="margin-top:6px"><summary style="cursor:pointer;color:var(--acc)">AI voice and name ${j.voice ? chip(j.voice + (j.agent_name ? ', ' + j.agent_name : '')) : chip('default voice')}</summary><div style="display:grid;gap:8px;margin-top:8px;max-width:520px">
        <label>AI voice ${voiceSel('vv-' + j.id, j.voice || '')}</label>${voiceNote}
        <label>AI recruiter name <input id="va-${j.id}" value="${esc(j.agent_name || '')}" placeholder="e.g. Riya" style="width:100%"></label>
        <div>${btn('Save voice and name', `sJobVoice('${j.id}')`, 'acc')} <span id="vm-${j.id}" style="font-size:12px;color:var(--mute)"></span></div></div></details><div id="m-${j.id}"></div></div>`).join('') || '<div class="empty">No jobs yet</div>';
  }
  // ------------------------------------------------------------ settings: keys and options, saved in the database (secrets encrypted)
  async function renderSettings() {
    const v = q('#v-settings');
    const [s, st] = await Promise.all([api('/api/app-settings'), api('/api/app-settings/dograh-status').catch(() => ({ connected: false }))]);
    const val = k => s.fields.find(f => f.key === k);
    const isSet = k => Boolean(val(k)?.is_set);
    const keep = {}; v.querySelectorAll('[data-skey]').forEach(el => { if (el.value !== undefined) keep[el.dataset.skey] = el.value; });
    const tick = (ok, t, sub = '') => `<div style="display:flex;gap:10px;align-items:flex-start;margin:7px 0"><span style="flex:none;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:700;color:#fff;background:${ok ? 'var(--acc)' : '#cbd5e1'}">${ok ? '✓' : ''}</span><div><b>${t}</b>${sub ? `<div style="color:var(--mute);font-size:12px">${sub}</div>` : ''}</div></div>`;
    const hasAgents = isSet('DOGRAH_AGENT_UUID');
    const phoneOk = (st.phone_providers || []).some(x => x.numbers > 0);
    const modelOk = Boolean(st.voice_model?.key_set);
    const field = f => {
      const id = 'sf-' + f.key, base = `data-skey="${f.key}" id="${id}"`;
      let input;
      if (f.type === 'secret') input = `<input ${base} type="password" autocomplete="new-password" placeholder="${f.is_set ? f.hint + ' (saved, leave blank to keep)' : (f.placeholder || 'not set')}" style="${input_style}">`;
      else if (f.type === 'toggle') input = `<label style="font-weight:500;display:flex;gap:8px;align-items:center"><input ${base} type="checkbox" ${f.value === '1' ? 'checked' : ''}> ${f.value === '1' ? '<b style="color:var(--amber)">ON</b>' : 'off'}</label>`;
      else if (f.type === 'select') input = `<select ${base} style="${input_style}">${f.options.map(([k, l]) => `<option value="${k}" ${f.value === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
      else if (f.type === 'textarea') input = `<textarea ${base} rows="2" placeholder="${esc(f.placeholder)}" style="${input_style}">${esc(f.value)}</textarea>`;
      else input = `<input ${base} type="${f.type === 'number' ? 'number' : 'text'}" value="${esc(f.value)}" placeholder="${esc(f.placeholder)}" style="${input_style}">`;
      const src = f.source === 'environment' ? '<span class="chip">from .env</span>' : f.source === 'settings' ? '<span class="chip" style="color:var(--acc)">saved here</span>' : '';
      return `<div><label style="display:block;font-size:12px;font-weight:600;margin:0 0 4px">${esc(f.label)} ${src}</label>${input}${f.help ? `<div style="font-size:11px;color:var(--mute);margin-top:3px">${esc(f.help)}</div>` : ''}</div>`;
    };
    const input_style = `${input};width:100%`;
    const group = g => `<div class="jobcard" id="sg-${g.id}"><b style="font-size:16px">${esc(g.title)}</b><p style="color:var(--mute);margin:4px 0 10px">${esc(g.help)}</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px 16px;max-width:900px">${s.fields.filter(f => f.group === g.id).map(field).join('')}</div>
      <div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">${btn('Save', `sSetSave('${g.id}')`, 'acc')}${g.id === 'voice' ? btn('Test the connection', "sSetTest('dograh')") : ''}${g.id === 'email' ? btn('Test the mailbox login', "sSetTest('email')") : ''}<span id="sm-${g.id}" style="font-size:12px;color:var(--mute)"></span></div></div>`;
    v.innerHTML = `${!s.can_manage ? `<div class="jobcard" style="border-color:#fca5a5;background:#fef2f2"><b>Settings are read only here.</b><div style="color:#7f1d1d;margin-top:4px">This dashboard is open to the internet without a password, so secrets cannot be edited. Open the dashboard on the computer that runs it (http://localhost) and set a Dashboard password under Dashboard security first.</div></div>` : ''}
      <div class="jobcard"><b style="font-size:18px">Where every key goes</b><p style="color:var(--mute);margin:4px 0 10px">Every secret lives on this page, saved encrypted inside the app. Nothing goes in a code file. Find the service you need, get the key from the link, press Go to, paste it in the box and Save.</p>
        <table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="text-align:left;color:var(--mute);font-size:11px;text-transform:uppercase;letter-spacing:.04em"><th style="padding:6px 8px">Key</th><th style="padding:6px 8px">What it does</th><th style="padding:6px 8px">Get it from</th><th style="padding:6px 8px">Status</th><th></th></tr></thead><tbody>
        ${[
          ['Dograh address and API key', 'Voice engine that places the calls', 'Your Dograh dashboard, Settings, API keys', isSet('DOGRAH_BASE_URL') && isSet('DOGRAH_API_KEY'), 'sg-voice', true],
          ['Twilio SID, token and number', 'The phone line calls go out on', 'console.twilio.com (Account Info)', phoneOk, 'sg-phone', true],
          ['AI voice model key', 'The realtime model that talks to applicants', s.caps?.voice_override ? 'Google AI Studio or OpenAI platform' : 'Dograh, Settings, Models', modelOk, s.caps?.voice_override ? 'sg-model' : 'sg-voice', true],
          ['Email (SMTP) login', 'Sends rejection emails', 'Your mailbox provider (Hostinger, Google, Zoho)', s.mail_ready, 'sg-email', false],
          ['Writing helper keys', 'Job drafts and resume analysis (Groq, Z.ai, Anthropic, Grok)', 'console.groq.com, console.anthropic.com, ...', ['GROQ_API_KEY','ZAI_API_KEY','ANTHROPIC_API_KEY','XAI_API_KEY','LLM_CUSTOM_URL'].some(isSet), 'sg-ai', false],
          ['Dashboard password', 'Keeps strangers out of this dashboard', 'You choose it', s.password_set, 'sg-security', true],
        ].map(([k, d, w, ok, id, req]) => `<tr style="border-top:1px solid var(--line)"><td style="padding:8px"><b>${k}</b>${req ? '' : ' <span class="chip">optional</span>'}</td><td style="padding:8px;color:var(--mute)">${d}</td><td style="padding:8px;color:var(--mute)">${w}</td><td style="padding:8px;white-space:nowrap">${ok ? '<b style="color:var(--acc)">✓ Saved</b>' : '<span style="color:var(--amber)">Not set</span>'}</td><td style="padding:8px">${btn('Go to', `document.getElementById('${id}')?.scrollIntoView({behavior:'smooth',block:'start'})`)}</td></tr>`).join('')}
        </tbody></table></div>
      <div class="jobcard"><b style="font-size:18px">Setup checklist</b><p style="color:var(--mute);margin:4px 0 8px">Work top to bottom. Everything is saved in this app, you never edit a file.</p>
        ${tick(s.password_set, 'Dashboard password', s.password_set ? 'Set.' : 'Not set. Save one under Dashboard security below, especially before going online.')}
        ${tick(isSet('DOGRAH_BASE_URL') && isSet('DOGRAH_API_KEY'), '1. Connect your voice engine (Dograh)', 'Install Dograh (one Docker command, see the README), then save its address and API key below and press Test the connection.')}
        ${tick(hasAgents, '2. Create the AI recruiter agents', hasAgents ? 'Done. Roles can now have their own voices.' : `Saves two ready-made agents into Dograh. ${btn('Create the AI agents', 'sSetAgents()', 'acc')} <span id="sm-agents" style="font-size:12px"></span>`)}
        ${tick(phoneOk, '3. Connect a phone provider', phoneOk ? `Connected: ${st.phone_providers.map(x => x.provider + ' (' + x.numbers + ' number' + (x.numbers === 1 ? '' : 's') + ')').join(', ')}.` : 'Your telephony account (Twilio) so calls can go out. Use the form below.')}
        ${s.caps?.voice_override ? tick(modelOk, '4. Choose the AI voice model', modelOk ? `Connected: ${st.voice_model.provider}${st.voice_model.voice ? ', default voice ' + st.voice_model.voice : ''}.` : 'The realtime voice model that does the talking. Use the form below.') : tick(false, '4. Choose the AI voice model in Dograh', 'Open Dograh, Settings > Models, pick a realtime voice model and paste its key. It stays in Dograh.')}
        ${tick(s.mail_ready, '5. Email (optional)', s.mail_ready ? 'Mailbox saved.' : 'Only needed for rejection emails.')}
        ${tick(!s.calls_locked, '6. Production calling (when you are ready)', s.calls_locked ? 'Locked: only numbers on the list below can be called. This is the safe default.' : '<b style="color:var(--amber)">ON: any applicant can be called.</b>')}</div>
      ${s.groups.filter(g => g.id === 'security' || g.id === 'brand' || g.id === 'voice').map(group).join('')}
      <div class="jobcard" id="sg-phone"><b style="font-size:16px">Phone provider (Twilio)</b><p style="color:var(--mute);margin:4px 0 10px">Sent straight to Dograh. Not stored in this app. ${st.connected ? '' : '<b>Connect Dograh first.</b>'}</p>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px 16px;max-width:900px">
          <div><label style="display:block;font-size:12px;font-weight:600;margin:0 0 4px">Twilio Account SID</label><input id="tw-sid" placeholder="AC..." style="${input_style}"></div>
          <div><label style="display:block;font-size:12px;font-weight:600;margin:0 0 4px">Twilio Auth Token</label><input id="tw-tok" type="password" autocomplete="new-password" style="${input_style}"></div>
          <div><label style="display:block;font-size:12px;font-weight:600;margin:0 0 4px">Number calls come from</label><input id="tw-num" placeholder="+14155550123" style="${input_style}"></div></div>
        <div style="margin-top:12px">${btn('Connect Twilio', 'sSetPhone()', 'acc')} <span id="sm-phone" style="font-size:12px;color:var(--mute)"></span></div></div>
      ${s.caps?.voice_override ? `<div class="jobcard" id="sg-model"><b style="font-size:16px">AI voice model</b><p style="color:var(--mute);margin:4px 0 10px">The realtime voice model that talks to applicants. Sent straight to Dograh. Not stored in this app.</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px 16px;max-width:900px">
          <div><label style="display:block;font-size:12px;font-weight:600;margin:0 0 4px">Provider</label><select id="vm-prov" style="${input_style}"><option value="google_realtime">Google realtime voice</option><option value="openai_realtime">OpenAI realtime voice</option></select></div>
          <div><label style="display:block;font-size:12px;font-weight:600;margin:0 0 4px">API key</label><input id="vm-key" type="password" autocomplete="new-password" style="${input_style}"></div></div>
        <div style="margin-top:12px">${btn('Save voice model', 'sSetModel()', 'acc')} <span id="sm-model" style="font-size:12px;color:var(--mute)"></span></div></div>` : `<div class="jobcard" id="sg-model"><b style="font-size:16px">AI voice model</b><p style="color:var(--mute);margin:4px 0 0">${s.caps?.reachable ? 'Your Dograh keeps its voice model in its own dashboard. Open Dograh, go to <b>Settings &gt; Models</b>, pick a realtime voice model and paste its key there. This app does not store that key.' : 'Connect Dograh above first.'}</p></div>`}
      ${s.groups.filter(g => g.id === 'safety' || g.id === 'email' || g.id === 'ai').map(group).join('')}`;
    Object.entries(keep).forEach(([k, val]) => { const el = v.querySelector(`[data-skey="${k}"]`); if (el && el.type !== 'checkbox' && el.type !== 'password' && el.value !== val && document.activeElement !== el) { /* keep what the server says */ } });
  }
  const sSetMsg = (id, t, bad) => { const el = q('#sm-' + id); if (el) { el.textContent = t; el.style.color = bad ? 'var(--red)' : 'var(--acc)'; } };
  window.sSetSave = gid => run(async () => {
    const values = {};
    document.querySelectorAll('#v-settings [data-skey]').forEach(el => {
      const key = el.dataset.skey; if (!el.closest('.jobcard') || !el.closest('.jobcard').querySelector(`[onclick="sSetSave('${gid}')"]`)) return;
      if (el.type === 'checkbox') values[key] = el.checked ? '1' : null;
      else values[key] = el.value;
    });
    try { const r = await api('/api/app-settings', { method: 'PUT', body: { values } }); sSetMsg(gid, r.changed.length ? 'Saved.' : 'Nothing changed.'); }
    catch (e) { sSetMsg(gid, e.message, true); return; }
    renderSettings();
  });
  window.sSetTest = what => run(async () => { const gid = what === 'email' ? 'email' : 'voice'; sSetMsg(gid, 'Testing...'); const r = await post('/api/app-settings/test', { what }); sSetMsg(gid, r.message, !r.ok); });
  window.sSetAgents = () => run(async () => { sSetMsg('agents', 'Creating the agents in Dograh, about 20 seconds...'); try { await post('/api/app-settings/create-agents', {}); sSetMsg('agents', 'Done.'); renderSettings(); } catch (e) { sSetMsg('agents', e.message, true); } });
  window.sSetPhone = () => run(async () => { sSetMsg('phone', 'Connecting...'); try { const r = await post('/api/app-settings/phone-provider', { account_sid: q('#tw-sid').value, auth_token: q('#tw-tok').value, phone_number: q('#tw-num').value }); q('#tw-tok').value = ''; sSetMsg('phone', r.message); renderSettings(); } catch (e) { sSetMsg('phone', e.message, true); } });
  window.sSetModel = () => run(async () => { sSetMsg('model', 'Saving...'); try { const r = await post('/api/app-settings/voice-model', { provider: q('#vm-prov').value, api_key: q('#vm-key').value }); q('#vm-key').value = ''; sSetMsg('model', r.message); renderSettings(); } catch (e) { sSetMsg('model', e.message, true); } });

  // ------------------------------------------------------------ how to use
  async function renderGuide() {
    const v = q('#v-guide'); if (v.dataset.built) return; v.dataset.built = '1';
    const step = (n, t, h) => `<div class="step"><em>${n}</em><div><b>${t}</b><div style="color:var(--mute);margin-top:2px">${h}</div></div></div>`;
    v.innerHTML = `<div class="jobcard guide"><b style="font-size:20px">How to use Recruit OS</b>
      <p style="color:var(--mute);margin:6px 0 0">An AI recruiter phones every applicant, reads their resume, asks a few questions, can negotiate salary inside your budget, and scores them out of 100. You review the ranked list and move people through the pipeline.</p>

      <h3>The 5 minute tour (left sidebar, top to bottom)</h3>
      ${step(1, 'Pipeline: the Kanban board', 'Each column is a hiring stage. Cards are ranked by AI score, best first, with the score ring on the card. <b>Drag a card</b> to another column to move that person. Click a card to open the full story: verdict, pros and cons, score breakdown, transcript, negotiation, work log.')}
      ${step(2, 'Candidates: the full list', 'Every applicant in one table with charts on top. Click a row to open the same detail panel.')}
      ${step(3, 'Calls: what the AI agent did', 'Every call with status, length, turns and score. Charts show how many calls completed. A call marked <i>in progress</i> is happening right now.')}
      ${step(4, 'Roles and jobs: create and control roles', 'Create a role, set its budget, switch salary negotiation on or off, add role-specific questions, close or reopen it.')}
      ${step(5, 'Import leads: bring candidates in from Naukri or any CSV', 'Pick the role, drop the CSV, click <b>Import leads</b>. Then click <b>Start AI calls</b> to have the agent phone the batch one by one.')}
      ${step(6, 'Evaluation criteria', 'How the 100 points are scored and where the AI stops and a human decides.')}

      <h3>Create a new role, for example "Mechanical Engineer, Factory"</h3>
      <ol><li>Go to <b>Roles and jobs</b>. In <b>New role</b> type the title, company, location (the plant city), minimum years, budget in rupees per month, maximum notice period and the must-have skills (for example <code>autocad, solidworks, cnc, quality control</code>).</li>
      <li>Optional: click <b>AI draft from title + notes</b> to write the description, or type your own. Add role-specific questions, one per line (for example <code>Have you worked rotating shifts?</code> or <code>Which CNC machines have you run?</code>).</li>
      <li>Click <b>Create job</b>. The role now appears on the public careers page at <code>/</code>, so applicants can apply to it.</li>
      <li>On the new role's card open <b>Negotiation settings</b>, enter the monthly budget, tick the switch if you want the AI to negotiate, set how far above budget it may go (the stretch) and write why the budget is tight. Click <b>Save negotiation settings</b>.</li></ol>

      <h3>Common questions</h3>
      <div class="qa"><b>How do I know which agent is active?</b>The bar at the top of Pipeline shows it: the agent's name, whether the voice engine is live, how many calls are on right now (with the candidate, the role and a timer), and how many are queued.</div>
      <div class="qa"><b>How do I know the agent is talking about the right role?</b>There is one agent for the whole system. Each call is built from the candidate's own application, so the agent speaks about <i>that candidate's role</i>: its title, location, skills and budget. Check it any time in <b>Calls</b> (the Role column) or on a card in the Kanban. Use the <b>Role</b> filter at the top to see only one role's candidates, calls and charts.</div>
      <div class="qa"><b>How do I set a role active or inactive?</b>In <b>Roles and jobs</b> click <b>Close</b> on a role. A closed role disappears from the careers page and stops taking applications. Click <b>Reopen</b> to switch it back on. Candidates already in the system stay.</div>
      <div class="qa"><b>How does salary negotiation work?</b>If negotiation is on for the role and a candidate asks for more than the budget, the agent explains the budget limits, asks if it can work, and makes one counter that never goes above your stretch limit. It always says the final decision is with the hiring team. The agreed figure feeds the score and shows as a flag on the candidate.</div>
      <div class="qa"><b>What does the score mean?</b>75 and above is Strong, 55 to 74 is Maybe, under 55 is Reject. Experience, salary fit, notice period, location, must-have skills and answer quality add up to 100. A red knockout (for example salary far above budget) forces Reject and shows the reason.</div>
      <div class="qa"><b>Who decides?</b>You do. The AI screens, scores and drafts. It never rejects, hires or sends an offer on its own, and a person approves each move.</div>
      <div class="qa"><b>Is it safe to demo?</b>Calls only go to numbers on the demo allowlist, so an imported list can never ring a stranger. Outside the allowlist the import page tells you the lead was skipped.</div>
      <div class="qa"><b>Candidate says "I did not apply"?</b>The agent apologises, asks to be removed from calls, and the call ends politely. The candidate stays in your list so you can delete or contact them.</div>
    </div>`;
  }

  // ------------------------------------------------------------ import leads (CSV) + AI call queue
  const SAMPLE_CSV = 'Name,Email ID,Mobile,Current Location,Total Experience,Current Company,Current Designation,Key Skills,Notice Period,Expected CTC (LPA),Education\n' +
    'Aarav Mehta,aarav.mehta@example.com,+910000000001,Pune,3 Yrs 4 Months,Brightline Systems,Software Engineer,"Node.js, Python, PostgreSQL",30 days,16,B.Tech Computer Science\n' +
    'Diya Nair,diya.nair@example.com,+910000000002,Bengaluru,5 Yrs,Cloudwave Labs,Senior Developer,"Python, FastAPI, SQL, Docker",2 Months,24,B.E. Information Technology\n' +
    'Rohan Kulkarni,rohan.k@example.com,+910000000003,Pune,1 Yr 6 Months,Kodeworks Labs,Junior Developer,"JavaScript, React, Node.js",Immediate,9,B.Sc Computer Science\n' +
    'Sneha Iyer,sneha.iyer@example.com,+910000000004,Mumbai,4 Yrs,Northstar Tech,Backend Engineer,"Java, Python, SQL",3 Months,20,B.Tech Electronics\n';
  async function renderImport() {
    const v = q('#v-import');
    const jobs = await api('/api/jobs');
    const batches = await api('/api/import/batches');
    const qs = await api('/api/import/queue');
    const keep = { job: q('#imJob')?.value, src: q('#imSrc')?.value };
    v.innerHTML = `<div class="jobcard"><b style="font-size:16px">1. Import leads from a CSV</b>
      <p style="color:var(--mute);margin:6px 0 10px">Export your applicants from Naukri, Indeed or any job board as a CSV and drop it here. Columns are matched by name (Name, Email, Mobile, Location, Experience, Skills, Notice Period, Expected CTC and similar). Duplicates are skipped.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div><label style="display:block;font-size:11px;color:var(--mute);margin:0 0 3px">Import into role</label>${sel('imJob', jobs.map(j => [j.id, j.title + ' (' + j.company + ')']), 'width:100%;background:#fff;color:#111')}</div>
        ${fld('imLabel', 'Where are these leads from? (naukri, indeed, referral)', 'value="naukri"')}</div>
      <div style="margin-top:10px"><input type="file" id="imFile" accept=".csv,.tsv,.txt" style="color:var(--mute)"> ${btn('Download sample CSV', 'sImSample()')}</div>
      <label style="display:block;font-size:11px;color:var(--mute);margin:10px 0 3px">Or paste the CSV text</label><textarea id="imText" rows="4" style="${input};width:100%"></textarea>
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center">${btn('Import leads', 'sImport()', 'acc')}<span id="imMsg" style="color:var(--mute);font-size:12px"></span></div><div id="imOut"></div></div>
      <div class="jobcard"><b style="font-size:16px">2. Let the AI call them</b>
      <p style="color:var(--mute);margin:6px 0 10px">The AI screener calls the imported leads one after another, reads each resume, asks the questions and scores them. Only valid Indian mobile numbers are dialled, and until you switch to production only numbers on the demo allowlist are called, so a demo can never ring a stranger. Calls go out 9 AM to 7 PM IST unless you tick the demo box. Each call costs roughly $0.40 to $0.75.</p>
      <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:10px"><div><label style="display:block;font-size:11px;color:var(--mute);margin:0 0 3px">Batch</label>${sel('imSrc', batches.length ? batches.map(b => [b.source, `${b.source.slice(4)}: ${b.total} leads, ${b.dialable} dialable, ${b.called} called`]) : [['', 'No imports yet']], 'width:100%;background:#fff;color:#111')}</div>
        ${fld('imLimit', 'Call how many', 'type="number" value="5" min="1"')}${fld('imGap', 'Seconds between calls', 'type="number" value="180" min="30"')}</div>
      <label style="display:block;margin-top:10px;font-size:12px;color:var(--mute)"><input type="checkbox" id="imForce"> Ignore calling hours (demo only)</label>
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center">${btn('Start AI calls', 'sImCall()', 'acc')}${btn('Cancel waiting calls', 'sImCancel()')}<span id="imCallMsg" style="color:var(--mute);font-size:12px"></span></div>
      <div style="margin-top:12px;color:var(--mute);font-size:12px">Queue: ${qs.waiting} waiting${qs.running ? ', calling now' : ''}</div>
      ${(qs.recent || []).map(r => `<div style="font-size:12px;margin-top:4px">${esc(r.name)}: ${esc(r.note)} ${chip(timeOf(r.at))}</div>`).join('')}</div>`;
    if (keep.job) q('#imJob').value = keep.job; if (keep.src) q('#imSrc').value = keep.src;
    const tot = batches.reduce((a, b) => a + b.total, 0), dial = batches.reduce((a, b) => a + b.dialable, 0), called = batches.reduce((a, b) => a + b.called, 0);
    v.insertAdjacentHTML('afterbegin', `<div class="charts">${donut('Imported leads', [{ label: 'Called', value: called, color: '#0f766e' }, { label: 'Ready to call', value: Math.max(0, dial - called), color: '#2563eb' }, { label: 'Not dialable', value: Math.max(0, tot - dial), color: '#94a3b8' }], tot)}${hbars('Leads per batch', batches.map(b => ({ label: b.source.replace('csv:', ''), value: b.total })), '#2563eb')}</div>`);
  }
  window.sImSample = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([SAMPLE_CSV], { type: 'text/csv' })); a.download = 'naukri-sample-leads.csv'; a.click(); };
  window.sImport = () => run(async () => {
    let csv = q('#imText').value; const f = q('#imFile').files[0];
    if (f) csv = await f.text();
    if (!csv.trim()) throw new Error('Choose a CSV file or paste the text first');
    q('#imMsg').textContent = 'Importing...';
    const r = await post('/api/import/csv', { job_id: q('#imJob').value, label: q('#imLabel').value, csv });
    q('#imMsg').textContent = `${r.created} imported, ${r.skipped} skipped${r.notDialable ? ', ' + r.notDialable + ' without a dialable Indian mobile' : ''}.`;
    q('#imOut').innerHTML = r.problems.length ? `<div style="margin-top:8px;font-size:12px;color:var(--mute)">${r.problems.map(p => `Line ${p.line}${p.name ? ' (' + esc(p.name) + ')' : ''}: ${esc(p.reason)}`).join('<br>')}</div>` : '';
    await renderImport(); q('#imSrc').value = r.source; q('#imMsg').textContent = `${r.created} imported, ${r.skipped} skipped. Now start the AI calls below.`;
    if (typeof load === 'function') load();
  });
  window.sImCall = () => run(async () => {
    const src = q('#imSrc').value; if (!src) throw new Error('Import a CSV first');
    const n = q('#imLimit').value;
    if (!confirm(`The AI will phone up to ${n} people from this batch, one after another (about $0.40 to $0.75 each). Continue?`)) return;
    const r = await post('/api/import/call', { source: src, limit: n, gap_seconds: q('#imGap').value, force: q('#imForce').checked, confirm: true });
    q('#imCallMsg').textContent = `${r.queued} calls queued${r.skippedNotDialable ? ', ' + r.skippedNotDialable + ' skipped (not a dialable Indian mobile)' : ''}${r.skippedLocked ? ', ' + r.skippedLocked + ' skipped (calling is locked to the demo allowlist)' : ''}.`;
    setTimeout(renderImport, 1500);
  });
  window.sImCancel = () => run(async () => { await api('/api/import/queue', { method: 'DELETE' }); renderImport(); });

  window.sJobDraft = () => run(async () => {
    const title = q('#jTitle').value.trim(); if (!title) throw new Error('Enter a title first');
    q('#jMsg').textContent = 'Drafting...';
    const d = await post('/api/jobs/generate', { title, company: q('#jCompany').value, location: q('#jLoc').value, notes: q('#jNotes').value });
    q('#jDesc').value = d.description; q('#jSkills').value = d.must_skills.join(', '); q('#jYears').value = d.min_years; if (d.max_salary) q('#jSalary').value = d.max_salary; q('#jQs').value = d.questions.join('\n');
    q('#jMsg').textContent = `Drafted by ${d.provider}. Review before creating.`;
  });
  window.sJobCreate = () => run(async () => {
    await post('/api/jobs', { title: q('#jTitle').value, company: q('#jCompany').value, location: q('#jLoc').value, min_years: q('#jYears').value, max_salary: q('#jSalary').value, max_notice_days: q('#jNotice').value, must_skills: q('#jSkills').value, locations: q('#jCities').value, description: q('#jDesc').value, custom_questions: q('#jQs').value, voice: q('#jVoice').value, agent_name: q('#jAgent').value });
    q('#jTitle').value = ''; q('#jDesc').value = ''; q('#jQs').value = ''; q('#jMsg').textContent = 'Created.'; renderJobs();
  });
  window.sJobEdit = id => run(async () => {
    await api('/api/jobs/' + id, { method: 'PUT', body: { title: q('#et-' + id).value, company: q('#ec-' + id).value, location: q('#el-' + id).value, description: q('#ed-' + id).value } });
    q('#em-' + id).textContent = 'Saved.'; setTimeout(renderJobs, 800);
  });
  window.sJobVoice = id => run(async () => {
    q('#vm-' + id).textContent = 'Saving and preparing the voice...';
    const r = await api('/api/jobs/' + id, { method: 'PUT', body: { voice: q('#vv-' + id).value, agent_name: q('#va-' + id).value } });
    q('#vm-' + id).textContent = q('#vv-' + id).value ? (r.agent_ready ? 'Saved. The agent for this role is ready.' : 'Saved. The agent could not be prepared yet, calls will use the default voice until it is.') : 'Saved. This role uses the default voice.';
    setTimeout(renderJobs, 1500);
  });
  window.sJobNeg = id => run(async () => { await api('/api/jobs/' + id, { method: 'PUT', body: { max_salary: q('#nb-' + id).value, negotiable: q('#nn-' + id).checked, stretch_pct: q('#ns-' + id).value, negotiation_notes: q('#nt-' + id).value } }); renderJobs(); });
  window.sJobStatus = (id, status) => run(async () => { await api('/api/jobs/' + id, { method: 'PUT', body: { status } }); renderJobs(); });
  window.sMatches = id => run(async () => {
    const m = await api(`/api/jobs/${id}/matches`);
    q('#m-' + id).innerHTML = `<div style="margin-top:10px"><b>Talent pool matches</b> <span style="color:var(--mute);font-size:12px">people who applied for other roles and fit this one</span>${m.map(x => `<div class="ev" style="display:flex;gap:8px;align-items:center"><b>${esc(x.name)}</b> ${esc(x.city)} from ${esc(x.from_job)} ${chip(x.total + ' ' + x.verdict)} ${x.consent ? btn('Add to this role', `sPoolAdd('${id}','${x.id}')`) : chip('no consent to re-contact', 'color:var(--amber)')}</div>`).join('') || '<div class="empty">No matches yet</div>'}</div>`;
  });
  window.sPoolAdd = (job, cid) => run(async () => { await post(`/api/jobs/${job}/matches/${cid}/apply`); await load(); sMatches(job); });

  // ------------------------------------------------------------ interviews
  async function renderInterviews() {
    const list = await api('/api/interviews');
    const order = list.slice().sort((a, b) => (a.status === 'scheduled' ? 0 : 1) - (b.status === 'scheduled' ? 0 : 1) || (a.status === 'scheduled' ? a.starts_at.localeCompare(b.starts_at) : b.starts_at.localeCompare(a.starts_at)));
    q('#v-interviews').innerHTML = `<div class="jobcard" style="padding:6px 10px"><table><tr><th>When (IST)</th><th>Candidate</th><th>Role</th><th>Interviewer</th><th>Status</th><th>Scorecards</th><th></th></tr>${order.map(i => `<tr><td>${when(i.starts_at)}</td><td><a href="#" onclick="show('${i.candidate_id}');return false" style="color:var(--acc)">${esc(i.candidate_name)}</a></td><td>${esc(i.job_title)}</td><td>${esc(i.recruiter_name || '-')}</td><td>${chip(i.status.replace('_', ' '))}</td><td>${i.scorecards}</td><td>${i.status === 'scheduled' ? btn('Join', `window.open('${esc(i.meet_link)}','_blank')`) + btn('No-show', `sIvStatus('${i.id}','no_show')`) + btn('Cancel', `sIvStatus('${i.id}','cancelled')`) : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No interviews yet. Shortlisted candidates book from the link in their message, or you can book from the candidate card.</td></tr>'}</table></div>`;
  }
  window.sIvStatus = (id, status) => run(async () => { await post(`/api/interviews/${id}/status`, { status }); renderInterviews(); });

  // ------------------------------------------------------------ offers
  const OFFER_FLOW = { draft: ['sent'], sent: ['accepted', 'declined', 'negotiating'], negotiating: ['sent', 'accepted', 'declined'], accepted: [], declined: [] };
  async function renderOffers() {
    const list = await api('/api/offers');
    q('#v-offers').innerHTML = `<div class="jobcard" style="padding:6px 10px"><table><tr><th>Candidate</th><th>Role</th><th>Monthly</th><th>Joining</th><th>Status</th><th>Note</th><th></th></tr>${list.map(o => `<tr><td><a href="#" onclick="show('${o.candidate_id}');return false" style="color:var(--acc)">${esc(o.candidate_name)}</a></td><td>${esc(o.job_title)}</td><td>${money(o.salary)}</td><td>${esc(o.joining_date)}</td><td>${chip(o.status)}</td><td style="color:var(--amber)">${esc(o.warning || '')}</td><td>${OFFER_FLOW[o.status].map(s => btn(s === 'sent' ? 'Mark sent' : s, `sOfferStatus('${o.id}','${s}')`)).join('')}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No offers yet. Draft one from a candidate card.</td></tr>'}</table></div>
      <p style="color:var(--mute);font-size:12px">Offers are always drafted, never sent automatically. A recruiter reviews the letter, sends it themselves, then marks it sent here.</p>`;
  }
  window.sOfferStatus = (id, status) => run(async () => { await post(`/api/offers/${id}/status`, { status }); if (current === 'offers') renderOffers(); if (open) show(open, true); });

  // ------------------------------------------------------------ automation
  async function renderAuto() {
    const v = q('#v-automation');
    const [st, tasks, llm] = await Promise.all([api('/api/settings'), api('/api/tasks'), api('/api/llm/status')]);
    const on = k => st[k] === '1';
    v.innerHTML = `<div class="jobcard"><b style="font-size:16px">Automation switches</b>
      <div class="stat" style="margin-top:8px"><span>Auto-call every new applicant with a Dograh phone screen (only if they consented)</span><input type="checkbox" ${on('auto_call') ? 'checked' : ''} onchange="sSet('auto_call',this.checked)"></div>
      <div class="stat"><span>Run AI analysis after every screening</span><input type="checkbox" ${on('auto_analyze') ? 'checked' : ''} onchange="sSet('auto_analyze',this.checked)"></div>
      <div class="stat"><span>Draft shortlist and rejection messages automatically (never sent without you)</span><input type="checkbox" ${on('auto_draft_messages') ? 'checked' : ''} onchange="sSet('auto_draft_messages',this.checked)"></div>
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px">${fld('sSpot', 'Spot-check share of auto-rejects (0 to 1)', `value="${esc(st.spot_check_rate)}"`)}${fld('sRem', 'Reminder hours before interview', `value="${esc(st.reminder_hours)}"`)}${fld('sStart', 'Interview day starts (hour, IST)', `value="${esc(st.workday_start)}"`)}${fld('sEnd', 'Interview day ends (hour, IST)', `value="${esc(st.workday_end)}"`)}${fld('sMin', 'Slot minutes', `value="${esc(st.slot_minutes)}"`)}</div>
      <div style="margin-top:10px">${btn('Save numbers', 'sSaveNums()', 'acc')}</div>
      <p style="color:var(--mute);font-size:12px">Calls are only placed between 9 AM and 9 PM IST. Anything due outside that window waits until 9 AM.</p></div>
      <div class="jobcard"><div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:16px">Task queue</b><div>${btn('Run queue now', 'sRunQueue()', 'acc')}</div></div>
      <table style="margin-top:8px"><tr><th>Task</th><th>Candidate</th><th>Status</th><th>Tries</th><th>Due</th><th>Result</th><th></th></tr>${tasks.map(t => `<tr><td>${esc(t.kind)}</td><td>${esc(t.candidate_name || '-')}</td><td>${chip(t.status, t.status === 'failed' ? 'color:var(--red)' : t.status === 'done' ? 'color:var(--acc)' : '')}</td><td>${t.attempts}</td><td>${esc(t.run_at.slice(5, 16))}</td><td style="color:var(--mute)">${esc(t.result || '')}</td><td>${t.status === 'failed' ? btn('Retry', `sRetry('${t.id}')`) : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Nothing queued</td></tr>'}</table></div>
      <div class="jobcard"><b style="font-size:16px">AI models and cost</b>
      <p style="color:var(--mute)">${llm.chain.length ? 'Order tried: ' + llm.chain.map(c => `${c.name} (${c.model})`).join(', then ') : (llm.disabled ? 'LLM is switched off.' : 'No AI provider is configured, so every AI feature is using its rules-based fallback. Add a key in .env (see .env.example).')}</p>
      <div class="stat">Real model calls today<b>${llm.calls_today} of ${llm.cap} cap</b></div><div class="stat">Answered from cache today (free)<b>${llm.cached_today}</b></div>
      <table style="margin-top:8px"><tr><th>Provider</th><th>Status</th><th>Model</th><th>Needs</th></tr>${llm.providers.map(p => `<tr><td>${p.name}</td><td>${chip(p.configured ? 'ready' : 'not set', p.configured ? 'color:var(--acc)' : '')}</td><td>${esc(p.model)}</td><td style="color:var(--mute)">${esc(p.needs)}</td></tr>`).join('')}</table>
      <p style="color:var(--mute);font-size:12px">${esc(llm.note)}</p></div>`;
  }
  window.sSet = (k, v) => run(async () => { await post('/api/settings', { [k]: v }); });
  window.sSaveNums = () => run(async () => { await post('/api/settings', { spot_check_rate: q('#sSpot').value, reminder_hours: q('#sRem').value, workday_start: q('#sStart').value, workday_end: q('#sEnd').value, slot_minutes: q('#sMin').value }); renderAuto(); });
  window.sRunQueue = () => run(async () => { await post('/api/tasks/run'); renderAuto(); });
  window.sRetry = id => run(async () => { await post(`/api/tasks/${id}/retry`); renderAuto(); });

  // ------------------------------------------------------------ analytics
  async function renderAnalytics() {
    const a = await api('/api/analytics');
    q('#v-analytics').innerHTML = `<div class="kpis">${kpi('Median time to AI screen', a.median_minutes_to_screen == null ? '-' : a.median_minutes_to_screen + ' min', 'apply to screened')}${kpi('Median time to hire', a.median_days_to_hire == null ? '-' : a.median_days_to_hire + ' d', 'apply to hired')}${kpi('Interview no-show', a.no_show_rate == null ? '-' : a.no_show_rate + '%', '')}${kpi('Offer acceptance', a.offer_accept_rate == null ? '-' : a.offer_accept_rate + '%', '')}${kpi('AI marked helpful', a.ai_helpful_rate == null ? '-' : a.ai_helpful_rate + '%', a.spot_checks_open + ' spot checks open')}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px"><div class="jobcard"><b>Hiring funnel</b><div style="margin-top:8px">${bars(a.funnel)}</div></div><div class="jobcard"><b>Score distribution (screened)</b><div style="margin-top:8px">${bars(a.score_hist)}</div><b style="display:block;margin-top:14px">Where applicants come from</b><div style="margin-top:8px">${bars(a.sources)}</div></div></div>
      <div class="jobcard" style="padding:6px 10px"><table><tr><th>Role</th><th>Applied</th><th>Screened</th><th>Shortlisted+</th><th>Hired</th></tr>${a.per_job.map(j => `<tr><td>${esc(j.job)}</td><td>${j.applied}</td><td>${j.screened}</td><td>${j.shortlisted}</td><td>${j.hired}</td></tr>`).join('')}</table></div>
      <a class="btn" href="/api/export/candidates.csv">Export candidates as CSV</a>`;
  }

  // ------------------------------------------------------------ assistant
  const chatLog = [];
  function renderAssistant() {
    const v = q('#v-assistant');
    if (!v.dataset.built) {
      v.dataset.built = '1';
      v.innerHTML = `<div class="jobcard"><b style="font-size:16px">Ask the recruiting assistant</b><p style="color:var(--mute);font-size:12px">It reads your candidate list and answers questions like "who are the top 3 for Inside Sales?". It only recommends, you decide. Personal contact details are never sent to the model.</p>
        <div id="chatLog" class="tr" style="max-height:360px"></div><div style="display:flex;gap:8px;margin-top:10px"><input id="chatQ" style="${input};flex:1" placeholder="Ask about your pipeline"><button class="btn acc" onclick="sAsk()">Ask</button></div></div>`;
      q('#chatQ').addEventListener('keydown', e => e.key === 'Enter' && window.sAsk());
    }
    q('#chatLog').innerHTML = chatLog.map(m => `<div class="m ${m.role === 'you' ? 'candidate' : 'agent'}">${esc(m.text)}${m.provider ? `<div style="color:var(--mute);font-size:11px;margin-top:4px">${esc(m.provider)}</div>` : ''}</div>`).join('');
  }
  window.sAsk = () => run(async () => {
    const t = q('#chatQ').value.trim(); if (!t) return;
    chatLog.push({ role: 'you', text: t }); q('#chatQ').value = ''; renderAssistant();
    const r = await post('/api/assistant', { question: t });
    chatLog.push({ role: 'ai', text: r.answer, provider: r.provider }); renderAssistant();
  });

  // ------------------------------------------------------------ candidate drawer sections
  const _show = window.show;
  window.show = async function (id, quiet) {
    const dr = q('#drawer'), st = dr.scrollTop;
    await _show(id, quiet);
    await decorate(id);
    dr.scrollTop = st;
  };
  const refresh = async () => { await window.show(open, true); load(); };
  const recOpts = () => [['', 'Assign automatically'], ...[...q('#who').options].map(o => [o.value, o.textContent])];

  async function decorate(id) {
    let s, slotsRes;
    try { [s, slotsRes] = await Promise.all([api(`/api/candidates/${id}/suite`), api(`/api/public/slots?c=${id}`)]); } catch { return; }
    if (open !== id) return;
    const byDay = {}; for (const t of slotsRes.slots.slice(0, 80)) (byDay[dayOf(t)] ||= []).push(t);
    const slotOpts = Object.entries(byDay).map(([d, l]) => `<optgroup label="${d}">${l.map(t => `<option value="${t}">${timeOf(t)}</option>`).join('')}</optgroup>`).join('');
    const a = s.analysis, sg = s.signal, digits = String(s.phone || '').replace(/\D/g, '');
    const activeOffer = s.offers.find(o => ['draft', 'sent', 'negotiating', 'accepted'].includes(o.status));
    const box = document.createElement('div'); box.id = 'suiteBox';
    box.innerHTML =
      (s.spot_check && s.stage === 'review' ? `<div class="sec"><div class="blocker"><b>Spot check.</b> This auto-reject was sampled for a human look. ${btn('Confirm reject', "stage('rejected')")} ${btn('Move to shortlisted', "stage('shortlisted')")}</div></div>` : '') +
      sec('Hire signal <span class="chip">screen + interviews + references</span>', sg.signal == null ? '<div class="empty">No data yet</div>' : `<div style="font-size:22px;font-weight:700" class="${sg.veto ? 'v-Reject' : sg.signal >= 65 ? 'v-Strong' : 'v-Maybe'}">${sg.signal}/100 <span style="font-size:14px;color:var(--mute);font-weight:500">${esc(sg.band)}</span></div><div style="margin-top:6px">${sg.parts.map(p => chip(`${p.label} ${p.value}`)).join(' ')}</div><div class="ev">A person makes the final hire decision.</div>`) +
      sec('AI analysis <span class="chip">suggestion only, you decide</span>', (a ? `<div>${esc(a.summary)}</div><div class="evalbox" style="margin-top:8px"><div><h5 class="pro">Strengths</h5><ul>${li(a.strengths)}</ul></div><div><h5 class="con">Concerns</h5><ul>${li(a.concerns)}</ul></div></div>${a.red_flags.length ? `<div class="blocker">${a.red_flags.map(esc).join('; ')}</div>` : ''}<div style="margin-top:8px">Suggested next step: <b>${esc(a.next_step)}</b> ${chip('confidence ' + Math.round(a.confidence * 100) + '%')} ${chip(a.provider)}</div>${a.follow_up_questions.length ? `<div class="ev">Ask in the interview: ${a.follow_up_questions.map(esc).join(' | ')}</div>` : ''}` : '<div class="empty">Not analyzed yet</div>') + `<div style="margin-top:8px;display:flex;gap:6px">${btn('Run AI analysis', 'sAnalyze()')}${btn('Interview prep kit', 'sKit()')}</div><div id="kitOut"></div>`) +
      sec('Resume', (s.resume ? `<div>${esc(s.resume.summary)}</div><div style="margin:6px 0">${(s.resume.skills || []).map(x => chip(x)).join(' ')}</div><div class="ev">${s.resume.years_experience != null ? s.resume.years_experience + ' yrs, ' : ''}${esc(s.resume.current_company || '')} ${chip(s.resume.provider)}</div>` : '<div class="empty">No resume parsed</div>') + `<input type="file" id="rsPdf" accept="application/pdf,.pdf" onchange="sResumePdf(this)" style="margin-top:8px"><textarea id="rsText" rows="3" placeholder="Paste resume text or choose a PDF" style="${input};width:100%;margin-top:8px"></textarea><div style="margin-top:6px">${btn(s.has_resume ? 'Replace and parse resume' : 'Save and parse resume', 'sResume()')}</div>`) +
      sec('Interviews and scorecards', `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${slotOpts ? `<select id="ivSlot" style="${input}">${slotOpts}</select>` : '<span style="color:var(--mute)">No free slots</span>'}${sel('ivRec', recOpts())}${btn('Book interview', 'sBook()', 'acc')}</div>` +
        s.interviews.map(i => `<div class="jobcard" style="margin-top:10px"><b>${when(i.starts_at)} IST</b> ${chip(i.status.replace('_', ' '))} <span style="color:var(--mute)">with ${esc(i.recruiter_name || '-')}</span> ${i.status === 'scheduled' ? btn('No-show', `sIvStatus('${i.id}','no_show')`) + btn('Cancel', `sIvStatus('${i.id}','cancelled')`) : ''}
          ${i.scorecards.map(c => `<div class="ev"><b>${esc(c.recruiter_name || '')}</b>: ${Object.entries(c.ratings).map(([k, v]) => `${k.replace('_', ' ')} ${v}`).join(', ')}. ${chip(c.recommendation.replace('_', ' '))} ${esc(c.notes || '')}</div>`).join('')}
          ${i.status !== 'cancelled' ? `<details style="margin-top:6px"><summary style="cursor:pointer;color:var(--acc)">Add scorecard</summary><div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-top:6px">${s.dimensions.map(d => `<div><label style="font-size:10px;color:var(--mute)">${d.replace('_', ' ')}</label><select id="sc-${i.id}-${d}" style="${input};width:100%">${[5, 4, 3, 2, 1].map(n => `<option>${n}</option>`).join('')}</select></div>`).join('')}</div>
            <div style="display:flex;gap:6px;margin-top:6px">${sel('scr-' + i.id, [['strong_yes', 'Strong yes'], ['yes', 'Yes'], ['no', 'No'], ['strong_no', 'Strong no']])}<input id="scn-${i.id}" placeholder="Notes" style="${input};flex:1">${btn('Submit', `sScore('${i.id}')`)}</div></details>` : ''}</div>`).join('')) +
      sec('Messages <span class="chip">drafts only, nothing is sent for you</span>', `<div style="display:flex;gap:6px">${sel('msgKind', [['shortlist', 'Shortlist + booking link'], ['reject', 'Polite rejection'], ['followup', 'Follow-up'], ['interview_confirm', 'Interview confirmation'], ['reminder', 'Interview reminder'], ['no_show', 'No-show rescue'], ['docs', 'Document request'], ['joining', 'Joining reminder']])}${btn('Draft', 'sMsg()')}</div>` +
        s.messages.map(m => `<div class="jobcard" style="margin-top:8px"><div>${chip(m.kind.replace('_', ' '))} ${chip(m.status, m.status === 'sent' ? 'color:var(--acc)' : '')} ${chip(m.provider)}</div><div style="white-space:pre-wrap;margin:8px 0">${esc(m.body)}</div>${m.status === 'draft' ? `<a class="btn" target="_blank" href="https://wa.me/${digits}?text=${encodeURIComponent(m.body)}">Open in WhatsApp</a> ${btn('Copy', `sCopy(${JSON.stringify(m.body).replace(/"/g, '&quot;')})`)} ${btn('Mark sent', `sMsgStatus('${m.id}','sent')`)} ${btn('Skip', `sMsgStatus('${m.id}','skipped')`)}` : ''}</div>`).join('')) +
      sec('Reference checks', `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${fld('rfName', 'Referee name')}${fld('rfPhone', 'Referee phone')}${fld('rfRel', 'Relationship (manager, peer)')}${fld('rfCo', 'Company')}</div><div style="margin-top:8px">${btn('Add reference', 'sRefAdd()')}</div>` +
        s.references.map(r => `<div class="jobcard" style="margin-top:8px"><b>${esc(r.name)}</b> ${chip(r.status)} <span style="color:var(--mute)">${esc(r.relation)} ${esc(r.company)}</span>${r.answers ? `<div class="ev">Rating ${r.answers.rating}/5, would rehire: ${r.answers.rehire == null ? '?' : r.answers.rehire ? 'yes' : 'no'}, dates match: ${r.answers.dates_match == null ? '?' : r.answers.dates_match ? 'yes' : 'no'}. ${esc(r.answers.strengths || '')} ${esc(r.answers.concerns || '')}</div>` : `<div style="margin-top:6px">${btn('AI reference call', `sRefCall('${r.id}')`)}</div><details style="margin-top:6px"><summary style="cursor:pointer;color:var(--acc)">Enter answers manually</summary><div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px">${sel('rr-' + r.id, [['5', '5 excellent'], ['4', '4'], ['3', '3'], ['2', '2'], ['1', '1 poor']])}${sel('rh-' + r.id, [['true', 'Would rehire'], ['false', 'Would not rehire']])}<input id="rs-${r.id}" placeholder="Strengths" style="${input}"><input id="rc-${r.id}" placeholder="Concerns" style="${input}"></div><div style="margin-top:6px">${btn('Save', `sRefDone('${r.id}')`)}</div></details>`}</div>`).join('')) +
      sec('Offer', (activeOffer ? `<div>${chip(activeOffer.status)} <b>${money(activeOffer.salary)}/month</b> joining ${esc(activeOffer.joining_date)} ${chip(activeOffer.provider)}</div>${activeOffer.warning ? `<div class="blocker">${esc(activeOffer.warning)}</div>` : ''}<textarea readonly rows="9" style="${input};width:100%;margin-top:8px">${esc(activeOffer.letter)}</textarea><div style="margin-top:6px">${OFFER_FLOW[activeOffer.status].map(x => btn(x === 'sent' ? 'Mark sent' : x, `sOfferStatus('${activeOffer.id}','${x}')`)).join(' ')}</div><div class="ev">Review and send the letter yourself, then mark it sent. Nothing goes out automatically.</div>` : `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${fld('ofSal', 'Monthly gross salary, Rs', 'type="number"')}${fld('ofDate', 'Joining date', 'type="date"')}</div><div style="margin-top:8px">${btn('Draft offer letter', 'sOffer()')}</div>`)) +
      sec('Onboarding', s.onboarding.length ? s.onboarding.map(o => `<div class="stat"><span><input type="checkbox" ${o.status === 'done' ? 'checked' : ''} onchange="sOb('${o.id}')"> ${esc(o.title)} ${chip(o.kind)}</span><b>${esc(o.due)}</b></div>`).join('') + `<div style="margin-top:8px">${btn('Draft document request', "sMsgKind('docs')")}</div>` : '<div class="empty">Starts when an offer is accepted</div>') +
      sec('Data', `${chip('source: ' + (s.source || 'careers'))} ${chip(s.consent ? 'consent recorded' : 'no consent recorded', s.consent ? '' : 'color:var(--amber)')} <div style="margin-top:8px">${btn('Erase all data for this candidate', 'sErase()', '')}</div>`);
    q('#drawer').appendChild(box);
  }

  const cid = () => open;
  window.sAnalyze = () => run(async () => { await post(`/api/candidates/${cid()}/analyze`); await refresh(); });
  window.sKit = () => run(async () => {
    const k = await api(`/api/candidates/${cid()}/kit`);
    q('#kitOut').innerHTML = `<div class="jobcard" style="margin-top:8px"><b>Interview prep kit</b> ${chip(k.provider)}<ol>${k.questions.map(x => `<li style="margin:6px 0">${esc(x.q)}<div style="color:var(--mute);font-size:11px">${esc(x.why)}</div></li>`).join('')}</ol></div>`;
  });
  window.sResumePdf = async inp => { const f = inp.files[0]; if (!f) return; try { const r = await fetch('/api/resume/pdf', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: await f.arrayBuffer() }); const j = await r.json(); if (!r.ok) throw new Error(j.error); q('#rsText').value = j.text; } catch (e) { alert(e.message); } };
  window.sResume = () => run(async () => { await post(`/api/candidates/${cid()}/resume`, { text: q('#rsText').value }); await refresh(); });
  window.sBook = () => run(async () => { if (!q('#ivSlot')) throw new Error('No free slots'); await post(`/api/candidates/${cid()}/interviews`, { starts_at: q('#ivSlot').value, recruiter_id: q('#ivRec').value || undefined }); await refresh(); });
  window.sScore = iv => run(async () => {
    const ratings = {}; for (const d of ['role_skills', 'communication', 'problem_solving', 'motivation', 'culture_add']) ratings[d] = Number(q(`#sc-${iv}-${d}`).value);
    await post(`/api/interviews/${iv}/scorecard`, { recruiter_id: me(), ratings, recommendation: q('#scr-' + iv).value, notes: q('#scn-' + iv).value });
    await refresh();
  });
  window.sMsg = () => run(async () => { await post(`/api/candidates/${cid()}/messages/draft`, { kind: q('#msgKind').value }); await refresh(); });
  window.sMsgKind = kind => run(async () => { await post(`/api/candidates/${cid()}/messages/draft`, { kind }); await refresh(); });
  window.sMsgStatus = (id, status) => run(async () => { await post(`/api/messages/${id}/status`, { status }); await refresh(); });
  window.sCopy = t => run(async () => { await navigator.clipboard.writeText(t); });
  window.sRefAdd = () => run(async () => { await post(`/api/candidates/${cid()}/references`, { name: q('#rfName').value, phone: q('#rfPhone').value, relation: q('#rfRel').value, company: q('#rfCo').value }); await refresh(); });
  window.sRefCall = id => run(async () => { await post(`/api/references/${id}/call`); await refresh(); });
  window.sRefDone = id => run(async () => { await post(`/api/references/${id}/complete`, { rating: Number(q('#rr-' + id).value), rehire: q('#rh-' + id).value === 'true', strengths: q('#rs-' + id).value, concerns: q('#rc-' + id).value }); await refresh(); });
  window.sOffer = () => run(async () => { await post(`/api/candidates/${cid()}/offers`, { salary: q('#ofSal').value, joining_date: q('#ofDate').value }); await refresh(); });
  window.sOb = id => run(async () => { await post(`/api/onboarding/${id}/toggle`); await refresh(); });
  window.sErase = () => run(async () => {
    if (!confirm('Erase every record for this candidate? This cannot be undone.')) return;
    await api(`/api/candidates/${cid()}`, { method: 'DELETE' }); closeD(); load();
  });
})();
