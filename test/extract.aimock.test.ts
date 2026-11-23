import { describe, expect, it } from 'vitest'
import type { RecallClient } from '../src/recall/client'
import { Calls } from '../src/sales/calls'
import { modelExtractor } from '../src/sales/extract'

/**
 * The real sales-call agent (prompt, structured output, parsing) against AIMock,
 * which answers from fixtures/sales-call.json. Needs `npm run aimock`; `npm test` starts it.
 */
const LINES: [string, string][] = [
  ['Tylan', "Thanks for jumping on. What's the big goal for the business this year?"],
  ['Marcus Reed', 'Honestly, I want to get to a million in sales this year.'],
  ['Tylan', 'What would hitting a million mean for you?'],
  ['Marcus Reed', "That's when I can hire a second install crew."],
  ['Tylan', 'Roughly how many calls and forms come in a month?'],
  ['Marcus Reed', 'About 60 a month, mostly Google ads.'],
  ['Tylan', 'And out of ten, how many hire you?'],
  ['Marcus Reed', 'We close maybe one in five. After five it goes to voicemail, and forms get answered the next day, usually.'],
  ['Tylan', 'Of every hundred dollars that comes in, how much do you keep?'],
  ['Marcus Reed', 'We keep about 25 cents on the dollar. Jobs are around six grand, and people rarely come back.'],
]

describe.runIf(process.env.USE_AIMOCK === 'true')('sales-call agent through AIMock', () => {
  it('builds up the call state pass by pass, then answers the money question', async () => {
    const recall = { createBot: async () => ({ id: 'bot' }), leaveCall: async () => ({}) } as unknown as RecallClient
    const calls = new Calls({ recall, extractor: modelExtractor(), publicUrl: 'x', botName: 'b', debounceMs: 60_000 })
    const call = await calls.start({ meetingUrl: 'https://meet.google.com/abc-defg-hij', prospect: 'Ridge Flooring', seller: { name: 'Tylan Miller', email: 'tylan@otakusolutions.io' } })
    const say = (who: string, text: string, at: number) =>
      calls.addUtterance(call.id, { speakerId: who === 'Tylan' ? 1 : 2, speaker: who, isHost: who === 'Tylan', text, at })

    for (let i = 0; i < LINES.length; i += 2) {
      for (const [who, text] of LINES.slice(i, i + 2)) say(who, text, i)
      await calls.extract(call.id)
      expect(calls.get(call.id)!.error).toBeNull()
    }
    let s = calls.get(call.id)!
    expect(s.goal).toEqual({ amount: 1000000, why: 'Hire a second install crew' })
    expect(Object.fromEntries(Object.entries(s.said).map(([k, v]) => [k, v!.value]))).toEqual({ leads: 720, conv: 0.2, margin: 0.25, sale: 6000, tx: 1 })
    expect(s.leak?.lever).toBe('conv')
    expect(s.step).toBe(2)

    say('Marcus Reed', 'So what would fixing that actually be worth to us?', 99)
    await calls.extract(call.id)
    s = calls.get(call.id)!
    expect(s.moneyQuestion?.text).toMatch(/worth/)
    expect(s.liftLever).toBe('conv')
    expect(s.step).toBe(3)
    expect(s.askNext?.question).toMatch(/Speed to lead/)
  }, 30_000)
})
