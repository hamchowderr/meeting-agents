import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { registerApiRoute } from '@mastra/core/server'
import type { Context } from 'hono'
import { z } from 'zod'
import { mailerFromEnv, type SendCode } from '../auth/mail'
import { type Seller, firstName, sellersFromEnv } from '../auth/sellers'
import { Codes, clearCookie, sellerFrom, sessionCookie } from '../auth/session'
import { isFromRecall } from '../recall/verify'
import { utteranceFrom } from '../recall/transcript'
import { type Calls, safeEqual } from '../sales/calls'
import { type CallState, copilotView, prospectView } from '../sales/state'

const open = { requiresAuth: false } as const

const denied = (c: Context) => c.json({ error: 'unauthorized', message: 'Sign in first' }, 401)
const notFound = (c: Context) => c.json({ error: 'not_found', message: 'No such call' }, 404)

/** The signed-in seller's call, or null: a seller sees their own calls, an admin sees all. */
function ownCall(c: Context, calls: Calls, seller: Seller): CallState | null {
  const s = calls.get(c.req.param('id') ?? '')
  return s && (seller.admin || s.seller.email === seller.email) ? s : null
}

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

const meetingLink = z
  .string()
  .url()
  .refine((u) => /zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com/.test(u), 'Zoom, Google Meet or Teams link')

const startInput = z.object({
  meetingUrl: meetingLink,
  prospect: z.string().max(120).nullish(),
  prospectEmail: z.string().email().nullish(),
  /** What the bot is called in the meeting; blank means "<first name>'s notetaker". */
  botName: z.string().trim().max(100).nullish(),
})

/** What the hub posts for each booking on a seller's intro-call event, and each cancellation. */
const bookingInput = z.object({
  bookingId: z.union([z.string(), z.number()]).transform(String),
  status: z.enum(['scheduled', 'cancelled']),
  /** The seller key the booking records ("tylan", "ric"): matched to a seller's first name. */
  seller: z.string().min(1),
  prospectName: z.string().max(120).nullish(),
  prospectEmail: z.string().email().nullish(),
  startAt: z.string().datetime({ offset: true }).nullish(),
  meetingUrl: z.string().nullish(),
})

const RECALL_HEADERS = ['webhook-id', 'webhook-timestamp', 'webhook-signature', 'svix-id', 'svix-timestamp', 'svix-signature']

function recallHeaders(c: Context): Record<string, string | undefined> {
  return Object.fromEntries(RECALL_HEADERS.map((k) => [k, c.req.header(k)]))
}

type RecallEvent = {
  event?: string
  data?: {
    data?: { code?: string; sub_code?: string | null }
    bot?: { id?: string }
    recording?: { id?: string }
    transcript?: { id?: string }
  }
}

/** Handles one verified Recall event after the 2xx went back. */
export async function handleRecallEvent(calls: Calls, ev: RecallEvent): Promise<void> {
  const type = ev.event ?? ''
  const botId = ev.data?.bot?.id
  if (!botId) return
  if (type.startsWith('bot.')) calls.botStatus(botId, ev.data?.data?.code ?? type.slice(4), ev.data?.data?.sub_code ?? null)
  else if (type === 'recording.done' && ev.data?.recording?.id) await calls.recordingDone(botId, ev.data.recording.id)
  else if (type === 'transcript.done' && ev.data?.transcript?.id) await calls.transcriptDone(botId, ev.data.transcript.id)
  else if (type === 'transcript.failed') calls.transcriptFailed(botId, ev.data?.data?.sub_code ?? null)
}

