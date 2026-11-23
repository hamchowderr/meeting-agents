/**
 * A small Recall.ai client: the bot, recording and transcript calls the meeting agents use.
 * Docs: https://docs.recall.ai/reference/bot_create
 */
export type RecallRegion = 'us-west-2' | 'us-east-1' | 'eu-central-1' | 'ap-northeast-1'

export type CreateBotInput = {
  meetingUrl: string
  botName: string
  /** When the bot joins. More than 10 minutes ahead makes a scheduled bot, which is never late. */
  joinAt: Date
  /** Where Recall posts finalized utterances (transcript.data). */
  transcriptWebhookUrl: string
  /** A page the bot shows as its camera, 1280x720. */
  cameraPageUrl?: string
  /** Posted to the meeting chat when the bot joins. */
  joinMessage?: string
  metadata?: Record<string, string>
}

export type RecallBot = {
  id: string
  join_at?: string | null
  status_changes?: { code: string; created_at: string }[]
  recordings?: { id: string; media_shortcuts?: { transcript?: { id: string; data?: { download_url?: string } } | null } }[]
}

export type RecallTranscript = { id: string; data?: { download_url?: string | null }; status?: { code?: string } }

/** One speaker turn in a downloaded transcript (JSON transcript download schema). */
export type TranscriptPart = {
  participant?: { id?: number; name?: string | null; is_host?: boolean | null }
  words?: { text?: string; start_timestamp?: { relative?: number | null } | null }[]
}

export class RecallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message)
  }
}

type Sleep = (ms: number) => Promise<void>

export class RecallClient {
  readonly base: string
  constructor(
    private readonly apiKey: string,
    region: RecallRegion = 'us-west-2',
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.base = `https://${region}.recall.ai/api/v1`
  }

  /**
   * One API call. 429 waits for Retry-After; 503 and 507 (ad-hoc bot pool empty) back off
   * with jitter. Other errors throw at once. Bot creation is retried only on those answers,
   * where Recall created nothing.
   */
  private async call<T>(method: string, path: string, body?: unknown, attempts = 4): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: { Authorization: this.apiKey, accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      const json = text ? safeJson(text) : null
      if (res.ok) return json as T
      const retryable = res.status === 429 || res.status === 503 || res.status === 507
      if (!retryable || attempt >= attempts) throw new RecallError(`Recall ${method} ${path} failed (${res.status})`, res.status, json ?? text)
      const after = Number(res.headers.get('retry-after'))
      const base = res.status === 507 ? 30_000 : 1000 * 2 ** (attempt - 1)
      await this.sleep(Number.isFinite(after) && after > 0 ? after * 1000 : base + Math.random() * 500)
    }
  }

  /** Schedules (or, under 10 minutes out, sends) a bot with low-latency streaming transcription. */
  createBot(input: CreateBotInput): Promise<RecallBot> {
    return this.call('POST', '/bot/', createBotBody(input))
  }

  getBot(botId: string): Promise<RecallBot> {
    return this.call('GET', `/bot/${botId}/`)
  }

  /** Removes a scheduled bot that has not started joining. */
  deleteBot(botId: string): Promise<unknown> {
    return this.call('DELETE', `/bot/${botId}/`)
  }

  leaveCall(botId: string): Promise<unknown> {
    return this.call('POST', `/bot/${botId}/leave_call/`)
  }

  startCameraPage(botId: string, url: string): Promise<unknown> {
    return this.call('POST', `/bot/${botId}/output_media/`, { camera: { kind: 'webpage', config: { url } } })
  }

  stopCameraPage(botId: string): Promise<unknown> {
    return this.call('DELETE', `/bot/${botId}/output_media/`, { camera: true })
  }

  /** Post-meeting transcript of a finished recording, by Recall.ai Transcription. */
  createTranscript(recordingId: string): Promise<RecallTranscript> {
    return this.call('POST', `/recording/${recordingId}/create_transcript/`, {
      provider: { recallai_async: { language_code: 'auto' } },
      diarization: { use_separate_streams_when_available: true },
    })
  }

  getTranscript(transcriptId: string): Promise<RecallTranscript> {
    return this.call('GET', `/transcript/${transcriptId}/`)
  }

  /** The transcript JSON behind a transcript's download_url (a signed URL, no API key). */
  async downloadTranscript(url: string): Promise<TranscriptPart[]> {
    const res = await this.fetchImpl(url)
    if (!res.ok) throw new RecallError(`Transcript download failed (${res.status})`, res.status, null)
    return (await res.json()) as TranscriptPart[]
  }
}

export function createBotBody(input: CreateBotInput) {
  return {
    meeting_url: input.meetingUrl,
    bot_name: input.botName,
    join_at: input.joinAt.toISOString(),
    metadata: input.metadata ?? {},
    ...(input.joinMessage && { chat: { on_bot_join: { send_to: 'everyone', message: input.joinMessage, pin: true } } }),
    recording_config: {
      transcript: {
        // prioritize_accuracy delays transcripts by minutes; low latency is 1-3 s.
        provider: { recallai_streaming: { mode: 'prioritize_low_latency', language_code: 'en' } },
      },
      realtime_endpoints: [{ type: 'webhook', url: input.transcriptWebhookUrl, events: ['transcript.data'] }],
    },
    ...(input.cameraPageUrl && {
      output_media: { camera: { kind: 'webpage', config: { url: input.cameraPageUrl } } },
      // A webpage camera needs the bigger machine to render smoothly.
      variant: { zoom: 'web_4_core', google_meet: 'web_4_core', microsoft_teams: 'web_4_core' },
    }),
  }
}

/** "Name: words" lines from a downloaded transcript. */
export function readableTranscript(parts: TranscriptPart[]): string {
  return parts
    .map((p) => {
      const text = (p.words ?? [])
        .map((w) => w.text ?? '')
        .join(' ')
        .replace(/\s+([,.!?;:])/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()
      return text ? `${p.participant?.name?.trim() || `Speaker ${p.participant?.id ?? '?'}`}: ${text}` : ''
    })
    .filter(Boolean)
    .join('\n')
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** The server's Recall client, from RECALL_API_KEY and RECALL_REGION. Null without a key. */
export function recallFromEnv(env: NodeJS.ProcessEnv = process.env): RecallClient | null {
  const key = env.RECALL_API_KEY
  if (!key) return null
  return new RecallClient(key, (env.RECALL_REGION as RecallRegion) || 'us-west-2')
}
