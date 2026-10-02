import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { RunnerLogin } from "@claude-hub/protocol"
import { Data, Effect, FileSystem } from "effect"

// What the Runner reads from Claude Code's own config file, `.claude.json`: the account signed in
// (the Runner login, ADR 0002) and which directories are trusted. It only reads it.

export class RunnerLoginUnknown extends Data.TaggedError("RunnerLoginUnknown")<{
  readonly message: string
}> {}

/** Claude Code's config file: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`. */
export function claudeConfigPath(env: Record<string, string | undefined> = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json")
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
 * Whether Claude Code would start in `directory` without asking to trust it: trust is inherited
 * from parent directories, so any ancestor with `hasTrustDialogAccepted` counts (spike #4).
 */
export function isTrusted(config: unknown, directory: string): boolean {
  const projects = field(config, "projects")
  for (let current = directory; ; current = dirname(current)) {
    if (field(field(projects, current), "hasTrustDialogAccepted") === true) return true
    if (dirname(current) === current) return false
  }
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

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined
}
