// Starting over when HUB_SECRETS_KEY is lost (#57). The Hub refuses to start while it stores
// Sensitive values it can't decrypt (Secrets.ts); a reset clears every value the lost key
// encrypted and keeps everything else, so a Hub with a new key starts. `bun run secrets-reset`
// (main.ts) and `kndl secrets reset` share it, as they share Admin.ts.
//
// - It refuses while a Hub runs on the database, and a Hub doesn't start while it runs: both
//   hold the database's lock (HubLock.ts).
// - It needs no key, so it works when the key is lost.
// - Each Sensitive variable, own or shared, keeps its name, kind, "available at build" and
//   Links, and needs a value (Environments.ts): the Repos' Sessions don't start until it gets one.
// - What else the lost key protects goes too: the check value, the retired values kept for
//   redaction (a Session still running may print those unredacted), and the Test builds, whose
//   digests are keyed from it, so none could match again.
// - Each person's Claude credential goes too (ADR 0015): they add theirs again on the Account
//   page, and until then their Sessions run on their Runner's own credential, if it has one.
// - Plain variables, Environments, versions, Sessions and builds already on Runners stay.
import { existsSync } from "node:fs"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { DatabaseFile, databaseAt } from "./Database.ts"
import { holdHubLock } from "./HubLock.ts"

/** There is no database to reset where the configuration says. */
// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class NoHubDatabase extends Schema.TaggedError<NoHubDatabase>()("NoHubDatabase", {
  message: Schema.String,
}) {}

/** What a reset clears: Sensitive variables by name, never their values. */
export interface SecretsResetPlan {
  /** Each Repo's Environment with Sensitive values, and those variables, in order. */
  readonly environments: ReadonlyArray<{
    readonly repo: string
    readonly names: ReadonlyArray<string>
  }>
  /** The Sensitive shared variables with values. */
  readonly sharedVariables: ReadonlyArray<string>
  /** How many replaced values were kept, encrypted, for redaction. */
  readonly retiredValues: number
  readonly testBuilds: number
  /** Who stored a Claude credential, by GitHub login, in order. */
  readonly claudeCredentials: ReadonlyArray<string>
}

/** How many Sensitive values the reset clears. */
export const clearedCount = (plan: SecretsResetPlan) =>
  plan.environments.reduce((sum, environment) => sum + environment.names.length, 0) +
  plan.sharedVariables.length

/** Whether there is anything the lost key protects: if not, a new key just works. */
export const resetNeeded = (plan: SecretsResetPlan) =>
  clearedCount(plan) > 0 || plan.retiredValues > 0 || plan.claudeCredentials.length > 0

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

/** The Sensitive variables cleared, one line per Environment and one for the shared ones. */
function clearedLines(plan: SecretsResetPlan): ReadonlyArray<string> {
  return [
    ...plan.environments.map(({ repo, names }) => `  - ${repo}: ${names.join(", ")}`),
    ...(plan.sharedVariables.length > 0
      ? [`  - shared variables: ${plan.sharedVariables.join(", ")}`]
      : []),
  ]
}

/** What the reset will do, before asking to go on. */
export function secretsResetPlanText(plan: SecretsResetPlan): string {
  const values = clearedCount(plan)
  const also = [
    ...(plan.retiredValues > 0
      ? [`${plural(plan.retiredValues, "retired value")} kept to redact what older Sessions print`]
      : []),
    ...(plan.testBuilds > 0 ? [`the record of ${plural(plan.testBuilds, "Test build")}`] : []),
  ]
  return [
    values > 0
      ? `This clears ${plural(values, "Sensitive value")}, keeping each variable, its "available at build" and its Links:`
      : "No Sensitive variable has a value.",
    ...clearedLines(plan),
    ...(values > 0
      ? [
          "Each then needs a value: the Sessions of a Repo that has, or links, one don't start until it gets one.",
        ]
      : []),
    ...(also.length > 0
      ? [`It also drops ${also.join(" and ")}: the lost key protects them.`]
      : []),
    ...claudeCredentialLines(plan),
    "Plain variables, Environments, Sessions and the builds on Runners stay.",
  ].join("\n")
}

/** The Claude credentials removed, by whose they were. */
function claudeCredentialLines(plan: SecretsResetPlan): ReadonlyArray<string> {
  const people = plan.claudeCredentials
  if (people.length === 0) return []
  return [
    `It removes the Claude credential${people.length === 1 ? "" : "s"} of ${people.join(", ")}: until each adds theirs again on the Account page, their Sessions run on their Runner's own.`,
  ]
}

