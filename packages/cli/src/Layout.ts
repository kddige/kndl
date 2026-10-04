// Where an installed claude-hub keeps everything: its home (`CLAUDE_HUB_HOME`, by default
// `~/.claude-hub`) and the few files outside it (the wrapper on PATH, the service files). The CLI
// always manages an installed home, even run from a checkout: a checkout's own dev home
// (`~/.claude-hub-dev`) is for `bun run hub` and `bun run runner`, which the CLI never touches.
import { homedir } from "node:os"
import { join } from "node:path"
import { type Home, HomeVariable, homeAt } from "@claude-hub/protocol/home"

/** What a machine runs: a Hub, a Runner, or both. */
export type Role = "hub" | "runner"

export const Roles: ReadonlyArray<Role> = ["hub", "runner"]

/** The home's paths, and the files the CLI writes outside it. */
export interface Layout {
  readonly home: Home
  /** The checkout the services and the wrapper run: `<home>/app`. */
  readonly app: string
  /** `<home>/hub.env`, `<home>/runner.env`: each 0600, with the variables the Hub and Runner read. */
  readonly envFile: (role: Role) => string
  readonly hubDb: string
  readonly sessions: string
  readonly claudeCode: string
  readonly logs: string
  /** `<home>/logs/hub.log`, `<home>/logs/runner.log`: the service's stdout and stderr. */
  readonly logFile: (role: Role) => string
  /** The Hub's or Runner's entry point in the checkout. */
  readonly entryPoint: (role: Role) => string
  /** The CLI's own entry point in the checkout, which the wrapper runs. */
  readonly cli: string
  /** The `claude-hub` wrapper install.sh writes: `~/.local/bin/claude-hub`. */
  readonly wrapper: string
  /** The user's home directory, which a home must never be. */
  readonly userHome: string
}

/** The home's own entries, as onboard and the services make them. A home holds at least one. */
export const HomeEntries = [
  "app",
  "hub.env",
  "runner.env",
  "hub.db",
  // The running Hub's lock on hub.db (the Hub's HubLock.ts); it stays when the Hub stops.
  "hub.db.lock",
  "sessions",
  "claude-code",
  "logs",
] as const

/**
 * The installed home: the one `CLAUDE_HUB_HOME` names, or else `~/.claude-hub`. Unlike the Hub and
 * Runner, the CLI never falls back to the dev home.
 */
export function resolveLayout(
  env: Record<string, string | undefined> = process.env,
  userHome: string = homedir(),
): Layout {
  const home = homeAt(env[HomeVariable] || join(userHome, ".claude-hub"))
  const app = join(home.dir, "app")
  return {
    home,
    app,
    envFile: (role) => join(home.dir, `${role}.env`),
    hubDb: join(home.dir, "hub.db"),
    sessions: join(home.dir, "sessions"),
    claudeCode: join(home.dir, "claude-code"),
    logs: join(home.dir, "logs"),
    logFile: (role) => join(home.dir, "logs", `${role}.log`),
    entryPoint: (role) => join(app, "packages", role, "src", "main.ts"),
    cli: join(app, "packages", "cli", "src", "main.ts"),
    wrapper: join(userHome, ".local", "bin", "claude-hub"),
    userHome,
  }
}

/** Shell-quotes a word for sh: single quotes, with any single quote closed and escaped. */
export function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`
}

/**
 * The `claude-hub` wrapper: runs the installed checkout's CLI with this Bun, in this home unless
 * `CLAUDE_HUB_HOME` names another. install.sh writes the same script; `doctor --fix` rewrites it.
 */
export function wrapperScript(layout: Layout, bun: string): string {
  return [
    "#!/bin/sh",
    "# claude-hub: written by install.sh. Runs the CLI from the installed checkout.",
    `: "\${CLAUDE_HUB_HOME:=${layout.home.dir}}"`,
    "export CLAUDE_HUB_HOME",
    `exec ${shellQuote(bun)} ${WrapperArgs}`,
    "",
  ].join("\n")
}

const WrapperArgs = `"$CLAUDE_HUB_HOME/app/packages/cli/src/main.ts" "$@"`

/**
 * Whether `text` is the wrapper for this home, whichever Bun it runs: install.sh writes the Bun it
 * found on PATH, the CLI the one running it.
 */
export function isWrapperFor(text: string, layout: Layout): boolean {
  const lines = text.split("\n")
  const expected = wrapperScript(layout, "bun").split("\n")
  return (
    lines.length === expected.length &&
    lines.every((line, i) =>
      expected[i]?.startsWith("exec ")
        ? line.startsWith("exec ") && line.endsWith(` ${WrapperArgs}`)
        : line === expected[i],
    )
  )
}
