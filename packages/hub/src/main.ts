// The Hub: the central server people sign in to. It knows every Session, Runner and
// Participant, and relays prompts and events between them.
//
// `bun src/main.ts` serves the Hub; `bun src/main.ts runner-token <name>` issues a Runner's
// token and prints it; `bun src/main.ts secrets-key` prints a new HUB_SECRETS_KEY (both in
// Admin.ts); `bun src/main.ts secrets-reset [--yes]` clears the Sensitive values a lost key
// encrypted (SecretsReset.ts). The claude-hub CLI shares all three. Configuration is read from
// the environment: see HubConfig.ts and Database.ts.

import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Layer, Option } from "effect"
import { HttpRouter } from "effect/http"
import { issueRunnerToken, runnerTokenNotice, secretsKeyNotice } from "./Admin.ts"
import { ClaudeCheck } from "./ClaudeCredentials.ts"
import { CliBuilds } from "./CliBuilds.ts"
import { DatabaseFile, DatabaseLive } from "./Database.ts"
import { GitHub } from "./GitHub.ts"
import { GitHubApp } from "./GitHubApp.ts"
import { HubRoutes, HubServices, idleTimeoutSeconds } from "./Hub.ts"
import { HubConfig } from "./HubConfig.ts"
import { holdHubLock } from "./HubLock.ts"
import { drainFirst } from "./HubShutdown.ts"
import { announceHubVersion, HubVersion } from "./HubVersion.ts"
import {
  resetSecrets,
  type SecretsResetPlan,
  secretsResetDoneText,
  secretsResetPlanText,
} from "./SecretsReset.ts"
import { announceWebUi } from "./WebUi.ts"

const ServerLive = Layer.unwrap(
  Effect.map(HubConfig, ({ host, port }) =>
    BunHttpServer.layer({ hostname: host, port, idleTimeout: idleTimeoutSeconds }),
  ),
)

const announceSignIn = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* HubConfig
    if (Option.isNone(config.github)) {
      yield* Effect.logWarning(
        "GitHub sign-in is off: GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are not set.",
      )
    }
    if (Option.isNone(config.githubApp)) {
      yield* Effect.logWarning(
        "The GitHub App is not configured (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH): Runners use their host's own git credentials, Sandboxes get no GitHub token so Claude can't push or open pull requests, and people signed in with GitHub can't see any Session. Run `claude-hub onboard --github-app create` to set one up.",
      )
    }
    if (Option.isNone(config.secretsKey)) {
      yield* Effect.logWarning(
        "HUB_SECRETS_KEY is not set: Environments can't hold Sensitive values. Run `bun run secrets-key` to make one.",
      )
    }
    if (Option.isSome(config.cookieWarning)) {
      yield* Effect.logWarning(config.cookieWarning.value)
    }
    if (Option.isSome(config.devLogin)) {
      yield* Effect.logWarning(
        `Dev login is on (CLAUDE_HUB_DEV_LOGIN): anyone reaching ${config.publicUrl.origin} can sign in without GitHub.`,
      )
    }
  }),
)

/**
 * The database, held by this Hub until it stops (HubLock.ts): a second Hub on it, or a
 * `secrets-reset`, is refused meanwhile. The lock is taken before the database is opened.
 */
const HeldDatabase = DatabaseLive.pipe(
  Layer.provide(
    Layer.effectDiscard(
      Effect.flatMap(DatabaseFile, (database) => holdHubLock(database, "The Hub can't start")),
    ),
  ),
)

const HubLive = drainFirst(HttpRouter.serve(HubRoutes)).pipe(
  Layer.provide(announceSignIn),
  Layer.provide(announceWebUi),
  Layer.provide(announceHubVersion),
  Layer.provide(ServerLive),
  Layer.provide(GitHub.layer),
  Layer.provide(HubServices),
  Layer.provide(ClaudeCheck.layer),
  Layer.provide(GitHubApp.layer),
  Layer.provide(CliBuilds.layer),
  Layer.provide(HubVersion.layer),
  Layer.provide(HeldDatabase),
  Layer.provide(HubConfig.layer),
)

/** A refusal, said without a stack trace, failing the command. */
const refused = (message: string) =>
  Effect.andThen(
    Console.error(message),
    Effect.sync(() => (process.exitCode = 1)),
  )

/** Says what the reset clears and asks, in a terminal, unless `yes`; without one it needs `yes`. */
const confirmReset = (yes: boolean) => (plan: SecretsResetPlan) =>
  Effect.sync(() => {
    console.log(secretsResetPlanText(plan))
    if (yes) return true
    if (process.stdin.isTTY !== true) {
      console.error("Pass --yes to reset without a terminal.")
      return false
    }
    return prompt("Type yes to clear them:")?.trim() === "yes"
  })

/** `secrets-reset [--yes]`, in SecretsReset.ts. */
const secretsReset = (yes: boolean) =>
  Effect.gen(function* () {
    const outcome = yield* resetSecrets(confirmReset(yes))
    if (outcome._tag === "NothingToReset") {
      yield* Console.log(
        "Nothing to reset: the Hub stores no Sensitive values, so a new key works as it is. Make one with `bun run secrets-key`.",
      )
    } else if (outcome._tag === "Kept") {
      yield* Console.log("Nothing was cleared.")
      process.exitCode = 1
    } else {
      yield* Console.log(secretsResetDoneText(outcome.plan, "`bun run secrets-key`"))
    }
  }).pipe(
    Effect.catchTags({
      HubLockRefused: (error) => refused(error.message),
      NoHubDatabase: (error) => refused(error.message),
    }),
  )

const [command, ...args] = process.argv.slice(2)
if (command === undefined) {
  BunRuntime.runMain(Layer.launch(HubLive))
} else if (command === "runner-token" && args.length === 1 && args[0]) {
  BunRuntime.runMain(
    Effect.flatMap(issueRunnerToken(args[0]), (issued) => Console.log(runnerTokenNotice(issued))),
  )
} else if (command === "secrets-key" && args.length === 0) {
  console.log(secretsKeyNotice("packages/hub/.env.local"))
} else if (command === "secrets-reset" && args.every((arg) => arg === "--yes")) {
  BunRuntime.runMain(secretsReset(args.length > 0))
} else {
  console.error(
    "Usage: bun src/main.ts [runner-token <name> | secrets-key | secrets-reset [--yes]]",
  )
  process.exit(2)
}
