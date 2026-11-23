import { useEffect, useState } from 'react'
import { type Me, api } from './api'

type CallRow = { id: string; prospect: string | null; seller: string; status: string; startedAt: number; meetingUrl: string }

const field = 'rounded-lg border border-line bg-paper px-3 py-2'
const button = 'rounded-lg bg-navy px-4 py-2.5 font-bold text-white disabled:opacity-60'

/** Sign in with an emailed code, then paste a meeting link to send the bot. */
export function Start() {
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  useEffect(() => {
    api<Me>('/auth/me').then(setMe, () => setMe(null))
  }, [])
  if (me === undefined) return null
  return me ? <SendBot me={me} /> : <SignIn onIn={setMe} />
}

function SignIn({ onIn }: { onIn: (m: Me) => void }) {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (!sent) {
        await api('/auth/code', { method: 'POST', body: JSON.stringify({ email }) })
        setSent(true)
      } else {
        onIn(await api<Me>('/auth/verify', { method: 'POST', body: JSON.stringify({ email, code }) }))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-5 px-4">
      <div>
        <p className="text-xs font-extrabold uppercase tracking-widest text-rust">Sales co-pilot</p>
        <h1 className="font-display text-4xl">Sign in</h1>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="text-sm font-bold" htmlFor="email">Email</label>
        <input id="email" type="email" required autoComplete="email" value={email} disabled={sent} onChange={(e) => setEmail(e.target.value)} className={field} />
        {sent && (
          <>
            <label className="text-sm font-bold" htmlFor="code">Code from your email</label>
            <input id="code" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} className={`${field} tracking-[.3em]`} />
            <p className="text-sm text-soft">If this email can use the sales co-pilot, a 6-digit code is on its way.</p>
          </>
        )}
        {error && <p className="text-sm font-bold text-rust">{error}</p>}
        <button disabled={busy} className={button}>{sent ? 'Sign in' : 'Email me a code'}</button>
      </form>
    </main>
  )
}

function SendBot({ me }: { me: Me }) {
  const [url, setUrl] = useState('')
  const [prospect, setProspect] = useState('')
  const [botName, setBotName] = useState(() => savedBotName() ?? `${me.name.split(' ')[0]}'s notetaker`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [calls, setCalls] = useState<CallRow[]>([])

  useEffect(() => {
    api<CallRow[]>('/calls').then(setCalls).catch(() => {})
  }, [])

  async function send(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const call = await api<{ id: string }>('/calls', { method: 'POST', body: JSON.stringify({ meetingUrl: url.trim(), prospect: prospect.trim() || null, botName: botName.trim() || null }) })
      saveBotName(botName.trim())
      location.href = `/app/live/${call.id}`
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-8 px-4 py-12">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-extrabold uppercase tracking-widest text-rust">Sales co-pilot</p>
          <h1 className="font-display text-4xl leading-tight">Send the co-pilot to a call</h1>
          <p className="mt-2 text-soft">Paste a Zoom or Google Meet link. The bot joins under the name you choose and your live screen opens here.</p>
        </div>
        <button
          onClick={() => api('/auth/logout', { method: 'POST' }).then(() => location.reload())}
          className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-sm font-bold"
        >
          Sign out {me.name.split(' ')[0]}
        </button>
      </header>
      <form onSubmit={send} className="flex flex-col gap-3 rounded-2xl border border-line bg-paper p-5">
        <label className="text-sm font-bold" htmlFor="url">Meeting link</label>
        <input id="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://meet.google.com/abc-defg-hij" className={field} />
        <label className="text-sm font-bold" htmlFor="botName">Bot name</label>
        <input id="botName" maxLength={100} value={botName} onChange={(e) => setBotName(e.target.value)} className={field} />
        <p className="-mt-1 text-sm text-soft">What everyone in the meeting sees. Kept for your next call.</p>
        <label className="text-sm font-bold" htmlFor="prospect">Business (optional)</label>
        <input id="prospect" value={prospect} onChange={(e) => setProspect(e.target.value)} placeholder="Ridge Flooring" className={field} />
        {error && <p className="text-sm font-bold text-rust">{error}</p>}
        <button disabled={busy} className={`mt-1 ${button}`}>{busy ? 'Sending the bot…' : 'Send the bot'}</button>
      </form>
      {calls.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-extrabold uppercase tracking-widest text-soft">{me.admin ? 'All calls' : 'Your calls'} since the last restart</h2>
          {calls.map((c) => (
            <a key={c.id} href={`/app/live/${c.id}`} className="flex justify-between gap-3 rounded-xl border border-line bg-paper px-4 py-3 font-bold text-ink no-underline">
              <span>
                {c.prospect ?? c.meetingUrl}
                {me.admin && <span className="font-medium text-soft"> · {c.seller}</span>}
              </span>
              <span className="text-soft">{c.status}</span>
            </a>
          ))}
        </section>
      )}
    </main>
  )
}

/** The seller's last bot name, kept in this browser only. */
function savedBotName(): string | null {
  try {
    return localStorage.getItem('botName') || null
  } catch {
    return null
  }
}

function saveBotName(name: string) {
  try {
    if (name) localStorage.setItem('botName', name)
  } catch {}
}
