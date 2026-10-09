// Environments follow Repo access (#104, ADR 0003, ADR 0009): Environment commands need access to
// the Repo, a Test build clones with a token the Hub mints for it, and the web can check a Repo as
// it is entered. A real Hub, web clients and fake Runners over WebSockets, against the stand-in
// GitHub API.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { DefaultEnvironmentDraft, Participant, ParticipantId } from "@kndl/protocol"
import { Effect, Option, Redacted } from "effect"
import { signInCookie } from "./Auth.ts"
import type { HubConfigInput } from "./HubConfig.ts"
import { SignIns } from "./SignIns.ts"
import {
  type Connection,
  issueRunnerToken,
  openRunner,
  openWeb,
  stopAll,
  type ToRunner,
  type Web,
} from "./testChannels.ts"
import { appId, appKeyPair, appSlug, StandInGitHub, webUrl } from "./testGitHubApi.ts"
import { seedEnvironment, startHub, type TestHub } from "./testSupport.ts"

afterEach(stopAll)

const keys = appKeyPair()
let github: StandInGitHub
beforeAll(() => {
  github = StandInGitHub.start(keys.publicKey)
})
afterAll(() => github.stop())

const repo = "kddige/kndl"
const secret = "kddige/secret"
const missing = "kddige/no-such-repo"
const octocat = { id: "github:1", login: "octocat", name: "octocat" }
const installUrl = `${webUrl}/apps/${appSlug}/installations/new`

/** A Hub with the GitHub App on `repo` and `secret`, octocat a collaborator on `repo` only. */
async function accessHub(config: Partial<HubConfigInput> = {}) {
  github.reset()
  github.installedOn.add(repo)
  github.installedOn.add(secret)
  github.grant(repo, "octocat")
  const hub = await startHub({
    config: {
      devLogin: true,
      githubAppId: Option.some(appId),
      githubAppPrivateKey: Option.some(Redacted.make(keys.privateKeyPem)),
      githubApiUrl: github.url,
      ...config,
    },
  })
  const issued = await issueRunnerToken(hub)
  const runner = await openRunner(hub, issued.token)
  return { hub, runner, runnerId: issued.runnerId, runnerToken: issued.token }
}

/** A web client signed in with GitHub as octocat. */
async function openOctocat(hub: TestHub) {
  const { token } = await hub.run(
    Effect.gen(function* () {
      const signIns = yield* SignIns
      return yield* signIns.signIn(
        Participant.make({ ...octocat, id: ParticipantId.make(octocat.id) }),
      )
    }),
  )
  return openWeb(hub, octocat.login, `${signInCookie}=${token}`)
}

let requests = 0
const nextRequest = () => `q-${++requests}`

/** Sends `command` with a fresh request id, and returns the Hub's answer to it. */
async function ask(web: Connection<Web>, command: Record<string, unknown> & { _tag: string }) {
  const requestId = nextRequest()
  web.send({ ...command, requestId })
  return web.takeWhere(
    (message): message is Web => "requestId" in message && message.requestId === requestId,
    `answer to ${command._tag}`,
  )
}

/** The answer to a Runner's FetchCloneAccess for the Test build. */
async function cloneAccess(runner: Connection<ToRunner>, testBuildId: string) {
  const requestId = `clone-${++requests}`
  runner.send({ _tag: "FetchCloneAccess", requestId, testBuildId })
  return (await runner.take("GitReply", (reply) => reply.requestId === requestId)).answer
}

/** What the Hub refuses a command about a Repo out of reach with, whether it exists or not. */
const noAccess = (command: string, about: string) => ({
  _tag: "CommandFailed" as const,
  command,
  requestId: expect.any(String),
  message: `You have no access to ${about} on GitHub, or the GitHub App isn't installed on it.`,
})

