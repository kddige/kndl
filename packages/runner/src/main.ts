// The Runner: a host machine connected to the Hub that runs Sessions on its own Runner login.
// For now it only reads its configuration, logs it and waits.
//
// Env: HUB_URL (http://127.0.0.1:7777), RUNNER_NAME (this machine's hostname).

import { hostname } from "node:os"
import { BunRuntime } from "@effect/platform-bun"
import { Config, Effect, Layer } from "effect"

const RunnerConfig = Config.all({
  hubUrl: Config.URL("HUB_URL").pipe(Config.withDefault(new URL("http://127.0.0.1:7777"))),
  name: Config.String("RUNNER_NAME").pipe(Config.withDefault(hostname().split(".")[0] ?? "runner")),
})

const RunnerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const { hubUrl, name } = yield* RunnerConfig
    yield* Effect.logInfo(`Runner ${name} started; Hub at ${hubUrl.href}`)
    yield* Effect.addFinalizer(() => Effect.logInfo(`Runner ${name} stopped`))
  }),
)

BunRuntime.runMain(Layer.launch(RunnerLive))
