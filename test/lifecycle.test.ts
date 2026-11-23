import { createClient } from '@libsql/client'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { salesRoutes } from '../src/mastra/routes'
import { RecallClient, RecallError, createBotBody, readableTranscript } from '../src/recall/client'
import { signForTest } from '../src/recall/verify'
import { Calls } from '../src/sales/calls'
import type { Extraction } from '../src/sales/state'
import type { MeetingSummary } from '../src/sales/summary'
import { LibsqlCallStore } from '../src/store/calls-db'

const WHSEC = 'whsec_' + Buffer.from('endpoint-secret-bytes-0123456789ab').toString('base64')
const HOOK = 'booking-hook-secret'
const ask = { question: 'q', reason: 'r', alternates: [] }
const none: Extraction = { numbers: [], goal: null, leak: null, coldQuotes: null, adminHoursPerWeek: null, moneyQuestion: null, step: 0, askNext: ask }
const SUMMARY: MeetingSummary = { summary: 'Marcus runs Ridge Flooring and wants faster quotes.', goal: 'A second crew', leak: 'Quotes go cold', nextStep: 'Proposal Friday', followUps: ['Send the proposal'] }
const TRANSCRIPT = [
  { participant: { id: 1, name: 'Tylan Miller' }, words: [{ text: 'Thanks' }, { text: 'for' }, { text: 'joining' }, { text: '.' }] },
  { participant: { id: 2, name: 'Marcus Reed' }, words: [{ text: 'Happy' }, { text: 'to' }, { text: 'be' }, { text: 'here' }] },
]

function fakeRecall() {
  let n = 0
  return {
    createBot: vi.fn(async (_input: unknown) => ({ id: `bot_${++n}` })),
    deleteBot: vi.fn(async () => ({})),
    leaveCall: vi.fn(async () => ({})),
    createTranscript: vi.fn(async () => ({ id: 'tr_1' })),
    getTranscript: vi.fn(async () => ({ id: 'tr_1', data: { download_url: 'https://files.example/tr_1.json' } })),
    downloadTranscript: vi.fn(async () => TRANSCRIPT),
  }
}

/** A FluentCRM stand-in that records every call. */
function fakeCrm() {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const api = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body })
    if (path.startsWith('/subscribers?search')) return { subscribers: { data: [{ id: 42, email: 'marcus@ridge.example' }] } }
    if (path.startsWith('/tags?search')) return { tags: { data: [{ id: 7, title: 'Call: Held' }] } }
    return {}
  })
  return Object.assign(api, { log: calls })
}

function signed(body: unknown, id = `msg_${Math.random()}`) {
  const raw = JSON.stringify(body)
  const ts = String(Math.floor(Date.now() / 1000))
  return { method: 'POST', body: raw, headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signForTest(WHSEC, id, ts, raw) } }
}

const inAnHour = () => new Date(Date.now() + 3600_000).toISOString()

