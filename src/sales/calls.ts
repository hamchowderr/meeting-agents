import crypto from 'node:crypto'
import { type CrmApi, writeMeetingNote } from '../crm/fluentcrm'
import { type RecallClient, RecallError, readableTranscript } from '../recall/client'
import type { Utterance } from '../recall/transcript'
import type { SendDm } from '../notify/slack'
import type { CallStore, StoredCall } from '../store/calls-db'
import { type Extractor, isSeller } from './extract'
import { type CallState, type Notes, applyExtraction } from './state'
import { type Summarizer, noteHtml } from './summary'

type Listener = (s: CallState) => void

type Entry = StoredCall & {
  listeners: Set<Listener>
  /** Index of the first utterance the extractor has not seen yet. */
  extractedTo: number
  running: Promise<void> | null
  timer: ReturnType<typeof setTimeout> | null
  /** The after-meeting job, so a repeated webhook never runs it twice at once. */
  finishing: Promise<void> | null
}

export type CallsOptions = {
  recall: RecallClient | null
  extractor: Extractor
  publicUrl: string
  /** Bot name when the seller picks none; defaults to "<first name>'s notetaker". */
  botName?: string
  /** Wait this long after the last line before asking the model, so one pass covers a burst. */
  debounceMs?: number
  /** Where calls survive restarts. Without it, calls live in memory only. */
  store?: CallStore | null
  /** Writes the meeting note to the prospect's CRM contact. Without it, notes stay in the app. */
  crm?: CrmApi | null
  summarizer?: Summarizer
  /** DMs the call's seller the live-screen link when the bot gets into the meeting. */
  dm?: SendDm | null
}

export type StartInput = {
  meetingUrl: string
  prospect?: string | null
  prospectEmail?: string | null
  botName?: string | null
  seller: { name: string; email: string }
  /** When the bot joins; omitted means now. */
  joinAt?: Date
  /** A hub booking id: the same booking never gets a second bot. */
  bookingId?: string | null
}

/** Recall bot status -> call status. Codes not listed leave the status alone. */
const BOT_STATUS: Record<string, CallState['status']> = {
  joining_call: 'joining',
  in_waiting_room: 'waiting',
  in_call_not_recording: 'live',
  recording_permission_allowed: 'live',
  in_call_recording: 'live',
  call_ended: 'ended',
  done: 'ended',
  fatal: 'failed',
}

const FINAL: CallState['status'][] = ['ended', 'cancelled', 'failed']

/** Join message posted in the meeting chat: people know the call is recorded. */
export const JOIN_MESSAGE = (seller: string) =>
  `Hi, I'm ${seller.split(/\s+/)[0]}'s notetaker from Otaku Solutions. This meeting is being recorded and transcribed for ${seller.split(/\s+/)[0]}'s notes.`

/**
 * Calls: one per meeting the bot attends. Each change is saved to the store, so a
 * restart keeps scheduled bots, transcripts and notes. Each new utterance schedules
 * one extraction pass; passes never overlap, so state changes land in order.
 */
export class Calls {
  private calls = new Map<string, Entry>()
  private persisting = new Map<string, Promise<void>>()
  constructor(private readonly opts: CallsOptions) {}

  /** Loads saved calls. Call once at startup. */
  async load(): Promise<number> {
    if (!this.opts.store) return 0
    const rows = await this.opts.store.all()
    for (const row of rows) this.calls.set(row.state.id, { ...row, listeners: new Set(), extractedTo: row.state.transcript.length, running: null, timer: null, finishing: null })
    return rows.length
  }

