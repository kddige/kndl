// The git tools and the WIP ref, with real git against a local bare repo and a fake Hub that
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
import { type GitToolCall, type SessionId, wipRef } from "@claude-hub/protocol"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Redacted, References } from "effect"
import { gitEnvironment } from "./HostGit.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import { sessionDirectories } from "./SessionNames.ts"
import { FakeHubGit, sessionId } from "./testSupport.ts"
import { Workspaces, WorkspacesGitClone } from "./Workspace.ts"
import { withCoAuthors, WorkspaceGit, WorkspaceGitLive, type WipReason } from "./WorkspaceGit.ts"

const Token = "ghs_FAKEtoken0123456789abcdef"
const Bot = {
  name: "claude-hub-test[bot]",
  email: "42+claude-hub-test[bot]@users.noreply.github.com",
}
const Alice = { name: "alice", email: "1001+alice@users.noreply.github.com" }
const Bob = { name: "bob", email: "1002+bob@users.noreply.github.com" }

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
    hubGit = new FakeHubGit({
      repo: `acme/repo-${counter}`,
      baseBranch: "main",
      workBranch: `claude/g-${counter}`,
    })
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
            login: undefined,
            sessionsRoot,
            modDir: dir,
            claudeBin: "claude",
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

  const call = (tool: GitToolCall["tool"], input: Record<string, unknown> = {}) =>
    run(Effect.flatMap(WorkspaceGit, (g) => g.call(id, directories(), { tool, input })))

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

  test("git_commit commits on the Work branch as the App's bot, with the co-authors' trailers", async () => {
    await prepare()
    hubGit.coAuthors = [Alice, Bob]
    hubGit.through = 3
    writeFileSync(join(workspace(), "a.txt"), "a\n")
    writeFileSync(join(workspace(), "b.txt"), "b\n")

    const reply = await call("git_commit", { message: "Add a and b", all: true })

    expect(reply).toMatchObject({ _tag: "ToolRan" })
    expect(reply._tag === "ToolRan" && reply.result).toContain(`on ${workBranch()}: Add a and b`)
    expect(git(workspace(), "log", "-1", "--format=%an <%ae>|%cn <%ce>")).toBe(
      `${Bot.name} <${Bot.email}>|${Bot.name} <${Bot.email}>`,
    )
    expect(git(workspace(), "log", "-1", "--format=%B")).toBe(
      `Add a and b\n\nCo-authored-by: alice <${Alice.email}>\nCo-authored-by: bob <${Bob.email}>`,
    )
    expect(
      git(workspace(), "show", "--name-only", "--format=", "HEAD").split("\n").toSorted(),
    ).toEqual(["a.txt", "b.txt"])
    // The Workspace's index matches the commit, and the Hub was told to reset its list.
    expect(git(workspace(), "status", "--porcelain")).toBe("")
    expect(hubGit.committed).toEqual([{ sessionId: id, through: 3 }])
    expectNoTokenOnDisk()
  })

  test("git_commit with paths stages only those, by any path the model knows the Workspace by", async () => {
    await prepare()
    writeFileSync(join(workspace(), "a.txt"), "a\n")
    writeFileSync(join(workspace(), "b.txt"), "b\n")

    const reply = await call("git_commit", { message: "Add a", paths: ["/workspace/a.txt"] })

    expect(reply).toMatchObject({ _tag: "ToolRan" })
    expect(git(workspace(), "show", "--name-only", "--format=", "HEAD")).toBe("a.txt")
    expect(git(workspace(), "status", "--porcelain")).toBe("?? b.txt")
  })

  test("git_commit refuses paths outside the Workspace, an empty commit, and other branches", async () => {
    await prepare()
    const head = git(workspace(), "rev-parse", "HEAD")

    expect(await call("git_commit", { message: "x", paths: ["/etc/passwd"] })).toMatchObject({
      _tag: "ToolFailed",
      message: "/etc/passwd is not in the Workspace.",
    })
    expect(await call("git_commit", { message: "x", paths: ["../outside"] })).toMatchObject({
      _tag: "ToolFailed",
    })
    expect(await call("git_commit", { message: "x", all: true })).toMatchObject({
      _tag: "ToolFailed",
      message: expect.stringContaining("Nothing to commit"),
    })
    expect(await call("git_commit", {})).toMatchObject({
      _tag: "ToolFailed",
      message: expect.stringContaining("git_commit was called with input it doesn't take"),
    })

    git(workspace(), "switch", "--quiet", "--create", "elsewhere")
    writeFileSync(join(workspace(), "a.txt"), "a\n")
    expect(await call("git_commit", { message: "x", all: true })).toMatchObject({
      _tag: "ToolFailed",
      message: expect.stringContaining(`not the Work branch ${workBranch()}`),
    })
    expect(git(workspace(), "rev-parse", "HEAD")).toBe(head)
    expect(hubGit.committed).toEqual([])
  })

  test("git_push pushes the Work branch, and never forces it", async () => {
    await prepare()
    writeFileSync(join(workspace(), "a.txt"), "a\n")
    await call("git_commit", { message: "Add a", all: true })
    const head = git(workspace(), "rev-parse", "HEAD")

    const reply = await call("git_push")

    expect(reply).toMatchObject({ _tag: "ToolRan" })
    expect(git(origin, "rev-parse", `refs/heads/${workBranch()}`)).toBe(head)
    expect(git(workspace(), "rev-parse", `refs/remotes/origin/${workBranch()}`)).toBe(head)
    expectNoTokenOnDisk()

    // Someone else pushes to the Work branch; the Session's next push is refused, not forced.
    const other = join(dir, `other-${counter}`)
    git(dir, "clone", "--quiet", "--branch", workBranch(), origin, other)
    writeFileSync(join(other, "theirs.txt"), "theirs\n")
    git(other, "add", ".")
    git(other, "commit", "--quiet", "-m", "theirs")
    git(other, "push", "--quiet", "origin", workBranch())
    const theirs = git(other, "rev-parse", "HEAD")
    writeFileSync(join(workspace(), "b.txt"), "b\n")
    await call("git_commit", { message: "Add b", all: true })

    expect(await call("git_push")).toMatchObject({
      _tag: "ToolFailed",
      message: expect.stringContaining("Nothing was force-pushed"),
    })
    expect(git(origin, "rev-parse", `refs/heads/${workBranch()}`)).toBe(theirs)
  })

  test("git_push pushes the Work branch only, whichever branch is checked out", async () => {
    await prepare()
    git(workspace(), "switch", "--quiet", "--create", "elsewhere")
    writeFileSync(join(workspace(), "a.txt"), "a\n")
    git(workspace(), "add", ".")
    git(workspace(), "commit", "--quiet", "-m", "elsewhere")

    expect(await call("git_push")).toMatchObject({ _tag: "ToolRan" })
    expect(
      git(origin, "branch", "--list", "--format=%(refname:short)").split("\n").toSorted(),
    ).toEqual(["claude/g-" + counter, "main"])
  })

  test("without the GitHub App, commits and pushes use the host's identity and credentials", async () => {
    hubGit.credentials = { _tag: "HostCredentials" }
    await prepare()
    hubGit.coAuthors = [Alice]
    writeFileSync(join(workspace(), "a.txt"), "a\n")
    const saved = { ...process.env }
    Object.assign(process.env, {
      GIT_AUTHOR_NAME: "Host User",
      GIT_AUTHOR_EMAIL: "host@example.com",
      GIT_COMMITTER_NAME: "Host User",
      GIT_COMMITTER_EMAIL: "host@example.com",
    })
    try {
      expect(await call("git_commit", { message: "Add a", all: true })).toMatchObject({
        _tag: "ToolRan",
      })
    } finally {
      for (const key of Object.keys(testIdentity)) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
    expect(git(workspace(), "log", "-1", "--format=%an <%ae>")).toBe("Host User <host@example.com>")
    expect(git(workspace(), "log", "-1", "--format=%(trailers:key=Co-authored-by,valueonly)")).toBe(
      `alice <${Alice.email}>`,
    )
    expect(await call("git_push")).toMatchObject({ _tag: "ToolRan" })
  })

  test("open_pr and review_pr go to the Hub, which holds the App", async () => {
    expect(await call("open_pr", { title: "T", body: "B", draft: true })).toMatchObject({
      _tag: "ToolRan",
      result: `Opened pull request #7: https://github.com/acme/repo-${counter}/pull/7`,
    })
    expect(await call("review_pr", { number: 3, body: "Looks good" })).toMatchObject({
      _tag: "ToolRan",
    })
    expect(hubGit.asked.map(({ ask }) => ask)).toEqual([
      { _tag: "OpenPullRequest", title: "T", body: "B", draft: true },
      { _tag: "ReviewPullRequest", number: 3, body: "Looks good", event: "COMMENT" },
    ])

    hubGit.answer = () => ({ _tag: "GitFailed", message: "open_pr needs the GitHub App" })
    expect(await call("open_pr", { title: "T" })).toEqual({
      _tag: "ToolFailed",
      message: "open_pr needs the GitHub App",
    })
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
    await call("git_commit", { message: "Add a", all: true })
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

    expect(await call("git_commit", { message: "Add a", all: true })).toMatchObject({
      _tag: "ToolRan",
    })
    expect(await call("git_push")).toMatchObject({ _tag: "ToolRan" })
    writeFileSync(join(workspace(), "b.txt"), "b\n")
    await pushWip()

    expect(readdirSync(planted)).toEqual([])
    // The pushes went to origin, not where the planted config pointed.
    expect(git(origin, "rev-parse", `refs/heads/${workBranch()}`)).toBe(
      git(workspace(), "rev-parse", "HEAD"),
    )
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

    expect(await call("git_commit", { message: "Add a", all: true })).toMatchObject({
      _tag: "ToolFailed",
      message: expect.stringContaining("refused the Workspace"),
    })
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
    expect(await call("git_commit", { message: "Add a", all: true })).toMatchObject({
      _tag: "ToolRan",
    })

    for (const file of ["alternates", "http-alternates"]) {
      writeFileSync(join(info, "alternates"), "")
      writeFileSync(join(info, "http-alternates"), "")
      writeFileSync(join(info, file), `${join(elsewhere, "objects")}\n`)
      for (const tool of ["git_commit", "git_push"] as const)
        expect(await call(tool, { message: "Again", all: true })).toMatchObject({
          _tag: "ToolFailed",
          message: expect.stringContaining(`.git/objects/info/${file} points git at other object`),
        })
      const before = hubGit.wipFailures.length
      writeFileSync(join(workspace(), "b.txt"), "b\n")
      await pushWip()
      expect(hubGit.wipFailures.slice(before)).toEqual([
        expect.objectContaining({ message: expect.stringContaining(`objects/info/${file}`) }),
      ])
    }
    expect(git(origin, "for-each-ref", wipRef(id))).toBe("")
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

describe("withCoAuthors", () => {
  test("adds a trailer block, once per email, after any trailers already there", () => {
    expect(withCoAuthors("Fix it\n", [])).toBe("Fix it")
    expect(withCoAuthors("Fix it", [Alice, Alice])).toBe(
      `Fix it\n\nCo-authored-by: alice <${Alice.email}>`,
    )
    expect(
      withCoAuthors(
        `Fix it\n\nMore words.\n\nCo-authored-by: Alice <${Alice.email.toUpperCase()}>`,
        [Alice, Bob],
      ),
    ).toBe(
      `Fix it\n\nMore words.\n\nCo-authored-by: Alice <${Alice.email.toUpperCase()}>\nCo-authored-by: bob <${Bob.email}>`,
    )
  })
})
