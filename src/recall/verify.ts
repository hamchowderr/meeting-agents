import crypto from 'node:crypto'

/**
 * Verifies a request signed by Recall with the workspace verification secret
 * (`whsec_...`, from the Recall dashboard's API keys page). Recall's own helper,
 * from https://docs.recall.ai/docs/authenticating-requests-from-recallai
 * Returns false instead of throwing.
 */
export function isFromRecall(secret: string, headers: Record<string, string | undefined>, payload: string | null): boolean {
  if (!secret?.startsWith('whsec_')) return false
  const id = headers['webhook-id'] ?? headers['svix-id']
  const ts = headers['webhook-timestamp'] ?? headers['svix-timestamp']
  const sigs = headers['webhook-signature'] ?? headers['svix-signature']
  if (!id || !ts || !sigs) return false
  // Reject replays older than five minutes.
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64')
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${payload ?? ''}`).digest()
  for (const versioned of sigs.split(' ')) {
    const [version, sig] = versioned.split(',')
    if (version !== 'v1' || !sig) continue
    const got = Buffer.from(sig, 'base64')
    if (got.length === expected.length && crypto.timingSafeEqual(new Uint8Array(got), new Uint8Array(expected))) return true
  }
  return false
}

export function signForTest(secret: string, id: string, ts: string, payload: string): string {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64')
  return 'v1,' + crypto.createHmac('sha256', key).update(`${id}.${ts}.${payload}`).digest('base64')
}
