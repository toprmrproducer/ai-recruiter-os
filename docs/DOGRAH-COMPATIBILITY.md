# Dograh compatibility

This app talks to [Dograh](https://github.com/dograh-hq/dograh) over its HTTP API. This page says exactly what was tested and what was only read from the source, so nothing here is a surprise.

## Versions

| Dograh | Status |
|---|---|
| **1.39.0, voice-engine build** | Tested end to end by the author, including real phone calls, agent creation from the Settings page, per-role voices, the 15 minute call limit and result webhooks. |
| **Standard upstream, 1.49.0 (latest at time of writing)** | **Not run.** The endpoints below were checked by reading the upstream source at tag `dograh-v1.49.0`. Please run `npm run doctor` and Settings > Test the connection first, then place one test call to your own phone. |

## Endpoints the app uses and whether they exist upstream (v1.49.0)

| Endpoint | Used for | In upstream 1.49.0 |
|---|---|---|
| `GET /api/v1/health` | Connection test, version | yes |
| `GET /api/v1/workflow/summary` | Key check | yes |
| `POST /api/v1/workflow/create/definition` | Create the agents | yes |
| `POST /api/v1/workflow/{id}/create-draft`, `PUT /api/v1/workflow/{id}`, `POST /api/v1/workflow/{id}/publish` | Save settings and publish | yes |
| `GET /api/v1/workflow/fetch/{id}` | Read the agent ID | yes |
| `POST /api/v1/public/agent/workflow/{uuid}` | Place a call | yes |
| `GET /api/v1/workflow/{id}/runs/{run_id}` | Read the transcript after a call | yes |
| `POST /api/v1/organizations/telephony-configs` and `.../phone-numbers` | Connect Twilio from the Settings page | yes, same request shape |
| `workflow_configurations.max_call_duration` | Calls longer than 5 minutes | yes |

## Where standard Dograh differs

- **Per-role voices need the voice-engine build.** The per-agent voice setting (`model_voice_override`) is not in any upstream release (checked tags 1.39, 1.43, 1.45 and 1.49). The app probes for it. On standard Dograh the voice dropdown says why it is switched off, no copies of the agent are created, and every role uses the voice you chose in Dograh under Settings > Models. Agent names per role still work.
- **The voice model key is set in Dograh.** Upstream moved model settings to a connections catalog. On standard Dograh the Settings page shows instructions instead of a form.
- **The 4,000 token prompt limit** exists only in the voice-engine build, so standard Dograh will not reject the 5,500 token screening prompt. If your Dograh has a prompt limit, create the agents anyway and shorten `dograh/screener-prompt.txt`.

## Voice-engine build

Public at <https://github.com/Harddiikk/voice-engine> (a fork of the upstream project).
