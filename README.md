# Meeting agents

Recall.ai bots that join Zoom and Google Meet calls, run by Mastra agents. The first
agent is the **sales call co-pilot**: it listens for the five profit-formula numbers
(leads, conversion, transactions, average sale, margin), finds the weakest lever,
suggests the next question, ranks every offer by fit and value, and can put the
prospect's own numbers on the bot's camera.

## How a call works

1. Open `https://<domain>/app/?key=<OWNER_KEY>`, paste a Zoom or Meet link, press **Send the bot**.
2. Recall sends "Otaku notes" into the meeting with low-latency streaming transcription
   (1-3 s, English). Each finished line is posted to `/recall/transcript/:id`.
3. After each burst of lines, the `sales-call` agent (Claude Haiku 5.5, structured output)
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
| `web/` | Vite + React + Tailwind: start page, co-pilot, bot screen |

## Run

```bash
npm ci
npm run build:web && npx tsx scripts/demo.ts   # scripted call, no Recall or model needed
npm test
npm run typecheck
npm run build                                   # web app + Mastra server into .mastra/output
```

`npm run dev` runs `mastra dev` on :4111 (Studio included). Recall needs a public
`PUBLIC_URL` to reach the webhook and camera page, so real calls run on the deployed server
(or a tunnel).

## Environment

See `.env.example`. In production the values come from Infisical (Otaku Solutions,
Production, `/otaku`): `RECALL_API_KEY`, `RECALL_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `OWNER_KEY`.

## Meeting platforms

- **Zoom:** works with no setup. Turn the waiting room off for booked calls, or admit the bot.
- **Google Meet:** works as a guest the host admits. For bots that join on their own,
  Recall's signed-in bots need a dedicated Google Workspace account.
