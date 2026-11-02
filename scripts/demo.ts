/**
 * Local demo with no Recall and no model: plays a scripted flooring call through the
 * real routes and web app, so the screens can be checked without a meeting.
 *   npm run build:web && npx tsx scripts/demo.ts   then open the printed links
 */
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { sessionCookie } from '../src/auth/session'
import { salesRoutes } from '../src/mastra/routes'
import type { RecallClient } from '../src/recall/client'
import { Calls } from '../src/sales/calls'
import type { Extraction } from '../src/sales/state'

const ask = (question: string, reason: string, alternates: string[] = []) => ({ question, reason, alternates })
const SCRIPT: [string, string, Partial<Extraction>][] = [
  ['Marcus', 'Honestly, I want to get to a million in sales this year.', { goal: { amount: 1000000, why: null }, step: 0, askNext: ask('What would hitting a million mean for you?', 'Get the reason in their words.') }],
  ['Marcus', "That's when I can hire a second install crew.", { goal: { amount: null, why: 'Hire a second install crew' }, step: 1, askNext: ask('Roughly how many calls and forms do you get a month?', 'Leads first.') }],
  ['Marcus', 'About 60 a month, mostly Google ads.', { numbers: [{ lever: 'leads', value: 720, quote: 'about 60 a month' }], step: 2, askNext: ask('Out of ten who reach out, how many hire you?', 'Conversion is the likely leak.', ['How many are calls versus forms?']) }],
  ['Marcus', 'We close maybe one in five.', { numbers: [{ lever: 'conv', value: 0.2, quote: 'maybe one in five' }], step: 2, askNext: ask('What happens to a call that comes in at 7pm?', 'Probe the leak.') }],
  ['Marcus', 'After five it goes to voicemail. Forms get answered the next day.', { leak: { lever: 'conv', evidence: 'After five it goes to voicemail; forms wait a day' }, step: 2, askNext: ask('Of every $100 that comes in, how much do you keep?', 'Margin is missing.') }],
  ['Marcus', 'We keep about 25 cents on the dollar. Jobs are around six grand, people rarely come back.', { numbers: [{ lever: 'margin', value: 0.25, quote: 'about 25 cents on the dollar' }, { lever: 'sale', value: 6000, quote: 'around six grand' }, { lever: 'tx', value: 1.05, quote: 'people rarely come back' }], step: 2, askNext: ask('Want to see what each one is worth?', 'All five numbers are in. Turn the math on.') }],
  ['Marcus', 'So what would fixing that actually be worth to us?', { moneyQuestion: 'So what would fixing that actually be worth to us?', step: 3, askNext: ask('Speed to lead fixes this. Name the outcome, then the price.', 'They asked the money question.') }],
]

const none: Extraction = { numbers: [], goal: null, leak: null, coldQuotes: null, adminHoursPerWeek: null, moneyQuestion: null, step: 0, askNext: ask('', '') }
let n = 0
const recall = { createBot: async () => ({ id: 'demo-bot' }), leaveCall: async () => ({}) } as unknown as RecallClient
const calls = new Calls({ recall, extractor: async () => ({ ...none, ...SCRIPT[n - 1]![2] }), publicUrl: 'http://localhost:4111', botName: 'Otaku notes', debounceMs: 50 })
process.env.RECALL_API_KEY ||= 'demo-signing-material'
process.env.SELLERS ||= 'Tylan Miller <tylan@otakusolutions.io> admin'

const app = new Hono()
for (const r of salesRoutes(calls)) app.on(r.method === 'ALL' ? ['GET', 'POST'] : [r.method], r.path, (r as unknown as { handler: never }).handler)
// Demo only: skip the emailed code.
app.get('/demo-login', (c) => {
  c.header('set-cookie', sessionCookie('tylan@otakusolutions.io', false))
  return c.redirect(c.req.query('to') ?? '/app/')
})
serve({ fetch: app.fetch, port: 4111 })

const call = await calls.start({ meetingUrl: 'https://meet.google.com/demo-call', prospect: 'Ridge Flooring', seller: { name: 'Tylan Miller', email: 'tylan@otakusolutions.io' } })
calls.setShowMath(call.id, true)
console.log(`co-pilot: http://localhost:4111/demo-login?to=/app/live/${call.id}`)
console.log(`bot screen: ${calls.screenUrl(call.id)}`)
const steps = Number(process.env.DEMO_STEPS ?? SCRIPT.length)
for (const [who, text] of SCRIPT.slice(0, steps)) {
  n++
  calls.addUtterance(call.id, { speakerId: who === 'Tylan' ? 1 : 2, speaker: who === 'Marcus' ? 'Marcus Reed' : who, isHost: who === 'Tylan', text, at: n * 30 })
  await new Promise((r) => setTimeout(r, Number(process.env.DEMO_GAP_MS ?? 3000)))
}
