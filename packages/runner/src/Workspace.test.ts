// Clones a local Repo with real git. Skipped when git isn't installed.
import { beforeAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Redacted } from "effect"
import { RunnerConfig } from "./RunnerConfig.ts"
import { sessionDirectories } from "./SessionNames.ts"
import { FakeHubGit, sessionId } from "./testSupport.ts"
import { removeSessionFiles, Workspaces, WorkspacesGitClone } from "./Workspace.ts"

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
      repo: "acme/origin" as never,
      baseBranch: "main" as never,
      workBranch: "claude/w-1" as never,
      modToken: "m",
      ...extra,
    }),
  )

describe.skipIf(Bun.which("git") === null)("WorkspacesGitClone", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-hub-workspace-"))
  const origin = join(dir, "acme", "origin")
  const sessionsRoot = join(dir, "sessions")
  // Without the GitHub App: the clone uses the host's own git credentials.
  const hubGit = new FakeHubGit("acme/origin")
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
                  sessionsRoot,
                  modDir: dir,
                  tmuxSocket: "unused",
                  // `{repo}` is a path under `dir` here.
                  repoUrlTemplate: `${dir}/{repo}`,
                }),
              ),
            ),
            Layer.provide(BunServices.layer),
            Layer.provide(hubGit.layer),
          ),
        ),
      ),
    )

  test("clones the Repo onto a new Work branch", async () => {
    const result = await run(start("w-1"))

    expect(result).toMatchObject({
      success: {
        session: join(sessionsRoot, "w-1"),
        workspace: join(sessionsRoot, "w-1", "workspace"),
      },
    })
    expect(existsSync(join(sessionsRoot, "w-1", "claude"))).toBe(false)
    expect(git(join(sessionsRoot, "w-1", "workspace"), "branch", "--show-current")).toBe(
      "claude/w-1",
    )
    // Preparing again keeps the Workspace as it is.
    expect(await run(start("w-1"))).toMatchObject({ _tag: "Success" })
  })

  test("fails, leaving no Workspace behind, when the clone fails", async () => {
    const result = await run(start("w-2", { repo: "acme/missing" }))

    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "WorkspaceError" } })
    expect(existsSync(join(sessionsRoot, "w-2", "workspace"))).toBe(false)
  })

  test("wakes a Session on its Workspace as it was left, uncommitted work included", async () => {
    expect(await run(start("w-4"))).toMatchObject({ _tag: "Success" })
    const workspace = join(sessionsRoot, "w-4", "workspace")
    writeFileSync(join(workspace, "notes.txt"), "half done")

    expect(await run(start("w-4", { resume: "c-4" }))).toMatchObject({ _tag: "Success" })
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe("half done")
    expect(git(workspace, "branch", "--show-current")).toBe("claude/w-1")
  })

  test("won't wake a Session whose Workspace is gone", async () => {
    const result = await run(start("w-3", { resume: "c-1" }))

    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "WorkspaceError" } })
  })
})

describe("removing a purged Session's files", () => {
  test("deletes its directory and Claude Code's transcripts and entry for it, nothing else", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "claude-hub-purge-")))
    const directories = sessionDirectories(join(dir, "sessions"), sessionId("p-1"))
    const other = sessionDirectories(join(dir, "sessions"), sessionId("p-2"))
    for (const d of [directories, other]) mkdirSync(join(d.workspace, ".git"), { recursive: true })
    for (const d of [directories, other]) mkdirSync(d.claude, { recursive: true })
    // Something the Sandbox left that can't be written to, and a link out of the Workspace.
    const outside = join(dir, "outside.txt")
    writeFileSync(outside, "keep")
    symlinkSync(outside, join(directories.workspace, "link"))
    mkdirSync(join(directories.workspace, "locked", "deep"), { recursive: true })
    writeFileSync(join(directories.workspace, "locked", "deep", "f"), "x")
    chmodSync(join(directories.workspace, "locked", "deep"), 0o500)
    chmodSync(join(directories.workspace, "locked"), 0o500)

    const projectsDir = join(dir, "claude", "projects")
    const transcripts = join(projectsDir, directories.claude.replace(/[^a-zA-Z0-9]/g, "-"))
    const otherTranscripts = join(projectsDir, other.claude.replace(/[^a-zA-Z0-9]/g, "-"))
    mkdirSync(transcripts, { recursive: true })
    mkdirSync(otherTranscripts, { recursive: true })
    writeFileSync(join(transcripts, "c-1.jsonl"), "{}")
    const configPath = join(dir, ".claude.json")
    writeFileSync(
      configPath,
      JSON.stringify({
        numStartups: 3,
        projects: { [directories.claude]: { lastCost: 1 }, [other.claude]: { lastCost: 2 } },
      }),
    )

    await Effect.runPromise(removeSessionFiles(directories, { projectsDir, configPath }))

    expect(existsSync(directories.session)).toBe(false)
    expect(existsSync(transcripts)).toBe(false)
    expect(readFileSync(outside, "utf8")).toBe("keep")
    expect(existsSync(other.workspace)).toBe(true)
    expect(existsSync(otherTranscripts)).toBe(true)
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      numStartups: 3,
      projects: { [other.claude]: { lastCost: 2 } },
    })

    // Nothing left to remove is fine.
    await Effect.runPromise(removeSessionFiles(directories, { projectsDir, configPath }))
    rmSync(dir, { recursive: true, force: true })
  })
})
