/**
 * Slack DMs from Perry's bot (SLACK_BOT_TOKEN, scope chat:write). SLACK_USERS maps each
 * seller's sign-in email to their Slack member id, because a seller's Slack email can
 * differ from their sign-in email:
 *   SLACK_USERS="tylan@otakusolutions.io=U091EPDMPB4, ricforbes@otakusolutions.io=U0CE74TH7DL"
 */
export type SendDm = (email: string, text: string) => Promise<void>

export function parseSlackUsers(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of (raw ?? '').split(',')) {
    const [email, id] = part.split('=').map((s) => s.trim())
    if (email && id) out.set(email.toLowerCase(), id)
  }
  return out
}

export function slackDm(token: string, users: Map<string, string>, fetchImpl: typeof fetch = fetch): SendDm {
  return async (email, text) => {
    const channel = users.get(email.toLowerCase())
    if (!channel) throw new Error(`No Slack user for ${email} in SLACK_USERS`)
    const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel, text, unfurl_links: false }),
    })
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    if (!body.ok) throw new Error(`Slack DM failed: ${body.error ?? res.status}`)
  }
}

export function slackFromEnv(env: NodeJS.ProcessEnv = process.env): SendDm | null {
  return env.SLACK_BOT_TOKEN ? slackDm(env.SLACK_BOT_TOKEN, parseSlackUsers(env.SLACK_USERS)) : null
}