describe("Environment commands", () => {
  test("are refused without Repo access, alike whether the Repo exists or not", async () => {
    const { hub, runner, runnerId } = await accessHub()
    const web = await openOctocat(hub)
    for (const about of [secret, missing]) {
      const commands = [
        { _tag: "GetEnvironment", repo: about },
        { _tag: "CheckEnvironmentDraft", repo: about, draft: DefaultEnvironmentDraft },
        { _tag: "StartTestBuild", repo: about, runnerId, draft: DefaultEnvironmentDraft },
        {
          _tag: "ApplyEnvironment",
          repo: about,
          baseVersion: null,
          draft: DefaultEnvironmentDraft,
        },
      ]
      for (const command of commands) {
        expect(await ask(web, command)).toEqual(noAccess(command._tag, about))
      }
    }
    // No Test build reached the Runner.
    expect(await runner.untaken("RunTestBuild")).toEqual([])
  })

  test("are let through with Repo access, and shared variables need none", async () => {
    const { hub, runner, runnerId } = await accessHub()
    const web = await openOctocat(hub)
    expect(await ask(web, { _tag: "GetEnvironment", repo })).toMatchObject({
      _tag: "EnvironmentState",
      repo,
    })
    expect(
      await ask(web, {
        _tag: "StartTestBuild",
        repo,
        runnerId,
        draft: DefaultEnvironmentDraft,
      }),
    ).toMatchObject({ _tag: "TestBuildStarted" })
    await runner.take("RunTestBuild")
    expect(await ask(web, { _tag: "GetSharedVariables" })).toMatchObject({
      _tag: "SharedVariables",
    })
  })

  test("dev login has access to every Repo's Environment", async () => {
    const { hub } = await accessHub()
    const web = await openWeb(hub, "alice")
    for (const about of [repo, secret, missing]) {
      expect(await ask(web, { _tag: "GetEnvironment", repo: about })).toMatchObject({
        _tag: "EnvironmentState",
        repo: about,
      })
    }
  })

  test("a person who loses access loses the Repo's Environment", async () => {
    const { hub } = await accessHub({ repoAccessTtlMs: 100 })
    const alice = await openWeb(hub, "alice")
    await seedEnvironment(hub, repo, "dev:alice")
    const web = await openOctocat(hub)
    expect((await ask(web, { _tag: "GetEnvironment", repo }))._tag).toBe("EnvironmentState")
    /** alice applies a new version of the Environment, which changes no build. */
    let version = 1
    const applyNew = async () => {
      const draft = {
        ...DefaultEnvironmentDraft,
        resources: { cpus: 2 + version, memoryMib: 4096 },
      }
      const applied = await ask(alice, {
        _tag: "ApplyEnvironment",
        repo,
        baseVersion: version,
        draft,
      })
      expect(applied).toMatchObject({ _tag: "EnvironmentState" })
      version += 1
    }
    await applyNew()
    expect((await web.take("EnvironmentState")).environment?.version).toBe(2)

    github.revoke(repo, "octocat")
    expect(await web.take("RepoAccessLost")).toEqual({ _tag: "RepoAccessLost", repo })
    expect(await ask(web, { _tag: "GetEnvironment", repo })).toEqual(
      noAccess("GetEnvironment", repo),
    )

    // A new version of it no longer reaches them.
    await applyNew()
    expect(await web.untaken("EnvironmentState")).toEqual([])
  })
})

