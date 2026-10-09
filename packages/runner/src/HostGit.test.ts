// Host git's clone, with real git against a local bare repo and a fake Hub that hands out a fake
// token. Skipped when git isn't installed.
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import type { SessionId } from "@kndl/protocol"
import { Effect, Layer, Redacted, References } from "effect"
import { AgentWorktreesPattern, gitEnvironment } from "./HostGit.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import { sessionDirectories } from "./SessionNames.ts"
import { FakeHubGit, sessionId } from "./testSupport.ts"
import { Workspaces, WorkspacesGitClone } from "./Workspace.ts"

const Token = "ghs_FAKEtoken0123456789abcdef"
const Bot = {
  name: "kndl-test[bot]",
  email: "42+kndl-test[bot]@users.noreply.github.com",
}

const testIdentity = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
}

function git(cwd: string, ...args: Array<string>): string {
  const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { ...process.env, ...testIdentity },
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

/** Every file under `dir` that contains `needle` as plain text. */
function filesContaining(dir: string, needle: string): Array<string> {
  const found: Array<string> = []
  const walk = (path: string) => {
    const stats = statSync(path, { throwIfNoEntry: false })
    if (stats === undefined) return
    if (stats.isDirectory()) {
      for (const entry of readdirSync(path)) walk(join(path, entry))
    } else if (stats.isFile() && readFileSync(path).includes(needle)) found.push(path)
  }
  walk(dir)
  return found
}

describe.skipIf(Bun.which("git") === null)("host git", () => {
  const dir = mkdtempSync(join(tmpdir(), "kndl-git-"))
  const sessionsRoot = join(dir, "sessions")
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  let counter = 0
  let origin: string
  let id: SessionId
  let hubGit: FakeHubGit

  beforeEach(() => {
    counter++
    id = sessionId(`g-${counter}`)
    origin = join(dir, "acme", `repo-${counter}`)
    mkdirSync(origin, { recursive: true })
    git(origin, "init", "--quiet", "--bare", "--initial-branch=main")
    const seed = join(dir, `seed-${counter}`)
    git(dir, "clone", "--quiet", origin, seed)
    writeFileSync(join(seed, "README.md"), "hello\n")
    writeFileSync(join(seed, ".gitignore"), "*.log\n")
    git(seed, "add", ".")
    git(seed, "commit", "--quiet", "-m", "first")
    git(seed, "push", "--quiet", "origin", "HEAD:main")
    hubGit = new FakeHubGit(`acme/repo-${counter}`)
    hubGit.useToken(Token, Bot)
  })

  const layer = () =>
    WorkspacesGitClone.pipe(
      Layer.provide(hubGit.layer),
      Layer.provide(
        Layer.succeed(
          RunnerConfig,
          RunnerConfig.of({
            hubUrl: new URL("http://hub.test"),
            name: "test",
            token: Redacted.make("runner-token"),
            sessionsRoot,
            modDir: dir,
            tmuxSocket: "unused",
            // `{repo}` is `acme/repo-<n>`, a path under `dir` here.
            repoUrlTemplate: `${dir}/{repo}`,
          }),
        ),
      ),
      Layer.provide(BunServices.layer),
    )

  const run = <A, E>(effect: Effect.Effect<A, E, Workspaces>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(layer()),
        Effect.provideService(References.MinimumLogLevel, "None"),
      ),
    )

  const workspace = () => sessionDirectories(sessionsRoot, id).workspace
  const workBranch = () => `claude/g-${counter}`

  const prepare = (branches: { readonly base?: string; readonly work?: string } = {}) =>
    run(
      Effect.flatMap(Workspaces, (w) =>
        w.prepare({
          _tag: "StartSession",
          sessionId: id,
          repo: `acme/repo-${counter}` as never,
          baseBranch: (branches.base ?? "main") as never,
          workBranch: (branches.work ?? workBranch()) as never,
          modToken: "m",
        }),
      ),
    )

  test("clones with the token, which stays out of the remote URL and .git/config", async () => {
    await prepare()

    expect(git(workspace(), "branch", "--show-current")).toBe(workBranch())
    expect(git(workspace(), "remote", "get-url", "origin")).toBe(origin)
    expect(hubGit.asked.map(({ ask }) => ask._tag)).toEqual(["GitAccess"])
    expect(filesContaining(join(sessionsRoot, id), Token)).toEqual([])
    expect(filesContaining(origin, Token)).toEqual([])
    const config = readFileSync(join(workspace(), ".git", "config"), "utf8")
    expect(config).not.toContain(Token)
    expect(config).not.toContain("extraHeader")
  })

  test("without the GitHub App, clones with the host's credentials", async () => {
    hubGit.credentials = { _tag: "HostCredentials" }
    await prepare()

    expect(git(workspace(), "branch", "--show-current")).toBe(workBranch())
    expect(git(workspace(), "rev-parse", "HEAD")).toBe(git(origin, "rev-parse", "main"))
  })

  test("works directly on the base branch when the Work branch is it (ADR 0023)", async () => {
    await prepare({ work: "main" })

    expect(git(workspace(), "branch", "--show-current")).toBe("main")
    expect(git(workspace(), "branch", "--format=%(refname:short)")).toBe("main")
  })

  test("refuses to create a Work branch the Repo already has", async () => {
    git(origin, "branch", "taken")
    const failure = await prepare({ work: "taken" }).then(
      () => undefined,
      (error: unknown) => String(error),
    )
    expect(failure).toContain("taken already exists in the Repo")
    // Working on it directly is the way to use it.
    await prepare({ base: "taken", work: "taken" })
    expect(git(workspace(), "branch", "--show-current")).toBe("taken")
  })

  test("the clone pushes nothing, and has no Runner git directory beside it (#194)", async () => {
    await prepare()

    expect(git(origin, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main")
    expect(readdirSync(join(sessionsRoot, id))).toEqual(["workspace"])
  })

  test("subagents' worktrees stay out of the Workspace's git status after a clone (ADR 0014)", async () => {
    await prepare()
    const exclude = readFileSync(join(workspace(), ".git", "info", "exclude"), "utf8")
    expect(exclude.split("\n").filter((line) => line === AgentWorktreesPattern)).toHaveLength(1)

    git(
      workspace(),
      "worktree",
      "add",
      "--quiet",
      "-b",
      "worktree-agent-a1",
      ".claude/worktrees/agent-a1",
    )
    writeFileSync(join(workspace(), ".claude", "worktrees", "agent-a1", "draft.md"), "draft\n")
    writeFileSync(join(workspace(), "notes.txt"), "notes\n")

    // So a `git add -A` in the Sandbox leaves them out.
    expect(git(workspace(), "status", "--porcelain")).toBe("?? notes.txt")
    git(workspace(), "add", "--all")
    expect(git(workspace(), "diff", "--cached", "--name-only")).toBe("notes.txt")
  })

  test("host git's environment drops variables that point it at other objects", () => {
    const saved = process.env["GIT_ALTERNATE_OBJECT_DIRECTORIES"]
    process.env["GIT_ALTERNATE_OBJECT_DIRECTORIES"] = "/elsewhere/objects"
    process.env["GIT_OBJECT_DIRECTORY"] = "/elsewhere/objects"
    try {
      const env = gitEnvironment({})
      expect(env["GIT_ALTERNATE_OBJECT_DIRECTORIES"]).toBeUndefined()
      expect(env["GIT_OBJECT_DIRECTORY"]).toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env["GIT_ALTERNATE_OBJECT_DIRECTORIES"]
      else process.env["GIT_ALTERNATE_OBJECT_DIRECTORIES"] = saved
      delete process.env["GIT_OBJECT_DIRECTORY"]
    }
  })
})