/**
 * What a reset did, and what's next: a new key, made as `newKey` says (such as
 * "`bun run secrets-key`"), then the values entered again.
 */
export function secretsResetDoneText(plan: SecretsResetPlan, newKey: string): string {
  const values = clearedCount(plan)
  return [
    values > 0
      ? `Cleared ${plural(values, "Sensitive value")}. These need a value:`
      : "Cleared what the lost key protected.",
    ...clearedLines(plan),
    ...claudeCredentialLines(plan),
    "",
    `Next: make a new key with ${newKey}, set HUB_SECRETS_KEY to it and start the Hub. Then enter the values again, on each Environment's screen and on the Shared variables screen.`,
  ].join("\n")
}

/** What the lost key protects in the database. */
const planOf = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const own = yield* sql<{ readonly repo: string; readonly name: string }>`
    SELECT repo, name FROM environment_variables
    WHERE kind = 'Sensitive' AND value IS NOT NULL ORDER BY repo, position
  `
  const shared = yield* sql<{ readonly name: string }>`
    SELECT name FROM shared_variables
    WHERE kind = 'Sensitive' AND value IS NOT NULL ORDER BY name
  `
  const [counts] = yield* sql<{ readonly retired: number; readonly builds: number }>`
    SELECT (SELECT COUNT(*) FROM retired_values) AS retired,
      (SELECT COUNT(*) FROM test_builds) AS builds
  `
  const credentials = yield* sql<{ readonly login: string }>`
    SELECT participants.login FROM claude_credentials
    JOIN participants ON participants.id = claude_credentials.participant_id
    ORDER BY participants.login
  `
  const byRepo = new Map<string, Array<string>>()
  for (const row of own) byRepo.set(row.repo, [...(byRepo.get(row.repo) ?? []), row.name])
  return {
    environments: [...byRepo].map(([repo, names]) => ({ repo, names })),
    sharedVariables: shared.map((row) => row.name),
    retiredValues: counts?.retired ?? 0,
    testBuilds: counts?.builds ?? 0,
    claudeCredentials: credentials.map((row) => row.login),
  } satisfies SecretsResetPlan
})

/** Clears what the lost key protects, in one transaction. */
const clear = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM secrets_check`
      yield* sql`UPDATE environment_variables SET value = NULL WHERE kind = 'Sensitive'`
      yield* sql`UPDATE shared_variables SET value = NULL WHERE kind = 'Sensitive'`
      yield* sql`DELETE FROM retired_values`
      yield* sql`DELETE FROM test_builds`
      yield* sql`DELETE FROM claude_credentials`
    }),
  )
})

/** How a reset ended. */
export type SecretsResetOutcome =
  /** Nothing the lost key protects is stored: a new key just works. */
  | { readonly _tag: "NothingToReset" }
  /** Not confirmed: nothing was cleared. */
  | { readonly _tag: "Kept"; readonly plan: SecretsResetPlan }
  | { readonly _tag: "Reset"; readonly plan: SecretsResetPlan }

/**
 * Resets the Sensitive values in the Hub's database at `DatabaseFile` (read from the
 * configuration: `HUB_DATABASE`, or the home's `hub.db`), migrating it first. Fails with
 * NoHubDatabase when there is none, rather than make one. Holds the database's lock throughout,
 * so it fails with HubLockRefused while a Hub runs on it. `confirm` is asked with what would be
 * cleared, and nothing is unless it answers true.
 */
export const resetSecrets = <E, R>(
  confirm: (plan: SecretsResetPlan) => Effect.Effect<boolean, E, R>,
) =>
  Effect.gen(function* () {
    const database = yield* DatabaseFile
    if (!existsSync(database)) {
      return yield* new NoHubDatabase({ message: `There is no Hub database at ${database}.` })
    }
    yield* holdHubLock(database, "The Sensitive values can't be reset")
    return yield* Effect.gen(function* () {
      const plan = yield* planOf
      if (!resetNeeded(plan)) return { _tag: "NothingToReset" } as const
      if (!(yield* confirm(plan))) return { _tag: "Kept", plan } as const
      yield* clear
      return { _tag: "Reset", plan } as const
    }).pipe(Effect.provide(databaseAt(database)))
  }).pipe(Effect.scoped)
