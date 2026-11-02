/** One finalized utterance from a Recall `transcript.data` event. */
export type Utterance = {
  speakerId: number
  speaker: string
  isHost: boolean
  text: string
  /** Seconds from the start of the recording. */
  at: number
  /** Set by the call: true when the seller said it. */
  seller?: boolean
}

type TranscriptEvent = {
  event?: string
  data?: {
    data?: {
      words?: { text?: string; start_timestamp?: { relative?: number } | null }[]
      participant?: { id?: number; name?: string | null; is_host?: boolean | null }
    }
    bot?: { id?: string }
  }
}

export function utteranceFrom(body: unknown): { botId?: string; utterance: Utterance } | null {
  const ev = body as TranscriptEvent
  if (ev?.event !== 'transcript.data') return null
  const d = ev.data?.data
  const words = d?.words ?? []
  const text = words
    .map((w) => w.text ?? '')
    .join(' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  const p = d?.participant ?? {}
  return {
    botId: ev.data?.bot?.id,
    utterance: {
      speakerId: p.id ?? -1,
      speaker: p.name?.trim() || `Speaker ${p.id ?? '?'}`,
      isHost: !!p.is_host,
      text,
      at: words[0]?.start_timestamp?.relative ?? 0,
    },
  }
}
