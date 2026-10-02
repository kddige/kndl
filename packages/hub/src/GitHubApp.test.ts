// The GitHub App client against a stand-in GitHub API: the App JWT, installation tokens scoped
// to one Repo and cached, the bot identity, and pull requests.

import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { createPrivateKey } from "node:crypto"
import { RepoName } from "@claude-hub/protocol"
import { Duration, Effect, Layer, Option, Redacted } from "effect"
import { appJwt, GitHubApp } from "./GitHubApp.ts"
import { HubConfig } from "./HubConfig.ts"
import {
  appId,
  appKeyPair,
  appSlug,
  botUserId,
  StandInGitHub,
  verifiedJwt,
} from "./testGitHubApi.ts"
import { baseConfig } from "./testSupport.ts"

const keys = appKeyPair()
const github = StandInGitHub.start(keys.publicKey)
afterAll(() => github.stop())

const repo = RepoName.make("octo/widgets")

beforeEach(() => {
  github.reset()
  github.installedOn.add(repo)
})

const appConfig = {
  ...baseConfig,
  githubAppId: Option.some(appId),
  githubAppPrivateKey: Option.some(Redacted.make(keys.privateKeyPem)),
  githubApiUrl: github.url,
}

/** Runs against one GitHubApp, as one Hub would hold it: its cache lasts for the whole effect. */
const withApp = <A, E>(effect: Effect.Effect<A, E, GitHubApp>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(GitHubApp.layer.pipe(Layer.provide(HubConfig.layerFrom(appConfig)))),
    ),
  )

describe("the App JWT", () => {
  test("is RS256, signed with the App's key, issued by the App, and short-lived", () => {
    const nowMs = Date.now()
    const jwt = appJwt({ appId, key: createPrivateKey(keys.privateKeyPem), nowMs })
    const claims = verifiedJwt(jwt, keys.publicKey)
    const now = Math.floor(nowMs / 1000)

    expect(claims).toEqual({ iss: appId, iat: now - 60, exp: now + 540 })
    expect(verifiedJwt(jwt, appKeyPair().publicKey)).toBeUndefined()
  })
})

describe("installation tokens", () => {
  test("are minted for the Repo alone, with contents and pull requests write", async () => {
    const token = await withApp(Effect.flatMap(GitHubApp, (app) => app.repoToken(repo)))

    expect(github.mintedTokens).toEqual([Redacted.value(token.token)])
    expect(token.expiresAt).toBeGreaterThan(Date.now() + Duration.toMillis(Duration.minutes(59)))
    const [lookup, mint] = github.requests
    expect(lookup).toMatchObject({ method: "GET", path: `/repos/${repo}/installation` })
    expect(mint).toMatchObject({
      method: "POST",
      path: "/app/installations/42/access_tokens",
      body: {
        repositories: ["widgets"],
        permissions: { contents: "write", pull_requests: "write" },
      },
    })
    // Both as the App, with the JWT.
    for (const request of [lookup, mint]) {
      const jwt = request?.authorization?.replace(/^Bearer /, "") ?? ""
      expect(verifiedJwt(jwt, keys.publicKey)).toMatchObject({ iss: appId })
    }
  })

  test("are cached until five minutes before they expire", async () => {
    await withApp(
      Effect.gen(function* () {
        const app = yield* GitHubApp
        const first = yield* app.repoToken(repo)
        const again = yield* app.repoToken(repo)
        expect(Redacted.value(again.token)).toBe(Redacted.value(first.token))
        expect(github.mintCount).toBe(1)
      }),
    )

    // A token with less than five minutes left is replaced.
    github.tokenLifetimeMs = Duration.toMillis(Duration.minutes(4))
    await withApp(
      Effect.gen(function* () {
        const app = yield* GitHubApp
        const first = yield* app.repoToken(repo)
        const again = yield* app.repoToken(repo)
        expect(Redacted.value(again.token)).not.toBe(Redacted.value(first.token))
      }),
    )
    expect(github.mintCount).toBe(3)
  })

  test("are refused for a Repo the App isn't installed on, saying so", async () => {
    const error = await withApp(
      Effect.flip(Effect.flatMap(GitHubApp, (app) => app.repoToken(RepoName.make("octo/other")))),
    )
    expect(error.message).toBe(
      "The GitHub App is not installed on octo/other, or can't see it: GitHub answered 404: Not Found",
    )
    expect(github.mintCount).toBe(0)
  })

  test("never show in a token's printed form", async () => {
    const token = await withApp(Effect.flatMap(GitHubApp, (app) => app.repoToken(repo)))
    const secret = Redacted.value(token.token)
    expect(String(token.token)).not.toContain(secret)
    expect(JSON.stringify(token)).not.toContain(secret)
  })
})