  async start(input: StartInput): Promise<CallState> {
    if (!this.opts.recall) throw new Error('RECALL_API_KEY is not set')
    const existing = input.bookingId ? this.byBooking(input.bookingId) : undefined
    if (existing && existing.state.status !== 'cancelled' && existing.state.status !== 'failed') {
      const sameMeeting = existing.state.meetingUrl === input.meetingUrl && existing.state.joinAt === (input.joinAt ?? new Date()).getTime()
      // A repeat of the same booking keeps its bot; a moved booking replaces the scheduled bot.
      if (sameMeeting || existing.state.status !== 'scheduled') return existing.state
      await this.cancel(existing.state.id)
    }
    const id = crypto.randomUUID()
    const joinAt = input.joinAt ?? new Date()
    const botName = input.botName?.trim() || this.opts.botName || defaultBotName(input.seller.name)
    const entry: Entry = {
      state: {
        id,
        botId: null,
        meetingUrl: input.meetingUrl,
        prospect: input.prospect?.trim() || null,
        prospectEmail: input.prospectEmail?.trim().toLowerCase() || null,
        seller: { name: input.seller.name, email: input.seller.email },
        botName,
        status: joinAt.getTime() > Date.now() + 60_000 ? 'scheduled' : 'joining',
        joinAt: joinAt.getTime(),
        bookingId: input.bookingId ?? null,
        notes: null,
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
      recordingId: null,
      transcriptId: null,
      listeners: new Set(),
      extractedTo: 0,
      running: null,
      timer: null,
      finishing: null,
    }
    // The intent is saved before Recall is asked, so a crash mid-request leaves a record.
    this.calls.set(id, entry)
    await this.persist(id)
    try {
      const bot = await this.opts.recall.createBot({
        meetingUrl: input.meetingUrl,
        botName,
        joinAt,
        joinMessage: JOIN_MESSAGE(input.seller.name),
        transcriptWebhookUrl: `${this.opts.publicUrl}/recall/transcript/${id}?s=${entry.hookSecret}`,
        cameraPageUrl: this.screenUrl(id),
        metadata: { callId: id, agent: 'sales-call', seller: input.seller.email, ...(input.bookingId && { bookingId: input.bookingId }) },
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

  byBot(botId: string): CallState | undefined {
    for (const e of this.calls.values()) if (e.state.botId === botId) return e.state
  }

  private byBooking(bookingId: string): Entry | undefined {
    // Newest first, so a re-booked meeting finds its live call.
    return [...this.calls.values()].filter((e) => e.state.bookingId === bookingId).sort((a, b) => b.state.startedAt - a.state.startedAt)[0]
  }

  /** Calls this seller may see: their own, or everyone's for an admin. */
  list(viewer?: { email: string; admin: boolean }): CallState[] {
    return [...this.calls.values()]
      .map((e) => e.state)
      .filter((s) => !viewer || viewer.admin || s.seller.email === viewer.email)
      .sort((a, b) => b.joinAt - a.joinAt)
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
    void this.persist(id)
    return e.state
  }

  /** Writes the call, one write at a time per call, so the last state always wins. */
  persist(id: string): Promise<void> {
    const store = this.opts.store
    const e = this.calls.get(id)
    if (!store || !e) return Promise.resolve()
    const prev = this.persisting.get(id) ?? Promise.resolve()
    const next = prev
      .then(() => {
        const { state, hookSecret, screenToken, recordingId, transcriptId } = e
        return store.save({ state, hookSecret, screenToken, recordingId, transcriptId })
      })
      .catch((err) => console.error('saving call failed', { callId: id, error: err instanceof Error ? err.message : String(err) }))
    this.persisting.set(id, next)
    return next
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

  /**
   * A cancelled booking: a scheduled bot is deleted; one already joining or in the
   * meeting is removed from the call, as Recall documents for the last 10 minutes.
   */
  async cancel(id: string): Promise<void> {
    const e = this.calls.get(id)
    if (!e || FINAL.includes(e.state.status)) return
    const botId = e.state.botId
    if (botId && this.opts.recall) {
      try {
        await this.opts.recall.deleteBot(botId)
      } catch (err) {
        // Recall refuses to delete a bot that has started joining; remove it from the call instead.
        if (!(err instanceof RecallError)) throw err
        await this.opts.recall.leaveCall(botId).catch(() => {})
      }
    }
    this.update(id, { status: 'cancelled' })
  }

  async cancelBooking(bookingId: string): Promise<CallState | undefined> {
    const e = this.byBooking(bookingId)
    if (!e) return
    await this.cancel(e.state.id)
    return e.state
  }

  /** A verified bot status webhook. */
  botStatus(botId: string, code: string, subCode: string | null) {
    const s = this.byBot(botId)
    if (!s) return
    const next = BOT_STATUS[code]
    if (!next || s.status === 'cancelled') return
    // A late "joining" never moves a call back from live or ended.
    const order = ['scheduled', 'joining', 'waiting', 'live', 'ended', 'failed']
    if (order.indexOf(next) < order.indexOf(s.status) && next !== 'failed') return
    this.update(s.id, { status: next, ...(code === 'fatal' && { error: `The bot could not stay in the meeting (${subCode ?? 'fatal'}).` }) })
    if (next === 'waiting' || next === 'live') void this.sendLink(s.id)
  }

  /** The seller's live-screen link, once per call, as soon as the bot is in the meeting or its waiting room. */
  async sendLink(id: string): Promise<void> {
    const e = this.calls.get(id)
    if (!e || !this.opts.dm || e.state.linkSentAt) return
    this.update(id, { linkSentAt: Date.now() })
    const s = e.state
    const who = s.prospect ? ` with ${s.prospect}` : ''
    const waiting = s.status === 'waiting' ? ' It is in the waiting room: admit it.' : ''
    try {
      await this.opts.dm(s.seller.email, `Your notetaker is in the meeting${who}.${waiting} Live screen: ${this.opts.publicUrl}/app/live/${id}`)
    } catch (err) {
      console.error('live-screen link not sent', { callId: id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** recording.done: start Recall's post-meeting transcript, once per recording. */
  async recordingDone(botId: string, recordingId: string): Promise<void> {
    const s = this.byBot(botId)
    const e = s && this.calls.get(s.id)
    if (!e || !this.opts.recall) return
    if (e.recordingId === recordingId && e.transcriptId) return
    e.recordingId = recordingId
    this.update(e.state.id, { notes: { status: 'transcribing', summary: null, transcript: null, crm: null, error: null } })
    const t = await this.opts.recall.createTranscript(recordingId)
    e.transcriptId = t.id
    await this.persist(e.state.id)
  }

  /** transcript.done: summarize and write the CRM note, once per call. */
  transcriptDone(botId: string, transcriptId: string): Promise<void> {
    const s = this.byBot(botId)
    const e = s && this.calls.get(s.id)
    if (!e) return Promise.resolve()
    if (e.state.notes?.status === 'done') return Promise.resolve()
    e.finishing ??= this.finish(e, transcriptId).finally(() => {
      e.finishing = null
    })
    return e.finishing
  }

  transcriptFailed(botId: string, subCode: string | null) {
    const s = this.byBot(botId)
    if (!s) return
    this.update(s.id, { notes: { ...emptyNotes(), status: 'failed', error: `Recall could not transcribe the recording (${subCode ?? 'failed'}).` } })
  }

  private async finish(e: Entry, transcriptId: string): Promise<void> {
    const recall = this.opts.recall
    if (!recall) return
    const id = e.state.id
    e.transcriptId = transcriptId
    try {
      const t = await recall.getTranscript(transcriptId)
      const url = t.data?.download_url
      if (!url) throw new Error('The transcript has no download link yet')
      const transcript = readableTranscript(await recall.downloadTranscript(url))
      if (!transcript) throw new Error('The transcript is empty: nobody spoke while the bot recorded')
      const summary = this.opts.summarizer ? await this.opts.summarizer(e.state, transcript) : null
      let crm: Notes['crm'] = 'skipped'
      let error: string | null = null
      if (this.opts.crm && summary && e.state.prospectEmail) {
        try {
          await writeMeetingNote(this.opts.crm, {
            email: e.state.prospectEmail,
            name: e.state.prospect ?? '',
            title: `Meeting with ${e.state.seller.name}`,
            html: noteHtml(e.state, summary, transcript, this.opts.publicUrl),
            tag: 'Call: Held',
          })
          crm = 'written'
        } catch (err) {
          crm = 'failed'
          error = `The CRM note was not saved: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      this.update(id, { notes: { status: 'done', summary, transcript, crm, error } })
    } catch (err) {
      this.update(id, { notes: { ...emptyNotes(), status: 'failed', error: err instanceof Error ? err.message : String(err) } })
    }
  }

  /** A finalized line from Recall. Shown at once; the extraction pass follows. */
  addUtterance(id: string, u: Utterance) {
    const e = this.calls.get(id)
    if (!e) return
    // Their lines are labelled SELLER for the model, matched by the seller's name in the meeting.
    const line = { ...u, seller: isSeller(u, e.state.seller.name) }
    const live = ['scheduled', 'joining', 'waiting'].includes(e.state.status)
    this.update(id, { transcript: [...e.state.transcript, line], status: live ? 'live' : e.state.status })
    if (!e.state.linkSentAt) void this.sendLink(id)
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

function emptyNotes(): Notes {
  return { status: 'transcribing', summary: null, transcript: null, crm: null, error: null }
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
