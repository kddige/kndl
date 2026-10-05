// A Test build's clone (#104): with the token the Hub mints for it, sent to git as a header for the
// one clone and kept nowhere; with the host's credentials only when the Hub has no GitHub App; and
// not at all when the Hub says why not. Real git against a stand-in git server that only records
// what it is sent. Skipped when git isn't installed.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GitAnswer, TestBuildId } from "@claude-hub/protocol"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Redacted } from "effect"
import { authorizationHeader } from "./HostGit.ts"
import { cloneTestBuild } from "./SessionSandboxes.ts"
import { FakeHubGit } from "./testSupport.ts"

const Token = "ghs_CLONEtoken0123456789abcdef"
const testBuildId = TestBuildId.make("t-1")

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

describe.skipIf(Bun.which("git") === null)("A Test build's clone", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-hub-test-build-clone-"))
  /** The Authorization header of each request git sent, or null. */
  const authorizations: Array<string | null> = []
  // Refuses every request, after noting how it was authorized: git's clone fails, as wanted.
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      authorizations.push(request.headers.get("authorization"))
      return new Response("no such Repo", { status: 404 })
    },
  })
  afterAll(() => {
    void server.stop(true)
    rmSync(dir, { recursive: true, force: true })
  })
  const url = `http://127.0.0.1:${server.port}/acme/repo.git`

  let clones = 0
  const clone = (hubGit: FakeHubGit) => {
    authorizations.length = 0
    const directory = join(dir, `clone-${++clones}`)
    return Effect.runPromise(
      cloneTestBuild({ url, directory, testBuildId }).pipe(
        Effect.provide(hubGit.layer),
        Effect.provide(BunServices.layer),
        Effect.exit,
      ),
    )
  }

  test("sends git the token the Hub minted for it, and keeps it nowhere", async () => {
    const hubGit = new FakeHubGit("acme/repo")
    hubGit.cloneAnswer = GitAnswer.cases.CloneAccess.make({
      credentials: { _tag: "CloneToken", token: Redacted.make(Token), expiresAt: 1 },
    })

    const exit = await clone(hubGit)

    expect(hubGit.clonesAsked).toEqual([testBuildId])
    expect(authorizations.length).toBeGreaterThan(0)
    expect(authorizations).toEqual(
      authorizations.map(() => authorizationHeader(Redacted.make(Token)).slice(15)),
    )
    // Failed, as the stand-in server wanted, without the token in what it says.
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).not.toContain(Token)
    expect(filesContaining(dir, Token)).toEqual([])
  })

  test("uses the host's credentials when the Hub has no GitHub App", async () => {
    const hubGit = new FakeHubGit("acme/repo")

    await clone(hubGit)

    expect(hubGit.clonesAsked).toEqual([testBuildId])
    expect(authorizations.length).toBeGreaterThan(0)
    expect(authorizations.every((header) => header === null)).toBe(true)
  })

  test("fails before cloning when the Hub says why not", async () => {
    const hubGit = new FakeHubGit("acme/repo")
    hubGit.cloneAnswer = GitAnswer.cases.GitFailed.make({
      message: "The GitHub App is not installed on acme/repo.",
    })

    const exit = await clone(hubGit)

    expect(authorizations).toEqual([])
    expect(exit).toEqual(
      Exit.fail({
        message:
          "could not get access to clone the Repo: The GitHub App is not installed on acme/repo.",
      }),
    )
  })
})
