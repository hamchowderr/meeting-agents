/**
 * Who can use the co-pilot. `SELLERS` lists them, comma separated, as
 * `Name <email>`; add ` admin` to one who may see everyone's calls:
 *   SELLERS="Tylan Miller <tylan@otakusolutions.io> admin, Ric Forbes <ric@example.com>"
 * Not a secret: sign-in still needs the code emailed to that address.
 */
export type Seller = { name: string; email: string; admin: boolean }

export function parseSellers(raw: string | undefined): Seller[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((part) => part.trim().match(/^(.+?)\s*<([^>]+)>\s*(admin)?$/i))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ name: m[1]!.trim(), email: m[2]!.trim().toLowerCase(), admin: !!m[3] }))
}

export function sellersFromEnv(): Seller[] {
  return parseSellers(process.env.SELLERS ?? 'Tylan Miller <tylan@otakusolutions.io> admin')
}

export function firstName(s: Pick<Seller, 'name'>): string {
  return s.name.split(/\s+/)[0] ?? s.name
}
