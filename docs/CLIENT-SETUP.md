# Rebuild it for a client

A checklist for turning this into a recruiting agent for one client (a staffing agency, a factory, a BPO).

## 1. Brand it

In `.env`:

```
BRAND_NAME=Acme Staffing
AGENT_NAME=Riya
PUBLIC_BASE_URL=https://recruit.acme.com
```

`BRAND_NAME` appears in the dashboard header and as the company on calls for new roles. `AGENT_NAME` is the first name the voice introduces itself with.

## 2. Pick the voice

In Dograh, Settings > Models, choose the voice and language. Keep it warm and fast. Test a call and listen to the first 10 seconds: that decides whether candidates stay on the line.

## 3. Set up their roles

For each role in **Roles and jobs**:

- Title, location, minimum years, maximum notice period.
- Must-have skills (comma separated). These drive scoring and the agent's skill questions.
- Budget in rupees per month.
- Extra questions, one per line (for example `Have you worked rotating shifts?`).
- **Negotiation settings**: budget, on or off, stretch percentage and the reason the budget is tight. The agent paraphrases the reason, so write it as a sentence a recruiter could say aloud.

## 4. Tune the screening agent

The agent's script is `dograh/screener-prompt.txt` (also inside `dograh/workflow.json`). It is plain English with placeholders such as `{{job_title}}` and `{{resume_text}}`. Common edits:

- Greeting and tone.
- How many resume questions it asks (default 3 to 4).
- Which details it confirms (notice period, salary, location).
- Rules for what it must never say.

After editing, either update the workflow in the Dograh dashboard or run `npm run setup:dograh` again to create a new copy and use its UUID.

## 5. Bring in their leads

Export applicants from their job board as CSV and use **Import leads**. If their columns have unusual names, add the names to the `HDR` table in `suite.js`.

## 6. Deploy

- **VPS**: any small Linux server. Run Dograh with Docker, run this app with `docker compose up -d` or `npm start` behind a reverse proxy with HTTPS. Put the app and Dograh close to your callers to keep call latency low.
- Set `ADMIN_PASSWORD` and a random `SESSION_SECRET`. Never expose the dashboard without a password.
- Back up the `data/` folder (the SQLite database).

## 7. Production checklist

- [ ] Every lead has applied or consented to a call.
- [ ] Do-not-call rules for the client's country are handled.
- [ ] The agent discloses the call is recorded (it does by default).
- [ ] `ADMIN_PASSWORD` and `SESSION_SECRET` are set.
- [ ] A test call to your own number sounds right, including a salary negotiation.
- [ ] `IMPORT_CALL_ALLOWLIST` is tested, then `IMPORT_CALL_ANY=1` is set deliberately.
- [ ] Call costs are agreed with the client.

## Selling it

Recruiting firms earn per placement, so sell hours saved and more placements per recruiter, not "AI". A human screen takes 15 to 20 minutes. The AI first pass means recruiters only talk to the top of the pool.
