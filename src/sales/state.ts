import { type Lever, LEVERS, type Signals, type Values, leverBoard, rankOffers } from './levers'
import type { Utterance } from '../recall/transcript'

export const STEPS = ['Objective', 'Why it matters', 'Find the leak', 'Solution', 'Offer'] as const

export type Said = { value: number; quote: string; at: number }

/** Everything the agent knows about one call. Kept in memory for Phase 1. */
export type CallState = {
  id: string
  botId: string | null
  meetingUrl: string
  prospect: string | null
  /** Who runs this call. Only they (and admins) see it; later, their commission. */
  seller: { name: string; email: string }
  /** The name the bot joins the meeting with, chosen by the seller. */
  botName: string
  status: 'joining' | 'live' | 'ended' | 'failed'
  startedAt: number
  transcript: Utterance[]
  said: Partial<Record<Lever, Said>>
  goal: { amount: number | null; why: string | null } | null
  leak: { lever: Lever; evidence: string } | null
  signals: Signals
  step: number
  askNext: { question: string; reason: string; alternates: string[] } | null
  moneyQuestion: { text: string; at: number } | null
  /** Whether the math is on the prospect's screen (the bot's camera). */
  showMath: boolean
  /** Lever lifted on the prospect's screen when they ask what a fix is worth. */
  liftLever: Lever | null
  error: string | null
}

/** What one pass of the extraction agent found in the newest part of the call. */
export type Extraction = {
  numbers: { lever: Lever; value: number; quote: string }[]
  goal: { amount: number | null; why: string | null } | null
  leak: { lever: Lever; evidence: string } | null
  coldQuotes: number | null
  adminHoursPerWeek: number | null
  moneyQuestion: string | null
  step: number
  askNext: { question: string; reason: string; alternates: string[] }
}

/** Plausible ranges after normalizing; anything outside is ignored as a mishearing. */
const RANGE: Record<Lever, [number, number]> = {
  leads: [1, 1_000_000],
  conv: [0.001, 1],
  tx: [0.1, 365],
  sale: [1, 10_000_000],
  margin: [0.001, 0.95],
}

export function applyExtraction(s: CallState, x: Extraction, at: number): CallState {
  const said = { ...s.said }
  for (const n of x.numbers) {
    if (!LEVERS.includes(n.lever)) continue
    const [lo, hi] = RANGE[n.lever]
    if (!(n.value >= lo && n.value <= hi)) continue
    said[n.lever] = { value: n.value, quote: n.quote, at }
  }
  const goal = x.goal && (x.goal.amount || x.goal.why) ? { amount: x.goal.amount ?? s.goal?.amount ?? null, why: x.goal.why ?? s.goal?.why ?? null } : s.goal
  const leak = x.leak && LEVERS.includes(x.leak.lever) ? x.leak : s.leak
  return {
    ...s,
    said,
    goal,
    leak,
    signals: {
      coldQuotes: x.coldQuotes ?? s.signals.coldQuotes,
      adminHoursPerWeek: x.adminHoursPerWeek ?? s.signals.adminHoursPerWeek,
    },
    // The conversation moves forward; a stray earlier step never sends the stepper back.
    step: Math.max(s.step, Math.min(4, Math.max(0, Math.round(x.step)))),
    askNext: x.askNext,
    moneyQuestion: x.moneyQuestion ? { text: x.moneyQuestion, at } : s.moneyQuestion,
    liftLever: x.moneyQuestion ? (leak?.lever ?? s.liftLever ?? 'conv') : s.liftLever,
  }
}

export function saidValues(s: CallState): Partial<Values> {
  const out: Partial<Values> = {}
  for (const l of LEVERS) if (s.said[l]) out[l] = s.said[l]!.value
  return out
}

/** The co-pilot's view: everything, plus the ranked offers and lever board. */
export function copilotView(s: CallState) {
  const said = saidValues(s)
  return {
    ...s,
    transcript: s.transcript.slice(-30),
    offers: rankOffers(said, s.leak?.lever ?? null, s.signals),
    board: leverBoard(said, s.leak?.lever ?? null, s.signals),
  }
}

/**
 * The prospect's view on the bot's camera: only what they said, never estimates,
 * offers or coaching. Empty unless the seller turned the math on.
 */
export function prospectView(s: CallState) {
  return {
    seller: s.seller.name.split(/\s+/)[0] ?? s.seller.name,
    botName: s.botName,
    prospect: s.prospect,
    showMath: s.showMath,
    said: s.showMath ? s.said : {},
    goal: s.showMath ? s.goal : null,
    leak: s.showMath ? s.leak : null,
    liftLever: s.showMath ? s.liftLever : null,
  }
}
