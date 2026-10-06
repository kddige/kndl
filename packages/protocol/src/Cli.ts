import { Schema } from "effect"
import { CommitId } from "./Build.ts"
import { PairingAlphabet } from "./Pairing.ts"
import { EpochMillis, Participant } from "./Session.ts"

// The `kndl` CLI the Hub serves (issue #178, ADR 0016): `GET /cli` is the install script,
// `GET /cli/version` the commit the Hub serves it at, and `GET /cli/<target>` the binary, built
// with `bun build --compile` from the Hub's own commit. The CLI follows that commit, as Runners
// follow the Hub's (ADR 0011).

/** The platforms the Hub builds the CLI for, as `<os>-<arch>`. Windows is not one. */
export const CliTargets = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const
export type CliTarget = (typeof CliTargets)[number]

export const isCliTarget = (name: string): name is CliTarget =>
  (CliTargets as ReadonlyArray<string>).includes(name)

/** What `GET /cli/version` answers: the commit the Hub builds the CLI at, which is its own. */
export const CliVersion = Schema.Struct({ commit: CommitId })
export type CliVersion = typeof CliVersion.Type

/** The response header on `GET /cli/<target>` naming the commit the binary was built at. */
export const CliCommitHeader = "x-kndl-commit"

// Signing the CLI in (issue #179, ADR 0016): `kndl login <hub>` opens `/cli-login` on the
// Hub in a browser, where a signed-in person approves the machine. The page hands the CLI a
// one-time Login code, by redirecting to the CLI on a `localhost` port or, when that can't reach
// it (as over SSH), by showing it to paste. The CLI trades the code, with the PKCE verifier only
// it knows, for a CLI token: `chc_<id>.<secret>`, long-lived, named after the machine, revocable
// on the Account page.

/** A CLI token, as the Hub's records name it: not the token itself, which only its machine has. */
export const CliTokenId = Schema.NonEmptyString.pipe(Schema.brand("CliTokenId"))
export type CliTokenId = typeof CliTokenId.Type

export const MaxMachineNameLength = 64

/** The machine a CLI token is named after: its host name, as `kndl login` sends it. */
export const MachineName = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MaxMachineNameLength),
)
export type MachineName = typeof MachineName.Type

/** A CLI token as its owner's Account page lists it. */
export const CliTokenInfo = Schema.Struct({
  id: CliTokenId,
  machine: MachineName,
  createdAt: EpochMillis,
  /** When the CLI last used it, to the minute; absent if it never has. */
  lastUsedAt: Schema.optionalKey(EpochMillis),
})
export type CliTokenInfo = typeof CliTokenInfo.Type

/** How long a Login code can be traded for a CLI token. */
export const CliLoginCodeLifetimeMs = 10 * 60 * 1000

/** How many characters of {@link PairingAlphabet} a Login code has: 5 bits each, 80 in all. */
export const CliLoginCodeLength = 16

/** A Login code as it is shown: its characters in groups of four, joined by dashes. */
export function formatCliLoginCode(code: string): string {
  return (code.replaceAll("-", "").match(/.{1,4}/g) ?? []).join("-")
}

/**
 * A Login code's characters, the way the Hub hashes them: read as forgivingly as a Pairing code
 * (case, dashes and spaces don't matter; O reads as 0, I and L as 1). `undefined` when it isn't
 * a whole code.
 */
export function normalizeCliLoginCode(text: string): string | undefined {
  const code = text
    .toUpperCase()
    .replaceAll(/[\s-]/g, "")
    .replaceAll("O", "0")
    .replaceAll(/[IL]/g, "1")
  if (code.length !== CliLoginCodeLength) return undefined
  for (const char of code) if (!PairingAlphabet.includes(char)) return undefined
  return code
}

/** A PKCE challenge: the base64url SHA-256 of the verifier, as RFC 7636's S256 method. */
export const CliLoginChallenge = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/))

/**
 * `POST /auth/cli/approve`, from the `/cli-login` page with the sign-in cookie: the person approves
 * this machine. Answered with a {@link CliLoginApproved}.
 */
export const CliLoginApproval = Schema.Struct({
  machine: MachineName,
  challenge: CliLoginChallenge,
})
export type CliLoginApproval = typeof CliLoginApproval.Type

export const CliLoginApproved = Schema.Struct({
  /** The Login code, in groups of four. */
  code: Schema.NonEmptyString,
  expiresAt: EpochMillis,
})
export type CliLoginApproved = typeof CliLoginApproved.Type

/**
 * `POST /auth/cli/token`, from the CLI: a Login code and the PKCE verifier whose challenge it was
 * approved for, traded for a {@link CliSignedIn}.
 */
export const CliTokenRequest = Schema.Struct({
  code: Schema.String,
  verifier: Schema.String,
})
export type CliTokenRequest = typeof CliTokenRequest.Type

/** Who a CLI token signs in, as `GET /auth/cli/me` answers. */
export const CliWhoAmI = Schema.Struct({
  you: Participant,
  id: CliTokenId,
  machine: MachineName,
  createdAt: EpochMillis,
})
export type CliWhoAmI = typeof CliWhoAmI.Type

/** What `POST /auth/cli/token` answers: the new CLI token, handed out once, and whose it is. */
export const CliSignedIn = Schema.Struct({
  ...CliWhoAmI.fields,
  token: Schema.NonEmptyString,
})
export type CliSignedIn = typeof CliSignedIn.Type
