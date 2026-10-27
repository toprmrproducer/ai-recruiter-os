// Screening questions, answer parsing and the scoring rubric (100 points).

export const QUESTIONS = [
  { key: 'years_experience', type: 'number', ask: 'How many years of relevant experience do you have for this role?' },
  { key: 'skill_example', type: 'text', ask: 'Walk me through one specific example from your work that shows you can do this job. What did you do, and what was the result?' },
  { key: 'notice_days', type: 'days', ask: 'What is your notice period? How soon could you join?' },
  { key: 'expected_salary', type: 'salary', ask: 'What monthly salary are you expecting, in rupees?' },
  { key: 'relocation_ok', type: 'bool', ask: 'This role is based at the job location. Are you able to work from there?' },
  { key: 'availability', type: 'text', ask: 'If you are shortlisted, when are you free for a 30-minute interview this week?' },
];

const WORDNUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30 };

function firstNumber(s) {
  const m = String(s).toLowerCase().replace(/,/g, '').match(/(\d+(\.\d+)?)|\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty)\b/);
  if (!m) return null;
  return m[1] !== undefined ? Number(m[1]) : WORDNUM[m[3]];
}

export function parseAnswer(q, raw) {
  if (raw === null || raw === undefined) return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
  const s = String(raw).trim().toLowerCase();
  switch (q.type) {
    case 'number': {
      const n = firstNumber(s);
      if (n === null) return null;
      return /month/.test(s) && !/year/.test(s) ? Math.round((n / 12) * 10) / 10 : n;
    }
    case 'days': {
      if (/immediate|right away|now|asap|serving|already left|no notice/.test(s) && !/\d/.test(s)) return 0;
      const n = firstNumber(s);
      if (n === null) return null;
      if (/month/.test(s)) return n * 30;
      if (/week/.test(s)) return n * 7;
      return n;
    }
    case 'salary': {
      const n = firstNumber(s);
      if (n === null) return null;
      if (/\blp[as]\b|lpa|lakh.*(annum|year|per year|pa)|per annum|ctc/.test(s)) return Math.round((n * 100000) / 12);
      if (n > 0 && n <= 300 && !/month|pm\b|monthly|k\b|thousand|lakh|lac/.test(s)) return Math.round((n * 100000) / 12); // bare small number = lakhs per year
      if (/lakh|lac/.test(s)) return (/month|per month|pm\b|monthly/.test(s) && n < 5) ? Math.round(n * 100000) : Math.round((n * 100000) / 12); // bare lakhs = yearly; 5+ lakh a month is not a real monthly figure, so read it as yearly
      if (/\d\s*k\b|thousand/.test(s)) return n * 1000;
      return n;
    }
    case 'bool':
      if (/^(n|no|nope|nah)\b|can't|cannot|can not|won't|unable|not (able|possible|willing)/.test(s)) return false;
      if (/^(y|yes|yeah|yep|sure|of course|absolutely|definitely|ok|okay|haan|ha)\b|can relocate|i can|no problem|already (live|based)/.test(s)) return true;
      if (/^(n|no|nope|nah|not)\b|can't|cannot|won't|unable/.test(s)) return false;
      return null;
    default:
      return String(raw).trim();
  }
}

const has = v => v !== undefined && v !== null && v !== '';


