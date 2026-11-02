# Agent notes

- Mastra 1.x server; custom routes in `src/mastra/routes.ts` are registered with `registerApiRoute`
  and are public (`requiresAuth: false`): each checks its own credential (owner key, per-call
  screen token, or per-call webhook secret plus Recall's signature).
- Money math lives only in `src/sales/levers.ts`. The model picks numbers out of speech; it never computes.
- The prospect's screen must never show estimates, offers or coaching (`prospectView`).
- Tests run with no network: `npm test`. `scripts/demo.ts` plays a scripted call through the real routes.
- Never mention outside training programs or their authors in anything client- or partner-facing.
