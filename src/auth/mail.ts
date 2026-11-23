import { contactId, crmApi } from '../crm/fluentcrm'

/**
 * Sends sign-in codes from the hub, through FluentCRM's "send email to contact",
 * the same way Client Desk does (FLUENTCRM_AUTH = a WordPress application password,
 * "user:pass"). Without it, codes are logged, for local development only.
 */
export type SendCode = (to: { email: string; name: string }, code: string) => Promise<void>

export function fluentCrmMailer(baseUrl: string, auth: string, fetchImpl: typeof fetch = fetch): SendCode {
  const api = crmApi(baseUrl, auth, fetchImpl)
  return async (to, code) => {
    const id = await contactId(api, to.email, to.name)
    await api('POST', `/subscribers/${id}/emails/send`, {
      campaign: {
        email_subject: `${code} is your sales co-pilot sign-in code`,
        email_body: `<p>Your sign-in code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>It works once and expires in 10 minutes. If you didn't try to sign in, ignore this email.</p>`,
      },
    })
  }
}

export function mailerFromEnv(): SendCode {
  const auth = process.env.FLUENTCRM_AUTH
  if (auth) return fluentCrmMailer(process.env.FLUENTCRM_URL || 'https://hub.otakusolutions.io', auth)
  return async (to, code) => {
    if (process.env.NODE_ENV === 'production') throw new Error('Sign-in email needs FLUENTCRM_AUTH')
    console.log(`[sign-in] code for ${to.email}: ${code}`)
  }
}
