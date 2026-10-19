// Claude Code's state in a Session's Sandbox (ADR 0013): its `CLAUDE_CONFIG_DIR`, on the
// Session's `claude` volume (SessionLayout.ts), which the durable agent's Claude bridge runs it
// on. The Runner seeds it at each start, so Claude Code goes straight to work, with no onboarding,
// folder-trust or bypass-permissions prompt.

import { posix } from "node:path"
import type { SessionId } from "@kndl/protocol"
import { Effect } from "effect"
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
