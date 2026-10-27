// Demo roles and sample leads (placeholder phone numbers only, nobody real). Used by `npm run demo` and `npm run seed`.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseCsv, mapLeadRows, leadToCandidate } from './suite.js';

export function seedDemo(db, root, brand = process.env.BRAND_NAME || 'Your Company') {
  const ROLES = [
    { id: 'software-engineer-demo', title: 'Software Engineer', company: brand, location: 'Pune or remote', min_years: 2, max_salary: 150000, max_notice_days: 90,
      locations: ['pune', 'remote'], must_skills: ['javascript', 'node.js', 'python', 'sql'], description: 'Build and run backend services and internal tools.',
      custom_questions: [], negotiable: 1, stretch_pct: 15, notes: 'The team budget for this role is fixed this quarter and headcount is limited.', csv: 'sample-leads-software.csv', label: 'naukri' },
    { id: 'mechanical-engineer-demo', title: 'Mechanical Engineer, Factory', company: brand, location: 'Pune (Chakan plant)', min_years: 2, max_salary: 65000, max_notice_days: 45,
      locations: ['pune', 'chakan', 'pimpri', 'ranjangaon'], must_skills: ['autocad', 'solidworks', 'cnc', 'quality control'], description: 'Design support, CNC programming and quality checks on the production floor. Rotating shifts.',
      custom_questions: ['Have you worked rotating shifts?', 'Which CNC machines or controllers have you run?'], negotiable: 1, stretch_pct: 12, notes: 'The plant budget is fixed for the quarter. Growth into a lead role within a year is realistic.', csv: 'sample-leads-mechanical.csv', label: 'naukri-factory' },
  ];
  
  const insJob = db.prepare('INSERT INTO jobs (id,title,company,location,min_years,max_salary,locations,must_skills,max_notice_days,description,status,headcount,custom_questions,negotiable,stretch_pct,negotiation_notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insCand = db.prepare('INSERT INTO candidates (id,job_id,name,email,phone,city,years,notice_days,expected_salary,skills,why,source,resume_text) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const made = [];
  for (const r of ROLES) {
    if (db.prepare('SELECT id FROM jobs WHERE id=?').get(r.id)) continue;
    insJob.run(r.id, r.title, r.company, r.location, r.min_years, r.max_salary, JSON.stringify(r.locations), JSON.stringify(r.must_skills), r.max_notice_days, r.description, 'open', 1, JSON.stringify(r.custom_questions), r.negotiable, r.stretch_pct, r.notes);
    const { leads } = mapLeadRows(parseCsv(readFileSync(path.join(root, 'demo', r.csv), 'utf8')));
    for (const l of leads) { const c = leadToCandidate(l); insCand.run(randomUUID(), r.id, c.name, c.email, c.phone, c.city, c.years, c.notice_days, c.expected_salary, c.skills, `Imported from ${r.label}`, `csv:${r.label}`, c.resume_text); }
    made.push(`${r.title} (${leads.length} sample leads)`);
  }
  return made;
}
