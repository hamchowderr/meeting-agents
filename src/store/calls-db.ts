import { type Client, createClient } from '@libsql/client'
import type { CallState } from '../sales/state'

/** Everything needed to bring a call back after a restart. */
export type StoredCall = {
  state: CallState
  hookSecret: string
  screenToken: string
  recordingId: string | null
  transcriptId: string | null
}

export interface CallStore {
  all(): Promise<StoredCall[]>
  save(call: StoredCall): Promise<void>
}

/**
 * Calls in libSQL: a local file on the server's volume (DATABASE_URL=file:/data/calls.db)
 * or Turso (libsql://..., DATABASE_AUTH_TOKEN). One row per call; the booking id is
 * unique so a booking can never own two calls.
 */
export class LibsqlCallStore implements CallStore {
  private ready: Promise<void> | null = null
  constructor(private readonly db: Client) {}

  private init(): Promise<void> {
    this.ready ??= this.db
      .batch(
        [
          `create table if not exists calls (
            id text primary key,
            booking_id text unique,
            bot_id text,
            data text not null,
            updated_at integer not null
          )`,
          'create index if not exists calls_bot on calls(bot_id)',
        ],
        'write',
      )
      .then(() => undefined)
    return this.ready
  }

  async all(): Promise<StoredCall[]> {
    await this.init()
    const rs = await this.db.execute('select data from calls order by updated_at desc')
    return rs.rows.map((r) => JSON.parse(String(r.data)) as StoredCall)
  }

  async save(call: StoredCall): Promise<void> {
    await this.init()
    await this.db.execute({
      sql: `insert into calls (id, booking_id, bot_id, data, updated_at) values (?, ?, ?, ?, ?)
            on conflict(id) do update set booking_id = excluded.booking_id, bot_id = excluded.bot_id, data = excluded.data, updated_at = excluded.updated_at`,
      args: [call.state.id, call.state.bookingId, call.state.botId, JSON.stringify(call), Date.now()],
    })
  }
}

export function callStoreFromEnv(env: NodeJS.ProcessEnv = process.env): CallStore | null {
  const url = env.DATABASE_URL
  if (!url) return null
  return new LibsqlCallStore(createClient({ url, authToken: env.DATABASE_AUTH_TOKEN || undefined }))
}
