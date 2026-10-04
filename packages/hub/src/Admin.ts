// What an operator does to a Hub from the command line, outside the server: issue a Runner's
// token and make a secrets key. `bun run runner-token` and `bun run secrets-key` (main.ts) and the
// claude-hub CLI (`claude-hub runner token`, `claude-hub secrets key`) share it.
import { Effect, Layer } from "effect"
import { DatabaseLive } from "./Database.ts"
import { type RunnerIdentity, RunnerTokens } from "./RunnerTokens.ts"
import { generateSecretsKey } from "./Secrets.ts"

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
