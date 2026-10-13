import { existsSync } from "node:fs"
import { hostname } from "node:os"
import { join, resolve } from "node:path"
import { runnerTunnelPath, type TunnelId } from "@kndl/protocol"
import { HomeConfig } from "@kndl/protocol/home"
import { Config, Context, Effect, Layer, type Redacted } from "effect"
import { modPlugins } from "./sandbox/SessionLayout.ts"

/** What a Runner is configured with. Read from the environment by {@link RunnerConfigLive}. */
export interface RunnerSettings {
  /** The Hub's base URL; the Runner connects to `/ws/runner` on it over WebSocket. */
  readonly hubUrl: URL
  /** This Runner's name, as the UI shows it. */
  readonly name: string
  /** The Runner token the Hub issued, sent as `Authorization: Bearer` on the WebSocket upgrade. */
  readonly token: Redacted.Redacted<string>
  /** The directory holding one directory per Session, with its Workspace. */
  readonly sessionsRoot: string
  /**
   * The mod package, whose plugins each Session's Claude Code loads with `--plugin-dir`, from a
   * copy made as it starts (SessionMod.ts).
   */
  readonly modDir: string
  /** The tmux server (`tmux -L <name>`) that holds the Sessions, kept apart from the user's own. */
  readonly tmuxSocket: string
  /** Where a Repo is cloned from: `{repo}` is replaced with its `owner/name`. */
  readonly repoUrlTemplate: string
}

export class RunnerConfig extends Context.Service<RunnerConfig, RunnerSettings>()(
  "@kndl/runner/RunnerConfig",
) {}

/** The environment variable that carries the Runner token; never passed on to tmux or Claude Code. */
export const RunnerTokenVariable = "RUNNER_TOKEN"

/**
 * Reads the configuration from the environment. The sessions root and the tmux socket default to
 * the home's (see `@kndl/protocol/home`): from a checkout, the dev home `~/.kndl-dev`,
 * unless `KNDL_HOME` names another.
 *
 * | Variable | Default |
 * |---|---|
 * | `HUB_URL` | `http://127.0.0.1:7777` |
 * | `RUNNER_TOKEN` | required |
 * | `RUNNER_NAME` | the short hostname |
 * | `RUNNER_SESSIONS_ROOT` | `sessions` in the home: `~/.kndl-dev/sessions` |
 * | `RUNNER_MOD_DIR` | `packages/mod` in this checkout |
 * | `RUNNER_TMUX_SOCKET` | the home's: `kndl-dev` |
 * | `RUNNER_REPO_URL` | `https://github.com/{repo}.git` |
 *
 * The mod relay's port, `RUNNER_RELAY_PORT`, is read by RelayConfigLive (relay/RelayConfig.ts).
 */
export const RunnerConfigLive = Layer.effect(
  RunnerConfig,
  Effect.gen(function* () {
    const home = yield* HomeConfig
    const settings = yield* Config.all({
      hubUrl: Config.URL("HUB_URL").pipe(Config.withDefault(new URL("http://127.0.0.1:7777"))),
      name: Config.String("RUNNER_NAME").pipe(
        Config.withDefault(hostname().split(".")[0] ?? "runner"),
      ),
      token: Config.Redacted(RunnerTokenVariable),
      sessionsRoot: Config.String("RUNNER_SESSIONS_ROOT").pipe(
        Config.withDefault(join(home.dir, "sessions")),
      ),
      modDir: Config.String("RUNNER_MOD_DIR").pipe(
        Config.withDefault(resolve(import.meta.dir, "../../mod")),
      ),
      tmuxSocket: Config.String("RUNNER_TMUX_SOCKET").pipe(Config.withDefault(home.tmuxSocket)),
      repoUrlTemplate: Config.String("RUNNER_REPO_URL").pipe(
        Config.withDefault("https://github.com/{repo}.git"),
      ),
    })
    const modDir = resolve(settings.modDir)
    // Without the mod a Session is never linked to the Hub: refuse to run without the built
    // bundles.
    const missing = missingModBundle(modDir)
    if (missing !== undefined) {
      return yield* Effect.die(
        new Error(
          `The hub-link mod isn't built: ${missing} is missing. Run \`bun run mod:build\`.`,
        ),
      )
    }
    return RunnerConfig.of({
      ...settings,
      sessionsRoot: resolve(settings.sessionsRoot),
      modDir,
    })
  }),
)

/** Each of the mod's plugins' bundle, which `bun run mod:build` writes; none loads without it. */
export const ModBundles = modPlugins.map((plugin) => `plugins/${plugin}/hooks/hub-link-lib.js`)

/** The first of the mod's bundles missing under `modDir`, if any. */
export const missingModBundle = (modDir: string) =>
  ModBundles.map((bundle) => join(modDir, bundle)).find((path) => !existsSync(path))

/** The Hub's WebSocket endpoint for Runners: `/ws/runner`, over `ws:` or `wss:`. */
/** Where the Runner asks whether the Hub has it connected, and still takes its token. */
export function runnerConnectionUrl(hubUrl: URL): string {
  return new URL("/runner/connection", hubUrl).href
}

export function runnerSocketUrl(hubUrl: URL): string {
  const url = new URL("/ws/runner", hubUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.href
}

/** Where the Runner dials back for a tunnel the Hub asked it to open (#177). */
export function runnerTunnelUrl(hubUrl: URL, tunnelId: TunnelId): string {
  const url = new URL(runnerTunnelPath(tunnelId), hubUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.href
}
