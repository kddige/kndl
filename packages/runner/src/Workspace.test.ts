// Clones a local Repo with real git. Skipped when git isn't installed.
import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Redacted } from "effect"
import { RunnerConfig } from "./RunnerConfig.ts"
import { sessionId } from "./testSupport.ts"
import { Workspaces, WorkspacesGitClone } from "./Workspace.ts"

function git(cwd: string, ...args: Array<string>): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

const start = (id: string, extra: Record<string, unknown> = {}) =>
  Effect.flatMap(Workspaces, (w) =>
    w.prepare({
      _tag: "StartSession",
      sessionId: sessionId(id),
      repo: "origin" as never,
      baseBranch: "main" as never,
      workBranch: "claude/w-1" as never,
      modToken: "m",
      ...extra,
    }),
  )

describe.skipIf(Bun.which("git") === null)("WorkspacesGitClone", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-hub-workspace-"))
  const origin = join(dir, "origin")
  const sessionsRoot = join(dir, "sessions")
  beforeAll(() => {
    git(dir, "init", "--quiet", "--initial-branch=main", origin)
    git(origin, "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "first")
  })

  const run = <A, E>(effect: Effect.Effect<A, E, Workspaces>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.result,
        Effect.provide(
          WorkspacesGitClone.pipe(
            Layer.provide(
              Layer.succeed(
                RunnerConfig,
                RunnerConfig.of({
                  hubUrl: new URL("http://hub.test"),
                  name: "test",
                  token: Redacted.make("token"),
                  login: undefined,
                  sessionsRoot,
                  modDir: dir,
                  claudeBin: "claude",
                  tmuxSocket: "unused",
                  // `{repo}` is a path under `dir` here.
                  repoUrlTemplate: `${dir}/{repo}`,
                }),
              ),
            ),
            Layer.provide(BunServices.layer),
          ),
        ),
      ),
    )

  test("clones the Repo onto a new Work branch, next to an empty directory for Claude Code", async () => {
    const result = await run(start("w-1"))

    expect(result).toMatchObject({
      success: {
        claude: join(sessionsRoot, "w-1", "claude"),
        workspace: join(sessionsRoot, "w-1", "workspace"),
        toolsSocket: join(sessionsRoot, "w-1", "tools.sock"),
      },
    })
    expect(existsSync(join(sessionsRoot, "w-1", "claude"))).toBe(true)
    expect(git(join(sessionsRoot, "w-1", "workspace"), "branch", "--show-current")).toBe(
      "claude/w-1",
    )
    // Preparing again keeps the Workspace as it is.
    expect(await run(start("w-1"))).toMatchObject({ _tag: "Success" })
  })

  test("fails, leaving no Workspace behind, when the clone fails", async () => {
    const result = await run(start("w-2", { repo: "missing" }))

    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "WorkspaceError" } })
    expect(existsSync(join(sessionsRoot, "w-2", "workspace"))).toBe(false)
  })

  test("won't wake a Session whose Workspace is gone", async () => {
    const result = await run(start("w-3", { resume: "c-1" }))

    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "WorkspaceError" } })
  })
})
