import crypto from 'node:crypto'
import type { Context } from 'hono'
import { type Seller, sellersFromEnv } from './sellers'

/**
 * Email-code sign-in for sellers, with no database and no extra secret:
 * a 6-digit code goes to a listed seller's email through the hub (FluentCRM), and
 * the session is a signed cookie. The signing key is SESSION_SECRET if set, else
 * derived from RECALL_API_KEY, so sessions survive a restart and rotate with that key.
 */
const COOKIE = 'otaku_notes'
const SESSION_DAYS = 30
const CODE_MINUTES = 10
const MAX_TRIES = 5

function key(): Buffer {
  const material = process.env.SESSION_SECRET || process.env.RECALL_API_KEY
  if (!material) throw new Error('Sign-in needs SESSION_SECRET or RECALL_API_KEY')
  return crypto.createHash('sha256').update(`meeting-agents/session/${material}`).digest()
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', key()).update(payload).digest('base64url')
}

export function sessionToken(email: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ e: email, x: now + SESSION_DAYS * 864e5 })).toString('base64url')
  return `${payload}.${sign(payload)}`
}

export function sellerFromToken(token: string | undefined, sellers: Seller[] = sellersFromEnv(), now = Date.now()): Seller | null {
  if (!token) return null
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const want = Buffer.from(sign(payload))
  const got = Buffer.from(sig)
  if (want.length !== got.length || !crypto.timingSafeEqual(new Uint8Array(want), new Uint8Array(got))) return null
  try {
    const { e, x } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { e: string; x: number }
    if (x < now) return null
    // Removing someone from SELLERS ends their sessions too.
    return sellers.find((s) => s.email === e) ?? null
  } catch {
    return null
  }
}

export function sellerFrom(c: Context): Seller | null {
  const cookie = c.req.header('cookie') ?? ''
  const token = cookie
    .split(/;\s*/)
    .find((p) => p.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1)
  return sellerFromToken(token)
}

export function sessionCookie(email: string, secure: boolean): string {
  return `${COOKIE}=${sessionToken(email)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

type Pending = { code: string; expires: number; tries: number }

/** One-time codes, in memory: they only need to live ten minutes. */
export class Codes {
  private pending = new Map<string, Pending>()

  issue(email: string, now = Date.now()): string {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
    this.pending.set(email, { code, expires: now + CODE_MINUTES * 60_000, tries: 0 })
    return code
  }

  check(email: string, code: string, now = Date.now()): boolean {
    const p = this.pending.get(email)
    if (!p || p.expires < now) return false
    p.tries++
    if (p.tries > MAX_TRIES) {
      this.pending.delete(email)
      return false
    }
    const ok = p.code.length === code.length && crypto.timingSafeEqual(new Uint8Array(Buffer.from(p.code)), new Uint8Array(Buffer.from(code)))
    if (ok) this.pending.delete(email)
    return ok
  }
}
