import { HomeConfig } from "@kndl/protocol/home"
import { Config, Context, Effect, Layer, Option } from "effect"

/** How the Runner's mod relay is set up. */
export interface RelaySettings {
  /** The port the relay listens on, on the host's loopback. */
  readonly port: number
}

export class RelayConfig extends Context.Service<RelayConfig, RelaySettings>()(
  "@kndl/runner/RelayConfig",
) {}

/** The relay's port in an installed home, and in a checkout's dev home, so both can run. */
export const DefaultRelayPort = { installed: 7778, dev: 7779 } as const

/**
 * Reads the relay's settings from the environment, beside RunnerConfigLive.
 *
 * | Variable | Default |
 * |---|---|
 * | `RUNNER_RELAY_PORT` | `RUNNER_PROXY_PORT`, its name from when it was the credential proxy; else `7778`, or `7779` in the dev home |
 *
 * `RUNNER_CLAUDE_CREDENTIAL`, `RUNNER_CLAUDE_PLAN` and `RUNNER_CLAUDE_RATE_LIMIT_TIER`, from when
 * a Runner had a Claude credential of its own (ADR 0026), are no longer read.
 */
export const RelayConfigLive = Layer.effect(
  RelayConfig,
  Effect.gen(function* () {
    const home = yield* HomeConfig
    const settings = yield* Config.all({
      relay: Config.option(Config.Port("RUNNER_RELAY_PORT")),
      proxy: Config.option(Config.Port("RUNNER_PROXY_PORT")),
    })
    const port = Option.getOrElse(
      Option.orElse(settings.relay, () => settings.proxy),
      () => (home.dev ? DefaultRelayPort.dev : DefaultRelayPort.installed),
    )
    return RelayConfig.of({ port })
  }),
)