describe('Recall client', () => {
  it('schedules with join_at and posts the recording notice in chat', () => {
    const body = createBotBody({ meetingUrl: 'https://meet.google.com/abc', botName: 'b', joinAt: new Date('2026-12-01T15:00:00Z'), transcriptWebhookUrl: 'https://x/h', joinMessage: 'This meeting is being recorded.' })
    expect(body.join_at).toBe('2026-12-01T15:00:00.000Z')
    expect(body.chat).toEqual({ on_bot_join: { send_to: 'everyone', message: 'This meeting is being recorded.', pin: true } })
  })

  it('waits for Retry-After on 429, backs off on 507, and stops at other errors', async () => {
    const answers = [429, 507, 201]
    const waits: number[] = []
    const fake = (async () => {
      const status = answers.shift()!
      return new Response(status === 201 ? JSON.stringify({ id: 'bot_9' }) : '{}', { status, headers: status === 429 ? { 'retry-after': '2' } : {} })
    }) as unknown as typeof fetch
    const client = new RecallClient('k', 'us-west-2', fake, async (ms) => void waits.push(ms))
    const bot = await client.createBot({ meetingUrl: 'https://meet.google.com/abc', botName: 'b', joinAt: new Date(), transcriptWebhookUrl: 'https://x' })
    expect(bot.id).toBe('bot_9')
    expect(waits[0]).toBe(2000)
    expect(waits[1]).toBeGreaterThanOrEqual(30_000)

    const bad = new RecallClient('k', 'us-west-2', (async () => new Response('{}', { status: 400 })) as unknown as typeof fetch, async () => {})
    await expect(bad.deleteBot('x')).rejects.toBeInstanceOf(RecallError)
  })

  it('creates a Recall.ai async transcript with separate-stream diarization', async () => {
    const seen: { url: string; body: unknown }[] = []
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify({ id: 'tr_1' }), { status: 200 })
    }) as unknown as typeof fetch
    await new RecallClient('k', 'us-west-2', fake).createTranscript('rec_1')
    expect(seen[0]).toEqual({
      url: 'https://us-west-2.recall.ai/api/v1/recording/rec_1/create_transcript/',
      body: { provider: { recallai_async: { language_code: 'auto' } }, diarization: { use_separate_streams_when_available: true } },
    })
  })

  it('turns a downloaded transcript into speaker lines', () => {
    expect(readableTranscript(TRANSCRIPT)).toBe('Tylan Miller: Thanks for joining.\nMarcus Reed: Happy to be here')
  })
})

