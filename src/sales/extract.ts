import { Agent } from '@mastra/core/agent'
import { z } from 'zod'
import { LEVERS } from './levers'
import { type CallState, type Extraction, STEPS } from './state'

export const EXTRACT_MODEL = process.env.SALES_CALL_MODEL || 'anthropic/claude-haiku-5-5'

const lever = z.enum(LEVERS)

export const extractionSchema = z.object({
  numbers: z
    .array(
      z.object({
        lever,
        value: z.number().describe('Normalized: leads per YEAR, conv and margin as 0-1, tx purchases per customer per year, sale in dollars'),
        quote: z.string().describe("The prospect's own words, short"),
      }),
    )
    .describe('Only numbers the PROSPECT stated or clearly confirmed in the new lines. Empty if none.'),
  goal: z
    .object({ amount: z.number().nullable(), why: z.string().nullable() })
    .nullable()
    .describe('Their goal (e.g. yearly revenue) and why it matters to them, in their words. Null if not in the new lines.'),
  leak: z
    .object({ lever, evidence: z.string() })
    .nullable()
    .describe('The weakest lever, only when the prospect describes a concrete problem with it. Null otherwise.'),
  coldQuotes: z.number().nullable().describe('How many old quotes or past leads went cold, if said'),
  adminHoursPerWeek: z.number().nullable().describe('Hours a week on admin work (quotes, scheduling, invoices), if said'),
  moneyQuestion: z
    .string()
    .nullable()
    .describe('The exact line, if the prospect just asked what a fix is worth or what it would cost them. Null otherwise.'),
  step: z.number().int().min(0).max(4).describe(`Where the conversation is now: ${STEPS.map((s, i) => `${i}=${s}`).join(', ')}`),
  askNext: z.object({
    question: z.string().describe('The single best next question for the seller, in plain spoken words'),
    reason: z.string().describe('One short line on why, for the seller'),
    alternates: z.array(z.string()).max(2),
  }),
})

const INSTRUCTIONS = `You listen to a live sales call for a seller of AI automations to small businesses.
The seller follows five steps: 1 Objective (the prospect's goal), 2 Why it matters (the reason in their words),
3 Find the leak (hear the five numbers: leads, conversion, transactions per customer, average sale, margin, and find the weakest lever),
4 Solution (show what fixing the weakest lever is worth), 5 Offer (name the fix and the price, then stop talking).

You get what is already known and the newest lines of the transcript. Report only what the newest lines add.
Rules:
- Numbers come only from the prospect, never from the seller's guesses, unless the prospect clearly agrees ("yeah, about that").
- Normalize: "60 calls a month" = leads 720; "one in five" = conv 0.2; "we keep 25 cents on the dollar" = margin 0.25;
  "around six grand a job" = sale 6000; "people rarely come back" = tx 1.0; "twice a year" = tx 2.
- Never invent a number. If unsure, leave it out.
- The next question fills the most important gap for the current step. Before all five numbers are in, ask for the
  missing one that matters most. Once they are in and a leak is confirmed, move to the solution. Keep it short and natural.`

export const salesCallAgent = new Agent({
  id: 'sales-call',
  name: 'Sales call co-pilot',
  description: 'Picks the profit-formula numbers, the goal, the leak and the next question out of a live sales call.',
  instructions: INSTRUCTIONS,
  model: EXTRACT_MODEL,
})

/** What we tell the model: known state plus the newest lines, speakers labelled. */
export function promptFor(s: CallState, fromIndex: number): string {
  const known = {
    step: STEPS[s.step],
    numbers: Object.fromEntries(Object.entries(s.said).map(([k, v]) => [k, v!.value])),
    goal: s.goal,
    leak: s.leak,
    coldQuotes: s.signals.coldQuotes ?? null,
    adminHoursPerWeek: s.signals.adminHoursPerWeek ?? null,
  }
  const label = (u: CallState['transcript'][number]) => (u.seller ? `SELLER (${u.speaker})` : `PROSPECT (${u.speaker})`)
  const earlier = s.transcript.slice(Math.max(0, fromIndex - 8), fromIndex)
  const fresh = s.transcript.slice(fromIndex)
  return [
    `Already known: ${JSON.stringify(known)}`,
    earlier.length ? `Earlier lines, for context only:\n${earlier.map((u) => `${label(u)}: ${u.text}`).join('\n')}` : '',
    `Newest lines:\n${fresh.map((u) => `${label(u)}: ${u.text}`).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function isSeller(u: { speaker: string; isHost: boolean }, sellerName: string): boolean {
  // The seller is matched by first name (SELLER_NAME); with none set, the meeting host is the seller.
  const first = sellerName.trim().split(/\s+/)[0]?.toLowerCase()
  if (!first) return u.isHost
  return u.speaker.toLowerCase().includes(first)
}

export type Extractor = (s: CallState, fromIndex: number) => Promise<Extraction>

export function modelExtractor(): Extractor {
  return async (s, fromIndex) => {
    const res = await salesCallAgent.generate(promptFor(s, fromIndex), {
      structuredOutput: { schema: extractionSchema },
    })
    return res.object as Extraction
  }
}