describe("the bot identity", () => {
  test("is the App's bot, with its noreply address", async () => {
    const identity = await withApp(Effect.flatMap(GitHubApp, (app) => app.botIdentity(repo)))
    expect(identity).toEqual({
      name: `${appSlug}[bot]`,
      email: `${botUserId}+${appSlug}[bot]@users.noreply.github.com`,
    })
  })
})

/** Opens a pull request from `head` into main. */
const openFrom = (head: string) =>
  Effect.flatMap(GitHubApp, (app) =>
    app.openPullRequest({
      repo,
      head,
      base: "main",
      title: "Widgets",
      body: "Body",
      draft: true,
    }),
  )

describe("pull requests", () => {
  test("are opened from the Work branch, or the open one is returned", async () => {
    const opened = await withApp(openFrom("claude/s-1"))
    expect(opened).toEqual({
      number: 1,
      url: `https://github.test/${repo}/pull/1`,
      existing: false,
    })
    expect(github.pulls.get(repo)).toEqual([
      {
        number: 1,
        head: "claude/s-1",
        base: "main",
        title: "Widgets",
        body: "Body",
        draft: true,
        html_url: opened.url,
      },
    ])
    // With an installation token, not the JWT.
    const create = github.requests.find((r) => r.method === "POST" && r.path.endsWith("/pulls"))
    expect(github.mintedTokens).toContain(create?.authorization?.replace(/^Bearer /, "") ?? "")

    expect(await withApp(openFrom("claude/s-1"))).toEqual({ ...opened, existing: true })
    expect(github.pulls.get(repo)).toHaveLength(1)
  })

  test("pass on GitHub's reason when it refuses", async () => {
    const error = await withApp(Effect.flip(openFrom("main")))
    expect(error.message).toBe(
      "Could not open the pull request: GitHub answered 422: Validation Failed; No commits between main and main",
    )
  })

  test("are reviewed with the event asked for", async () => {
    await withApp(openFrom("claude/s-1"))
    const url = await withApp(
      Effect.flatMap(GitHubApp, (app) =>
        app.reviewPullRequest({ repo, number: 1, body: "Looks good", event: "APPROVE" }),
      ),
    )
    expect(url).toBe(`https://github.test/${repo}/pull/1#pullrequestreview-1`)
    expect(github.reviews).toEqual([{ repo, number: 1, body: "Looks good", event: "APPROVE" }])
  })
})

describe("without the App configured", () => {
  test("every call fails, saying what to set", async () => {
    const error = await Effect.runPromise(
      Effect.flip(Effect.flatMap(GitHubApp, (app) => app.repoToken(repo))).pipe(
        Effect.provide(GitHubApp.layer.pipe(Layer.provide(HubConfig.layerFrom(baseConfig)))),
      ),
    )
    expect(error.message).toContain("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH")
  })
})

/** Why HubConfig refuses `appConfig` with `input` over it. */
const configError = (input: Partial<typeof appConfig>) =>
  Effect.runPromise(Effect.flip(HubConfig.make({ ...appConfig, ...input })))

describe("HubConfig", () => {
  test("needs both the App id and its key", async () => {
    expect((await configError({ githubAppId: Option.none() })).message).toBe(
      "The git tools need both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH; only one is set.",
    )
    expect((await configError({ githubAppPrivateKey: Option.none() })).message).toContain(
      "only one",
    )
  })

  test("refuses a key that isn't an RSA private key, without showing it", async () => {
    const error = await configError({
      githubAppPrivateKey: Option.some(Redacted.make("not a key")),
    })
    expect(error.message).toBe("The GitHub App's private key is not a PEM key.")
  })
})
