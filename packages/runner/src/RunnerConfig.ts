import { existsSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { join, resolve } from "node:path"
import { Config, Context, Effect, Layer, type Redacted } from "effect"

/** What a Runner is configured with. Read from the environment by {@link RunnerConfigLive}. */
export interface RunnerSettings {
  /** The Hub's base URL; the Runner connects to `/ws/runner` on it over WebSocket. */
  readonly hubUrl: URL
  /** This Runner's name, as the UI shows it. */
  readonly name: string
  /** The Runner token the Hub issued, sent as `Authorization: Bearer` on the WebSocket upgrade. */
  readonly token: Redacted.Redacted<string>
  /** How the Runner login is shown; read from Claude Code's config when unset. */
  readonly login: string | undefined
  /**
   * The directory holding one directory per Session. Claude Code inherits workspace trust from
   * parent directories, so trusting this one once covers every Session under it (spike #4).
   */
  readonly sessionsRoot: string
  /** The `hub-link` mod, loaded into each Session's Claude Code with `--plugin-dir`. */
  readonly modDir: string
  /** The Claude Code executable. */
  readonly claudeBin: string
  /** The tmux server (`tmux -L <name>`) that holds the Sessions, kept apart from the user's own. */
  readonly tmuxSocket: string
  /** Where a Repo is cloned from: `{repo}` is replaced with its `owner/name`. */
  readonly repoUrlTemplate: string
}

export class RunnerConfig extends Context.Service<RunnerConfig, RunnerSettings>()(
  "@claude-hub/runner/RunnerConfig",
) {}

/** The environment variable that carries the Runner token; never passed on to tmux or Claude Code. */
export const RunnerTokenVariable = "RUNNER_TOKEN"

/**
 * Reads the configuration from the environment:
 *
 * | Variable | Default |
 * |---|---|
 * | `HUB_URL` | `http://127.0.0.1:7777` |
 * | `RUNNER_TOKEN` | required |
 * | `RUNNER_NAME` | the short hostname |
 * | `RUNNER_LOGIN` | `oauthAccount.emailAddress` from Claude Code's `.claude.json` |
 * | `RUNNER_SESSIONS_ROOT` | `~/.claude-hub/sessions` |
 * | `RUNNER_MOD_DIR` | `packages/mod` in this checkout |
 * | `CLAUDE_BIN` | `claude` |
 * | `RUNNER_TMUX_SOCKET` | `claude-hub` |
 * | `RUNNER_REPO_URL` | `https://github.com/{repo}.git` |
 */
export const RunnerConfigLive = Layer.effect(
  RunnerConfig,
  Effect.gen(function* () {
    const settings = yield* Config.all({
      hubUrl: Config.URL("HUB_URL").pipe(Config.withDefault(new URL("http://127.0.0.1:7777"))),
      name: Config.String("RUNNER_NAME").pipe(
        Config.withDefault(hostname().split(".")[0] ?? "runner"),
      ),
      token: Config.Redacted(RunnerTokenVariable),
      login: Config.option(Config.NonEmptyString("RUNNER_LOGIN")),
      sessionsRoot: Config.String("RUNNER_SESSIONS_ROOT").pipe(
        Config.withDefault(join(homedir(), ".claude-hub", "sessions")),
      ),
      modDir: Config.String("RUNNER_MOD_DIR").pipe(
        Config.withDefault(resolve(import.meta.dir, "../../mod")),
      ),
      claudeBin: Config.String("CLAUDE_BIN").pipe(Config.withDefault("claude")),
      tmuxSocket: Config.String("RUNNER_TMUX_SOCKET").pipe(Config.withDefault("claude-hub")),
      repoUrlTemplate: Config.String("RUNNER_REPO_URL").pipe(
        Config.withDefault("https://github.com/{repo}.git"),
      ),
    })
    const modDir = resolve(settings.modDir)
    // A mod that doesn't load answers no tool call, and Claude Code would run its tools on the
    // host: refuse to run without the built bundle.
    if (!existsSync(join(modDir, ModBundle))) {
      return yield* Effect.die(
        new Error(
          `The hub-link mod isn't built: ${join(modDir, ModBundle)} is missing. Run \`bun run mod:build\`.`,
        ),
      )
    }
    return RunnerConfig.of({
      ...settings,
      login: settings.login._tag === "Some" ? settings.login.value : undefined,
      sessionsRoot: resolve(settings.sessionsRoot),
      modDir,
    })
  }),
)

/** The hub-link mod's bundle, which `bun run mod:build` writes; the mod doesn't load without it. */
export const ModBundle = "hooks/hub-link-lib.js"

/** The Hub's WebSocket endpoint for Runners: `/ws/runner`, over `ws:` or `wss:`. */
export function runnerSocketUrl(hubUrl: URL): string {
  const url = new URL("/ws/runner", hubUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.href
}
