import { Mastra } from '@mastra/core'
import { crmFromEnv } from '../crm/fluentcrm'
import { recallFromEnv } from '../recall/client'
import { Calls } from '../sales/calls'
import { modelExtractor, salesCallAgent } from '../sales/extract'
import { meetingSummaryAgent, modelSummarizer } from '../sales/summary'
import { callStoreFromEnv } from '../store/calls-db'
import { salesRoutes } from './routes'

/**
 * Meeting agents. One Mastra server (Hono) for Coolify:
 * - /app/*            the web app: start page, co-pilot (/app/live/:id), bot camera (/app/screen/:id)
 * - /auth/*           seller sign-in: a code emailed through the hub, then a signed cookie
 * - /calls/*          seller API: each seller sees their own calls, admins see all
 * - /bookings         the hub's bookings snippet: schedule or cancel the bot for a booking
 * - /screen/:id/*     the prospect view, for the bot's camera page (per-call token)
 * - /recall/webhook   Recall's dashboard webhook: bot status, recording and transcript events
 * - /recall/transcript/:id  Recall's real-time transcript webhook (per-call secret)
 */
const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT ?? 4111}`).replace(/\/$/, '')

export const calls = new Calls({
  recall: recallFromEnv(),
  extractor: modelExtractor(),
  summarizer: modelSummarizer(),
  store: callStoreFromEnv(),
  crm: crmFromEnv(),
  publicUrl,
  botName: process.env.BOT_NAME || undefined,
})

// Bring back saved calls (scheduled bots, transcripts, notes) before serving.
const loaded = await calls.load().catch((e) => {
  console.error('loading saved calls failed', e instanceof Error ? e.message : String(e))
  return 0
})
console.log(`meeting agents: ${loaded} saved calls loaded`)

export const mastra = new Mastra({
  agents: { salesCallAgent, meetingSummaryAgent },
  server: {
    port: Number(process.env.PORT ?? 4111),
    host: process.env.HOST ?? '0.0.0.0',
    apiRoutes: salesRoutes(calls),
  },
})
