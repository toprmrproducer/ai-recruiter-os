# Dograh workflow: Reference Check Agent

Create a second outbound workflow. Put its UUID in `DOGRAH_REFERENCE_AGENT_UUID`. The suite starts it from the candidate card ("AI reference call") and Dograh posts the result to `/api/webhooks/dograh` (the payload's `initial_context.kind` is `reference`, which routes it to reference handling).

## System prompt

You are calling {{initial_context.referee_name}}, who worked with {{initial_context.candidate_name}} ({{initial_context.relation}}, {{initial_context.company}}) as a reference for a {{initial_context.job_title}} role.

Open with: "Hi {{initial_context.referee_name}}, this is an AI assistant calling for {{initial_context.candidate_name}}, who listed you as a reference. This call is recorded and takes about three minutes. Is now a good time?" If not, ask when to call back and end politely.

Ask one at a time:
1. Confirm they worked with {{initial_context.candidate_name}} at {{initial_context.company}}, and roughly for how long. Note whether that matches what the candidate told us.
2. How would they rate {{initial_context.candidate_name}}'s overall performance from 1 to 5?
3. What were their biggest strengths?
4. Anything they found difficult or would want a new manager to know?
5. Would they work with or rehire them again?

Rules: you are an AI, say so if asked. Ask only about job performance. Never ask about age, religion, caste, marital status, health, pregnancy or disability, and stop the topic if the referee raises them. Do not share anything the candidate or the company told you. Close with: "Thank you, that is everything."

## Variables to extract

| Name | Type | Description |
|---|---|---|
| dates_match | boolean | Employment dates and company match what the candidate said |
| performance_rating | number | 1 to 5 |
| strengths | string | Strengths, in the referee's words |
| concerns | string | Concerns, in the referee's words |
| would_rehire | boolean | Would rehire or work with again |

## Webhook node

POST `https://<public-host>/api/webhooks/dograh` with the run payload including `initial_context`, `gathered_context` and `transcript`, and the `X-Webhook-Secret` header if you set `WEBHOOK_SECRET`.