describe("Test builds", () => {
  test("clone with a read-only token minted for the Repo, not the host's credentials", async () => {
    const { hub, runner, runnerId } = await accessHub()
    const web = await openOctocat(hub)
    await ask(web, { _tag: "StartTestBuild", repo, runnerId, draft: DefaultEnvironmentDraft })
    const run = await runner.take("RunTestBuild")
    const minted = github.mintCount

    const answer = await cloneAccess(runner, run.testBuildId)
    expect(answer).toMatchObject({
      _tag: "CloneAccess",
      credentials: { _tag: "CloneToken", expiresAt: expect.any(Number) },
    })
    // A token of its own, just minted.
    expect(github.mintCount).toBe(minted + 1)
    const token = JSON.stringify(answer).match(/ghs_standin\w+/)?.[0]
    expect(github.mintedTokens).toContain(token ?? "none")
    const mint = github.requests.findLast((request) => request.path.endsWith("/access_tokens"))
    expect(mint?.body).toEqual({ repositories: ["kndl"], permissions: { contents: "read" } })

    // Not for a Test build that isn't the Runner's.
    expect(await cloneAccess(runner, "not-a-test-build")).toEqual({
      _tag: "GitFailed",
      message: "Not a Test build this Runner runs.",
    })
  })

  test("clone with the host's credentials only when the Hub has no GitHub App", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    const issued = await issueRunnerToken(hub)
    const runner = await openRunner(hub, issued.token)
    const web = await openWeb(hub, "alice")
    await ask(web, {
      _tag: "StartTestBuild",
      repo,
      runnerId: issued.runnerId,
      draft: DefaultEnvironmentDraft,
    })
    const run = await runner.take("RunTestBuild")
    expect(await cloneAccess(runner, run.testBuildId)).toEqual({
      _tag: "CloneAccess",
      credentials: { _tag: "HostCredentials" },
    })
  })

  test("without the App installed on the Repo, fail before cloning, saying so", async () => {
    const { hub, runner, runnerId } = await accessHub()
    const web = await openWeb(hub, "alice")

    // Refused before it starts.
    expect(
      await ask(web, {
        _tag: "StartTestBuild",
        repo: missing,
        runnerId,
        draft: DefaultEnvironmentDraft,
      }),
    ).toMatchObject({
      _tag: "CommandFailed",
      message: `The GitHub App isn't installed on ${missing}, so a Test build can't clone it: install the App on the Repo, then try again.`,
    })
    expect(await runner.untaken("RunTestBuild")).toEqual([])

    // And, uninstalled once it has, when the Runner asks to clone.
    await ask(web, {
      _tag: "StartTestBuild",
      repo: secret,
      runnerId,
      draft: DefaultEnvironmentDraft,
    })
    const run = await runner.take("RunTestBuild")
    github.installedOn.delete(secret)
    expect(await cloneAccess(runner, run.testBuildId)).toEqual({
      _tag: "GitFailed",
      message: expect.stringContaining(`The GitHub App is not installed on ${secret}`),
    })
  })

  test("aren't sent to an older Runner, which would clone with its host's credentials", async () => {
    const { hub } = await accessHub()
    const older = await issueRunnerToken(hub, "old")
    const oldRunner = await openRunner(hub, older.token, [], undefined, false)
    const web = await openWeb(hub, "alice")
    expect(
      await ask(web, {
        _tag: "StartTestBuild",
        repo,
        runnerId: older.runnerId,
        draft: DefaultEnvironmentDraft,
      }),
    ).toMatchObject({
      _tag: "CommandFailed",
      message: expect.stringContaining("runs an older kndl"),
    })
    expect(await oldRunner.untaken("RunTestBuild")).toEqual([])
  })
})

describe("Checking a Repo", () => {
  test("says whether the person has access, and if not, why", async () => {
    const { hub } = await accessHub()
    const web = await openOctocat(hub)
    expect(await ask(web, { _tag: "CheckRepo", repo })).toEqual({
      _tag: "RepoChecked",
      requestId: expect.any(String),
      repo,
      status: "Allowed",
    })
    expect(await ask(web, { _tag: "CheckRepo", repo: secret })).toMatchObject({
      status: "NoAccess",
    })
    expect(await ask(web, { _tag: "CheckRepo", repo: missing })).toEqual({
      _tag: "RepoChecked",
      requestId: expect.any(String),
      repo: missing,
      status: "NotInstalled",
      installUrl,
    })
  })

  test("is cached, and asked of GitHub again when fresh", async () => {
    const { hub } = await accessHub()
    const web = await openOctocat(hub)
    expect(await ask(web, { _tag: "CheckRepo", repo: missing })).toMatchObject({
      status: "NotInstalled",
    })
    github.installedOn.add(missing)
    github.grant(missing, "octocat")
    expect(await ask(web, { _tag: "CheckRepo", repo: missing })).toMatchObject({
      status: "NotInstalled",
    })
    expect(await ask(web, { _tag: "CheckRepo", repo: missing, fresh: true })).toMatchObject({
      status: "Allowed",
    })
  })

  test("a dev login has access, and hears whether the App is installed", async () => {
    const { hub } = await accessHub()
    const web = await openWeb(hub, "alice")
    expect(await ask(web, { _tag: "CheckRepo", repo: secret })).toMatchObject({
      status: "Allowed",
    })
    expect(await ask(web, { _tag: "CheckRepo", repo: missing })).toMatchObject({
      status: "NotInstalled",
      installUrl,
    })
    // Without the App, every Repo.
    const devHub = await startHub({ config: { devLogin: true } })
    const devWeb = await openWeb(devHub, "alice")
    expect(await ask(devWeb, { _tag: "CheckRepo", repo: missing })).toMatchObject({
      status: "Allowed",
    })
  })
})

