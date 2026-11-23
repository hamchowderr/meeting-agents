import { useEffect, useState } from 'react'
import type { Lever, RankedOffer, Signals } from '../../src/sales/levers'

export type Said = { value: number; quote: string; at: number }
export type Utterance = { speakerId: number; speaker: string; isHost: boolean; text: string; at: number; seller?: boolean }

export type CopilotView = {
  id: string
  botId: string | null
  meetingUrl: string
  prospect: string | null
  seller: { name: string; email: string }
  botName: string
  status: CallStatus
  joinAt: number
  bookingId: string | null
  prospectEmail: string | null
  notes: Notes | null
  startedAt: number
  transcript: Utterance[]
  said: Partial<Record<Lever, Said>>
  goal: { amount: number | null; why: string | null } | null
  leak: { lever: Lever; evidence: string } | null
  signals: Signals
  step: number
  askNext: { question: string; reason: string; alternates: string[] } | null
  moneyQuestion: { text: string; at: number } | null
  showMath: boolean
  liftLever: Lever | null
  error: string | null
  offers: RankedOffer[]
  board: { lever: Lever; value: number; said: boolean; weakest: boolean; gain: number }[]
}

export type CallStatus = 'scheduled' | 'joining' | 'waiting' | 'live' | 'ended' | 'cancelled' | 'failed'

export type Notes = {
  status: 'transcribing' | 'done' | 'failed'
  summary: { summary: string; goal: string | null; leak: string | null; nextStep: string | null; followUps: string[] } | null
  transcript: string | null
  crm: 'written' | 'skipped' | 'failed' | null
  error: string | null
}

/** "Mon, Dec 1, 3:00 PM" in the viewer's time zone. */
export function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** A call's status in words. */
export function statusLabel(status: CallStatus, joinAt: number): string {
  switch (status) {
    case 'scheduled':
      return `Bot joins ${when(joinAt)}`
    case 'joining':
      return 'Joining…'
    case 'waiting':
      return 'In the waiting room: admit the bot'
    case 'live':
      return 'Live'
    case 'ended':
      return 'Ended'
    case 'cancelled':
      return 'Booking cancelled'
    case 'failed':
      return 'Bot failed'
  }
}

export type ProspectView = {
  seller: string
  botName: string
  prospect: string | null
  showMath: boolean
  said: Partial<Record<Lever, Said>>
  goal: { amount: number | null; why: string | null } | null
  leak: { lever: Lever; evidence: string } | null
  liftLever: Lever | null
}

export type Me = { name: string; email: string; admin: boolean }

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.message ?? `Request failed (${res.status})`)
  return body as T
}

/** Live state over server-sent events; EventSource reconnects on its own. */
export function useLive<T>(url: string | null): { data: T | null; connected: boolean } {
  const [data, setData] = useState<T | null>(null)
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    if (!url) return
    const es = new EventSource(url)
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = (m) => setData(JSON.parse(m.data))
    return () => es.close()
  }, [url])
  return { data, connected }
}
