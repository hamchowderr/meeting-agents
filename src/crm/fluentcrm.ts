/**
 * FluentCRM on the hub, over its REST API (FLUENTCRM_AUTH = a WordPress application
 * password, "user:pass"). Used for sign-in emails and for meeting notes.
 */
export type CrmApi = <T>(method: string, path: string, body?: unknown) => Promise<T>

export function crmApi(baseUrl: string, auth: string, fetchImpl: typeof fetch = fetch): CrmApi {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/wp-json/fluent-crm/v2${path}`, {
      method,
      headers: { authorization: `Basic ${Buffer.from(auth).toString('base64')}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw new Error(`FluentCRM ${method} ${path} answered ${res.status}`)
    return (await res.json()) as T
  }
}

export function crmFromEnv(env: NodeJS.ProcessEnv = process.env): CrmApi | null {
  return env.FLUENTCRM_AUTH ? crmApi(env.FLUENTCRM_URL || 'https://hub.otakusolutions.io', env.FLUENTCRM_AUTH) : null
}

/** The contact's id, creating a transactional contact when none has this email. */
export async function contactId(api: CrmApi, email: string, name: string): Promise<number> {
  const lower = email.trim().toLowerCase()
  const found = await api<{ subscribers: { data: { id: number; email: string }[] } }>('GET', `/subscribers?search=${encodeURIComponent(lower)}&per_page=10`)
  const id = found.subscribers.data.find((s) => s.email.toLowerCase() === lower)?.id
  if (id) return id
  const [first, ...rest] = name.trim().split(/\s+/)
  return (await api<{ contact: { id: number } }>('POST', '/subscribers', { email: lower, first_name: first ?? '', last_name: rest.join(' '), status: 'transactional' })).contact.id
}

/** The tag's id by exact title, created when missing. */
export async function tagId(api: CrmApi, title: string): Promise<number> {
  const found = await api<{ tags: { data: { id: number; title: string }[] } }>('GET', `/tags?search=${encodeURIComponent(title)}&per_page=50`)
  const id = found.tags.data.find((t) => t.title === title)?.id
  if (id) return id
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return (await api<{ tag: { id: number } }>('POST', '/tags', { title, slug })).tag.id
}

export type MeetingNote = { email: string; name: string; title: string; html: string; tag: string }

/**
 * Writes a meeting note on the contact and applies the tag. Adding a tag can start
 * automations; "Call: Held" is the tag the CRM Tagging Model reserves for this.
 */
export async function writeMeetingNote(api: CrmApi, note: MeetingNote): Promise<{ contactId: number }> {
  const id = await contactId(api, note.email, note.name)
  await api('POST', `/subscribers/${id}/notes`, { note: { title: note.title, description: note.html, type: 'meeting' } })
  await api('POST', '/subscribers/sync-segments', { type: 'tags', subscribers: [id], attach: [await tagId(api, note.tag)], detach: [] })
  return { contactId: id }
}
