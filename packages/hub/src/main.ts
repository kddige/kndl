// The Hub: the central server people sign in to. It knows every Session, Runner and
// Participant, and relays prompts and events between them.
//
// `bun src/main.ts` serves the Hub; `bun src/main.ts runner-token <name>` issues a Runner's
// token and prints it; `bun src/main.ts secrets-key` prints a new HUB_SECRETS_KEY (both in
// Admin.ts, which the claude-hub CLI shares). Configuration is read from the environment: see
// HubConfig.ts and Database.ts.

import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Layer, Option } from "effect"
import { HttpRouter } from "effect/http"
import { issueRunnerToken, runnerTokenNotice, secretsKeyNotice } from "./Admin.ts"
import { DatabaseLive } from "./Database.ts"
import { GitHub } from "./GitHub.ts"
import { GitHubApp } from "./GitHubApp.ts"
import { HubRoutes, HubServices, idleTimeoutSeconds } from "./Hub.ts"
import { HubConfig } from "./HubConfig.ts"
import { drainFirst } from "./HubShutdown.ts"
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
        "The GitHub App is not configured (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH): Runners use their host's own git credentials, and the pull request tools are off.",
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

const HubLive = drainFirst(HttpRouter.serve(HubRoutes)).pipe(
  Layer.provide(announceSignIn),
  Layer.provide(announceWebUi),
  Layer.provide(ServerLive),
  Layer.provide(GitHub.layer),
  Layer.provide(HubServices),
  Layer.provide(GitHubApp.layer),
  Layer.provide(DatabaseLive),
  Layer.provide(HubConfig.layer),
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
} else {
  console.error("Usage: bun src/main.ts [runner-token <name> | secrets-key]")
  process.exit(2)
}
