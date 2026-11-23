# Meeting agents

Recall.ai bots that join Zoom and Google Meet calls, run by Mastra agents. The first
agent is the **sales call co-pilot**: it listens for the five profit-formula numbers
(leads, conversion, transactions, average sale, margin), finds the weakest lever,
suggests the next question, ranks every offer by fit and value, and can put the
prospect's own numbers on the bot's camera.

## How a call works

1. Open `https://<domain>/app/`, sign in with the code emailed to you (sellers are listed in
   `SELLERS`; Tylan and Ric each see only their own calls, an admin sees all), paste a Zoom or
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
