/**
 * A small Recall.ai client: just the bot calls the meeting agents use.
 * Docs: https://docs.recall.ai/reference/bot_create
 */
export type RecallRegion = 'us-west-2' | 'us-east-1' | 'eu-central-1' | 'ap-northeast-1'

export type CreateBotInput = {
  meetingUrl: string
  botName: string
  /** Where Recall posts finalized utterances (transcript.data). */
  transcriptWebhookUrl: string
  /** A page the bot shows as its camera, 1280x720. */
  cameraPageUrl?: string
  metadata?: Record<string, string>
}

export type RecallBot = { id: string; meeting_url?: unknown; status_changes?: { code: string; created_at: string }[] }

export class RecallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message)
  }
}

export class RecallClient {
  readonly base: string
  constructor(
    private readonly apiKey: string,
    region: RecallRegion = 'us-west-2',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = `https://${region}.recall.ai/api/v1`
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { Authorization: this.apiKey, accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    const json = text ? safeJson(text) : null
    if (!res.ok) throw new RecallError(`Recall ${method} ${path} failed (${res.status})`, res.status, json ?? text)
    return json as T
  }

  /** Sends a bot to the meeting with low-latency streaming transcription (1-3 s, English). */
  createBot(input: CreateBotInput): Promise<RecallBot> {
    return this.call('POST', '/bot/', createBotBody(input))
  }

  getBot(botId: string): Promise<RecallBot> {
    return this.call('GET', `/bot/${botId}/`)
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
}

export function createBotBody(input: CreateBotInput) {
  return {
    meeting_url: input.meetingUrl,
    bot_name: input.botName,
    metadata: input.metadata ?? {},
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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function recallFromEnv(): RecallClient | null {
  const key = process.env.RECALL_API_KEY
  if (!key) return null
  return new RecallClient(key, (process.env.RECALL_REGION as RecallRegion) || 'us-west-2')
}
