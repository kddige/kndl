// Repo access against a stand-in GitHub API, on the test clock: how long each answer is kept, and
// why access is refused (#104).

import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { Participant, ParticipantId, RepoName } from "@kndl/protocol"
import { Duration, Effect, Layer, Option, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { GitHubApp } from "./GitHubApp.ts"
import { type HubConfigInput, HubConfig } from "./HubConfig.ts"
import { refusedAnswerTtl, RepoAccess } from "./RepoAccess.ts"
import { appId, appKeyPair, StandInGitHub } from "./testGitHubApi.ts"
import { baseConfig } from "./testSupport.ts"

const keys = appKeyPair()
const github = StandInGitHub.start(keys.publicKey)
afterAll(() => github.stop())

const repo = RepoName.make("octo/widgets")
const octocat = Participant.make({
  id: ParticipantId.make("github:1"),
  login: "octocat",
  name: "octocat",
})
const dev = Participant.make({ id: ParticipantId.make("dev:alice"), login: "alice", name: "alice" })

beforeEach(() => github.reset())

const appConfig: HubConfigInput = {
  ...baseConfig,
  devLogin: true,
  githubAppId: Option.some(appId),
  githubAppPrivateKey: Option.some(Redacted.make(keys.privateKeyPem)),
  githubApiUrl: github.url,
  repoAccessTtlMs: Duration.toMillis(Duration.minutes(5)),
}

/**
 * Runs against one RepoAccess, as one Hub holds it, on a test clock set to now: the stand-in
 * checks the App JWT against the real time.
 */
const withAccess = <A, E>(
  effect: Effect.Effect<A, E, RepoAccess>,
  config: HubConfigInput = appConfig,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.now())
      return yield* effect
    }).pipe(
      Effect.provide(
        RepoAccess.layer.pipe(
          Layer.provideMerge(GitHubApp.layer),
          Layer.provide(HubConfig.layerFrom(config)),
        ),
      ),
      Effect.provide(TestClock.layer()),
    ),
  )

describe("Repo access", () => {
  test("a no is kept briefly: once the App is installed, access follows without a restart", async () => {
    github.grant(repo, "octocat")
    const answers = await withAccess(
      Effect.gen(function* () {
        const access = yield* RepoAccess
        const before = yield* access.status(octocat, repo)
        github.installedOn.add(repo)
        // Still the cached no, a moment later.
        yield* TestClock.adjust(Duration.subtract(refusedAnswerTtl, Duration.seconds(1)))
        const cached = yield* access.check(octocat, repo)
        yield* TestClock.adjust(Duration.seconds(2))
        const after = yield* access.check(octocat, repo)
        return { before, cached, after }
      }),
    )
    expect(answers).toEqual({ before: "NotInstalled", cached: false, after: true })
  })

  test("a yes is kept for the TTL, even after access is lost", async () => {
    github.installedOn.add(repo)
    github.grant(repo, "octocat")
    const answers = await withAccess(
      Effect.gen(function* () {
        const access = yield* RepoAccess
        const first = yield* access.check(octocat, repo)
        github.revoke(repo, "octocat")
        yield* TestClock.adjust(Duration.minutes(4))
        const cached = yield* access.check(octocat, repo)
        yield* TestClock.adjust(Duration.minutes(2))
        return { first, cached, after: yield* access.status(octocat, repo) }
      }),
    )
    expect(answers).toEqual({ first: true, cached: true, after: "NoAccess" })
    expect(github.collaboratorChecks("octocat")).toBe(2)
  })

  test("lists the Repos the App is on that the person has access to, kept", async () => {
    const other = RepoName.make("octo/other")
    github.installedOn.add(repo)
    github.installedOn.add(other)
    github.grant(repo, "octocat")
    const answers = await withAccess(
      Effect.gen(function* () {
        const access = yield* RepoAccess
        const first = yield* access.accessible(octocat)
        github.grant(other, "octocat")
        // Within a minute, as the stand-in checks the App JWT against the real time.
        yield* TestClock.adjust(Duration.seconds(50))
        const cached = yield* access.accessible(octocat)
        return { first, cached }
      }),
    )
    expect(answers).toEqual({ first: [repo], cached: [repo] })
    expect(github.requests.filter((r) => r.path === "/app/installations")).toHaveLength(1)
  })

  test("forget asks GitHub again at once", async () => {
    const answers = await withAccess(
      Effect.gen(function* () {
        const access = yield* RepoAccess
        const before = yield* access.status(octocat, repo)
        github.installedOn.add(repo)
        github.grant(repo, "octocat")
        yield* access.forget(octocat, repo)
        return { before, after: yield* access.status(octocat, repo) }
      }),
    )
    expect(answers).toEqual({ before: "NotInstalled", after: "Allowed" })
  })

  test("says whether the App is installed or the person has no access", async () => {
    github.installedOn.add(repo)
    const statuses = await withAccess(
      Effect.gen(function* () {
        const access = yield* RepoAccess
        return [
          yield* access.status(octocat, repo),
          yield* access.status(octocat, RepoName.make("octo/elsewhere")),
        ]
      }),
    )
    expect(statuses).toEqual(["NoAccess", "NotInstalled"])
  })

  test("a dev login has access to every Repo, and is told where the App isn't installed", async () => {
    github.installedOn.add(repo)
    const elsewhere = RepoName.make("octo/elsewhere")
    const answers = await withAccess(
      Effect.gen(function* () {
        const access = yield* RepoAccess
        return {
          check: [yield* access.check(dev, repo), yield* access.check(dev, elsewhere)],
          status: [yield* access.status(dev, repo), yield* access.status(dev, elsewhere)],
        }
      }),
    )
    expect(answers).toEqual({ check: [true, true], status: ["Allowed", "NotInstalled"] })
    // Without the App, the dev fallback: everything, as the host's credentials reach it.
    const devOnly = await withAccess(
      Effect.flatMap(RepoAccess, (access) => access.status(dev, elsewhere)),
      { ...baseConfig, devLogin: true },
    )
    expect(devOnly).toBe("Allowed")
  })

  test("a failure to ask isn't kept", async () => {
    github.installedOn.add(repo)
    github.grant(repo, "octocat")
    github.collaboratorsDown = true
    const answers = await withAccess(
      Effect.gen(function* () {
        const access = yield* RepoAccess
        const down = yield* Effect.flip(access.check(octocat, repo))
        github.collaboratorsDown = false
        return { down: down._tag, up: yield* access.check(octocat, repo) }
      }),
    )
    expect(answers).toEqual({ down: "RepoAccessUnknown", up: true })
  })
})

