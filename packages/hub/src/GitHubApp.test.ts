// The GitHub App client against a stand-in GitHub API: the App JWT, installation tokens scoped
// to one Repo (cached for host git, fresh for each Sandbox), the bot identity, who is a Repo's
// collaborator, the App's and its installations' permissions, and trading a manifest's code for a
// new App's credentials.

import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { createPrivateKey } from "node:crypto"
import { RepoName } from "@claude-hub/protocol"
import { Duration, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { appJwt, convertManifest, GitHubApp } from "./GitHubApp.ts"
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
  test("for host git are minted for the Repo alone, with contents write only", async () => {
    const token = await withApp(Effect.flatMap(GitHubApp, (app) => app.repoToken(repo)))

    expect(github.mintedTokens).toEqual([Redacted.value(token.token)])
    expect(token.expiresAt).toBeGreaterThan(Date.now() + Duration.toMillis(Duration.minutes(59)))
    const [lookup, mint] = github.requests
    expect(lookup).toMatchObject({ method: "GET", path: `/repos/${repo}/installation` })
    expect(mint).toMatchObject({
      method: "POST",
      path: "/app/installations/42/access_tokens",
      body: { repositories: ["widgets"], permissions: { contents: "write" } },
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

  test("for a Sandbox are minted for the Repo alone, with no permissions list", async () => {
    const token = await withApp(Effect.flatMap(GitHubApp, (app) => app.sandboxToken(repo)))

    expect(github.mintedTokens).toEqual([Redacted.value(token.token)])
    expect(token.expiresAt).toBeGreaterThan(Date.now() + Duration.toMillis(Duration.minutes(59)))
    const mint = github.requests.find((request) => request.path.endsWith("/access_tokens"))
    // Without `permissions`, GitHub grants every permission the installation has.
    expect(mint?.body).toEqual({ repositories: ["widgets"] })
  })

  test("for a Sandbox are fresh each time, and never the host's", async () => {
    await withApp(
      Effect.gen(function* () {
        const app = yield* GitHubApp
        const host = yield* app.repoToken(repo)
        const first = yield* app.sandboxToken(repo)
        const second = yield* app.sandboxToken(repo)
        const values = [host, first, second].map((token) => Redacted.value(token.token))
        expect(new Set(values).size).toBe(3)
        // The host's cached token is still the one it had.
        expect(Redacted.value((yield* app.repoToken(repo)).token)).toBe(Redacted.value(host.token))
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

const isCollaborator = (login: string) =>
  withApp(Effect.flatMap(GitHubApp, (app) => app.isCollaborator(repo, login)))

describe("collaborators", () => {
  test("are asked about as the Repo's installation", async () => {
    github.grant(repo, "octocat")
    expect(await isCollaborator("octocat")).toBe(true)
    expect(await isCollaborator("hubot")).toBe(false)
    expect(github.collaboratorChecks()).toBe(2)
  })

  test("can't be asked about on a Repo the App isn't installed on: a 404", async () => {
    const error = await withApp(
      Effect.flip(
        Effect.flatMap(GitHubApp, (app) => app.isCollaborator(RepoName.make("octo/other"), "x")),
      ),
    )
    expect(error.status).toBe(404)
  })

  test("are unknown when GitHub can't say, with its status", async () => {
    github.collaboratorsDown = true
    const error = await withApp(
      Effect.flip(Effect.flatMap(GitHubApp, (app) => app.isCollaborator(repo, "octocat"))),
    )
    expect(error.status).toBe(503)
    expect(error.message).toBe(
      "Could not check octocat's access to octo/widgets: GitHub answered 503: Service Unavailable",
    )
  })
})

describe("a Repo's default branch", () => {
  test("is asked for as the Repo's installation", async () => {
    github.defaultBranches.set(repo, "trunk")
    expect(await withApp(Effect.flatMap(GitHubApp, (app) => app.defaultBranch(repo)))).toBe("trunk")
    const asked = github.requests.find((request) => request.path === `/repos/${repo}`)
    expect(asked?.authorization).toStartWith("Bearer ghs_standin")
  })

  test("can't be asked for on a Repo the App isn't installed on", async () => {
    const error = await withApp(
      Effect.flip(
        Effect.flatMap(GitHubApp, (app) => app.defaultBranch(RepoName.make("octo/other"))),
      ),
    )
    expect(error.message).toContain("octo/other")
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
    const sandbox = await Effect.runPromise(
      Effect.flip(Effect.flatMap(GitHubApp, (app) => app.sandboxToken(repo))).pipe(
        Effect.provide(GitHubApp.layer.pipe(Layer.provide(HubConfig.layerFrom(baseConfig)))),
      ),
    )
    expect(sandbox.message).toContain("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH")
  })

  test("has no pull request calls: gh in the Sandbox makes those (#73)", () => {
    expect(Object.keys(GitHubApp.unconfigured).toSorted()).toEqual(
      [
        "botIdentity",
        "checkPermissions",
        "cloneToken",
        "defaultBranch",
        "installUrl",
        "isCollaborator",
        "isConfigured",
        "isInstalled",
        "repoToken",
        "sandboxToken",
      ].toSorted(),
    )
  })
})

const checkPermissions = () => withApp(Effect.flatMap(GitHubApp, (app) => app.checkPermissions))

describe("the permission check", () => {
  test("finds nothing when the App and its installation have all it needs", async () => {
    const check = await checkPermissions()
    expect(check).toMatchObject({
      slug: appSlug,
      settingsUrl: `https://github.com/settings/apps/${appSlug}/permissions`,
      installUrl: `https://github.com/apps/${appSlug}/installations/new`,
      missing: [],
      installed: 1,
      installations: [],
    })
    // Both as the App.
    expect(github.requests.map((request) => request.path)).toEqual(["/app", "/app/installations"])
    for (const request of github.requests) {
      const jwt = request.authorization?.replace(/^Bearer /, "") ?? ""
      expect(verifiedJwt(jwt, keys.publicKey)).toMatchObject({ iss: appId })
    }
  })

  test("finds what the App lacks, and an installation that hasn't accepted it", async () => {
    github.appPermissions = { contents: "write", metadata: "read", pull_requests: "write" }
    github.installations.push({
      id: 43,
      account: "octo",
      accountType: "Organization",
      permissions: { contents: "read", metadata: "read" },
      events: [],
      suspended: false,
    })
    const check = await checkPermissions()
    expect(check.missing).toEqual([{ name: "issues", title: "Issues", access: "write" }])
    expect(check.installed).toBe(2)
    expect(check.installations).toEqual([
      {
        id: 43,
        account: "octo",
        reviewUrl:
          "https://github.com/organizations/octo/settings/installations/43/permissions/update",
        missing: [
          { name: "contents", title: "Contents", access: "write" },
          { name: "pull_requests", title: "Pull requests", access: "write" },
          { name: "issues", title: "Issues", access: "write" },
        ],
        missingEvents: [],
      },
    ])
  })

  test("reads every page of installations", async () => {
    for (let id = 100; id < 250; id++) {
      github.installations.push({
        id,
        account: `user${id}`,
        accountType: "User",
        permissions: { metadata: "read" },
        events: [],
        suspended: false,
      })
    }
    const check = await checkPermissions()
    expect(check.installed).toBe(151)
    expect(check.installations.map((installation) => installation.id)).toContain(249)
    expect(github.requests.map((request) => request.path)).toEqual([
      "/app",
      "/app/installations",
      "/app/installations",
    ])
  })

  test("fails with GitHub's status when it can't say", async () => {
    github.appDown = true
    const error = await withApp(
      Effect.flip(Effect.flatMap(GitHubApp, (app) => app.checkPermissions)),
    )
    expect(error.status).toBe(503)
    expect(error.message).toBe(
      "Could not read the GitHub App's permissions: GitHub answered 503: Service Unavailable",
    )
  })
})

const convert = (code: string) =>
  Effect.runPromise(convertManifest(code, github.url).pipe(Effect.provide(FetchHttpClient.layer)))

describe("the manifest conversion", () => {
  test("trades a code for the new App's credentials, with none of its own", async () => {
    const { code, conversion } = github.registerApp()
    const converted = await convert(code)
    expect(converted).toMatchObject({
      id: conversion.id,
      slug: conversion.slug,
      htmlUrl: `https://github.com/apps/${conversion.slug}`,
      owner: "kddige",
      clientId: conversion.clientId,
    })
    expect(Redacted.value(converted.clientSecret)).toBe(conversion.clientSecret)
    expect(Redacted.value(converted.pem)).toBe(conversion.pem)
    expect(Option.isNone(converted.webhookSecret)).toBe(true)
    const [request] = github.requests
    expect(request).toMatchObject({ method: "POST", path: `/app-manifests/${code}/conversions` })
    expect(request?.authorization ?? undefined).toBeUndefined()
  })

  test("hands over the webhook secret when GitHub made one", async () => {
    const { code } = github.registerApp({ webhookSecret: "whsec" })
    const converted = await convert(code)
    expect(Option.map(converted.webhookSecret, Redacted.value)).toEqual(Option.some("whsec"))
  })

  test("never shows the secrets in its printed form", async () => {
    const { code, conversion } = github.registerApp()
    const printed = JSON.stringify(await convert(code))
    expect(printed).not.toContain(conversion.clientSecret)
    expect(printed).not.toContain("PRIVATE KEY")
  })

  test("refuses a code that was used, or never was, with GitHub's words", async () => {
    const { code } = github.registerApp()
    await convert(code)
    const error = await Effect.runPromise(
      Effect.flip(convertManifest(code, github.url)).pipe(Effect.provide(FetchHttpClient.layer)),
    )
    expect(error.status).toBe(404)
    expect(error.message).toBe(
      "GitHub didn't hand over the new App's credentials: GitHub answered 404: Not Found",
    )
  })
})

/** Why HubConfig refuses `appConfig` with `input` over it. */
const configError = (input: Partial<typeof appConfig>) =>
  Effect.runPromise(Effect.flip(HubConfig.make({ ...appConfig, ...input })))

describe("HubConfig", () => {
  test("needs both the App id and its key", async () => {
    expect((await configError({ githubAppId: Option.none() })).message).toBe(
      "The GitHub App needs both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH; only one is set.",
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
