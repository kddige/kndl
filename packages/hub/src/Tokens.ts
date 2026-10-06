import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

// Bearer secrets the Hub mints: Runner tokens, mod tokens, CLI tokens and the sign-in cookies of
// browsers.
//
// A token is `<kind>_<id>.<secret>`. The id finds the row; the secret is 32 random bytes that the
// Hub never stores, only its SHA-256, and compares in constant time. The kind prefix keeps one
// kind of token from being read as another, and makes a leaked token recognisable.

const prefixes = { runner: "chr", mod: "chm", cli: "chc", signIn: "chs" } as const

export type TokenKind = keyof typeof prefixes

/** A token as handed out once, with the id and hash the Hub keeps. */
export interface MintedToken {
  readonly id: string
  readonly token: string
  readonly secretHash: string
}

/** A random id for a row: 24 hex characters. */
export function randomId(): string {
  return randomBytes(12).toString("hex")
}

/** A new token of a kind, for the row `id`. */
export function mintToken(kind: TokenKind, id: string = randomId()): MintedToken {
  const secret = randomBytes(32).toString("base64url")
  return { id, token: `${prefixes[kind]}_${id}.${secret}`, secretHash: hashSecret(secret) }
}

/** Splits a token of a kind into its row id and secret, or `undefined` if it isn't one. */
export function parseToken(
  kind: TokenKind,
  token: string,
): { readonly id: string; readonly secret: string } | undefined {
  const [, prefix, id, secret] =
    /^([a-z]+)_([A-Za-z0-9-]{1,64})\.([A-Za-z0-9_-]{43})$/.exec(token) ?? []
  if (prefix !== prefixes[kind] || id === undefined || secret === undefined) return undefined
  return { id, secret }
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex")
}

/** Whether `secret` hashes to `secretHash`, compared in constant time. */
export function secretMatches(secret: string, secretHash: string): boolean {
  return constantTimeEqual(hashSecret(secret), secretHash)
}

/** Compares two strings in time that depends only on their length (hash them first). */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** A random value for one-off checks such as the OAuth `state`. */
export function randomSecret(): string {
  return randomBytes(32).toString("base64url")
}
