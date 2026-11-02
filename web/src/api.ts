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
  showMath: boolean
  liftLever: Lever | null
  error: string | null
  offers: RankedOffer[]
  board: { lever: Lever; value: number; said: boolean; weakest: boolean; gain: number }[]
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
