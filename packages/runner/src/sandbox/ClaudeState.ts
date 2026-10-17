// Claude Code's state in a Session's Sandbox (ADR 0013): its `CLAUDE_CONFIG_DIR`, on the
// Session's `claude` volume (SessionLayout.ts). The Runner seeds it at each start, so Claude Code
// goes straight to the conversation, with no onboarding, folder-trust or bypass-permissions
// prompt, and copies in the transcript of a conversation Claude Code had on the host, before it
// moved into the Sandbox, the first time that Session wakes.

import { constants } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import { dirname, join, posix, relative, sep } from "node:path"
import type { SessionId } from "@kndl/protocol"
import { Effect } from "effect"
import { ClaudeSessionIdPattern, hostTranscriptPath } from "../ClaudeConfig.ts"
import { SandboxBackendError } from "./SandboxBackend.ts"
import type { SandboxBackendShape } from "./SandboxBackend.ts"
import { claudeStateGuestPath, workspaceGuestPath } from "./SessionLayout.ts"

/**
 * What Claude Code needs in its environment in the Sandbox, besides the image's: its state
 * directory, and `IS_SANDBOX`, which lets `--dangerously-skip-permissions` run as root.
 */
export const claudeStateEnv: Readonly<Record<string, string>> = {
  CLAUDE_CONFIG_DIR: claudeStateGuestPath,
  IS_SANDBOX: "1",
}

/** Claude Code's config file, in its state directory as `CLAUDE_CONFIG_DIR` puts it. */
const configGuestPath = posix.join(claudeStateGuestPath, ".claude.json")

/** Claude Code's user settings. */
const settingsGuestPath = posix.join(claudeStateGuestPath, "settings.json")

/**
 * The directory of Claude Code's transcripts of conversations begun in the Workspace: named after
 * `/workspace` as Claude Code names a working directory's.
 */
const transcriptsGuestPath = posix.join(claudeStateGuestPath, "projects", "-workspace")

const objectOrEmpty = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** A JSON object file in the Sandbox: empty when it is missing or not one. */
const readObject = (backend: SandboxBackendShape, sessionId: SessionId, path: string) =>
  backend.readFile(sessionId, path).pipe(
    Effect.map((data) => {
      try {
        return objectOrEmpty(JSON.parse(new TextDecoder().decode(data)))
      } catch {
        return {}
      }
    }),
    Effect.catchTag("SandboxBackendError", () => Effect.succeed<Record<string, unknown>>({})),
  )

/**
 * Seeds Claude Code's state in the running Sandbox, keeping whatever else it holds: onboarding
 * done, the Workspace trusted, and bypass-permissions mode accepted, as every Session runs in it
 * (ADR 0004). Claude Code reads both files only as it starts.
 */
export const seedClaudeState = (backend: SandboxBackendShape, sessionId: SessionId) =>
  Effect.gen(function* () {
    const config = yield* readObject(backend, sessionId, configGuestPath)
    const projects = objectOrEmpty(config.projects)
    yield* backend.writeFile(
      sessionId,
      configGuestPath,
      `${JSON.stringify(
        {
          ...config,
          hasCompletedOnboarding: true,
          theme: config.theme ?? "dark",
          projects: {
            ...projects,
            [workspaceGuestPath]: {
              ...objectOrEmpty(projects[workspaceGuestPath]),
              hasTrustDialogAccepted: true,
            },
          },
        },
        null,
        2,
      )}\n`,
    )
    const settings = yield* readObject(backend, sessionId, settingsGuestPath)
    yield* backend.writeFile(
      sessionId,
      settingsGuestPath,
      `${JSON.stringify({ ...settings, skipDangerousModePermissionPrompt: true }, null, 2)}\n`,
    )
  })

/**
 * Every file under `directory` on the host, relative to it; none when it is missing or a symlink.
 * Symlinks under it are left out too, and never followed, whatever they point at.
 */
const hostFiles = async (directory: string): Promise<Array<string>> => {
  const stats = await lstat(directory).catch(() => undefined)
  if (stats?.isDirectory() !== true) return []
  const files: Array<string> = []
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile()) files.push(relative(directory, child))
    }
  }
  await walk(directory)
  return files
}

/**
 * A file on the host, read only if it is one itself, in `within`: not a symlink, nor reached
 * through one that leads out of it.
 */
const readHostFile = async (path: string, within: string): Promise<Uint8Array> => {
  const real = await realpath(path)
  const root = await realpath(within)
  if (!real.startsWith(`${root}${sep}`)) throw new Error(`${path} is outside ${within}`)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`${path} is not a file`)
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

/**
 * Whether Claude Code in the running Sandbox has a transcript of conversation `id` to resume.
 * One it had on the host, in `hostCwd` under `projectsDir`, before it moved into the Sandbox, is
 * copied in first, with the directory of the same name beside it (its subagents' transcripts and
 * tool results). The id comes from the Sandbox, so there is none for one that isn't a Claude Code
 * session id, and only files, never symlinks, are copied, from that directory alone.
 */
export const ensureTranscript = (
  backend: SandboxBackendShape,
  sessionId: SessionId,
  id: string,
  host: { readonly cwd: string; readonly projectsDir: string },
) =>
  Effect.gen(function* () {
    if (!ClaudeSessionIdPattern.test(id)) return false
    const transcript = posix.join(transcriptsGuestPath, `${id}.jsonl`)
    const found = yield* backend.exec(sessionId, { command: "test", args: ["-f", transcript] })
    if (found.exitCode === 0) return true
    const hostTranscript = hostTranscriptPath(host.cwd, id, host.projectsDir)
    if (hostTranscript === undefined) return false
    const hostProject = dirname(hostTranscript)
    const hostDirectory = join(hostProject, id)
    const files = yield* Effect.tryPromise({
      try: async () => {
        const nested = await hostFiles(hostDirectory)
        return [
          { from: hostTranscript, to: transcript },
          ...nested.map((file) => ({
            from: join(hostDirectory, file),
            to: posix.join(transcriptsGuestPath, id, ...file.split("/")),
          })),
        ]
      },
      catch: (cause) =>
        new SandboxBackendError({ operation: "copy transcript", message: String(cause), cause }),
    })
    // The transcript itself goes last, so a copy cut short is tried again on the next start.
    for (const file of files.toReversed()) {
      const data = yield* Effect.tryPromise({
        try: () => readHostFile(file.from, hostProject),
        catch: (cause) =>
          new SandboxBackendError({ operation: "copy transcript", message: String(cause), cause }),
      })
      yield* backend.writeFile(sessionId, file.to, data)
    }
    yield* Effect.logInfo(
      `Session ${sessionId}: copied the transcript of conversation ${id} from the host into its Sandbox`,
    )
    return true
  })
