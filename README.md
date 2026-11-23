# Meeting agents

Recall.ai bots that join Zoom and Google Meet calls, run by Mastra agents. The first
agent is the **sales call co-pilot**: it listens for the five profit-formula numbers
(leads, conversion, transactions, average sale, margin), finds the weakest lever,
suggests the next question, ranks every offer by fit and value, and can put the
prospect's own numbers on the bot's camera.

## How a call works

1. Open `https://<domain>/app/`, sign in with the code emailed to you (sellers are listed in
   `SELLERS`; Tylan and Sam each see only their own calls, an admin sees all), paste a Zoom or
   Meet link, press **Send the bot**.
2. Recall sends the bot into the meeting under the name the seller picks (default "<first name>'s notetaker") with low-latency streaming transcription
   (1-3 s, English). Each finished line is posted to `/recall/transcript/:id`.
3. After each burst of lines, the `sales-call` agent (Claude Haiku 5.5, structured output; AIMock in tests)
   reports what the new lines add: numbers the prospect said, goal, leak, money question,
   the step, and the next question. All math is done in `src/sales/levers.ts`, never by the model.
4. The co-pilot (`/app/live/:id`) updates live over server-sent events.
5. **Math on their screen** turns on the bot's camera page (`/app/screen/:id`, 1280x720):
   only the prospect's own numbers, never estimates, offers or coaching.

Calls are kept in memory in Phase 1, so a restart forgets them. Call history goes to
Doltgres in Phase 2.

## Layout

| Path | What |
|---|---|
| `src/recall/` | Recall client, request verification, transcript events |
| `src/sales/levers.ts` | Profit formula, offers by lever, ranking (shared with the web app) |
| `src/sales/extract.ts` | The `sales-call` agent and its output schema |
| `src/sales/calls.ts` | Live calls: bot start, utterances, one extraction pass at a time |
| `src/mastra/routes.ts` | Owner API, prospect screen stream, Recall webhook, web app files |
| `src/mastra/tools/recall.ts` | Tools so other agents can send the bot to a meeting |
| `src/auth/` | Seller sign-in: emailed code through the hub, signed cookie |
| `src/sales/model.ts` | The model switch: Claude Haiku 5.5, or AIMock with `USE_AIMOCK=true` |
| `fixtures/` | AIMock answers for the sales-call agent |
| `web/` | Vite + React + Tailwind: sign-in, start page, co-pilot, bot screen |

## Run

```bash
npm ci
npm run build:web && npx tsx scripts/demo.ts   # scripted call, no Recall or model needed
npm test                                        # starts AIMock (fixtures/), runs vitest
npm run typecheck
npm run build                                   # web app + Mastra server into .mastra/output
```

`npm run dev` runs `mastra dev` on :4111 (Studio included). Recall needs a public
`PUBLIC_URL` to reach the webhook and camera page, so real calls run on the deployed server
(or a tunnel).

## Environment

See `.env.example`. In production the values come from Infisical (Otaku Solutions,
Production, `/otaku`): `RECALL_API_KEY`, `ANTHROPIC_API_KEY`, and the hub's `FLUENTCRM_AUTH` for sign-in
codes (Client Desk's `DESK_FLUENTCRM_AUTH`). `SELLERS` is not a secret. Sessions are signed with a key
derived from `RECALL_API_KEY` unless `SESSION_SECRET` is set. `RECALL_WEBHOOK_SECRET` is optional.

## Meeting platforms

- **Zoom:** works with no setup. Turn the waiting room off for booked calls, or admit the bot.
- **Google Meet:** works as a guest the host admits. For bots that join on their own,
  Recall's signed-in bots need a dedicated Google Workspace account.

## How bots reach meetings

- **Booked meetings (production path).** The hub's bookings snippet posts every booking on a seller's intro-call event to `POST /bookings` (header `X-Hook-Secret` = `BOOKINGS_SECRET`). The app creates a Recall bot with `join_at` set to the meeting start and stores booking id → bot id, so a repeated post never creates a second bot. A rescheduled booking replaces the scheduled bot; a cancelled one deletes it (or removes it from the call inside the last 10 minutes). A booking without a Zoom or Meet link gets no bot.
- **Pasted link (unplanned calls).** The start page sends a bot to a link at once.
- **Recording notice.** Every bot posts "This meeting is being recorded and transcribed" in the meeting chat when it joins.
- **Calendar.** Recall Calendar V2 is not used: FluentBooking already syncs the sellers' Google calendars and creates the meeting links, so bookings are the scheduling source. Next step if meetings booked outside FluentBooking need bots: connect Calendar V2 (Google OAuth app, then `start_calendar_integration_setup`) with an opt-in rule per event.

## After the meeting

Recall's dashboard webhook (`POST /recall/webhook`, verified with `RECALL_WEBHOOK_VERIFICATION_SECRET`) drives the rest:

1. `bot.*` events move the call through scheduled → joining → waiting → live → ended (or failed).
2. `recording.done` starts a Recall.ai Transcription post-meeting transcript (`recallai_async`, separate-stream diarization).
3. `transcript.done` downloads it, writes a summary with the meeting-summary agent, and adds a `meeting` note plus the `Call: Held` tag to the prospect's FluentCRM contact. The transcript and summary also show on the call's page.

Each webhook id is handled once; the after-meeting job runs once per call. Calls are saved in libSQL (`DATABASE_URL`: a file on the Coolify volume, or Turso), so a restart keeps scheduled bots and notes.
