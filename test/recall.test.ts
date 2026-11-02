import { describe, expect, it } from 'vitest'
import { RecallClient, createBotBody } from '../src/recall/client'
import { utteranceFrom } from '../src/recall/transcript'
import { isFromRecall, signForTest } from '../src/recall/verify'

const SECRET = 'whsec_' + Buffer.from('test-secret-bytes-0123456789abcdef').toString('base64')

describe('Recall request verification', () => {
  const payload = JSON.stringify({ event: 'transcript.data' })
  const ts = String(Math.floor(Date.now() / 1000))
  it('accepts a correctly signed request', () => {
    const sig = signForTest(SECRET, 'msg_1', ts, payload)
    expect(isFromRecall(SECRET, { 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': sig }, payload)).toBe(true)
  })
  it('rejects a changed body, a missing header and an old timestamp', () => {
    const sig = signForTest(SECRET, 'msg_1', ts, payload)
    expect(isFromRecall(SECRET, { 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': sig }, payload + ' ')).toBe(false)
    expect(isFromRecall(SECRET, { 'webhook-id': 'msg_1', 'webhook-timestamp': ts }, payload)).toBe(false)
    const old = String(Math.floor(Date.now() / 1000) - 3600)
    const oldSig = signForTest(SECRET, 'msg_1', old, payload)
    expect(isFromRecall(SECRET, { 'webhook-id': 'msg_1', 'webhook-timestamp': old, 'webhook-signature': oldSig }, payload)).toBe(false)
  })
})

describe('transcript events', () => {
  it('joins words into one utterance with the speaker', () => {
    const r = utteranceFrom({
      event: 'transcript.data',
      data: {
        data: {
          words: [{ text: 'About', start_timestamp: { relative: 12.5 } }, { text: '60' }, { text: 'calls' }, { text: 'a' }, { text: 'month' }, { text: '.' }],
          participant: { id: 2, name: 'Marcus Reed', is_host: false },
        },
        bot: { id: 'bot_1' },
      },
    })
    expect(r).toEqual({ botId: 'bot_1', utterance: { speakerId: 2, speaker: 'Marcus Reed', isHost: false, text: 'About 60 calls a month.', at: 12.5 } })
  })
  it('ignores other events and empty utterances', () => {
    expect(utteranceFrom({ event: 'participant_events.join' })).toBeNull()
    expect(utteranceFrom({ event: 'transcript.data', data: { data: { words: [] } } })).toBeNull()
  })
})

describe('Recall client', () => {
  it('asks for low-latency streaming transcription and a 4-core webpage camera', () => {
    const body = createBotBody({ meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: 'Otaku notes', transcriptWebhookUrl: 'https://x/hook', cameraPageUrl: 'https://x/screen' })
    expect(body.recording_config.transcript.provider.recallai_streaming).toEqual({ mode: 'prioritize_low_latency', language_code: 'en' })
    expect(body.recording_config.realtime_endpoints).toEqual([{ type: 'webhook', url: 'https://x/hook', events: ['transcript.data'] }])
    expect(body.output_media?.camera.config.url).toBe('https://x/screen')
    expect(body.variant?.google_meet).toBe('web_4_core')
  })
  it('sends the key and surfaces Recall errors', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return new Response(JSON.stringify({ detail: 'nope' }), { status: 400 })
    }) as unknown as typeof fetch
    const client = new RecallClient('key_123', 'us-west-2', fake)
    await expect(client.leaveCall('bot_1')).rejects.toMatchObject({ status: 400 })
    expect(seen[0]!.url).toBe('https://us-west-2.recall.ai/api/v1/bot/bot_1/leave_call/')
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe('key_123')
  })
})
