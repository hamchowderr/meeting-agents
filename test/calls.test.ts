import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { salesRoutes } from '../src/mastra/routes'
import type { RecallClient } from '../src/recall/client'
import { Calls } from '../src/sales/calls'
import { promptFor } from '../src/sales/extract'
import { type Extraction, applyExtraction, prospectView } from '../src/sales/state'

const ask = { question: 'q', reason: 'r', alternates: [] }
const none: Extraction = { numbers: [], goal: null, leak: null, coldQuotes: null, adminHoursPerWeek: null, moneyQuestion: null, step: 0, askNext: ask }

function fakeRecall() {
  return {
    createBot: vi.fn(async () => ({ id: 'bot_1' })),
    leaveCall: vi.fn(async () => ({})),
  } as unknown as RecallClient & { createBot: ReturnType<typeof vi.fn> }
}

function word(text: string) {
  return { text }
}
function event(name: string, text: string) {
  return { event: 'transcript.data', data: { data: { words: text.split(' ').map(word), participant: { id: name === 'Tylan' ? 1 : 2, name, is_host: name === 'Tylan' } }, bot: { id: 'bot_1' } } }
}

describe('a call, end to end through the API', () => {
  let app: Hono
  let calls: Calls
  let recall: ReturnType<typeof fakeRecall>
  const extractor = vi.fn(async (_s: unknown, _from: number): Promise<Extraction> => none)

  beforeEach(() => {
    process.env.OWNER_KEY = 'owner-key'
    delete process.env.RECALL_WEBHOOK_SECRET
    recall = fakeRecall()
    extractor.mockReset()
    calls = new Calls({ recall, extractor, publicUrl: 'https://agents.example', botName: 'Otaku notes', sellerName: 'Tylan', debounceMs: 0 })
    app = new Hono()
    for (const r of salesRoutes(calls, '/nonexistent')) app.on(r.method === "ALL" ? ["GET", "POST"] : [r.method], r.path, (r as unknown as { handler: never }).handler)
  })

  const owner = { authorization: 'Bearer owner-key', 'content-type': 'application/json' }

  it('refuses owner routes without the key, and when no key is configured', async () => {
    expect((await app.request('/calls', { method: 'POST', body: '{}' })).status).toBe(401)
    delete process.env.OWNER_KEY
    expect((await app.request('/calls', { headers: { authorization: 'Bearer ' } })).status).toBe(401)
  })

  it('starts a bot with a signed webhook and the camera page, then turns transcript into state', async () => {
    const res = await app.request('/calls', { method: 'POST', headers: owner, body: JSON.stringify({ meetingUrl: 'https://us02web.zoom.us/j/123', prospect: 'Ridge Flooring' }) })
    expect(res.status).toBe(201)
    const call = (await res.json()) as { id: string; botId: string }
    expect(call.botId).toBe('bot_1')
    const sent = recall.createBot.mock.calls[0]![0] as { transcriptWebhookUrl: string; cameraPageUrl: string }
    expect(sent.transcriptWebhookUrl).toMatch(new RegExp(`^https://agents.example/recall/transcript/${call.id}\\?s=`))
    expect(sent.cameraPageUrl).toMatch(new RegExp(`^https://agents.example/app/screen/${call.id}\\?t=`))

    // Wrong secret: refused.
    expect((await app.request(`/recall/transcript/${call.id}?s=wrong`, { method: 'POST', body: JSON.stringify(event('Marcus', 'hi')) })).status).toBe(401)

    extractor.mockResolvedValueOnce({ ...none, numbers: [{ lever: 'leads', value: 720, quote: 'about 60 a month' }], step: 2 })
    const hook = new URL(sent.transcriptWebhookUrl).pathname + new URL(sent.transcriptWebhookUrl).search
    await app.request(hook, { method: 'POST', body: JSON.stringify(event('Tylan', 'How many calls do you get?')) })
    await app.request(hook, { method: 'POST', body: JSON.stringify(event('Marcus', 'About 60 a month')) })
    await vi.waitFor(() => expect(calls.get(call.id)!.said.leads?.value).toBe(720))

    const state = calls.get(call.id)!
    expect(state.status).toBe('live')
    expect(state.transcript.map((u) => u.seller)).toEqual([true, false])
    expect(promptFor(state, 0)).toContain('SELLER (Tylan): How many calls do you get?')
    expect(promptFor(state, 0)).toContain('PROSPECT (Marcus): About 60 a month')

    // The prospect's screen shows nothing until the seller turns the math on.
    expect(prospectView(state).said).toEqual({})
    await app.request(`/calls/${call.id}/math`, { method: 'POST', headers: owner, body: JSON.stringify({ show: true }) })
    expect(prospectView(calls.get(call.id)!).said.leads?.value).toBe(720)

    await app.request(`/calls/${call.id}/leave`, { method: 'POST', headers: owner })
    expect(recall.leaveCall).toHaveBeenCalledWith('bot_1')
    expect(calls.get(call.id)!.status).toBe('ended')
  })

  it('serves the prospect view only with the screen token', async () => {
    const call = await calls.start({ meetingUrl: 'https://meet.google.com/abc-defg-hij' })
    expect((await app.request(`/screen/${call.id}/events?t=nope`)).status).toBe(404)
    const t = new URL(calls.screenUrl(call.id)).searchParams.get('t')!
    const ctrl = new AbortController()
    const res = await app.request(`/screen/${call.id}/events?t=${t}`, { signal: ctrl.signal })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const reader = res.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(JSON.parse(first.replace(/^data: /, ''))).toMatchObject({ showMath: false, said: {} })
    ctrl.abort()
  })

  it('rejects links that are not meetings', async () => {
    const res = await app.request('/calls', { method: 'POST', headers: owner, body: JSON.stringify({ meetingUrl: 'https://example.com' }) })
    expect(res.status).toBe(400)
  })
})

describe('applying what the model found', () => {
  const base = new Calls({ recall: fakeRecall(), extractor: async () => none, publicUrl: 'x', botName: 'b', sellerName: 'Tylan' })
  it('ignores out-of-range numbers and never moves the step backwards', async () => {
    const s = await base.start({ meetingUrl: 'https://meet.google.com/abc' })
    const a = applyExtraction({ ...s, step: 3 }, { ...none, numbers: [{ lever: 'conv', value: 20, quote: '20%' }, { lever: 'margin', value: 0.25, quote: '25 cents' }], step: 1 }, 5)
    expect(a.said.conv).toBeUndefined()
    expect(a.said.margin?.value).toBe(0.25)
    expect(a.step).toBe(3)
  })
  it('lifts the leak lever when the money question is asked', async () => {
    const s = await base.start({ meetingUrl: 'https://meet.google.com/abc' })
    const a = applyExtraction(s, { ...none, leak: { lever: 'conv', evidence: 'voicemail after five' }, moneyQuestion: 'what would that be worth?', step: 3 }, 9)
    expect(a.liftLever).toBe('conv')
    expect(a.moneyQuestion?.text).toMatch(/worth/)
  })
})
