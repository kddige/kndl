// What an operator does to a Hub from the command line, outside the server: issue a Runner's
// token, make a secrets key, and make the Setup link its Owner signs in with first (#209).
// `bun run runner-token`, `bun run secrets-key` and `bun run setup-link` (main.ts) and the kndl CLI
// (`kndl runner token`, `kndl secrets key`, `kndl hub setup-link`) share it.
import { admissionLink, SetupPath } from "@kndl/protocol"
import { Effect, Layer } from "effect"
import { CliTokens } from "./CliTokens.ts"
import { DatabaseLive } from "./Database.ts"
import { PublicUrlConfig } from "./HubConfig.ts"
import { Members } from "./Members.ts"
import { type RunnerIdentity, RunnerTokens } from "./RunnerTokens.ts"
import { generateSecretsKey } from "./Secrets.ts"
import { SignIns } from "./SignIns.ts"

/** A Runner and its new token, shown once. */
export type IssuedRunnerToken = RunnerIdentity & { readonly token: string }

/**
 * Issues a token for the Runner of this name, in the Hub's database at `DatabaseFile` (read from
 * the configuration: `HUB_DATABASE`, or the home's `hub.db`). Rotates any earlier token, keeping
 * the Runner's id and its Sessions.
 */
export const issueRunnerToken = (name: string) =>
  Effect.gen(function* () {
    return yield* (yield* RunnerTokens).issue(name)
  }).pipe(Effect.provide(RunnerTokens.layer.pipe(Layer.provideMerge(DatabaseLive))))

/** What `runner-token` prints: the token, once, and what to do with it. */
export function runnerTokenNotice(issued: IssuedRunnerToken): string {
  return [
    `Runner ${issued.name} (${issued.runnerId}). Its token, shown only now:`,
    "",
    `  ${issued.token}`,
    "",
    "Any earlier token for this Runner no longer works. Give the token to the Runner as RUNNER_TOKEN.",
  ].join("\n")
}

/** What `secrets-key` prints: a new HUB_SECRETS_KEY, and to put it in `destination`. */
export function secretsKeyNotice(destination: string, key: string = generateSecretsKey()): string {
  return [
    `A new key for the Hub's Sensitive values. Put it in ${destination}:`,
    "",
    `  HUB_SECRETS_KEY=${key}`,
    "",
    "Keep a copy somewhere safe: without it, the Sensitive values saved under it can't be read, and the Hub won't start.",
  ].join("\n")
}

/**
 * A new Setup link for the Hub whose database is at `DatabaseFile`, at its `HUB_PUBLIC_URL`:
 * whoever signs in with it first becomes the Owner. Replaces any earlier one. Refused
 * (SetupLinkRefused) once the Hub has an Owner.
 */
export const issueSetupLink = Effect.gen(function* () {
  const secret = yield* (yield* Members).newSetupLink
  return admissionLink((yield* PublicUrlConfig).href, SetupPath, secret)
}).pipe(
  Effect.provide(
    Members.layer.pipe(
      Layer.provide(Layer.mergeAll(SignIns.layer, CliTokens.layer)),
      Layer.provideMerge(DatabaseLive),
    ),
  ),
)

/** What `setup-link` prints: the link, once, and what to do with it. */
export function setupLinkNotice(link: string): string {
  return [
    "The Hub has no Owner yet. Its Setup link, shown only now:",
    "",
    `  ${link}`,
    "",
    "Open it and sign in with GitHub to become the Hub's Owner, then invite everyone else from the People page. It works once, and only until the Hub has an Owner; a new one replaces it.",
  ].join("\n")
}
