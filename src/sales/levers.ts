/**
 * The profit formula and the offers, in plain code. The model only picks numbers
 * out of the conversation; every dollar figure on either screen is worked out here.
 * Browser-safe: the web app imports this file too.
 */
export const LEVERS = ['leads', 'conv', 'tx', 'sale', 'margin'] as const
export type Lever = (typeof LEVERS)[number]
export type Values = Record<Lever, number>

export const LEVER_INFO: Record<Lever, { name: string; unit: string }> = {
  leads: { name: 'Leads', unit: 'enquiries a year' },
  conv: { name: 'Conversion', unit: 'become customers' },
  tx: { name: 'Transactions', unit: 'per customer a year' },
  sale: { name: 'Average sale', unit: 'per purchase' },
  margin: { name: 'Margin', unit: 'kept after costs' },
}

/** Used until a number is said, always shown as an estimate. */
export const DEFAULT_ESTIMATES: Values = { leads: 600, conv: 0.2, tx: 1, sale: 2500, margin: 0.25 }

export function calc(v: Values) {
  const customers = v.leads * v.conv
  const revenue = customers * v.tx * v.sale
  return { customers, revenue, profit: revenue * v.margin }
}

export function fmt(lever: Lever, x: number): string {
  if (lever === 'conv' || lever === 'margin') return `${Math.round(x * 1000) / 10}%`
  if (lever === 'sale') return money(x)
  if (lever === 'tx') return String(Math.round(x * 100) / 100)
  return Math.round(x).toLocaleString('en-US')
}

export function money(x: number): string {
  return `${x < 0 ? '-' : ''}$${Math.round(Math.abs(x)).toLocaleString('en-US')}`
}

/** Extra profit a year if one lever rises by `pct` (0.1 = 10%). */
export function liftGain(v: Values, lever: Lever, pct = 0.1): number {
  const after = { ...v, [lever]: v[lever] * (1 + pct) }
  return calc(after).profit - calc(v).profit
}

export type Signals = {
  /** Old quotes or leads that went cold, if the prospect said. */
  coldQuotes?: number
  /** Hours a week spent on admin (quotes, scheduling, invoices), if said. */
  adminHoursPerWeek?: number
}

export type Offer = {
  id: string
  name: string
  lever: Lever
  price: number
  priceText: string
  how: string
  /** A question that firms up the value, when the offer depends on a number not yet heard. */
  needs?: (s: Signals) => string | undefined
  value: (v: Values, s: Signals) => number
}

const ADMIN_RATE = 30

export const OFFERS: Offer[] = [
  {
    id: 'speed-to-lead',
    name: 'Speed to lead',
    lever: 'conv',
    price: 1000,
    priceText: '$1,000 setup',
    how: 'Answer every call and form in under a minute, after hours too',
    value: (v) => liftGain(v, 'conv'),
  },
  {
    id: 'reactivation',
    name: 'Database reactivation',
    lever: 'leads',
    price: 1000,
    priceText: '$1,000 setup',
    how: 'Text old quotes and past leads; about 1% come back',
    needs: (s) => (s.coldQuotes ? undefined : 'How many quotes went cold in the last two years?'),
    value: (v, s) => {
      const cold = s.coldQuotes ?? v.leads * (1 - v.conv)
      return Math.round(cold * 0.01) * v.tx * v.sale * v.margin
    },
  },
  {
    id: 'quote-agent',
    name: 'Good/better/best quote agent',
    lever: 'sale',
    price: 1000,
    priceText: 'from $1,000',
    how: 'Three-tier quotes lift the average sale about 10%',
    value: (v) => liftGain(v, 'sale'),
  },
  {
    id: 'rebooking',
    name: 'Reviews + rebooking agent',
    lever: 'tx',
    price: 1000,
    priceText: 'from $1,000',
    how: 'Check-ins, reviews and rebooking add about 0.05 purchases per customer',
    value: (v) => calc({ ...v, tx: v.tx + 0.05 }).profit - calc(v).profit,
  },
  {
    id: 'retainer',
    name: 'Retainer: admin agents',
    lever: 'margin',
    price: 18000,
    priceText: '$1,500/mo',
    how: `Admin hours handed to agents, valued at $${ADMIN_RATE}/h`,
    needs: (s) => (s.adminHoursPerWeek ? undefined : 'How many hours a week go to quotes, scheduling and invoices?'),
    value: (_v, s) => (s.adminHoursPerWeek ?? 12) * ADMIN_RATE * 52,
  },
]

export type Fit = 'strong' | 'possible' | 'ask'

export type RankedOffer = {
  id: string
  name: string
  lever: Lever
  priceText: string
  price: number
  how: string
  ask?: string
  value: number
  fit: Fit
  /** True when the value rests on an estimate, not only numbers they said. */
  estimated: boolean
  /** Days until extra profit covers the price; null when the value is zero. */
  paybackDays: number | null
}

export function valuesWithEstimates(said: Partial<Values>, estimates: Values = DEFAULT_ESTIMATES): Values {
  return { ...estimates, ...said } as Values
}

/** Offers ordered by fit (the confirmed leak first), then by what they're worth a year. */
export function rankOffers(said: Partial<Values>, leak: Lever | null, signals: Signals = {}, estimates?: Values): RankedOffer[] {
  const v = valuesWithEstimates(said, estimates)
  const allSaid = LEVERS.every((l) => said[l] !== undefined)
  const order: Record<Fit, number> = { strong: 0, possible: 1, ask: 2 }
  return OFFERS.map((o) => {
    const ask = o.needs?.(signals)
    // A confirmed leak is a strong fit even before its number is said; anything else waits for its number.
    const fit: Fit = ask ? 'ask' : leak === o.lever ? 'strong' : said[o.lever] === undefined ? 'ask' : 'possible'
    const value = o.value(v, signals)
    return {
      id: o.id,
      name: o.name,
      lever: o.lever,
      priceText: o.priceText,
      price: o.price,
      how: o.how,
      ask,
      value,
      fit,
      estimated: !allSaid || !!ask,
      paybackDays: value > 0 ? Math.max(1, Math.round((o.price / value) * 365)) : null,
    }
  }).sort((a, b) => order[a.fit] - order[b.fit] || b.value - a.value)
}

/** What fixing each lever's offer adds a year, for the lever board. */
export function leverBoard(said: Partial<Values>, leak: Lever | null, signals: Signals = {}, estimates?: Values) {
  const v = valuesWithEstimates(said, estimates)
  return LEVERS.map((lever) => {
    const offer = OFFERS.find((o) => o.lever === lever)!
    return { lever, value: v[lever], said: said[lever] !== undefined, weakest: leak === lever, gain: offer.value(v, signals) }
  })
}
