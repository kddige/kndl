// The WIP ref, with real git against a local bare repo and a fake Hub that
// hands out a fake token. Skipped when git isn't installed.
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
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
import { type SessionId, wipRef } from "@claude-hub/protocol"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Redacted, References } from "effect"
import { AgentWorktreesPattern, gitEnvironment, WipIdentity } from "./HostGit.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import { sessionDirectories } from "./SessionNames.ts"
import { FakeHubGit, sessionId } from "./testSupport.ts"
import { Workspaces, WorkspacesGitClone } from "./Workspace.ts"
import { WorkspaceGit, WorkspaceGitLive, type WipReason } from "./WorkspaceGit.ts"

const Token = "ghs_FAKEtoken0123456789abcdef"
const Bot = {
  name: "claude-hub-test[bot]",
  email: "42+claude-hub-test[bot]@users.noreply.github.com",
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

describe.skipIf(Bun.which("git") === null)("WorkspaceGit", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-hub-git-"))
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
    Layer.mergeAll(WorkspaceGitLive, WorkspacesGitClone).pipe(
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

  const run = <A, E>(effect: Effect.Effect<A, E, WorkspaceGit | Workspaces>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(layer()),
        Effect.provideService(References.MinimumLogLevel, "None"),
      ),
    )

  const directories = () => sessionDirectories(sessionsRoot, id)
  const workspace = () => directories().workspace
  const workBranch = () => `claude/g-${counter}`

  const prepare = () =>
    run(
      Effect.flatMap(Workspaces, (w) =>
        w.prepare({
          _tag: "StartSession",
          sessionId: id,
          repo: `acme/repo-${counter}` as never,
          baseBranch: "main" as never,
          workBranch: workBranch() as never,
          modToken: "m",
        }),
      ),
    )

  const pushWip = (reason: WipReason = "TurnEnded") =>
    run(Effect.flatMap(WorkspaceGit, (g) => g.pushWip(id, directories(), reason)))

  /** The token is nowhere on disk: not in the Workspace, the Runner's git dir or the remote. */
  const expectNoTokenOnDisk = () => {
    expect(filesContaining(join(sessionsRoot, id), Token)).toEqual([])
    expect(filesContaining(origin, Token)).toEqual([])
    expect(readFileSync(join(workspace(), ".git", "config"), "utf8")).not.toContain(Token)
    expect(readFileSync(join(workspace(), ".git", "config"), "utf8")).not.toContain("extraHeader")
  }

  test("clones with the token, which stays out of the remote URL and .git/config", async () => {
    await prepare()

    expect(git(workspace(), "branch", "--show-current")).toBe(workBranch())
    expect(git(workspace(), "remote", "get-url", "origin")).toBe(origin)
    expect(hubGit.asked.map(({ ask }) => ask._tag)).toEqual(["GitAccess"])
    expectNoTokenOnDisk()
  })

  test("without the GitHub App, the WIP push uses the host's credentials, as claude-hub", async () => {
    hubGit.credentials = { _tag: "HostCredentials" }
    await prepare()
    writeFileSync(join(workspace(), "a.txt"), "a\n")

    await pushWip()

    expect(hubGit.wipFailures).toEqual([])
    expect(git(origin, "log", "-1", "--format=%an <%ae>", wipRef(id))).toBe(
      `${WipIdentity.name} <${WipIdentity.email}>`,
    )
  })

  test("the WIP ref holds every file but ignored ones, and leaves the index and branches alone", async () => {
    await prepare()
    writeFileSync(join(workspace(), "README.md"), "changed\n")
    writeFileSync(join(workspace(), "staged.txt"), "staged\n")
    git(workspace(), "add", "staged.txt")
    writeFileSync(join(workspace(), "untracked.txt"), "untracked\n")
    writeFileSync(join(workspace(), "debug.log"), "ignored\n")
    const head = git(workspace(), "rev-parse", "HEAD")
    const status = git(workspace(), "status", "--porcelain")

    await pushWip()

    const ref = wipRef(id)
    const wip = git(origin, "rev-parse", ref)
    expect(git(origin, "rev-parse", `${wip}^`)).toBe(head)
    expect(git(origin, "ls-tree", "-r", "--name-only", wip).split("\n").toSorted()).toEqual([
      ".gitignore",
      "README.md",
      "staged.txt",
      "untracked.txt",
    ])
    expect(git(origin, "show", `${wip}:README.md`)).toBe("changed")
    expect(git(origin, "log", "-1", "--format=%an", wip)).toBe(Bot.name)
    expect(git(workspace(), "rev-parse", "HEAD")).toBe(head)
    expect(git(workspace(), "status", "--porcelain")).toBe(status)
    expect(git(origin, "rev-parse", "main")).toBe(head)
    expect(hubGit.wipFailures).toEqual([])
    expectNoTokenOnDisk()
  })

  test("subagents' worktrees stay out of the WIP ref and the Workspace's git status (ADR 0014)", async () => {
    await prepare()
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

    await pushWip("Sleep")
    writeFileSync(join(workspace(), "notes.txt"), "more notes\n")
    await pushWip("Sleep")

    const wip = git(origin, "rev-parse", wipRef(id))
    expect(git(origin, "ls-tree", "-r", "--name-only", wip).split("\n").toSorted()).toEqual([
      ".gitignore",
      "README.md",
      "notes.txt",
    ])
    // A `git add -A` in the Sandbox leaves them out too.
    expect(git(workspace(), "status", "--porcelain")).toBe("?? notes.txt")
    const exclude = readFileSync(join(workspace(), ".git", "info", "exclude"), "utf8")
    expect(exclude.split("\n").filter((line) => line === AgentWorktreesPattern)).toHaveLength(1)
    // The snapshots leave the worktree's own git records and branch be.
    expect(existsSync(join(workspace(), ".git", "worktrees", "agent-a1"))).toBe(true)
    expect(git(workspace(), "worktree", "list")).toContain("[worktree-agent-a1]")
    expect(hubGit.wipFailures).toEqual([])
  })

  test("a WIP push is skipped while nothing changed, and force-pushes the ref when it did", async () => {
    await prepare()
    writeFileSync(join(workspace(), "a.txt"), "1\n")
    await pushWip()
    const first = git(origin, "rev-parse", wipRef(id))
    const asked = hubGit.asked.length

    await pushWip()
    expect(hubGit.asked.length).toBe(asked)
    expect(git(origin, "rev-parse", wipRef(id))).toBe(first)

    // A commit replaces the snapshot's parent: the new WIP commit doesn't descend from the old.
    git(workspace(), "add", "--all")
    git(workspace(), "commit", "--quiet", "-m", "Add a")
    await pushWip("Sleep")
    const second = git(origin, "rev-parse", wipRef(id))
    expect(second).not.toBe(first)
    expect(git(origin, "rev-parse", `${second}^`)).toBe(git(workspace(), "rev-parse", "HEAD"))
    expect(git(origin, "log", "-1", "--format=%s", second)).toContain("(Sleep)")
  })

  test("a failed WIP push is reported to the Hub and doesn't fail", async () => {
    await prepare()
    writeFileSync(join(workspace(), "a.txt"), "1\n")
    rmSync(origin, { recursive: true, force: true })

    await pushWip("Sleep")

    expect(hubGit.wipFailures).toEqual([
      { sessionId: id, message: expect.stringContaining("Could not push the WIP ref (Sleep)") },
    ])
  })

  test("a WIP push of a Session with no Workspace does nothing", async () => {
    await pushWip("Archive")

    expect(hubGit.asked).toEqual([])
    expect(hubGit.wipFailures).toEqual([])
  })

  test("host git runs nothing the Sandbox planted in the Workspace's .git", async () => {
    await prepare()
    const planted = join(dir, `planted-${counter}`)
    mkdirSync(planted)
    const marker = (name: string) => `touch ${join(planted, name)}`
    const gitDir = join(workspace(), ".git")
    const hooks = join(workspace(), "hooks")
    mkdirSync(hooks)
    for (const hook of [
      "pre-commit",
      "post-commit",
      "pre-push",
      "reference-transaction",
      "post-index-change",
    ]) {
      for (const where of [join(gitDir, "hooks"), hooks]) {
        writeFileSync(join(where, hook), `#!/bin/sh\n${marker(`hook-${hook}`)}\n`)
        chmodSync(join(where, hook), 0o755)
      }
    }
    const other = join(dir, `elsewhere-${counter}.git`)
    git(dir, "init", "--quiet", "--bare", other)
    const evil = [
      `[core]`,
      `\thooksPath = ${hooks}`,
      `\tfsmonitor = "${marker("fsmonitor")}; false"`,
      `\tsshCommand = "${marker("ssh")}"`,
      `[filter "evil"]`,
      `\tclean = "${marker("clean")}; cat"`,
      `\tprocess = "${marker("process")}"`,
      `[credential]`,
      `\thelper = "!f() { ${marker("credential")}; cat > ${join(planted, "credential-input")}; }; f"`,
      `[url "${other}"]`,
      `\tinsteadOf = ${origin}`,
      `\tpushInsteadOf = ${origin}`,
    ].join("\n")
    writeFileSync(
      join(gitDir, "config"),
      `${readFileSync(join(gitDir, "config"), "utf8")}\n${evil}\n`,
    )
    writeFileSync(join(workspace(), ".gitattributes"), "* filter=evil\n")
    writeFileSync(join(workspace(), "a.txt"), "a\n")

    await pushWip()

    expect(readdirSync(planted)).toEqual([])
    // The push went to origin, not where the planted config pointed.
    expect(git(origin, "rev-parse", "--verify", "--quiet", wipRef(id))).not.toBe("")
    expect(git(other, "for-each-ref")).toBe("")
    expect(hubGit.wipFailures).toEqual([])
    expectNoTokenOnDisk()
  })

  test("host git refuses a Workspace whose .git has a planted link", async () => {
    await prepare()
    const target = join(dir, `target-${counter}`)
    writeFileSync(target, "precious\n")
    const index = join(workspace(), ".git", "index")
    rmSync(index)
    Bun.spawnSync(["ln", "-s", target, index])
    writeFileSync(join(workspace(), "a.txt"), "a\n")

    await pushWip()

    expect(hubGit.wipFailures).toEqual([
      expect.objectContaining({ message: expect.stringContaining("refused the Workspace") }),
    ])
    expect(readFileSync(target, "utf8")).toBe("precious\n")
    expect(existsSync(index)).toBe(true)
  })

  test("host git refuses a Workspace whose objects use alternates", async () => {
    await prepare()
    const elsewhere = join(dir, `elsewhere-objects-${counter}.git`)
    git(dir, "init", "--quiet", "--bare", elsewhere)
    const info = join(workspace(), ".git", "objects", "info")
    mkdirSync(info, { recursive: true })
    writeFileSync(join(workspace(), "a.txt"), "a\n")

    // Empty files point nowhere, so they're fine.
    writeFileSync(join(info, "alternates"), "")
    writeFileSync(join(info, "http-alternates"), "")
    await pushWip()
    expect(hubGit.wipFailures).toEqual([])
    const pushed = git(origin, "rev-parse", wipRef(id))

    for (const file of ["alternates", "http-alternates"]) {
      writeFileSync(join(info, "alternates"), "")
      writeFileSync(join(info, "http-alternates"), "")
      writeFileSync(join(info, file), `${join(elsewhere, "objects")}\n`)
      const before = hubGit.wipFailures.length
      writeFileSync(join(workspace(), "b.txt"), "b\n")
      await pushWip()
      expect(hubGit.wipFailures.slice(before)).toEqual([
        expect.objectContaining({
          message: expect.stringContaining(`.git/objects/info/${file} points git at other object`),
        }),
      ])
    }
    expect(git(origin, "rev-parse", wipRef(id))).toBe(pushed)
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
