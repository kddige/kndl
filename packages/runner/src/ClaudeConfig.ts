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
import type { ClaudePlan, ClaudeSubscriptionType, RunnerLogin } from "@claude-hub/protocol"
import { Context, Data, Effect, FileSystem } from "effect"

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

/** Claude Code's `organizationType`s, by the plan Claude Code 2.1.289 takes each for. */
const plansByOrganization: Record<string, ClaudeSubscriptionType> = {
  claude_pro: "pro",
  claude_max: "max",
  claude_team: "team",
  claude_enterprise: "enterprise",
}

/**
 * The plan of the signed-in account, from `oauthAccount.organizationType` and
 * `organizationRateLimitTier`, which Claude Code refreshes as it starts.
 */
export function planFromClaudeConfig(config: unknown): ClaudePlan | undefined {
  const account = field(config, "oauthAccount")
  const organization = field(account, "organizationType")
  const subscriptionType =
    typeof organization === "string" && Object.hasOwn(plansByOrganization, organization)
      ? plansByOrganization[organization]
      : undefined
  if (subscriptionType === undefined) return undefined
  const tier = field(account, "organizationRateLimitTier")
  return typeof tier === "string" && tier !== ""
    ? { subscriptionType, rateLimitTier: tier }
    : { subscriptionType }
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
const rewriteAttempts = 5

/**
 * Changes Claude Code's config file at `file`, a real path: `change` returns the new config, or
 * `undefined` when the file already says what it should. Claude Code processes rewrite the file
 * often, so the read, the change and the write happen synchronously with nothing in between: the
 * new content goes to a temp file beside it (with the same mode), the file is read again to check
 * nothing changed meanwhile, and the temp file is renamed over it. The result is read back, and
 * the whole thing tried again if another write won. Says whether it had anything to change.
 */
function rewriteConfig(
  file: string,
  change: (config: Record<string, unknown>) => Record<string, unknown> | undefined,
): "Unchanged" | "Changed" {
  for (let attempt = 1; attempt <= rewriteAttempts; attempt++) {
    const text = readFileSync(file, "utf8")
    const next = change(parseConfig(text, file))
    if (next === undefined) return attempt === 1 ? "Unchanged" : "Changed"
    const temp = join(
      dirname(file),
      `.${basename(file)}.claude-hub-${process.pid}-${randomBytes(4).toString("hex")}`,
    )
    const mode = statSync(file).mode & 0o7777
    try {
      writeFileSync(temp, serialize(next, text), { mode, flag: "wx" })
      chmodSync(temp, mode)
      if (readFileSync(file, "utf8") !== text) continue
      renameSync(temp, file)
    } finally {
      rmSync(temp, { force: true })
    }
    if (change(parseConfig(readFileSync(file, "utf8"), file)) === undefined) return "Changed"
  }
  throw new Error(`another process kept rewriting it (${rewriteAttempts} attempts)`)
}

const causeMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/**
 * Marks `directory`, resolved with realpath, as trusted in Claude Code's config file:
 * `projects[<directory>].hasTrustDialogAccepted: true`. Claude Code inherits trust from parent
 * directories (spike #4), so trusting the sessions root once covers every Session under it.
 *
 * Writes only when the flag is missing, and never creates the file. See {@link rewriteConfig}
 * for how it writes without losing a Claude Code process's own write.
 */
export const trustDirectory = (configPath: string, directory: string) =>
  Effect.try({
    try: (): TrustOutcome => {
      const target = realpathSync(directory)
      if (!existsSync(configPath)) return { _tag: "NoConfigFile" }
      // Write next to the real file, so a symlinked config stays a symlink.
      const outcome = rewriteConfig(realpathSync(configPath), (config) =>
        hasTrust(config, target) ? undefined : withTrust(config, target),
      )
      return { _tag: outcome === "Unchanged" ? "AlreadyTrusted" : "Trusted", directory: target }
    },
    catch: (cause) =>
      new ClaudeConfigError({
        message: `Could not mark ${directory} as trusted in ${configPath}: ${causeMessage(cause)}`,
      }),
  })

/**
 * Removes `directories` from the `projects` of Claude Code's config file, where Claude Code keeps
 * what it remembers of each directory it ran in, as when a Session is purged. Does nothing when
 * the file or the entries are missing.
 */
export const forgetDirectories = (configPath: string, directories: ReadonlyArray<string>) =>
  Effect.try({
    try: (): void => {
      if (!existsSync(configPath)) return
      rewriteConfig(realpathSync(configPath), (config) => {
        const projects = objectOrEmpty(config.projects)
        const known = directories.filter((directory) => Object.hasOwn(projects, directory))
        if (known.length === 0) return undefined
        const kept = { ...projects }
        for (const directory of known) delete kept[directory]
        return { ...config, projects: kept }
      })
    },
    catch: (cause) =>
      new ClaudeConfigError({
        message: `Could not forget ${directories.join(", ")} in ${configPath}: ${causeMessage(cause)}`,
      }),
  })

/** Where Claude Code keeps its transcripts, one directory per working directory. */
export function claudeProjectsDir(env: Record<string, string | undefined> = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects")
}

/** {@link claudeProjectsDir} for the Runner, or a test's own. */
export const ClaudeProjectsDir = Context.Reference<string>("@claude-hub/runner/ClaudeProjectsDir", {
  defaultValue: () => claudeProjectsDir(),
})

/**
 * The name of the directory under {@link claudeProjectsDir} that holds what Claude Code keeps of
 * a working directory, given by its real path: every character but a letter or digit becomes `-`,
 * as Claude Code 2.1.287 names it. Undefined for a path over 200 characters, which Claude Code
 * shortens with a hash.
 */
export function claudeProjectDirName(cwd: string): string | undefined {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-")
  return name.length <= 200 ? name : undefined
}

/**
 * Where Claude Code on the host kept the transcript of conversation `id` begun in `cwd`, the
 * directory it ran in: `<projects>/<cwd's name>/<id>.jsonl`, looked for under `cwd` as given and
 * as its real path. Undefined when there is none, as for a conversation Claude Code never wrote
 * to, or a path too long to name the way Claude Code does. Sessions ran Claude Code on the host
 * before it moved into their Sandboxes (ADR 0013), whose first wake copies it from here.
 */
export function hostTranscriptPath(
  cwd: string,
  id: string,
  projectsDir: string = claudeProjectsDir(),
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  let real = cwd
  try {
    real = realpathSync(cwd)
  } catch {
    // It doesn't exist (any more): the path as given is all there is.
  }
  for (const name of new Set([cwd, real].map(claudeProjectDirName))) {
    if (name === undefined) continue
    const path = join(projectsDir, name, `${id}.jsonl`)
    if (exists(path)) return path
  }
  return undefined
}

function parseConfig(text: string, path: string): Record<string, unknown> {
  const config = JSON.parse(text) as unknown
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`${path} does not hold a JSON object`)
  }
  return config as Record<string, unknown>
}

/** Whether `directory` (already resolved with realpath) is marked trusted in the config. */
export function hasTrust(config: unknown, directory: string): boolean {
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