describe('bookings, webhooks and notes through the API', () => {
  let app: Hono
  let calls: Calls
  let recall: ReturnType<typeof fakeRecall>
  let crm: ReturnType<typeof fakeCrm>
  let store: LibsqlCallStore
  const summarizer = vi.fn(async () => SUMMARY)

  beforeEach(() => {
    process.env.SELLERS = 'Tylan Miller <tylan@otakusolutions.io> admin, Ric Forbes <ricforbes@otakusolutions.io>'
    process.env.BOOKINGS_SECRET = HOOK
    process.env.RECALL_WEBHOOK_VERIFICATION_SECRET = WHSEC
    recall = fakeRecall()
    crm = fakeCrm()
    summarizer.mockClear()
    store = new LibsqlCallStore(createClient({ url: ':memory:' }))
    calls = new Calls({ recall: recall as never, extractor: async () => none, summarizer, crm: crm as never, store, publicUrl: 'https://notes.example', debounceMs: 0 })
    app = new Hono()
    for (const r of salesRoutes(calls, { webDist: '/nonexistent', sendCode: async () => {} })) app.on([r.method as string], r.path, (r as unknown as { handler: never }).handler)
  })

  const book = (body: Record<string, unknown>, secret = HOOK) =>
    app.request('/bookings', { method: 'POST', headers: { 'x-hook-secret': secret, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const booking = { bookingId: 501, status: 'scheduled', seller: 'ric', prospectName: 'Marcus Reed', prospectEmail: 'marcus@ridge.example', meetingUrl: 'https://meet.google.com/abc-defg-hij' }

  it("schedules one bot per booking, under the booking's seller, at the meeting start", async () => {
    const startAt = inAnHour()
    expect((await book({ ...booking, startAt }, 'wrong')).status).toBe(401)
    const res = await book({ ...booking, startAt })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ bot: 'bot_1', status: 'scheduled', joinAt: new Date(startAt).toISOString() })
    const sent = recall.createBot.mock.calls[0]![0] as { joinAt: Date; botName: string; metadata: Record<string, string>; joinMessage: string }
    expect(sent.joinAt.toISOString()).toBe(new Date(startAt).toISOString())
    expect(sent.botName).toBe("Ric's notetaker")
    expect(sent.metadata).toMatchObject({ bookingId: '501', seller: 'ricforbes@otakusolutions.io' })
    expect(sent.joinMessage).toMatch(/being recorded/)

    // The same booking posted again keeps its one bot.
    await book({ ...booking, startAt })
    expect(recall.createBot).toHaveBeenCalledTimes(1)
    expect(calls.list()).toHaveLength(1)
  })

  it('moves the bot when the booking moves, and removes it when the booking is cancelled', async () => {
    await book({ ...booking, startAt: inAnHour() })
    await book({ ...booking, startAt: new Date(Date.now() + 7200_000).toISOString() })
    expect(recall.deleteBot).toHaveBeenCalledWith('bot_1')
    expect(recall.createBot).toHaveBeenCalledTimes(2)
    const res = await book({ bookingId: 501, status: 'cancelled', seller: 'ric' })
    expect(await res.json()).toMatchObject({ status: 'cancelled' })
    expect(recall.deleteBot).toHaveBeenLastCalledWith('bot_2')
  })

  it('removes the bot from the call when Recall will no longer delete it', async () => {
    await book({ ...booking, startAt: inAnHour() })
    recall.deleteBot.mockRejectedValueOnce(new RecallError('Only non-dispatched bots can be deleted', 400, null))
    await book({ bookingId: 501, status: 'cancelled', seller: 'ric' })
    expect(recall.leaveCall).toHaveBeenCalledWith('bot_1')
  })

  it('creates no bot for a booking without a meeting link or for an unknown seller', async () => {
    expect(await (await book({ ...booking, meetingUrl: '+1 555 0100', startAt: inAnHour() })).json()).toEqual({ ok: true, skipped: 'no_meeting_link' })
    expect((await book({ ...booking, seller: 'nobody', startAt: inAnHour() })).status).toBe(422)
    expect(recall.createBot).not.toHaveBeenCalled()
  })

  it('rejects unsigned webhooks and follows the bot through the meeting', async () => {
    const res = await book({ ...booking, startAt: inAnHour() })
    const { call } = (await res.json()) as { call: string }
    expect((await app.request('/recall/webhook', { method: 'POST', body: JSON.stringify({ event: 'bot.done' }) })).status).toBe(401)

    const status = (code: string) => ({ event: `bot.${code}`, data: { data: { code, sub_code: null }, bot: { id: 'bot_1', metadata: {} } } })
    expect((await app.request('/recall/webhook', signed(status('in_waiting_room')))).status).toBe(200)
    await vi.waitFor(() => expect(calls.get(call)!.status).toBe('waiting'))
    await app.request('/recall/webhook', signed(status('in_call_recording')))
    await vi.waitFor(() => expect(calls.get(call)!.status).toBe('live'))
    // A late, retried "joining" never moves the call backwards.
    await app.request('/recall/webhook', signed(status('joining_call')))
    await app.request('/recall/webhook', signed(status('call_ended')))
    await vi.waitFor(() => expect(calls.get(call)!.status).toBe('ended'))
  })

  it('transcribes after the meeting and writes one CRM note with "Call: Held"', async () => {
    const { call } = (await (await book({ ...booking, startAt: inAnHour() })).json()) as { call: string }
    const recDone = { event: 'recording.done', data: { data: { code: 'done' }, recording: { id: 'rec_1' }, bot: { id: 'bot_1' } } }
    await app.request('/recall/webhook', signed(recDone, 'msg_rec'))
    // Recall retries the same message: handled once.
    expect(await (await app.request('/recall/webhook', signed(recDone, 'msg_rec'))).json()).toMatchObject({ duplicate: true })
    await vi.waitFor(() => expect(recall.createTranscript).toHaveBeenCalledWith('rec_1'))
    expect(recall.createTranscript).toHaveBeenCalledTimes(1)
    expect(calls.get(call)!.notes?.status).toBe('transcribing')

    const trDone = { event: 'transcript.done', data: { data: { code: 'done' }, transcript: { id: 'tr_1' }, recording: { id: 'rec_1' }, bot: { id: 'bot_1' } } }
    await app.request('/recall/webhook', signed(trDone))
    await app.request('/recall/webhook', signed(trDone))
    await vi.waitFor(() => expect(calls.get(call)!.notes?.status).toBe('done'))
    const notes = calls.get(call)!.notes!
    expect(notes.transcript).toContain('Marcus Reed: Happy to be here')
    expect(notes.summary).toEqual(SUMMARY)
    expect(notes.crm).toBe('written')
    expect(summarizer).toHaveBeenCalledTimes(1)

    const note = crm.log.find((c) => c.path === '/subscribers/42/notes')!
    expect(note.body).toMatchObject({ note: { title: 'Meeting with Ric Forbes', type: 'meeting' } })
    expect(JSON.stringify(note.body)).toContain('Proposal Friday')
    expect(crm.log.filter((c) => c.path === '/subscribers/42/notes')).toHaveLength(1)
    expect(crm.log.find((c) => c.path === '/subscribers/sync-segments')!.body).toEqual({ type: 'tags', subscribers: [42], attach: [7], detach: [] })
  })

  it('records a failed transcript without touching the CRM', async () => {
    const { call } = (await (await book({ ...booking, startAt: inAnHour() })).json()) as { call: string }
    await app.request('/recall/webhook', signed({ event: 'transcript.failed', data: { data: { code: 'failed', sub_code: 'audio_empty' }, bot: { id: 'bot_1' } } }))
    await vi.waitFor(() => expect(calls.get(call)!.notes?.status).toBe('failed'))
    expect(calls.get(call)!.notes?.error).toMatch(/audio_empty/)
    expect(crm).not.toHaveBeenCalled()
  })

  it('keeps calls, bots and notes across a restart', async () => {
    const { call } = (await (await book({ ...booking, startAt: inAnHour() })).json()) as { call: string }
    await calls.persist(call)
    const again = new Calls({ recall: recall as never, extractor: async () => none, store, publicUrl: 'https://notes.example' })
    expect(await again.load()).toBe(1)
    expect(again.byBot('bot_1')).toMatchObject({ id: call, bookingId: '501', status: 'scheduled', prospectEmail: 'marcus@ridge.example' })
    // The restored call still refuses a duplicate bot for its booking.
    await again.start({ meetingUrl: booking.meetingUrl, joinAt: new Date(again.get(call)!.joinAt), bookingId: '501', seller: { name: 'Ric Forbes', email: 'ricforbes@otakusolutions.io' } })
    expect(recall.createBot).toHaveBeenCalledTimes(1)
  })
})

describe('the live-screen link in Slack', () => {
  it('DMs the call seller once, when the bot reaches the waiting room or the meeting', async () => {
    const dm = vi.fn(async (_email: string, _text: string) => {})
    const recall = fakeRecall()
    const calls = new Calls({ recall: recall as never, extractor: async () => none, dm, publicUrl: 'https://sales.example', debounceMs: 0 })
    const s = await calls.start({ meetingUrl: 'https://meet.google.com/abc', joinAt: new Date(Date.now() + 3600_000), prospect: 'Ridge Flooring', seller: { name: 'Ric Forbes', email: 'ricforbes@otakusolutions.io' } })
    calls.botStatus('bot_1', 'joining_call', null)
    expect(dm).not.toHaveBeenCalled()
    calls.botStatus('bot_1', 'in_waiting_room', null)
    calls.botStatus('bot_1', 'in_call_recording', null)
    calls.addUtterance(s.id, { speakerId: 1, speaker: 'Ric', isHost: true, text: 'hi', at: 1 })
    await vi.waitFor(() => expect(dm).toHaveBeenCalledTimes(1))
    expect(dm.mock.calls[0]![0]).toBe('ricforbes@otakusolutions.io')
    expect(dm.mock.calls[0]![1]).toContain(`https://sales.example/app/live/${s.id}`)
    expect(dm.mock.calls[0]![1]).toMatch(/waiting room/)
  })

  it('maps sign-in emails to Slack member ids', async () => {
    const { parseSlackUsers } = await import('../src/notify/slack')
    expect(parseSlackUsers('tylan@otakusolutions.io=U1, RicForbes@otakusolutions.io = U2')).toEqual(new Map([['tylan@otakusolutions.io', 'U1'], ['ricforbes@otakusolutions.io', 'U2']]))
  })
})