describe("Repo names ignoring case (#197)", () => {
  const typed = RepoName.make("OCTO/Widgets")

  test("every spelling of a Repo's name gets the same answer, asked of GitHub once", async () => {
    github.installedOn.add(repo)
    github.grant(repo, "octocat")
    const answers = await withAccess(
      Effect.gen(function* () {
        const access = yield* RepoAccess
        const first = yield* access.check(octocat, typed)
        github.revoke(repo, "octocat")
        return { first, again: yield* access.check(octocat, repo) }
      }),
    )
    expect(answers).toEqual({ first: true, again: true })
    expect(github.collaboratorChecks("octocat")).toBe(1)
  })

  test("forgetting one spelling forgets them all", async () => {
    github.installedOn.add(repo)
    const answers = await withAccess(
      Effect.gen(function* () {
        const access = yield* RepoAccess
        const before = yield* access.status(octocat, repo)
        github.grant(repo, "octocat")
        yield* access.forget(octocat, typed)
        return { before, after: yield* access.status(octocat, repo) }
      }),
    )
    expect(answers).toEqual({ before: "NoAccess", after: "Allowed" })
  })

  test("fullName is the Repo's name as GitHub spells it, whatever spelling it is asked by", async () => {
    github.installedOn.add(repo)
    const names = await withAccess(
      Effect.gen(function* () {
        const access = yield* RepoAccess
        return [yield* access.fullName(typed), yield* access.fullName(repo)]
      }),
    )
    expect(names).toEqual([Option.some(repo), Option.some(repo)])
    // Asked once: the answer is kept.
    expect(
      github.requests.filter((request) => request.path === "/repos/OCTO/Widgets"),
    ).toHaveLength(1)
    expect(
      github.requests.filter((request) => request.path === "/repos/octo/widgets"),
    ).toHaveLength(0)
  })

  test("fullName is none where the App isn't installed, or without the App", async () => {
    const notInstalled = await withAccess(
      Effect.flatMap(RepoAccess, (access) => access.fullName(typed)),
    )
    expect(notInstalled).toEqual(Option.none())
    const withoutApp = await withAccess(
      Effect.flatMap(RepoAccess, (access) => access.fullName(typed)),
      { ...baseConfig, devLogin: true },
    )
    expect(withoutApp).toEqual(Option.none())
  })
})
