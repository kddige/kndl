// The Hub: the central server people sign in to. It knows every Session, Runner and
// Participant, and relays prompts and events between them.
//
// `bun src/main.ts` serves the Hub; `bun src/main.ts runner-token <name>` issues a Runner's
// token and prints it. Configuration is read from the environment: see HubConfig.ts and
// Database.ts, and the README.

import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Layer, Option } from "effect"
import { HttpRouter } from "effect/http"
import { DatabaseLive } from "./Database.ts"
import { GitHub } from "./GitHub.ts"
import { HubRoutes, HubServices, idleTimeoutSeconds } from "./Hub.ts"
import { HubConfig } from "./HubConfig.ts"
import { drainFirst } from "./HubShutdown.ts"
import { RunnerTokens } from "./RunnerTokens.ts"

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
    if (Option.isSome(config.devLogin)) {
      yield* Effect.logWarning(
        `Dev login is on (CLAUDE_HUB_DEV_LOGIN): anyone reaching ${config.publicUrl.origin} can sign in without GitHub.`,
      )
    }
  }),
)

const HubLive = drainFirst(HttpRouter.serve(HubRoutes)).pipe(
  Layer.provide(announceSignIn),
  Layer.provide(ServerLive),
  Layer.provide(GitHub.layer),
  Layer.provide(HubServices),
  Layer.provide(DatabaseLive),
  Layer.provide(HubConfig.layer),
)

/** Issues a token for the Runner of this name (rotating any earlier one) and prints it. */
const issueRunnerToken = (name: string) =>
  Effect.gen(function* () {
    const issued = yield* (yield* RunnerTokens).issue(name)
    yield* Console.log(
      [
        `Runner ${issued.name} (${issued.runnerId}). Its token, shown only now:`,
        "",
        `  ${issued.token}`,
        "",
        "Any earlier token for this Runner no longer works. Give the token to the Runner as RUNNER_TOKEN.",
      ].join("\n"),
    )
  }).pipe(Effect.provide(RunnerTokens.layer.pipe(Layer.provideMerge(DatabaseLive))))

const [command, ...args] = process.argv.slice(2)
if (command === undefined) {
  BunRuntime.runMain(Layer.launch(HubLive))
} else if (command === "runner-token" && args.length === 1 && args[0]) {
  BunRuntime.runMain(issueRunnerToken(args[0]))
} else {
  console.error("Usage: bun src/main.ts [runner-token <name>]")
  process.exit(2)
}