// ---------------------------------------------------------------- evidence of specifics (numbers beat vague claims)
const NUM_WORDS = '(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|lakh|lakhs|crore|crores|million|billion|percent)';
const NUM_RE = new RegExp(`(\\d[\\d,.]*\\s*(?:%|k\\b|x\\b)?|\\b${NUM_WORDS}\\b)`, 'i');
const IMPACT_RE = /(sav(?:ed|ing|ings)|reduc(?:ed|tion)|\bcut\b|increas(?:ed|e)|\bgrew\b|growth|improv(?:ed|ement)|boost(?:ed)?|doubl(?:ed|e)|tripl(?:ed|e)|revenue|profit|\bcost|faster|conversion|retention|uptime|latency|percent|%|per (?:day|month|week)|a (?:day|month|week)|within|in (?:\d+|a|two|three|four|five|six)\s*(?:day|week|month|year)s?)/i;
const SCALE_RE = /(?:\d[\d,.]*|thousand|lakh|lakhs|million|hundred)\s*(?:\+\s*)?(?:users|clients|customers|requests|leads|calls|orders|transactions|employees|people|team|members|stores|accounts|candidates|agents|invoices|tickets|downloads|sites|projects)/gi;
const OWN_RE = /\b(?:i|we)\s+(built|led|designed|owned|launched|shipped|created|developed|managed|set up|wrote|implemented|automated|scaled|migrated|ran)\b/gi;
const OFF_TOPIC = /\b(notice|salary|ctc|lpa|lakh per|joining|expect(?:ing)?|relocat|available|slot)\b/i;
export function evidenceOf(text) {
  const t = String(text || '').replace(/\b(?:19|20)\d{2}\b/g, 'YEAR').replace(/\s+/g, ' ').trim();
  const seen = new Set();
  const sentences = t.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => { const k = s.toLowerCase(); if (!s || seen.has(k)) return false; seen.add(k); return true; });
  const usable = sentences.filter(s => !OFF_TOPIC.test(s) || /\b(saved|reduced|increased|revenue|users|clients)\b/i.test(s));
  const quant = usable.filter(s => NUM_RE.test(s));
  const impact = quant.filter(s => IMPACT_RE.test(s));
  const scale = [...t.matchAll(SCALE_RE)].length;
  const own = new Set([...t.matchAll(OWN_RE)].map(m => m[1].toLowerCase()));
  const words = t.split(/\s+/).filter(Boolean).length;
  const pts = Math.min(3, impact.length) * 5 + Math.min(2, Math.max(0, quant.length - impact.length)) * 2 + Math.min(2, scale) * 2.5 + Math.min(3, own.size) + (words >= 250 ? 3 : words >= 120 ? 2 : words >= 60 ? 1 : 0);
  return { points: Math.min(30, Math.round(pts)), impact: impact.length, quant: quant.length, scale, own: own.size, words, proof: [...impact, ...quant.filter(s => !impact.includes(s))].slice(0, 4).map(s => s.length > 230 ? s.slice(0, 227) + '...' : s) };
}

