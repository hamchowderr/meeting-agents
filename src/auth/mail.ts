/**
 * Sends sign-in codes from the hub, through FluentCRM's "send email to contact",
 * the same way Client Desk does (FLUENTCRM_AUTH = a WordPress application password,
 * "user:pass"). Without it, codes are logged, for local development only.
 */
export type SendCode = (to: { email: string; name: string }, code: string) => Promise<void>

export function fluentCrmMailer(baseUrl: string, auth: string, fetchImpl: typeof fetch = fetch): SendCode {
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/wp-json/fluent-crm/v2${path}`, {
      method,
      headers: { authorization: `Basic ${Buffer.from(auth).toString('base64')}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw new Error(`FluentCRM ${method} ${path} answered ${res.status}`)
    return (await res.json()) as T
  }
  return async (to, code) => {
    const found = await api<{ subscribers: { data: { id: number; email: string }[] } }>('GET', `/subscribers?search=${encodeURIComponent(to.email)}&per_page=10`)
    let id = found.subscribers.data.find((s) => s.email.toLowerCase() === to.email)?.id
    if (!id) {
      const [first, ...rest] = to.name.split(/\s+/)
      id = (await api<{ contact: { id: number } }>('POST', '/subscribers', { email: to.email, first_name: first, last_name: rest.join(' '), status: 'transactional' })).contact.id
    }
    await api('POST', `/subscribers/${id}/emails/send`, {
      campaign: {
        email_subject: `${code} is your Otaku notes sign-in code`,
        email_body: `<p>Your sign-in code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>It works once and expires in 10 minutes. If you didn't try to sign in, ignore this email.</p>`,
      },
    })
  }
}

export function mailerFromEnv(): SendCode {
  const auth = process.env.FLUENTCRM_AUTH
  if (auth) return fluentCrmMailer(process.env.FLUENTCRM_URL ?? 'https://hub.otakusolutions.io', auth)
  return async (to, code) => {
    if (process.env.NODE_ENV === 'production') throw new Error('Sign-in email needs FLUENTCRM_AUTH')
    console.log(`[sign-in] code for ${to.email}: ${code}`)
  }
}
