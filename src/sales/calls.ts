import crypto from 'node:crypto'
import type { RecallClient } from '../recall/client'
import type { Utterance } from '../recall/transcript'
import { type Extractor, isSeller } from './extract'
import { type CallState, applyExtraction } from './state'

type Listener = (s: CallState) => void

type Entry = {
  state: CallState
  /** Signs the transcript webhook URL for this call. */
  hookSecret: string
  /** Lets the bot's camera page read the prospect view, and nothing else. */
  screenToken: string
  listeners: Set<Listener>
  /** Index of the first utterance the extractor has not seen yet. */
  extractedTo: number
  running: Promise<void> | null
  timer: ReturnType<typeof setTimeout> | null
}

export type CallsOptions = {
  recall: RecallClient | null
  extractor: Extractor
  publicUrl: string
  /** Bot name when the seller picks none; defaults to "<first name>'s notetaker". */
  botName?: string
  /** Wait this long after the last line before asking the model, so one pass covers a burst. */
  debounceMs?: number
}

/**
 * Live calls, in memory (Phase 1: a restart forgets them; call history goes to
 * Doltgres in Phase 2). Each new utterance schedules one extraction pass; passes
 * never overlap, so state changes land in order.
 */
export class Calls {
  private calls = new Map<string, Entry>()
  constructor(private readonly opts: CallsOptions) {}

  async start(input: { meetingUrl: string; prospect?: string | null; botName?: string | null; seller: { name: string; email: string } }): Promise<CallState> {
    if (!this.opts.recall) throw new Error('RECALL_API_KEY is not set')
    const id = crypto.randomUUID()
    const botName = input.botName?.trim() || this.opts.botName || defaultBotName(input.seller.name)
    const entry: Entry = {
      state: {
        id,
        botId: null,
        meetingUrl: input.meetingUrl,
        prospect: input.prospect?.trim() || null,
        seller: { name: input.seller.name, email: input.seller.email },
        botName,
        status: 'joining',
        startedAt: Date.now(),
        transcript: [],
        said: {},
        goal: null,
        leak: null,
        signals: {},
        step: 0,
        askNext: null,
        moneyQuestion: null,
        showMath: false,
        liftLever: null,
        error: null,
      },
      hookSecret: token(),
      screenToken: token(),
      listeners: new Set(),
      extractedTo: 0,
      running: null,
      timer: null,
    }
    this.calls.set(id, entry)
    try {
      const bot = await this.opts.recall.createBot({
        meetingUrl: input.meetingUrl,
        botName,
        transcriptWebhookUrl: `${this.opts.publicUrl}/recall/transcript/${id}?s=${entry.hookSecret}`,
        cameraPageUrl: this.screenUrl(id),
        metadata: { callId: id, agent: 'sales-call', seller: input.seller.email },
      })
      this.update(id, { botId: bot.id })
    } catch (e) {
      this.update(id, { status: 'failed', error: e instanceof Error ? e.message : String(e) })
      throw e
    }
    return entry.state
  }

  screenUrl(id: string): string {
    const e = this.calls.get(id)
    return `${this.opts.publicUrl}/app/screen/${id}?t=${e?.screenToken ?? ''}`
  }

  get(id: string): CallState | undefined {
    return this.calls.get(id)?.state
  }

  /** Calls this seller may see: their own, or everyone's for an admin. */
  list(viewer?: { email: string; admin: boolean }): CallState[] {
    return [...this.calls.values()]
      .map((e) => e.state)
      .filter((s) => !viewer || viewer.admin || s.seller.email === viewer.email)
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  checkHook(id: string, secret: string | undefined): boolean {
    const e = this.calls.get(id)
    return !!e && !!secret && safeEqual(e.hookSecret, secret)
  }

  checkScreen(id: string, t: string | undefined): boolean {
    const e = this.calls.get(id)
    return !!e && !!t && safeEqual(e.screenToken, t)
  }

  subscribe(id: string, fn: Listener): () => void {
    const e = this.calls.get(id)
    if (!e) return () => {}
    e.listeners.add(fn)
    return () => e.listeners.delete(fn)
  }

  update(id: string, patch: Partial<CallState>): CallState | undefined {
    const e = this.calls.get(id)
    if (!e) return
    e.state = { ...e.state, ...patch }
    for (const fn of e.listeners) fn(e.state)
    return e.state
  }

  setShowMath(id: string, show: boolean) {
    return this.update(id, { showMath: show })
  }

  async leave(id: string) {
    const e = this.calls.get(id)
    if (!e) return
    if (e.state.botId && this.opts.recall) await this.opts.recall.leaveCall(e.state.botId).catch(() => {})
    this.update(id, { status: 'ended' })
  }

  /** A finalized line from Recall. Shown at once; the extraction pass follows. */
  addUtterance(id: string, u: Utterance) {
    const e = this.calls.get(id)
    if (!e) return
    // Their lines are labelled SELLER for the model, matched by the seller's name in the meeting.
    const line = { ...u, seller: isSeller(u, e.state.seller.name) }
    this.update(id, { transcript: [...e.state.transcript, line], status: e.state.status === 'joining' ? 'live' : e.state.status })
    if (e.timer) clearTimeout(e.timer)
    e.timer = setTimeout(() => {
      e.timer = null
      void this.extract(id)
    }, this.opts.debounceMs ?? 1200)
  }

  /** Runs one pass over the lines not yet seen; if more arrive meanwhile, runs again after. */
  async extract(id: string): Promise<void> {
    const e = this.calls.get(id)
    if (!e) return
    if (e.running) {
      await e.running
      return this.extract(id)
    }
    const from = e.extractedTo
    const to = e.state.transcript.length
    if (from >= to) return
    e.running = (async () => {
      try {
        const x = await this.opts.extractor(e.state, from)
        e.extractedTo = to
        const at = e.state.transcript[to - 1]?.at ?? 0
        e.state = applyExtraction(e.state, x, at)
        this.update(id, { error: null })
      } catch (err) {
        // Keep the transcript flowing; the next line retries these lines too.
        console.error('extraction failed', err)
        this.update(id, { error: 'The co-pilot missed an update; it will catch up on the next line.' })
      } finally {
        e.running = null
      }
    })()
    await e.running
    if (e.state.transcript.length > e.extractedTo && !e.timer) return this.extract(id)
  }
}

function token() {
  return crypto.randomBytes(24).toString('base64url')
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(new Uint8Array(x), new Uint8Array(y))
}

/** The bot's name when the seller leaves it blank: "Tylan's notetaker". */
export function defaultBotName(sellerName: string): string {
  const first = sellerName.trim().split(/\s+/)[0] || 'Sales'
  return `${first}'s notetaker`
}
