import { useEffect, useState } from 'react'
import { LEVERS, LEVER_INFO, type Lever, type Values, calc, fmt, money } from '../../src/sales/levers'
import { type ProspectView, useLive } from './api'

/**
 * The bot's camera in the meeting: a fixed 1280x720 page (Recall renders it at that size).
 * Shows only the prospect's own numbers, never estimates, offers or coaching.
 */
export function Screen({ id }: { id: string }) {
  const t = new URL(location.href).searchParams.get('t') ?? ''
  const { data: v } = useLive<ProspectView>(`/screen/${id}/events?t=${encodeURIComponent(t)}`)
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / 1280, window.innerHeight / 720))
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  return (
    <div className="h-screen w-screen overflow-hidden bg-bg">
      <div className="origin-top-left" style={{ width: 1280, height: 720, transform: `scale(${scale})` }}>
        {!v || !v.showMath ? <Idle seller={v?.seller} /> : <Formula v={v} />}
      </div>
    </div>
  )
}

function Idle({ seller }: { seller?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <p className="text-[15px] font-extrabold uppercase tracking-[.14em] text-rust">Otaku notes</p>
      <p className="font-display text-[52px] leading-tight">Taking notes for {seller ?? 'Otaku Solutions'}</p>
      <p className="text-xl text-soft">This call is recorded. Ask {seller ?? 'your host'} to remove me at any time.</p>
    </div>
  )
}

function Formula({ v }: { v: ProspectView }) {
  const said = Object.fromEntries(LEVERS.filter((l) => v.said[l]).map((l) => [l, v.said[l]!.value])) as Partial<Values>
  const all = LEVERS.every((l) => said[l] !== undefined)
  const now = all ? calc(said as Values) : null
  const lift = v.liftLever && all ? v.liftLever : null
  const after = lift ? calc({ ...(said as Values), [lift]: (said as Values)[lift] * 1.1 }) : null

  return (
    <div className="grid h-full grid-cols-[1fr_440px] gap-8 px-10 pt-7 pb-10">
      <div className="flex flex-col gap-2.5">
        <div>
          <p className="text-[15px] font-extrabold uppercase tracking-[.12em] text-rust">Your profit formula</p>
          <p className="font-display text-[34px] leading-tight">{v.prospect ?? 'Today'}</p>
        </div>
        {LEVERS.map((l) => (
          <Row key={l} lever={l} v={v} lifted={lift === l} />
        ))}
        {now && (
          <div className="mt-1 grid grid-cols-3 gap-3">
            <Cell label="Customers a year" value={String(Math.round(now.customers))} />
            <Cell label="Revenue" value={money(now.revenue)} />
            <Cell label="Profit" value={money(now.profit)} gold />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-4">
        {v.goal?.amount && (
          <Card label="Your goal this year">
            <p className="font-display text-[52px] leading-none">{money(v.goal.amount)}</p>
            {v.goal.why && <p className="text-xl italic text-soft">“{v.goal.why}”</p>}
            {now && (
              <>
                <div className="h-3 overflow-hidden rounded-full bg-line">
                  <i className="block h-full rounded-full bg-good transition-all duration-700" style={{ width: `${Math.min(100, ((after ?? now).revenue / v.goal.amount) * 100)}%` }} />
                </div>
                <p className="text-base text-soft">
                  {after ? 'With the fix: ' : 'Today: '}
                  {money((after ?? now).revenue)} of {money(v.goal.amount)}
                </p>
              </>
            )}
          </Card>
        )}
        {after && now && lift ? (
          <Card label={`If ${LEVER_INFO[lift].name.toLowerCase()} rises 10%`}>
            <p className="font-display text-[56px] leading-none text-good">+{money(after.profit - now.profit)}</p>
            <p className="text-xl">
              more profit a year. Revenue goes from {money(now.revenue)} to {money(after.revenue)}.
            </p>
          </Card>
        ) : v.leak ? (
          <Card label="Where it leaks">
            <p className="text-xl">“{v.leak.evidence}”</p>
          </Card>
        ) : (
          <Card label="How profit is made">
            <p className="text-lg">Leads × conversion × transactions × average sale × margin. A small lift on each one multiplies.</p>
          </Card>
        )}
        <p className="mt-auto text-sm text-soft">Numbers are what you told us today, rounded. Otaku Solutions</p>
      </div>
    </div>
  )
}

function Row({ lever, v, lifted }: { lever: Lever; v: ProspectView; lifted: boolean }) {
  const s = v.said[lever]
  const weak = v.leak?.lever === lever
  return (
    <div className={`grid grid-cols-[190px_250px_1fr] items-center gap-4 rounded-2xl border-2 px-5 py-2 transition-colors duration-500 ${weak ? 'border-rust bg-blush' : 'border-line bg-paper'}`}>
      <div>
        <p className="text-xl font-extrabold">{LEVER_INFO[lever].name}</p>
        {weak ? <p className="text-xs font-extrabold uppercase tracking-wider text-rust">Weakest lever</p> : <p className="text-sm text-soft">{LEVER_INFO[lever].unit}</p>}
      </div>
      {s ? (
        <>
          <p className={`font-display text-[34px] ${lifted ? 'text-good' : ''}`}>{lifted ? `${fmt(lever, s.value)} → ${fmt(lever, s.value * 1.1)}` : fmt(lever, s.value)}</p>
          <p className="text-base italic text-soft">You said: “{s.quote}”</p>
        </>
      ) : (
        <>
          <p className="font-display text-[26px] text-[#b9b4c6]">Listening…</p>
          <span />
        </>
      )}
    </div>
  )
}

function Cell({ label, value, gold }: { label: string; value: string; gold?: boolean }) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl bg-navy px-4 py-3 text-[#fdf8f0]">
      <small className="text-xs font-extrabold uppercase tracking-widest opacity-80">{label}</small>
      <b className={`font-display text-[28px] leading-none ${gold ? 'text-gold' : ''}`}>{value}</b>
    </div>
  )
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border-2 border-line bg-paper p-6">
      <small className="text-xs font-extrabold uppercase tracking-widest text-rust">{label}</small>
      {children}
    </div>
  )
}
