import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { salesRoutes } from '../src/mastra/routes'
import type { RecallClient } from '../src/recall/client'
import { Calls } from '../src/sales/calls'
import { promptFor } from '../src/sales/extract'
import { type Extraction, applyExtraction, prospectView } from '../src/sales/state'

const ask = { question: 'q', reason: 'r', alternates: [] }
const TYLAN = { name: 'Tylan Miller', email: 'tylan@otakusolutions.io' }
const sent: { to: string; code: string }[] = []
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
    process.env.SELLERS = 'Tylan Miller <tylan@otakusolutions.io> admin, Ric Forbes <ric@example.com>'
    process.env.RECALL_API_KEY = 'test-recall-key'
    delete process.env.RECALL_WEBHOOK_SECRET
    recall = fakeRecall()
    extractor.mockReset()
    calls = new Calls({ recall, extractor, publicUrl: 'https://agents.example', debounceMs: 0 })
    sent.length = 0
    app = new Hono()
    for (const r of salesRoutes(calls, { webDist: '/nonexistent', sendCode: async (to, code) => void sent.push({ to: to.email, code }) })) app.on(r.method === "ALL" ? ["GET", "POST"] : [r.method], r.path, (r as unknown as { handler: never }).handler)
  })

  let owner: Record<string, string> = {}

  async function signIn(email: string): Promise<Record<string, string>> {
    await app.request('/auth/code', { method: 'POST', body: JSON.stringify({ email }) })
    const code = sent.find((m) => m.to === email)!.code
    const res = await app.request('/auth/verify', { method: 'POST', body: JSON.stringify({ email, code }) })
    expect(res.status).toBe(200)
    return { cookie: res.headers.get('set-cookie')!.split(';')[0]!, 'content-type': 'application/json' }
  }

  beforeEach(async () => {
    owner = await signIn('tylan@otakusolutions.io')
  })

  it('signs in only listed sellers, with the emailed code, once', async () => {
    expect((await app.request('/calls', { method: 'POST', body: '{}' })).status).toBe(401)
    sent.length = 0
    await app.request('/auth/code', { method: 'POST', body: JSON.stringify({ email: 'stranger@example.com' }) })
    expect(sent).toEqual([])
    await app.request('/auth/code', { method: 'POST', body: JSON.stringify({ email: 'RIC@example.com' }) })
    const code = sent[0]!.code
    const wrong = await app.request('/auth/verify', { method: 'POST', body: JSON.stringify({ email: 'ric@example.com', code: code === '000000' ? '111111' : '000000' }) })
    expect(wrong.status).toBe(401)
    const ok = await app.request('/auth/verify', { method: 'POST', body: JSON.stringify({ email: 'ric@example.com', code }) })
    expect(await ok.json()).toEqual({ name: 'Ric Forbes', email: 'ric@example.com', admin: false })
    const again = await app.request('/auth/verify', { method: 'POST', body: JSON.stringify({ email: 'ric@example.com', code }) })
    expect(again.status).toBe(401)
  })

  it('joins under the name the seller picks, or "<first name>\'s notetaker"', async () => {
    const ric = await signIn('ric@example.com')
    await app.request('/calls', { method: 'POST', headers: ric, body: JSON.stringify({ meetingUrl: 'https://meet.google.com/abc-defg-hij' }) })
    expect(recall.createBot.mock.calls[0]![0]).toMatchObject({ botName: "Ric's notetaker" })
    const res = await app.request('/calls', { method: 'POST', headers: owner, body: JSON.stringify({ meetingUrl: 'https://us02web.zoom.us/j/9', botName: '  Ridge Notes ' }) })
    expect(recall.createBot.mock.calls[1]![0]).toMatchObject({ botName: 'Ridge Notes' })
    const call = (await res.json()) as { botName: string }
    expect(call.botName).toBe('Ridge Notes')
    expect(prospectView(calls.get((call as unknown as { id: string }).id)!).botName).toBe('Ridge Notes')
    const long = await app.request('/calls', { method: 'POST', headers: owner, body: JSON.stringify({ meetingUrl: 'https://us02web.zoom.us/j/9', botName: 'x'.repeat(101) }) })
    expect(long.status).toBe(400)
  })

  it("keeps each seller's calls to them; an admin sees all", async () => {
    const ric = await signIn('ric@example.com')
    const res = await app.request('/calls', { method: 'POST', headers: ric, body: JSON.stringify({ meetingUrl: 'https://meet.google.com/abc-defg-hij', prospect: 'Ric prospect' }) })
    const ricCall = (await res.json()) as { id: string; seller: { name: string } }
    expect(ricCall.seller.name).toBe('Ric Forbes')
    await app.request('/calls', { method: 'POST', headers: owner, body: JSON.stringify({ meetingUrl: 'https://us02web.zoom.us/j/9' }) })
    const ricList = (await (await app.request('/calls', { headers: ric })).json()) as unknown[]
    const tylanList = (await (await app.request('/calls', { headers: owner })).json()) as unknown[]
    expect(ricList).toHaveLength(1)
    expect(tylanList).toHaveLength(2)
    const tylanCallId = calls.list().find((s) => s.seller.name === 'Tylan Miller')!.id
    expect((await app.request(`/calls/${tylanCallId}`, { headers: ric })).status).toBe(404)
    expect((await app.request(`/calls/${ricCall.id}`, { headers: owner })).status).toBe(200)
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
    const call = await calls.start({ meetingUrl: 'https://meet.google.com/abc-defg-hij', seller: TYLAN })
    expect((await app.request(`/screen/${call.id}/events?t=nope`)).status).toBe(404)
    const t = new URL(calls.screenUrl(call.id)).searchParams.get('t')!
    const ctrl = new AbortController()
    const res = await app.request(`/screen/${call.id}/events?t=${t}`, { signal: ctrl.signal })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const reader = res.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(JSON.parse(first.replace(/^data: /, ''))).toMatchObject({ seller: 'Tylan', showMath: false, said: {} })
    ctrl.abort()
  })

  it('rejects links that are not meetings', async () => {
    const res = await app.request('/calls', { method: 'POST', headers: owner, body: JSON.stringify({ meetingUrl: 'https://example.com' }) })
    expect(res.status).toBe(400)
  })
})

describe('applying what the model found', () => {
  const base = new Calls({ recall: fakeRecall(), extractor: async () => none, publicUrl: 'x', botName: 'b' })
  it('ignores out-of-range numbers and never moves the step backwards', async () => {
    const s = await base.start({ meetingUrl: 'https://meet.google.com/abc', seller: TYLAN })
    const a = applyExtraction({ ...s, step: 3 }, { ...none, numbers: [{ lever: 'conv', value: 20, quote: '20%' }, { lever: 'margin', value: 0.25, quote: '25 cents' }], step: 1 }, 5)
    expect(a.said.conv).toBeUndefined()
    expect(a.said.margin?.value).toBe(0.25)
    expect(a.step).toBe(3)
  })
  it('lifts the leak lever when the money question is asked', async () => {
    const s = await base.start({ meetingUrl: 'https://meet.google.com/abc', seller: TYLAN })
    const a = applyExtraction(s, { ...none, leak: { lever: 'conv', evidence: 'voicemail after five' }, moneyQuestion: 'what would that be worth?', step: 3 }, 9)
    expect(a.liftLever).toBe('conv')
    expect(a.moneyQuestion?.text).toMatch(/worth/)
  })
})
