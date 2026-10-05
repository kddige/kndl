import { Schema } from "effect"
import { RunnerId } from "./Ids.ts"
import { EpochMillis, Participant } from "./Session.ts"

// Pairing codes (GLOSSARY.md): what a person mints on the Runners page and a machine redeems with
// `claude-hub runner join` for a lasting Runner token. The Hub keeps only a code's hash.
//
// A code is 20 characters of Crockford base32 (100 random bits), shown in groups of five:
// `7K3QH-WM2PA-...`. Reading one back is forgiving: case, dashes and spaces don't matter, and the
// letters Crockford base32 leaves out read as the digits they look like (O as 0, I and L as 1).
// It travels with the Hub's URL as one link, `<hub-url>#<code>`: the fragment never reaches a
// server, so the code isn't logged by a proxy in front of the Hub when the link is opened.

/** A minted Pairing code, as the Hub's records name it: not the code itself, which only its maker sees. */
export const PairingCodeId = Schema.NonEmptyString.pipe(Schema.brand("PairingCodeId"))
export type PairingCodeId = typeof PairingCodeId.Type

/** How long a Pairing code can be redeemed for. */
export const PairingCodeLifetimeMs = 15 * 60 * 1000

/** Crockford's base32 alphabet: no I, L, O or U. */
export const PairingAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** How many characters of {@link PairingAlphabet} a code has: 5 bits each, 100 in all. */
export const PairingCodeLength = 20

/** A code as it is shown: its characters in groups of five, joined by dashes. */
export function formatPairingCode(code: string): string {
  return (code.match(/.{1,5}/g) ?? []).join("-")
}

/**
 * A code's characters, the way the Hub hashes them: upper case, without dashes or spaces, with O
 * read as 0 and I and L as 1. `undefined` when it isn't a whole code.
 */
export function normalizePairingCode(text: string): string | undefined {
  const code = text
    .toUpperCase()
    .replaceAll(/[\s-]/g, "")
    .replaceAll("O", "0")
    .replaceAll(/[IL]/g, "1")
  if (code.length !== PairingCodeLength) return undefined
  for (const char of code) if (!PairingAlphabet.includes(char)) return undefined
  return code
}

/** The link a machine joins with: the Hub's origin, and the code as its fragment. */
export function pairingLink(hubUrl: string, code: string): string {
  return `${new URL(hubUrl).origin}#${formatPairingCode(code)}`
}

/** What the Runners page offers to paste on the new machine. */
export function pairingCommand(link: string): string {
  return `claude-hub runner join '${link}'`
}

/** A pairing link, read: where the Hub is, and the code to redeem there. */
export interface PairingTarget {
  /** The Hub's origin, such as `https://hub.example.com`. */
  readonly hubUrl: string
  /** The code, normalized. */
  readonly code: string
}

/**
 * Reads what `runner join` (or `onboard --pair`) was given: a pairing link, or a code alone with
 * the Hub's URL given apart as `hubUrl`. Says what's wrong with it otherwise.
 */
export function parsePairing(
  text: string,
  hubUrl?: string,
): { readonly _tag: "Parsed"; readonly target: PairingTarget } | {
  readonly _tag: "Invalid"
  readonly message: string
} {
  const invalid = (message: string) => ({ _tag: "Invalid", message }) as const
  const trimmed = text.trim().replace(/^'(.*)'$/s, "$1")
  const hash = trimmed.indexOf("#")
  if (hash < 0) {
    const code = normalizePairingCode(trimmed)
    if (code === undefined) {
      return invalid(
        "That isn't a pairing link. Copy it from the Hub's Runners page (Add a Runner): it looks like https://hub.example.com#XXXXX-XXXXX-XXXXX-XXXXX.",
      )
    }
    if (hubUrl === undefined) {
      return invalid("A pairing code alone needs the Hub's URL too: paste the whole pairing link.")
    }
    const origin = originOf(hubUrl)
    if (origin === undefined) return invalid(`${hubUrl} isn't an http or https URL.`)
    return { _tag: "Parsed", target: { hubUrl: origin, code } }
  }
  const origin = originOf(trimmed.slice(0, hash))
  if (origin === undefined) {
    return invalid(`${trimmed.slice(0, hash) || "(nothing)"} isn't an http or https URL.`)
  }
  const code = normalizePairingCode(decodeURIComponent(trimmed.slice(hash + 1)))
  if (code === undefined) {
    return invalid(
      `The code after # isn't a whole pairing code: it has ${PairingCodeLength} letters and digits, in groups of five. Copy the link again.`,
    )
  }
  return { _tag: "Parsed", target: { hubUrl: origin, code } }
}

function originOf(text: string): string | undefined {
  try {
    const url = new URL(text)
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined
  } catch {
    return undefined
  }
}

// ── Redeeming, over HTTP ──────────────────────────────────────────────────

/** `POST /runner/pair`'s body. */
export const PairRequest = Schema.Struct({
  code: Schema.String,
  /** The new Runner's name; a Re-pair keeps the Runner's own. */
  name: Schema.String,
})
export type PairRequest = typeof PairRequest.Type

/** `POST /runner/pair`'s answer: the Runner's lasting token, shown nowhere else. */
export const Paired = Schema.Struct({
  runnerId: RunnerId,
  name: Schema.NonEmptyString,
  token: Schema.NonEmptyString,
  /** Whether the code was a Re-pair's: the Runner kept its id and Sessions, and its old token stopped working. */
  repaired: Schema.Boolean,
})
export type Paired = typeof Paired.Type

/** `GET /runner/connection`'s answer, to a Runner token: whether the Hub has that Runner connected. */
export const RunnerConnection = Schema.Struct({
  runnerId: RunnerId,
  name: Schema.NonEmptyString,
  online: Schema.Boolean,
})
export type RunnerConnection = typeof RunnerConnection.Type

/** What the Hub answers a request it refuses, on these routes as on others: `{ error }`. */
export const HubError = Schema.Struct({ error: Schema.String })

/**
 * What the Hub answers every redemption it refuses for its code: the same whether the code never
 * existed, was mistyped, has expired, was used or was revoked, so a refusal tells a guesser nothing.
 */
export const PairingCodeRefused =
  "That pairing code can't be used: it may be mistyped, expired (codes last 15 minutes), already used or revoked. Make a new one on the Hub's Runners page (Add a Runner)."

/** A Pairing code not yet redeemed, revoked or expired, as the Runners page lists it. */
export const PendingPairingCode = Schema.Struct({
  id: PairingCodeId,
  /** The Runner a Re-pair's code is for; absent for a new Runner's. */
  runnerId: Schema.optionalKey(RunnerId),
  createdBy: Participant,
  createdAt: EpochMillis,
  expiresAt: EpochMillis,
})
export type PendingPairingCode = typeof PendingPairingCode.Type

/** Why a Runner name can't be used, or `undefined` when it can. */
export function checkRunnerName(name: string): string | undefined {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name)
    ? undefined
    : `${JSON.stringify(name)} can't be a Runner's name: use up to 63 letters, digits, dots, dashes and underscores, starting with a letter or digit.`
}