// Score from the form alone (before screening) or from form + screening answers.
export function scoreCandidate(c, job, answers) {
  const a = answers || {};
  const breakdown = [];
  const flags = [];
  let knockout = false;
  // Weights: specifics and results carry the most (30), the rest are scaled so the total stays 100.
  const SCALE = { Experience: 0.8, 'Salary fit': 0.75, 'Notice period': 2 / 3, Location: 2 / 3 };
  const add = (label, pts, max, note) => { const k = SCALE[label] ?? 1; breakdown.push({ label, points: Math.round(pts * k), max: Math.round(max * k), note }); };

  // 1. Experience (25)
  const years = has(a.years_experience) ? a.years_experience : c.years;
  if (has(years)) {
    const r = Math.min(years / Math.max(job.min_years, 0.5), 1.5);
    add('Experience', Math.min(25, r * (25 / 1.2)), 25, `${years} yrs vs ${job.min_years} required`);
    if (years < job.min_years - 2) { knockout = true; flags.push({ level: 'red', text: `Only ${years} yrs, role needs ${job.min_years}` }); }
  } else add('Experience', 0, 25, 'not given');

  // 2. Salary fit (20)
  const asked = has(a.expected_salary) ? a.expected_salary : c.expected_salary;
  const negotiated = a.negotiation_outcome === 'accepted' && has(a.agreed_salary);
  const sal = negotiated ? a.agreed_salary : asked;
  if (has(sal) && !job.max_salary) add('Salary fit', 20, 20, `Rs ${Number(sal).toLocaleString('en-IN')}/mo, no budget set for this role`);
  else if (has(sal)) {
    const ratio = sal / job.max_salary;
    const pts = ratio <= 1 ? 20 : ratio <= 1.15 ? 12 : ratio <= 1.3 ? 5 : 0;
    add('Salary fit', pts, 20, `Rs ${Number(sal).toLocaleString('en-IN')}/mo vs budget Rs ${job.max_salary.toLocaleString('en-IN')}${negotiated ? ` (negotiated down from Rs ${Number(asked).toLocaleString('en-IN')})` : ''}`);
    if (negotiated && has(asked) && asked > sal) flags.push({ level: 'amber', text: `Negotiated: asked Rs ${Number(asked).toLocaleString('en-IN')}/mo, agreed Rs ${Number(sal).toLocaleString('en-IN')}/mo (subject to hiring team approval)` });
    if (a.negotiation_outcome === 'declined') flags.push({ level: 'amber', text: 'Salary negotiation not agreed: candidate held at their ask' });
    if (ratio > 1.3) { knockout = true; flags.push({ level: 'red', text: 'Salary expectation more than 30% over budget' }); }
  } else add('Salary fit', 0, 20, 'not given');

  // 3. Notice period (15)
  const notice = has(a.notice_days) ? a.notice_days : c.notice_days;
  if (has(notice)) {
    const pts = notice <= job.max_notice_days ? 15 : notice <= job.max_notice_days * 2 ? 7 : 0;
    add('Notice period', pts, 15, `${notice} days vs max ${job.max_notice_days}`);
    if (notice > job.max_notice_days * 2) flags.push({ level: 'amber', text: `Long notice period: ${notice} days` });
  } else add('Notice period', 0, 15, 'not given');

  // 4. Location (15)
  const city = String(c.city || '').toLowerCase();
  const inCity = job.locations.some(l => l && !l.endsWith('-no') && city.includes(l));
  if (a.relocation_ok === false && !inCity) { add('Location', 0, 15, `${c.city}, cannot work from job location`); knockout = true; flags.push({ level: 'red', text: 'Cannot work from the job location' }); }
  else if (inCity || a.relocation_ok === true) add('Location', 15, 15, inCity ? `Based in ${c.city}` : `Will work from job location (lives in ${c.city})`);
  else add('Location', 6, 15, `${c.city}, relocation not confirmed`);

  // 5. Must-have skills across form + call (15)
  const text = `${c.skills || ''} ${c.why || ''} ${a.skill_example || ''}`.toLowerCase();
  const hit = job.must_skills.filter(s => text.includes(s.toLowerCase()));
  add('Must-have skills', (hit.length / Math.max(job.must_skills.length, 1)) * 15, 15, hit.length ? `Mentioned: ${hit.join(', ')}` : `None of: ${job.must_skills.join(', ')}`);

  // 6. Answer quality (30): specific numbers and results, ownership, willingness to elaborate. Only once screened.
  if (answers) {
    const e = evidenceOf([a.evidence_text, a.skill_example].filter(Boolean).join(' '));
    let q = e.points;
    if (has(a.years_experience) && has(c.years) && Math.abs(a.years_experience - c.years) >= 2) {
      q -= 6; flags.push({ level: 'amber', text: `Form says ${c.years} yrs, call says ${a.years_experience} yrs` });
    }
    add('Answer quality', Math.max(0, Math.min(30, q)), 30, e.words ? `${e.impact} result${e.impact === 1 ? '' : 's'} with numbers, ${e.scale} scale detail${e.scale === 1 ? '' : 's'}, ${e.own} ownership claim${e.own === 1 ? '' : 's'}, ${e.words} words` : 'no example given');
    if (!e.words) flags.push({ level: 'amber', text: 'No role example given' });
    else if (e.impact === 0) flags.push({ level: 'amber', text: 'Vague: no numbers or results given' });
    else if (e.impact >= 2) flags.push({ level: 'good', text: 'Specific: backs claims with numbers and results' });
  } else add('Answer quality', 0, 30, 'not screened yet');

  let total = breakdown.reduce((s, b) => s + b.points, 0);
  let verdict;
  if (!answers) verdict = 'Pending screen';
  else if (knockout) verdict = 'Reject';
  else verdict = total >= 75 ? 'Strong' : total >= 55 ? 'Maybe' : 'Reject';
  return { total: Math.round(total), verdict, breakdown, flags, knockout };
}

