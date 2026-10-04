// Where a Hub or Runner keeps its state on this machine: its home. Which home a process uses is
// decided here and nowhere else, for the Hub, the Runner and the claude-hub CLI to come.
//
// Imported as `@claude-hub/protocol/home`, not from the package's index: it reads the host's home
// directory, which the web UI and the mod's bundle have no use for.
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { Config, Option } from "effect"

/**
 * Names the home. Unset, as when the Hub and Runner run from a checkout (`bun run hub`,
 * `bun run runner`, ...), a process uses {@link devHome}. The claude-hub CLI sets it for the
 * processes it installs: `~/.claude-hub`, unless `CLAUDE_HUB_HOME` names another.
 */
export const HomeVariable = "CLAUDE_HUB_HOME"

/** A home: the directory a Hub or Runner keeps its state in, and the Runner's tmux server. */
export interface Home {
  /** Holds a Runner's `sessions/` and `claude-code/`, and, outside a checkout, the Hub's `hub.db`. */
  readonly dir: string
  /** The tmux server (`tmux -L <name>`) a Runner keeps its Sessions on. */
  readonly tmuxSocket: string
  /** Whether this is a checkout's dev home, rather than one `CLAUDE_HUB_HOME` names. */
  readonly dev: boolean
}

/**
 * A checkout's home: `~/.claude-hub-dev`, with tmux socket `claude-hub-dev`. It is kept apart from
 * an installed claude-hub's `~/.claude-hub` and socket `claude-hub`, so a dev Runner never
 * re-adopts an installed Runner's Sessions or reconciles its Sandboxes: the Runner mark is a digest
 * of the socket and the sessions root.
 */
export const devHome: Home = {
  dir: join(homedir(), ".claude-hub-dev"),
  tmuxSocket: "claude-hub-dev",
  dev: true,
}

/** The home at `dir`, as `CLAUDE_HUB_HOME` names it, with tmux socket `claude-hub`. */
export const homeAt = (dir: string): Home => ({
  dir: resolve(dir),
  tmuxSocket: "claude-hub",
  dev: false,
})

/**
 * The home this process uses: the one `CLAUDE_HUB_HOME` names, or else {@link devHome}. A setting
 * that names one of its paths (`RUNNER_SESSIONS_ROOT`, `RUNNER_TMUX_SOCKET`, ...) still wins.
 */
export const HomeConfig: Config.Config<Home> = Config.option(
  Config.NonEmptyString(HomeVariable),
).pipe(Config.map(Option.match({ onNone: () => devHome, onSome: homeAt })))
