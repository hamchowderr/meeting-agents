import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { registerApiRoute } from '@mastra/core/server'
import type { Context } from 'hono'
import { z } from 'zod'
import { isFromRecall } from '../recall/verify'
import { utteranceFrom } from '../recall/transcript'
import type { Calls } from '../sales/calls'
import { safeEqual } from '../sales/calls'
import { type CallState, copilotView, prospectView } from '../sales/state'

const open = { requiresAuth: false } as const

/** The owner's key, from `Authorization: Bearer` or `?key=` (EventSource can't send headers). */
export function isOwner(c: Context, ownerKey = process.env.OWNER_KEY): boolean {
  if (!ownerKey) return false
  const header = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
  const given = header || c.req.query('key')
  return !!given && safeEqual(given, ownerKey)
}

const denied = (c: Context) => c.json({ error: 'unauthorized', message: 'Owner key required' }, 401)
const notFound = (c: Context) => c.json({ error: 'not_found', message: 'No such call' }, 404)

/** Server-sent events: the view now, then again on every change. */
function sse(c: Context, calls: Calls, id: string, view: (s: CallState) => unknown): Response {
  const enc = new TextEncoder()
  let stop = () => {}
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const send = (s: CallState) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(view(s))}\n\n`))
      const unsubscribe = calls.subscribe(id, send)
      const ping = setInterval(() => ctrl.enqueue(enc.encode(': ping\n\n')), 20_000)
      stop = () => {
        clearInterval(ping)
        unsubscribe()
      }
      c.req.raw.signal.addEventListener('abort', () => {
        stop()
        try {
          ctrl.close()
        } catch {}
      })
      const now = calls.get(id)
      if (now) send(now)
    },
    cancel() {
      stop()
    },
  })
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' },
  })
}

const startInput = z.object({
  meetingUrl: z.string().url().refine((u) => /zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com/.test(u), 'Zoom, Google Meet or Teams link'),
  prospect: z.string().max(120).nullish(),
})

export function salesRoutes(calls: Calls, webDist = process.env.WEB_DIST || path.resolve(process.cwd(), 'web/dist')) {
  return [
    registerApiRoute('/health', { method: 'GET', ...open, handler: async (c) => c.json({ ok: true }) }),

    // Owner: start, list, watch and control calls.
    registerApiRoute('/calls', {
      method: 'POST',
      ...open,
      handler: async (c) => {
        if (!isOwner(c)) return denied(c)
        const parsed = startInput.safeParse(await c.req.json().catch(() => ({})))
        if (!parsed.success) return c.json({ error: 'invalid', message: parsed.error.issues[0]?.message ?? 'Invalid input' }, 400)
        try {
          const s = await calls.start(parsed.data)
          return c.json(copilotView(s), 201)
        } catch (e) {
          return c.json({ error: 'recall_failed', message: e instanceof Error ? e.message : String(e) }, 502)
        }
      },
    }),
    registerApiRoute('/calls', {
      method: 'GET',
      ...open,
      handler: async (c) => {
        if (!isOwner(c)) return denied(c)
        return c.json(calls.list().map((s) => ({ id: s.id, prospect: s.prospect, status: s.status, startedAt: s.startedAt, meetingUrl: s.meetingUrl })))
      },
    }),
    registerApiRoute('/calls/:id', {
      method: 'GET',
      ...open,
      handler: async (c) => {
        if (!isOwner(c)) return denied(c)
        const s = calls.get(c.req.param('id'))
        return s ? c.json(copilotView(s)) : notFound(c)
      },
    }),
    registerApiRoute('/calls/:id/events', {
      method: 'GET',
      ...open,
      handler: async (c) => {
        if (!isOwner(c)) return denied(c)
        const id = c.req.param('id')
        return calls.get(id) ? sse(c, calls, id, copilotView) : notFound(c)
      },
    }),
    registerApiRoute('/calls/:id/math', {
      method: 'POST',
      ...open,
      handler: async (c) => {
        if (!isOwner(c)) return denied(c)
        const body = (await c.req.json().catch(() => ({}))) as { show?: boolean }
        const s = calls.setShowMath(c.req.param('id'), !!body.show)
        return s ? c.json({ showMath: s.showMath }) : notFound(c)
      },
    }),
    registerApiRoute('/calls/:id/leave', {
      method: 'POST',
      ...open,
      handler: async (c) => {
        if (!isOwner(c)) return denied(c)
        const id = c.req.param('id')
        if (!calls.get(id)) return notFound(c)
        await calls.leave(id)
        return c.json({ ok: true })
      },
    }),

    // The bot's camera page reads only the prospect view, with the call's screen token.
    registerApiRoute('/screen/:id/events', {
      method: 'GET',
      ...open,
      handler: async (c) => {
        const id = c.req.param('id')
        if (!calls.checkScreen(id, c.req.query('t'))) return notFound(c)
        return sse(c, calls, id, prospectView)
      },
    }),

    // Recall's real-time transcript webhook. The URL carries a per-call secret; with
    // RECALL_WEBHOOK_SECRET set (whsec_...), Recall's signature is checked too.
    registerApiRoute('/recall/transcript/:id', {
      method: 'POST',
      ...open,
      handler: async (c) => {
        const id = c.req.param('id')
        if (!calls.checkHook(id, c.req.query('s'))) return c.json({ error: 'unauthorized' }, 401)
        const raw = await c.req.text()
        const secret = process.env.RECALL_WEBHOOK_SECRET
        if (secret) {
          const h = (k: string) => c.req.header(k)
          const headers = Object.fromEntries(['webhook-id', 'webhook-timestamp', 'webhook-signature', 'svix-id', 'svix-timestamp', 'svix-signature'].map((k) => [k, h(k)]))
          if (!isFromRecall(secret, headers, raw)) return c.json({ error: 'bad_signature' }, 401)
        }
        let body: unknown
        try {
          body = JSON.parse(raw)
        } catch {
          return c.json({ error: 'invalid' }, 400)
        }
        const parsed = utteranceFrom(body)
        // Answer at once; the extraction runs after the response.
        if (parsed) calls.addUtterance(id, parsed.utterance)
        return c.json({ ok: true })
      },
    }),

    // The web app (Vite build): /app/... serves files, unknown paths get index.html.
    registerApiRoute('/app/*', {
      method: 'GET',
      ...open,
      handler: async (c) => {
        const rel = decodeURIComponent(new URL(c.req.url).pathname.replace(/^\/app\/?/, ''))
        const file = path.resolve(webDist, rel || 'index.html')
        if (!file.startsWith(path.resolve(webDist) + path.sep)) return c.text('Not found', 404)
        // A file if it exists; otherwise the app shell for client-side routes (paths without an extension).
        let servedPath = file
        let served = await readFile(file).catch(() => null)
        if (!served && !path.extname(rel)) {
          servedPath = path.join(webDist, 'index.html')
          served = await readFile(servedPath).catch(() => null)
        }
        if (!served) return c.text('Not found', 404)
        const type = TYPES[path.extname(servedPath)] ?? 'application/octet-stream'
        return new Response(new Uint8Array(served), {
          headers: { 'content-type': type, 'cache-control': rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' },
        })
      },
    }),
    registerApiRoute('/', { method: 'GET', ...open, handler: async (c) => c.redirect('/app/') }),
  ]
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
}
