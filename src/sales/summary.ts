import { Agent } from '@mastra/core/agent'
import { z } from 'zod'
import { LEVERS } from './levers'
import { salesCallModel } from './model'
import type { CallState } from './state'

/** The note written to the prospect's CRM contact after the meeting. */
export const summarySchema = z.object({
  summary: z.string().describe('Three to six plain sentences: who they are, what they want, what was agreed'),
  goal: z.string().nullable().describe("The prospect's goal and why it matters, in their words. Null if not said."),
  leak: z.string().nullable().describe('Where the business loses money, as the prospect described it. Null if not found.'),
  nextStep: z.string().nullable().describe('The agreed next step with any date. Null if none was agreed.'),
  followUps: z.array(z.string()).max(5).describe('Things the seller promised to send or do'),
})

export type MeetingSummary = z.infer<typeof summarySchema>

const INSTRUCTIONS = `You write the CRM note after a sales meeting held by a seller of AI automations to small businesses.
Write for the seller and the owner, who will read it before the next contact. Facts only, from the transcript.
Never invent numbers, prices, dates or promises. Leave a field null when the meeting did not cover it.`

export const meetingSummaryAgent = new Agent({
  id: 'meeting-summary',
  name: 'Meeting summary',
  description: 'Turns a finished sales meeting transcript into the CRM note.',
  instructions: INSTRUCTIONS,
  model: () => salesCallModel(),
})

export function summaryPrompt(s: CallState, transcript: string): string {
  const numbers = LEVERS.filter((l) => s.said[l]).map((l) => `${l}: ${s.said[l]!.value} ("${s.said[l]!.quote}")`)
  return [
    `Seller: ${s.seller.name}. Prospect: ${s.prospect ?? 'unknown'}.`,
    numbers.length ? `Numbers the co-pilot heard live:\n${numbers.join('\n')}` : '',
    `Meeting transcript:\n${transcript}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export type Summarizer = (s: CallState, transcript: string) => Promise<MeetingSummary>

export function modelSummarizer(): Summarizer {
  return async (s, transcript) => {
    const res = await meetingSummaryAgent.generate(summaryPrompt(s, transcript), { structuredOutput: { schema: summarySchema } })
    return res.object as MeetingSummary
  }
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The CRM note body: the summary, the fields that were found, and the full transcript. */
export function noteHtml(s: CallState, m: MeetingSummary, transcript: string, appUrl: string): string {
  const rows: [string, string | null][] = [
    ['Goal', m.goal],
    ['Leak', m.leak],
    ['Next step', m.nextStep],
  ]
  return [
    `<p>${esc(m.summary)}</p>`,
    ...rows.filter(([, v]) => v).map(([k, v]) => `<p><strong>${k}:</strong> ${esc(v!)}</p>`),
    m.followUps.length ? `<p><strong>Follow-ups:</strong></p><ul>${m.followUps.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '',
    `<p><strong>Seller:</strong> ${esc(s.seller.name)} · <a href="${appUrl}/app/live/${s.id}">Open the call</a></p>`,
    `<details><summary>Transcript</summary><pre style="white-space:pre-wrap">${esc(transcript)}</pre></details>`,
  ]
    .filter(Boolean)
    .join('\n')
}
