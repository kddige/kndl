import { randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import type { RunnerLogin } from "@claude-hub/protocol"
import { Data, Effect, FileSystem } from "effect"

// Claude Code's own config file, `.claude.json`: the Runner reads the account signed in from it
// (the Runner login, ADR 0002), and marks the sessions root as trusted in it, so no Session stops
// at the folder-trust dialog.

export class RunnerLoginUnknown extends Data.TaggedError("RunnerLoginUnknown")<{
  readonly message: string
}> {}

export class ClaudeConfigError extends Data.TaggedError("ClaudeConfigError")<{
  readonly message: string
}> {}

/**
 * Where Claude Code keeps its config file, found the way Claude Code 2.1.287 finds it: a legacy
 * `.config.json` in its config directory (`$CLAUDE_CONFIG_DIR`, else `~/.claude`) wins when it
 * exists; otherwise `.claude.json` in `$CLAUDE_CONFIG_DIR`, else in the home directory. A custom
 * OAuth URL gives the file a `-custom-oauth` suffix.
 */
export function claudeConfigPath(
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = existsSync,
): string {
  const configDir = env.CLAUDE_CONFIG_DIR || undefined
  const legacy = join(configDir ?? join(homedir(), ".claude"), ".config.json")
  if (exists(legacy)) return legacy
  const suffix = env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? "-custom-oauth" : ""
  return join(configDir ?? homedir(), `.claude${suffix}.json`)
}

/** The parsed config file, or `undefined` when it is missing or not JSON. */
export const readClaudeConfig = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(path)
    return JSON.parse(text) as unknown
  }).pipe(Effect.orElseSucceed(() => undefined))

/** The signed-in account's email address, from `oauthAccount.emailAddress`. */
export function loginFromClaudeConfig(config: unknown): RunnerLogin | undefined {
  const account = field(field(config, "oauthAccount"), "emailAddress")
  return typeof account === "string" && account.length > 0 ? { account } : undefined
}

/**
 * The Runner login: `configured` (from `RUNNER_LOGIN`) when set, else the account in Claude
 * Code's config file.
 */
export const resolveRunnerLogin = (configured: string | undefined, configPath: string) =>
  configured !== undefined
    ? Effect.succeed<RunnerLogin>({ account: configured })
    : readClaudeConfig(configPath).pipe(
        Effect.flatMap((config) => {
          const login = loginFromClaudeConfig(config)
          return login !== undefined
            ? Effect.succeed(login)
            : Effect.fail(
                new RunnerLoginUnknown({
                  message: `No Claude account is signed in according to ${configPath}. Run \`claude\` and sign in, or set RUNNER_LOGIN.`,
                }),
              )
        }),
      )

/**
 * What {@link trustDirectory} did: wrote the flag, found it already set, or found no config file
 * to write it to.
 */
export type TrustOutcome =
  | { readonly _tag: "Trusted"; readonly directory: string }
  | { readonly _tag: "AlreadyTrusted"; readonly directory: string }
  | { readonly _tag: "NoConfigFile" }

/** How often a write lost to a Claude Code process rewriting the file is tried again. */
const trustAttempts = 5

/**
 * Marks `directory`, resolved with realpath, as trusted in Claude Code's config file:
 * `projects[<directory>].hasTrustDialogAccepted: true`. Claude Code inherits trust from parent
 * directories (spike #4), so trusting the sessions root once covers every Session under it.
 *
 * Writes only when the flag is missing, and never creates the file. Claude Code processes
 * rewrite the file often, so the read, the change and the write happen synchronously with
 * nothing in between: the new content goes to a temp file beside it (with the same mode), the
 * file is read again to check nothing changed meanwhile, and the temp file is renamed over it.
 * The result is read back, and the whole thing tried again if another write won.
 */
export const trustDirectory = (configPath: string, directory: string) =>
  Effect.try({
    try: (): TrustOutcome => {
      const target = realpathSync(directory)
      if (!existsSync(configPath)) return { _tag: "NoConfigFile" }
      // Write next to the real file, so a symlinked config stays a symlink.
      const file = realpathSync(configPath)
      for (let attempt = 1; attempt <= trustAttempts; attempt++) {
        const text = readFileSync(file, "utf8")
        const config = parseConfig(text, file)
        if (hasTrust(config, target)) {
          return attempt === 1
            ? { _tag: "AlreadyTrusted", directory: target }
            : { _tag: "Trusted", directory: target }
        }
        const temp = join(
          dirname(file),
          `.${basename(file)}.claude-hub-${process.pid}-${randomBytes(4).toString("hex")}`,
        )
        const mode = statSync(file).mode & 0o7777
        try {
          writeFileSync(temp, serialize(withTrust(config, target), text), { mode, flag: "wx" })
          chmodSync(temp, mode)
          if (readFileSync(file, "utf8") !== text) continue
          renameSync(temp, file)
        } finally {
          rmSync(temp, { force: true })
        }
        if (hasTrust(parseConfig(readFileSync(file, "utf8"), file), target)) {
          return { _tag: "Trusted", directory: target }
        }
      }
      throw new Error(`another process kept rewriting it (${trustAttempts} attempts)`)
    },
    catch: (cause) =>
      new ClaudeConfigError({
        message: `Could not mark ${directory} as trusted in ${configPath}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      }),
  })

function parseConfig(text: string, path: string): Record<string, unknown> {
  const config = JSON.parse(text) as unknown
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`${path} does not hold a JSON object`)
  }
  return config as Record<string, unknown>
}

function hasTrust(config: unknown, directory: string): boolean {
  return field(field(field(config, "projects"), directory), "hasTrustDialogAccepted") === true
}

function withTrust(config: Record<string, unknown>, directory: string): Record<string, unknown> {
  const projects = objectOrEmpty(config.projects)
  return {
    ...config,
    projects: {
      ...projects,
      [directory]: { ...objectOrEmpty(projects[directory]), hasTrustDialogAccepted: true },
    },
  }
}

/** JSON indented the way Claude Code writes it, keeping a trailing newline if there was one. */
function serialize(config: unknown, original: string): string {
  return JSON.stringify(config, null, 2) + (original.endsWith("\n") ? "\n" : "")
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined
}