export function salesRoutes(calls: Calls, opts: { webDist?: string; sendCode?: SendCode } = {}) {
  const webDist = opts.webDist ?? (process.env.WEB_DIST || path.resolve(process.cwd(), 'web/dist'))
  const sendCode = opts.sendCode ?? mailerFromEnv()
  const codes = new Codes()
  // Recall retries a message until it gets a 2xx; the same webhook-id is handled once.
  const seenEvents = new Map<string, number>()
  return [
    registerApiRoute('/health', { method: 'GET', ...open, handler: async (c) => c.json({ ok: true }) }),

    // Sign-in: a code to a listed seller's email, then a signed cookie.
    registerApiRoute('/auth/code', {
      method: 'POST',
      ...open,
      handler: async (c) => {
        const { email } = (await c.req.json().catch(() => ({}))) as { email?: string }
        const seller = sellersFromEnv().find((s) => s.email === email?.trim().toLowerCase())
        // Same answer either way, so the form doesn't reveal who is a seller.
        if (seller) {
          try {
            await sendCode(seller, codes.issue(seller.email))
          } catch (e) {
            console.error('sign-in email failed', e)
            return c.json({ error: 'email_failed', message: "The code couldn't be sent. Try again in a minute." }, 502)
          }
        }
        return c.json({ ok: true })
      },
    }),
    registerApiRoute('/auth/verify', {
      method: 'POST',
      ...open,
      handler: async (c) => {
        const { email, code } = (await c.req.json().catch(() => ({}))) as { email?: string; code?: string }
        const seller = sellersFromEnv().find((s) => s.email === email?.trim().toLowerCase())
        if (!seller || !code || !codes.check(seller.email, code.trim())) return c.json({ error: 'bad_code', message: 'That code is wrong or expired.' }, 401)
        c.header('set-cookie', sessionCookie(seller.email, new URL(c.req.url).protocol === 'https:' || process.env.NODE_ENV === 'production'))
        return c.json({ name: seller.name, email: seller.email, admin: seller.admin })
      },
    }),
    registerApiRoute('/auth/me', {
      method: 'GET',
      ...open,
      handler: async (c) => {
        const seller = sellerFrom(c)
        return seller ? c.json({ name: seller.name, email: seller.email, admin: seller.admin }) : denied(c)
      },
    }),
    registerApiRoute('/auth/logout', {
      method: 'POST',
      ...open,
      handler: async (c) => {
        c.header('set-cookie', clearCookie())
        return c.json({ ok: true })
      },
    }),

    // Sellers: start, list, watch and control their calls.
    registerApiRoute('/calls', {
      method: 'POST',
      ...open,
      handler: async (c) => {
        const seller = sellerFrom(c)
        if (!seller) return denied(c)
        const parsed = startInput.safeParse(await c.req.json().catch(() => ({})))
        if (!parsed.success) return c.json({ error: 'invalid', message: parsed.error.issues[0]?.message ?? 'Invalid input' }, 400)
        try {
          const s = await calls.start({ ...parsed.data, seller })
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
        const seller = sellerFrom(c)
        if (!seller) return denied(c)
        return c.json(
          calls.list(seller).map((s) => ({
            id: s.id,
            prospect: s.prospect,
            seller: s.seller.name,
            status: s.status,
            startedAt: s.startedAt,
            joinAt: s.joinAt,
            booked: !!s.bookingId,
            notes: s.notes?.status ?? null,
            crm: s.notes?.crm ?? null,
            meetingUrl: s.meetingUrl,
          })),
        )
      },
    }),
    registerApiRoute('/calls/:id', {
      method: 'GET',
      ...open,
      handler: async (c) => {
        const seller = sellerFrom(c)
        if (!seller) return denied(c)
        const s = ownCall(c, calls, seller)
        return s ? c.json(copilotView(s)) : notFound(c)
      },
    }),
    registerApiRoute('/calls/:id/events', {
      method: 'GET',
      ...open,
      handler: async (c) => {
        const seller = sellerFrom(c)
        if (!seller) return denied(c)
        const s = ownCall(c, calls, seller)
        return s ? sse(c, calls, s.id, copilotView) : notFound(c)
      },
    }),
    registerApiRoute('/calls/:id/math', {
      method: 'POST',
      ...open,
      handler: async (c) => {
        const seller = sellerFrom(c)
        if (!seller) return denied(c)
        const own = ownCall(c, calls, seller)
        if (!own) return notFound(c)
        const body = (await c.req.json().catch(() => ({}))) as { show?: boolean }
        return c.json({ showMath: calls.setShowMath(own.id, !!body.show)!.showMath })
      },
    }),
    registerApiRoute('/calls/:id/leave', {
      method: 'POST',
      ...open,
      handler: async (c) => {
        const seller = sellerFrom(c)
        if (!seller) return denied(c)
        const own = ownCall(c, calls, seller)
        if (!own) return notFound(c)
        await calls.leave(own.id)
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

    // Recall's dashboard webhook: bot status, recording.done, transcript.done / failed.
    // Verified on the raw body with RECALL_WEBHOOK_VERIFICATION_SECRET, answered at once,
    // processed after the response. Logs ids, event types and outcomes only.
    registerApiRoute('/recall/webhook', {
      method: 'POST',
      ...open,
      handler: async (c) => {
        const secret = process.env.RECALL_WEBHOOK_VERIFICATION_SECRET
        const raw = await c.req.text()
        const headers = recallHeaders(c)
        const msgId = headers['webhook-id'] ?? headers['svix-id'] ?? ''
        if (!secret || !isFromRecall(secret, headers, raw)) {
          console.warn('recall webhook rejected', { id: msgId || null, configured: !!secret })
          return c.json({ error: 'bad_signature' }, 401)
        }
        let ev: RecallEvent
        try {
          ev = JSON.parse(raw) as RecallEvent
        } catch {
          return c.json({ error: 'invalid' }, 400)
        }
        if (seenEvents.has(msgId)) return c.json({ ok: true, duplicate: true })
        seenEvents.set(msgId, Date.now())
        if (seenEvents.size > 5000) seenEvents.delete(seenEvents.keys().next().value!)
        setImmediate(() => {
          handleRecallEvent(calls, ev)
            .then(() => console.log('recall event handled', { id: msgId, event: ev.event, bot: ev.data?.bot?.id ?? null }))
            .catch((e) => {
              // Forget the id so Recall's retry runs it again.
              seenEvents.delete(msgId)
              console.error('recall event failed', { id: msgId, event: ev.event, error: e instanceof Error ? e.message : String(e) })
            })
        })
        return c.json({ ok: true })
      },
    }),

    // The hub's bookings snippet: schedules the seller's bot for a booking, or cancels it.
    registerApiRoute('/bookings', {
      method: 'POST',
      ...open,
      handler: async (c) => {
        const secret = process.env.BOOKINGS_SECRET
        const given = c.req.header('x-hook-secret')
        if (!secret || !given || !safeEqual(secret, given)) return c.json({ error: 'unauthorized' }, 401)
        const parsed = bookingInput.safeParse(await c.req.json().catch(() => ({})))
        if (!parsed.success) return c.json({ error: 'invalid', message: parsed.error.issues[0]?.message ?? 'Invalid input' }, 400)
        const b = parsed.data
        if (b.status === 'cancelled') {
          const s = await calls.cancelBooking(b.bookingId)
          return c.json({ ok: true, call: s?.id ?? null, status: s?.status ?? 'none' })
        }
        const seller = sellersFromEnv().find((s) => firstName(s).toLowerCase() === b.seller.toLowerCase())
        if (!seller) return c.json({ error: 'unknown_seller', message: `No seller named ${b.seller}` }, 422)
        const link = meetingLink.safeParse(b.meetingUrl ?? '')
        if (!link.success) return c.json({ ok: true, skipped: 'no_meeting_link' })
        if (!b.startAt) return c.json({ error: 'invalid', message: 'startAt is required' }, 400)
        try {
          const s = await calls.start({
            meetingUrl: link.data,
            joinAt: new Date(b.startAt),
            bookingId: b.bookingId,
            prospect: b.prospectName,
            prospectEmail: b.prospectEmail,
            seller,
          })
          return c.json({ ok: true, call: s.id, bot: s.botId, status: s.status, joinAt: new Date(s.joinAt).toISOString() }, 201)
        } catch (e) {
          return c.json({ error: 'recall_failed', message: e instanceof Error ? e.message : String(e) }, 502)
        }
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
