import { useEffect, useState } from 'react'
import { api, ownerKey, saveKey } from './api'

type CallRow = { id: string; prospect: string | null; status: string; startedAt: number; meetingUrl: string }

/** Paste a meeting link, send the bot, open the co-pilot. */
export function Start() {
  const [key, setKey] = useState(ownerKey())
  const [url, setUrl] = useState('')
  const [prospect, setProspect] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [calls, setCalls] = useState<CallRow[]>([])

  useEffect(() => {
    if (key) api<CallRow[]>('/calls').then(setCalls).catch(() => {})
  }, [key])

  async function send(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const call = await api<{ id: string }>('/calls', { method: 'POST', body: JSON.stringify({ meetingUrl: url.trim(), prospect: prospect.trim() || null }) })
      location.href = `/app/live/${call.id}`
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  if (!key) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4">
        <h1 className="font-display text-4xl">Otaku notes</h1>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            const k = new FormData(e.currentTarget).get('k') as string
            saveKey(k)
            setKey(k)
          }}
        >
          <label className="text-sm font-bold" htmlFor="k">Owner key</label>
          <input id="k" name="k" type="password" required className="rounded-lg border border-line bg-paper px-3 py-2" />
          <button className="rounded-lg bg-navy px-4 py-2 font-bold text-white">Continue</button>
        </form>
      </main>
    )
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-8 px-4 py-12">
      <header>
        <p className="text-xs font-extrabold uppercase tracking-widest text-rust">Otaku notes</p>
        <h1 className="font-display text-4xl leading-tight">Send the co-pilot to a call</h1>
        <p className="mt-2 text-soft">Paste a Zoom or Google Meet link. The bot joins as "Otaku notes" and your live screen opens here.</p>
      </header>
      <form onSubmit={send} className="flex flex-col gap-3 rounded-2xl border border-line bg-paper p-5">
        <label className="text-sm font-bold" htmlFor="url">Meeting link</label>
        <input id="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://meet.google.com/abc-defg-hij" className="rounded-lg border border-line px-3 py-2" />
        <label className="text-sm font-bold" htmlFor="prospect">Business (optional)</label>
        <input id="prospect" value={prospect} onChange={(e) => setProspect(e.target.value)} placeholder="Ridge Flooring" className="rounded-lg border border-line px-3 py-2" />
        {error && <p className="text-sm font-bold text-rust">{error}</p>}
        <button disabled={busy} className="mt-1 rounded-lg bg-navy px-4 py-2.5 font-bold text-white disabled:opacity-60">
          {busy ? 'Sending the bot…' : 'Send the bot'}
        </button>
      </form>
      {calls.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-extrabold uppercase tracking-widest text-soft">Calls since the last restart</h2>
          {calls.map((c) => (
            <a key={c.id} href={`/app/live/${c.id}`} className="flex justify-between rounded-xl border border-line bg-paper px-4 py-3 font-bold no-underline text-ink">
              <span>{c.prospect ?? c.meetingUrl}</span>
              <span className="text-soft">{c.status}</span>
            </a>
          ))}
        </section>
      )}
    </main>
  )
}