// Pros, cons, outliers vs the applicant pool, and the one-line reason they can't be hired.
const median = xs => { const s = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function evaluate(result, candidate, answers, pool) {
  const pros = [], cons = [], outliers = [];
  for (const b of result.breakdown) {
    if (b.label === 'Answer quality' && !answers) continue;
    const r = b.points / b.max;
    if (r >= 0.8) pros.push(`${b.label}: ${b.note}`);
    else if (r <= 0.4) cons.push(`${b.label}: ${b.note}`);
  }
  // pool = other candidates for the same job: [{years, expected_salary, total}]
  const a = answers || {};
  const val = {
    years: a.years_experience ?? candidate.years,
    salary: a.expected_salary ?? candidate.expected_salary,
    score: result.total,
  };
  if (pool.length >= 3) {
    const med = { years: median(pool.map(p => p.years)), salary: median(pool.map(p => p.expected_salary)), score: median(pool.map(p => p.total)) };
    const check = (k, label, unit, goodHigh) => {
      const v = val[k], m = med[k];
      if (!Number.isFinite(v) || !Number.isFinite(m) || m === 0) return;
      const ratio = v / m;
      if (ratio >= 1.5 || ratio <= 0.6) {
        const good = goodHigh ? ratio > 1 : ratio < 1;
        outliers.push({ good, text: `${label} ${v}${unit} vs pool median ${Math.round(m * 10) / 10}${unit} (${ratio > 1 ? '+' : ''}${Math.round((ratio - 1) * 100)}%)` });
      }
    };
    check('years', 'Experience', ' yrs', true);
    check('salary', 'Salary ask', '', false);
    check('score', 'Score', '', true);
  }
  const ex = String(a.skill_example || '');
  if (ex.split(/\s+/).length >= 40 && /\d/.test(ex)) outliers.push({ good: true, text: 'Unusually detailed, number-backed role example' });

  let blocker = null;
  const red = result.flags.filter(f => f.level === 'red');
  if (red.length) blocker = red.map(f => f.text).join('; ');
  else if (answers && result.verdict === 'Reject') {
    const worst = [...result.breakdown].sort((x, y) => x.points / x.max - y.points / y.max)[0];
    blocker = `Score ${result.total}/100 is under the 55 bar, weakest area: ${worst.label} (${worst.note})`;
  }
  return { hire_score: result.total, pros, cons, outliers, blocker };
}

export const CRITERIA = [
  { label: 'Experience', max: 20, rule: 'Relevant years vs the role minimum. Full marks at 1.2x the minimum. Knockout if 2+ years under.' },
  { label: 'Salary fit', max: 15, rule: 'Within budget = full marks, up to 15% over = 60%, up to 30% over = 25%. Knockout above 30% over.' },
  { label: 'Notice period', max: 10, rule: 'Within the max notice = full marks, up to 2x = about half, longer = 0 and flagged.' },
  { label: 'Location', max: 10, rule: 'Lives in a job city or confirms they can work there = full marks. Unconfirmed = 40%. Refuses = 0 and knockout.' },
  { label: 'Must-have skills', max: 15, rule: 'Share of the role\'s must-have skills mentioned in the form or call.' },
  { label: 'Answer quality', max: 30, rule: 'The biggest line. Numbers and results beat vague claims: each result backed by a number (money saved, revenue, time, percentages, users, clients, requests) earns up to 5 points (3 results max), scale details, ownership verbs (built, led, shipped) and a willingness to explain add the rest. Minus 6 if the form and call disagree on experience.' },
];

// ---------------------------------------------------------------- resume probes
// Rules-based resume compaction for the voice agent: employment timeline with
// gap detection, claimed skills, and curveball probes. No LLM needed; if the
// v2 suite parsed the resume, its summary rides along in the call context.
const PROBE_SKILLS = ['crm', 'cold calling', 'excel', 'sql', 'python', 'java', 'javascript', 'typescript', 'react', 'node', 'node.js', 'next.js', 'sales', 'support', 'zendesk', 'salesforce', 'hubspot', 'team lead', 'marketing', 'seo', 'accounting', 'tally', 'customer service', 'communication', 'docker', 'aws', 'postgres', 'mongodb'];

export function resumeProbes(resumeText) {
  const text = String(resumeText || '');
  if (!text.trim()) return { gaps: [], skills: [], probes: [], summary: '' };
  const low = text.toLowerCase();
  const now = new Date().getFullYear();

  // Employment timeline: year ranges like 2019-2021, 2021 - Present, 2021 to 2022
  const ranges = [...text.matchAll(/((?:19|20)\d{2})\s*(?:-|–|—|to|until)\s*((?:19|20)\d{2}|present|current|now)/gi)]
    .map(m => ({ start: Number(m[1]), end: /present|current|now/i.test(m[2]) ? now : Number(m[2]) }))
    .filter(r => r.end >= r.start && r.start >= 1970 && r.start <= now)
    .sort((a, b) => a.start - b.start);
  const gaps = [];
  for (let i = 1; i < ranges.length; i++) {
    const hole = ranges[i].start - ranges[i - 1].end;
    if (hole >= 1) gaps.push({ after: ranges[i - 1].end, until: ranges[i].start });
  }

  // Match complete skill names. Substring matching turns JavaScript into a false
  // Java claim, which makes a live interview sound careless.
  const hasSkill = skill => {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`(^|[^a-z0-9+#.])${escaped}(?=$|[^a-z0-9+#.])`, 'i').test(low);
  };
  const found = PROBE_SKILLS.filter(hasSkill);
  const skills = found.filter(s => !(s === 'node' && found.includes('node.js'))).slice(0, 6);
  const label = s => ({ crm: 'CRM', sql: 'SQL', seo: 'SEO', sla: 'SLA', aws: 'AWS', hr: 'HR', node: 'Node.js', 'node.js': 'Node.js', 'next.js': 'Next.js', tally: 'Tally' })[s] || s.replace(/\b\w/g, ch => ch.toUpperCase());

  // Concrete achievements deserve their own follow-up. This prevents a screen
  // from becoming a generic skill checklist when a resume contains real work.
  const highlights = [...new Set(text.split(/\n|\u2022|(?<=[.!?])\s+/).map(s => s.trim()).filter(s => /\d/.test(s) && s.length > 30 && s.length < 200 && !/(?:19|20)\d{2}\s*[-–]\s*(?:(?:19|20)\d{2}|present|current|now)/i.test(s) && !/^\+?\d[\d\s]+$/.test(s)))]
    .slice(0, 3).map(s => s.replace(/\s+/g, ' ').slice(0, 150));

  // Curveball probes: gaps and evidence first, then claimed skills, capped at 4.
  const probes = [];
  for (const g of gaps) probes.push(`Your resume shows work until ${g.after} and then nothing until ${g.until}. Walk me through what you were doing in that period.`);
  for (const h of highlights.slice(0, Math.max(0, 4 - probes.length))) {
    probes.push(`Your resume says: "${h}". What was the hardest tradeoff in that work, and how did you know your decision was right?`);
  }
  for (const s of skills.slice(0, Math.max(0, 4 - probes.length))) {
    probes.push(`You claim ${label(s)} on your resume. Rate yourself 1 to 10, then walk me through the hardest problem you solved with it.`);
  }
  const total = ranges.length ? Math.max(...ranges.map(r => r.end)) - Math.min(...ranges.map(r => r.start)) : 0;
  const summary = [
    ranges.length ? `Work history ${ranges[0].start}-${Math.max(...ranges.map(r => r.end))} (${ranges.length} stints, ~${total} yrs span)` : '',
    skills.length ? `Skills on resume: ${skills.join(', ')}` : '',
    gaps.length ? `Gaps: ${gaps.map(g => `${g.after}-${g.until}`).join(', ')}` : 'No visible gaps',
    highlights.length ? `Highlights: ${highlights.join(' | ')}` : '',
  ].filter(Boolean).join('. ');
  return { gaps, skills, probes: probes.slice(0, 4), summary, highlights };
}
