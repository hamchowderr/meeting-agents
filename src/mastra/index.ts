import { Mastra } from '@mastra/core'
import { recallFromEnv } from '../recall/client'
import { Calls } from '../sales/calls'
import { modelExtractor, salesCallAgent } from '../sales/extract'
import { salesRoutes } from './routes'

/**
 * Meeting agents. One Mastra server (Hono) for Coolify:
 * - /app/*            the web app: start page, co-pilot (/app/live/:id), bot camera (/app/screen/:id)
 * - /auth/*           seller sign-in: a code emailed through the hub, then a signed cookie
 * - /calls/*          seller API: each seller sees their own calls, admins see all
 * - /screen/:id/*     the prospect view, for the bot's camera page (per-call token)
 * - /recall/*         Recall's real-time transcript webhook (per-call secret + Recall signature)
 */
const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT ?? 4111}`).replace(/\/$/, '')

export const calls = new Calls({
  recall: recallFromEnv(),
  extractor: modelExtractor(),
  publicUrl,
  botName: process.env.BOT_NAME || undefined,
})

export const mastra = new Mastra({
  agents: { salesCallAgent },
  server: {
    port: Number(process.env.PORT ?? 4111),
    host: process.env.HOST ?? '0.0.0.0',
    apiRoutes: salesRoutes(calls),
  },
})