/** Gives `about` its first Environment, applied by alice, who signs in to do so. */
async function seed(hub: TestHub, about: string) {
  const alice = await openWeb(hub, "alice")
  await seedEnvironment(hub, about, "dev:alice")
  return alice
}

describe("Repo names ignoring case (#197)", () => {
  const pep = "Entria-io/PEP"
  const typed = "entria-io/pep"

  /** accessHub, with the App on `pep` too, as GitHub spells it, octocat a collaborator on it. */
  async function pepHub() {
    const scene = await accessHub()
    github.installedOn.add(pep)
    github.grant(pep, "octocat")
    return scene
  }

  test("another spelling finds the Repo's Environment, and its access", async () => {
    const { hub } = await pepHub()
    await seed(hub, pep)
    const web = await openOctocat(hub)
    expect(await ask(web, { _tag: "GetEnvironment", repo: typed })).toMatchObject({
      _tag: "EnvironmentState",
      environment: { repo: pep, version: 1 },
    })
    expect(await ask(web, { _tag: "GetEnvironment", repo: pep })).toMatchObject({
      environment: { repo: pep, version: 1 },
    })
    // Asked of GitHub once for both spellings.
    expect(github.collaboratorChecks("octocat")).toBe(1)
  })

  test("a Session is created under GitHub's spelling, on the Repo's Environment", async () => {
    const { hub, runner } = await pepHub()
    await seed(hub, pep)
    const web = await openOctocat(hub)
    const created = await ask(web, {
      _tag: "CreateSession",
      repo: typed,
      branch: { _tag: "Existing", name: "main", newWorkBranch: true },
    })
    expect(created).toMatchObject({ _tag: "SessionCreated", session: { repo: pep } })
    expect(await runner.take("StartSession")).toMatchObject({
      repo: pep,
      environment: { version: 1 },
    })
  })

  test("an Environment applied by another spelling is the Repo's one, under the spelling it is stored by", async () => {
    const { hub } = await pepHub()
    // From before #197: stored as it was typed.
    await seed(hub, typed)
    const web = await openOctocat(hub)
    const applied = await ask(web, {
      _tag: "ApplyEnvironment",
      repo: "ENTRIA-IO/Pep",
      baseVersion: 1,
      draft: { ...DefaultEnvironmentDraft, resources: { cpus: 3, memoryMib: 4096 } },
    })
    expect(applied).toMatchObject({
      _tag: "EnvironmentState",
      environment: { repo: typed, version: 2 },
    })
  })

  test("without the App, a Session is created under the spelling its Environment is stored by", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    const issued = await issueRunnerToken(hub)
    const runner = await openRunner(hub, issued.token)
    const web = await seed(hub, pep)
    const created = await ask(web, {
      _tag: "CreateSession",
      repo: typed,
      branch: { _tag: "Existing", name: "main", newWorkBranch: true },
    })
    expect(created).toMatchObject({ _tag: "SessionCreated", session: { repo: pep } })
    expect(await runner.take("StartSession")).toMatchObject({ repo: pep })
    // A Repo with no Environment keeps the name as typed.
    expect(
      await ask(web, {
        _tag: "CreateSession",
        repo: "Octo/Unseen",
        branch: { _tag: "Existing", name: "main", newWorkBranch: true },
      }),
    ).toMatchObject({
      _tag: "CommandFailed",
      message: "Octo/Unseen has no Environment yet: set one up before its first Session.",
    })
  })

  test("access learned by one spelling lets a person see the Sessions of another", async () => {
    const { hub } = await pepHub()
    const alice = await seed(hub, pep)
    const web = await openOctocat(hub)
    expect(await ask(web, { _tag: "CheckRepo", repo: typed })).toMatchObject({
      status: "Allowed",
    })
    await ask(alice, {
      _tag: "CreateSession",
      repo: pep,
      branch: { _tag: "Existing", name: "main", newWorkBranch: true },
    })
    expect((await web.take("SessionUpdated")).session.repo).toBe(pep)
    expect(github.collaboratorChecks("octocat")).toBe(1)
  })
})
