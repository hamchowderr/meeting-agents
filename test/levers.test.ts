import { describe, expect, it } from 'vitest'
import { calc, leverBoard, liftGain, rankOffers, type Values } from '../src/sales/levers'

// The flooring example used in every mockup and the product video.
const flooring: Values = { leads: 720, conv: 0.2, tx: 1.05, sale: 6000, margin: 0.25 }

describe('profit formula', () => {
  it('matches the flooring example', () => {
    const r = calc(flooring)
    expect(Math.round(r.customers)).toBe(144)
    expect(Math.round(r.revenue)).toBe(907200)
    expect(Math.round(r.profit)).toBe(226800)
  })

  it('a 10% conversion lift is worth $22,680 a year', () => {
    expect(Math.round(liftGain(flooring, 'conv'))).toBe(22680)
  })
})

describe('offer ranking', () => {
  it('puts the confirmed leak first, then by value', () => {
    const ranked = rankOffers(flooring, 'conv', { adminHoursPerWeek: 12, coldQuotes: 900 })
    expect(ranked[0]).toMatchObject({ id: 'speed-to-lead', fit: 'strong', estimated: false })
    expect(Math.round(ranked[0]!.value)).toBe(22680)
    expect(ranked[0]!.paybackDays).toBe(16)
    expect(ranked.slice(1).every((o) => o.fit === 'possible')).toBe(true)
    // 1% of 900 cold quotes = 9 jobs
    expect(Math.round(ranked.find((o) => o.id === 'reactivation')!.value)).toBe(Math.round(9 * 1.05 * 6000 * 0.25))
  })

  it('asks before valuing offers that depend on an unheard number', () => {
    const ranked = rankOffers(flooring, null)
    const retainer = ranked.find((o) => o.id === 'retainer')!
    expect(retainer.fit).toBe('ask')
    expect(retainer.ask).toMatch(/hours a week/)
    expect(retainer.estimated).toBe(true)
  })

  it('marks values as estimates until all five numbers are said', () => {
    const ranked = rankOffers({ leads: 720 }, 'conv')
    expect(ranked.find((o) => o.id === 'speed-to-lead')).toMatchObject({ fit: 'strong', estimated: true })
    expect(ranked.find((o) => o.id === 'quote-agent')!.fit).toBe('ask')
  })

  it('lever board flags said values and the weakest lever', () => {
    const board = leverBoard({ leads: 720 }, 'conv')
    expect(board.find((b) => b.lever === 'leads')).toMatchObject({ said: true, value: 720 })
    expect(board.find((b) => b.lever === 'conv')).toMatchObject({ said: false, weakest: true })
  })
})
