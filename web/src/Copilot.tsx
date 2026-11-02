import { useEffect, useState } from 'react'
import { LEVER_INFO, fmt, money } from '../../src/sales/levers'
import { type CopilotView, api, ownerKey, useLive } from './api'

const STEPS = ['Objective', 'Why it matters', 'Find the leak', 'Solution', 'Offer']
const FIT = { strong: ['Strong fit', 'bg-good text-white'], possible: ['Possible', 'bg-[#fdf0c8] text-[#7a5600]'], ask: ['Ask first', 'bg-mist text-soft'] } as const

function clock(startedAt: number, now: number) {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** The seller's private screen: where the call is, what to ask, what each fix is worth. */
export function Copilot({ id }: { id: string }) {
  const { data: v, connected } = useLive<CopilotView>(`/calls/${id}/events?key=${encodeURIComponent(ownerKey())}`)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  if (!v) return <p className="p-8 text-soft">{connected ? 'Loading…' : 'Connecting to the call…'}</p>

  const sellerShare = talkShare(v)
  const allSaid = v.board.every((b) => b.said)
  const lastTwo = v.transcript.slice(-3)
  const missing = v.board.filter((b) => !b.said)
  const top = v.offers[0]

  return (
    <div className="flex min-h-screen flex-col bg-mist">
      <header className="flex flex-wrap items-center gap-x-5 gap-y-2 bg-ink px-4 py-3 text-[#f1ecf6] md:px-6">
        <span className="flex items-center gap-2 font-mono font-extrabold">
          <i className={`size-2.5 rounded-full ${v.status === 'live' ? 'bg-[#e5484d]' : 'bg-soft'}`} />
          {v.status === 'live' ? clock(v.startedAt, now) : v.status === 'joining' ? 'Joining…' : v.status}
        </span>
        <span className="font-extrabold">{v.prospect ?? 'Live call'}</span>
        <ol className="flex flex-wrap gap-1 md:ml-auto">
          {STEPS.map((s, i) => (
            <li key={s} className={`rounded-full px-2.5 py-1 text-xs font-extrabold ${i === v.step ? 'bg-gold text-ink' : i < v.step ? 'bg-white/10' : 'bg-white/5 text-white/50'}`}>
              {i < v.step && <span className="text-[#8fd1a6]">✓ </span>}
              {s}
            </li>
          ))}
        </ol>
        {sellerShare !== null && (
          <span className="flex w-40 flex-col gap-1 text-xs font-bold opacity-85">
            Them {100 - sellerShare}% · You {sellerShare}%
            <span className="flex h-1.5 overflow-hidden rounded-full bg-gold">
              <i className="bg-[#8b93d6]" style={{ width: `${100 - sellerShare}%` }} />
            </span>
          </span>
        )}
        <button
          onClick={() => api(`/calls/${id}/math`, { method: 'POST', body: JSON.stringify({ show: !v.showMath }) })}
          className={`rounded-lg border px-3 py-1.5 text-sm font-extrabold ${v.showMath ? 'border-good bg-good' : 'border-white/25'}`}
        >
          {v.showMath ? 'Math on their screen' : 'Math hidden'}
        </button>
        <button onClick={() => confirm('Remove the bot from the call?') && api(`/calls/${id}/leave`, { method: 'POST' })} className="rounded-lg border border-white/25 px-3 py-1.5 text-sm font-extrabold">
          Remove bot
        </button>
      </header>

      {(v.error || !connected) && <p className="bg-blush px-6 py-2 text-sm font-bold text-rust">{!connected ? 'Reconnecting…' : v.error}</p>}

      <main className="grid flex-1 gap-4 p-4 md:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <section className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-3 rounded-2xl bg-navy p-5 text-[#fdf8f0] md:p-6">
            <small className="text-xs font-extrabold uppercase tracking-widest text-gold">Ask next · {STEPS[v.step]}</small>
            <p className="font-display text-3xl leading-tight">{v.askNext?.question ?? 'Listening for their goal…'}</p>
            {v.askNext && <span className="opacity-80">{v.askNext.reason}</span>}
            {!!v.askNext?.alternates.length && (
              <div className="flex flex-col gap-1 border-t border-white/15 pt-3">
                {v.askNext.alternates.map((a) => (
                  <span key={a}>
                    <b className="text-gold">or</b> {a}
                  </span>
                ))}
              </div>
            )}
          </div>

          {v.moneyQuestion && allSaid && top ? (
            <Banner tone="good" label="Money question heard · answer is up" big={`+${money(top.value)}`}>
              {top.name} · {LEVER_INFO[top.lever].name.toLowerCase()}. {top.paybackDays ? `Pays back in about ${top.paybackDays} days.` : ''}
            </Banner>
          ) : v.leak ? (
            <Banner tone="rust" label={`Leak · ${LEVER_INFO[v.leak.lever].name}`}>“{v.leak.evidence}”</Banner>
          ) : v.goal ? (
            <Banner tone="plain" label="Their goal · repeat it at the offer" big={v.goal.amount ? money(v.goal.amount) : undefined}>
              {v.goal.why ? `“${v.goal.why}”` : 'Get the reason in their words next.'}
            </Banner>
          ) : null}

          <div className="flex flex-col gap-2">
            <h2 className="text-xs font-extrabold uppercase tracking-widest text-soft">{missing.length ? `Still to hear · ${missing.length} left` : 'Before you close'}</h2>
            <div className="flex flex-wrap gap-2">
              {missing.length
                ? missing.map((b) => (
                    <span key={b.lever} className="rounded-lg border-[1.5px] border-dashed border-[#b9b4c6] bg-paper px-2.5 py-1.5 text-sm font-extrabold">
                      {LEVER_INFO[b.lever].name} <em className="font-medium not-italic text-soft">est. {fmt(b.lever, b.value)}</em>
                    </span>
                  ))
                : v.offers
                    .filter((o) => o.ask)
                    .map((o) => (
                      <span key={o.id} className="rounded-lg border-[1.5px] border-dashed border-[#b9b4c6] bg-paper px-2.5 py-1.5 text-sm font-extrabold">
                        {o.ask} <em className="font-medium not-italic text-soft">for {o.name.toLowerCase()}</em>
                      </span>
                    ))}
            </div>
          </div>

          <div className="mt-auto flex flex-col gap-1.5 rounded-xl border border-line bg-paper px-4 py-3 text-[15px] leading-snug">
            {lastTwo.length ? (
              lastTwo.map((u, i) => (
                <p key={`${u.at}-${i}`} className={i === lastTwo.length - 1 ? '' : 'text-soft'}>
                  <b className="mr-1.5 text-ink">{u.speaker}</b>
                  {u.text}
                </p>
              ))
            ) : (
              <p className="text-soft">The transcript shows here once people talk.</p>
            )}
          </div>
        </section>

        <section className="flex min-w-0 flex-col gap-4">
          <div>
            <h2 className="mb-2 flex justify-between text-xs font-extrabold uppercase tracking-widest text-soft">
              <span>Their five levers · what the fix adds a year</span>
              <span>{v.board.filter((b) => b.said).length} of 5 said</span>
            </h2>
            <div className="overflow-hidden rounded-2xl border border-line bg-paper">
              {v.board.map((b) => {
                const max = Math.max(...v.board.map((x) => x.gain), 1)
                return (
                  <div key={b.lever} className={`grid grid-cols-[minmax(0,1fr)_auto_auto] items-center sm:grid-cols-[7.5rem_5.5rem_4.5rem_1fr_5.5rem] gap-2.5 border-b border-[#efebf3] px-4 py-2 last:border-0 ${b.weakest ? 'bg-blush' : ''}`}>
                    <span className="font-extrabold">{LEVER_INFO[b.lever].name}</span>
                    <span className={`font-display text-xl ${b.said ? '' : 'text-soft'}`}>{fmt(b.lever, b.value)}</span>
                    <span className={`hidden rounded-md px-1.5 py-0.5 text-center text-[11px] font-extrabold uppercase sm:block ${b.said ? 'bg-[#e7e9f5] text-navy' : 'border border-dashed border-[#b9b4c6] text-soft'}`}>{b.said ? 'Said' : 'Est.'}</span>
                    <span className="hidden h-2 overflow-hidden rounded-full bg-[#efebf3] sm:block">
                      <i className={`block h-full rounded-full ${b.weakest ? 'bg-good' : 'bg-[#9fc9ad]'}`} style={{ width: `${Math.round((b.gain / max) * 100)}%` }} />
                    </span>
                    <span className={`text-right font-extrabold ${b.said ? 'text-good' : 'text-soft'}`}>+{money(b.gain)}</span>
                  </div>
                )
              })}
            </div>
          </div>

          <div>
            <h2 className="mb-2 flex justify-between text-xs font-extrabold uppercase tracking-widest text-soft">
              <span>Best offers right now</span>
              <span>by fit, then value</span>
            </h2>
            <div className="flex flex-col gap-2">
              {v.offers.slice(0, 4).map((o, i) => (
                <div key={o.id} className={`grid grid-cols-[1.5rem_1fr_auto] items-center gap-x-3 rounded-xl border-[1.5px] bg-paper px-3.5 py-2.5 ${i === 0 && o.fit === 'strong' ? 'border-good shadow-[0_0_0_3px_rgba(47,107,69,.12)]' : 'border-line'}`}>
                  <span className={`row-span-2 font-display text-xl ${i === 0 && o.fit === 'strong' ? 'text-good' : 'text-soft'}`}>{i + 1}</span>
                  <span className="truncate font-extrabold">
                    {o.name} <em className="text-xs font-semibold not-italic text-soft">{LEVER_INFO[o.lever].name} · {o.priceText}</em>
                  </span>
                  <span className="row-span-2 flex flex-col items-end gap-1">
                    <b className={`font-display text-xl ${o.fit === 'ask' ? 'text-soft' : 'text-good'}`}>
                      {o.estimated ? '≈' : '+'}
                      {money(o.value)}/yr
                    </b>
                    <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-extrabold uppercase ${FIT[o.fit][1]}`}>{FIT[o.fit][0]}</span>
                  </span>
                  <span className="truncate text-sm text-soft">{o.ask ? `Ask: ${o.ask}` : o.how}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}

function Banner({ tone, label, big, children }: { tone: 'good' | 'rust' | 'plain'; label: string; big?: string; children: React.ReactNode }) {
  const box = tone === 'good' ? 'border-good bg-[#eef6f0]' : tone === 'rust' ? 'border-rust bg-blush' : 'border-line bg-paper'
  const lab = tone === 'good' ? 'text-good' : 'text-rust'
  return (
    <div className={`grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 rounded-2xl border-2 px-4 py-3 ${box}`}>
      <small className={`text-xs font-extrabold uppercase tracking-widest ${lab}`}>{label}</small>
      {big && <b className={`row-span-2 font-display text-3xl ${tone === 'good' ? 'text-good' : 'text-ink'}`}>{big}</b>}
      <span>{children}</span>
    </div>
  )
}

/** Share of words the seller spoke. Null until anyone talks. */
function talkShare(v: CopilotView): number | null {
  let seller = 0
  let total = 0
  for (const u of v.transcript) {
    const n = u.text.split(/\s+/).length
    total += n
    if (u.seller) seller += n
  }
  return total ? Math.round((seller / total) * 100) : null
}
