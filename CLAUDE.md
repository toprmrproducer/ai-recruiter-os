# AI Recruiter OS: notes for coding agents

Node 22.13+ with the built-in `node:sqlite` (run with `--experimental-sqlite`), zero npm dependencies. Run `npm test` after every change (32 tests, mock Dograh).

- `server.js`: HTTP server, applications, Dograh call trigger, result webhook, screening context sent into every call. `screeningContext()` is the contract with `dograh/screener-prompt.txt`: every `{{variable}}` in the prompt must exist there.
- `suite.js`: jobs and negotiation settings, CSV import (`parseCsv`, `mapLeadRows`, `leadToCandidate`) and the call queue, plus interviews, offers, automation. The call queue only dials numbers on the allowlist unless `IMPORT_CALL_ANY=1`. Never weaken this lock and never use realistic fake mobile numbers in tests.
- `scoring.js`: 100 point rubric and `parseAnswer` (salary: bare lakhs and bare numbers up to 300 mean lakhs per year).
- `public/dashboard.html` and `public/suite.js`: dashboard. Charts are hand-written SVG helpers (`donut`, `hbars`, `histo`).
- `dograh/workflow.json`: the voice agent. `scripts/setup-dograh.mjs` creates it in Dograh.
- Secrets live only in `.env` (gitignored). Never commit `.env`, `*.db` or `call-allowlist.txt`.
