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
import { Data, Effect } from "effect"

// What the Runner reads of Claude Code's state on its host, when there is any; none of it is
// needed: what Claude Code kept of Sessions from before they ran in Sandboxes (ADR 0013), to
// carry over or forget.

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
      `.${basename(file)}.kndl-${process.pid}-${randomBytes(4).toString("hex")}`,
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

function parseConfig(text: string, path: string): Record<string, unknown> {
  const config = JSON.parse(text) as unknown
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`${path} does not hold a JSON object`)
  }
  return config as Record<string, unknown>
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
