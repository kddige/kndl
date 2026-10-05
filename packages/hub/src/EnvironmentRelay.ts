// What the Session relay does with Environment messages (issue #47, ADR 0009): the web UI's
// commands to read and apply Environments and manage shared variables, Test builds on a Runner
// the person picks, and Runners fetching variable values.
//
// - A Test build's draft, values included, is kept in memory only, for its Runner to fetch, until
//   the Runner reports it finished or goes offline. Its log and result go to the web connections
//   of the person who started it; the result is recorded against the draft's digest.
// - A Runner gets variable values only for a Session of its own that is Active, or a Test build
//   it was sent. Values go to the Runner and nowhere else: never to the web, a log or the
//   database in plaintext.
// - A Test build's log and result are redacted (Redaction.ts) of its draft's Sensitive values
//   before they reach the web.
// - Environments follow Repo access (ADR 0003, ADR 0009, #104): the Session relay lets through only
//   the commands about a Repo the person has access to, and an Environment, a Test build's log or
//   its result goes only to connections whose person has access to its Repo. Shared variables
//   aren't any Repo's: everyone signed in may manage them, as before.
// - A Test build clones its Repo with a token the Hub mints for the one clone (SessionGit.ts), the
//   Runner asking for it with a FetchCloneAccess just before. A Runner from before that would clone
//   with its host's credentials, so with the GitHub App it gets no Test builds.
//
// It runs under the Session relay's lock, as part of it.

import {
  CommandFailed,
  type HubToRunner,
  HubToWeb,
  type Participant,
  type RepoName,
  type RunnerId,
  RunTestBuild,
  type RunnerToHub,
  TestBuildId,
  type VariableValue,
  VariablesFetched,
  VariablesRefused,
  type WebToHub,
} from "@claude-hub/protocol"
import { Clock, Effect, Option, Redacted } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { EnvironmentRefused, Environments } from "./Environments.ts"
import { needlesOf, type Needles, redactText, StreamRedactor } from "./Redaction.ts"
import type { Peer } from "./SessionRelay.ts"
import { Sessions } from "./Sessions.ts"
import { randomId } from "./Tokens.ts"

const webTags = [
  "GetEnvironment",
  "CheckEnvironmentDraft",
  "StartTestBuild",
  "ApplyEnvironment",
  "GetSharedVariables",
  "SetSharedVariable",
  "DeleteSharedVariable",
] as const

/** A web command about Environments or shared variables. */
export type EnvironmentCommand = Extract<WebToHub, { readonly _tag: (typeof webTags)[number] }>

export const isEnvironmentCommand = (message: WebToHub): message is EnvironmentCommand =>
  (webTags as ReadonlyArray<string>).includes(message._tag)

/** A Runner's message about variables or a Test build. */
export type EnvironmentReport = Extract<
  RunnerToHub,
  { readonly _tag: "FetchVariables" | "TestBuildLog" | "TestBuildFinished" }
>

/** A web connection, as the relay knows it. */
export interface EnvironmentWebClient {
  readonly you: Participant
  readonly peer: Peer<HubToWeb>
  /** Whether its person has access to each Repo, as last asked (ADR 0003). */
  readonly repos: ReadonlyMap<string, boolean>
}

/** A Runner online, as the relay knows it. */
export interface EnvironmentRunner {
  readonly id: RunnerId
  readonly name: string
  readonly peer: Peer<HubToRunner>
  /** Whether it asks how to clone a Test build (RunnerHello.asksCloneAccess). */
  readonly asksCloneAccess: boolean
}

interface RunningTestBuild {
  readonly id: TestBuildId
  readonly repo: RepoName
  readonly runnerId: RunnerId
  readonly startedBy: Participant
  readonly values: ReadonlyArray<VariableValue>
  /** Its draft's Sensitive values, to redact. */
  readonly needles: Needles
  /** Its log, redacted as it comes. */
  readonly log: StreamRedactor
  /** Whether letting go of the log's held text is scheduled. */
  flushing: boolean
}

/** What the Environment relay needs of the Session relay. */
export interface EnvironmentRelayHost {
  /** Whether the Hub has the GitHub App, to mint a Test build's clone token with. */
  readonly hasGitHubApp: boolean
  readonly onlineRunner: (id: RunnerId) => EnvironmentRunner | undefined
  readonly toWeb: (message: HubToWeb, to: (client: EnvironmentWebClient) => boolean) => void
  /** Tells web clients the Repo's Sessions changed, as when its Environment has a new version. */
  readonly repoSessionsUpdated: (repo: string) => Effect.Effect<void, SqlError>
  /** The Sensitive values of a Repo, or of every Repo when none is given, may have changed. */
  readonly sensitiveValuesChanged: (repo?: string) => void
  /** Runs `effect` under the relay's lock once `holdMillis` (Redaction.ts) have passed. */
  readonly afterHold: (effect: Effect.Effect<void>) => Effect.Effect<void>
}

/** Whether the connection's person has access to the Repo, as last asked. */
const maySee = (client: EnvironmentWebClient, repo: string) => client.repos.get(repo) === true

export const makeEnvironmentRelay = Effect.fnUntraced(function* (host: EnvironmentRelayHost) {
  const environments = yield* Environments
  const sessions = yield* Sessions
  const running = new Map<TestBuildId, RunningTestBuild>()

  // A Hub that restarted lost the Test builds it was running, and their drafts' values.
  yield* environments.failUnfinishedTestBuilds(yield* Clock.currentTimeMillis)

  const toStarter = (build: RunningTestBuild, message: HubToWeb) =>
    host.toWeb(
      message,
      (client) => client.you.id === build.startedBy.id && maySee(client, build.repo),
    )

  const endTestBuild = Effect.fn("EnvironmentRelay.endTestBuild")(function* (
    build: RunningTestBuild,
    result: "Passed" | "Failed",
    message: string | undefined,
  ) {
    running.delete(build.id)
    const held = build.log.flush()
    if (held !== "") {
      toStarter(build, HubToWeb.cases.TestBuildLogged.make({ testBuildId: build.id, data: held }))
    }
    yield* environments.finishTestBuild(build.id, result, yield* Clock.currentTimeMillis)
    toStarter(
      build,
      HubToWeb.cases.TestBuildEnded.make({
        testBuildId: build.id,
        repo: build.repo,
        result,
        ...(message !== undefined && { message: redactText(build.needles, message) }),
      }),
    )
  })

  const environmentState = Effect.fn("EnvironmentRelay.environmentState")(function* (repo: string) {
    const state = yield* environments.state(repo)
    return HubToWeb.cases.EnvironmentState.make({ repo, ...state })
  })

  const sharedVariables = Effect.map(environments.sharedVariables, (variables) =>
    HubToWeb.cases.SharedVariables.make({ variables }),
  )

  const handleWeb = Effect.fn("EnvironmentRelay.receiveWeb")(function* (
    client: EnvironmentWebClient,
    message: EnvironmentCommand,
  ) {
    const { you, peer } = client
    const { requestId } = message
    const others = (other: EnvironmentWebClient) => other.peer !== peer
    const othersWithAccess = (repo: string) => (other: EnvironmentWebClient) =>
      others(other) && maySee(other, repo)
    const at = yield* Clock.currentTimeMillis
    switch (message._tag) {
      case "GetEnvironment":
        return peer.send({ ...(yield* environmentState(message.repo)), requestId })

      case "CheckEnvironmentDraft": {
        const prepared = yield* environments.prepare(message.repo, message.draft)
        return peer.send(
          HubToWeb.cases.EnvironmentDraftChecked.make({
            requestId,
            repo: message.repo,
            needsTestBuild: prepared.changesBuild,
            testBuildPassed: yield* environments.testBuildPassed(message.repo, prepared.digest),
          }),
        )
      }

      case "StartTestBuild": {
        const runner = host.onlineRunner(message.runnerId)
        if (runner === undefined) {
          return yield* new EnvironmentRefused({
            message: `Runner ${message.runnerId} is not online.`,
          })
        }
        if (host.hasGitHubApp && !runner.asksCloneAccess) {
          return yield* new EnvironmentRefused({
            message: `${runner.name} runs an older claude-hub, which would clone the Repo with its machine's own git credentials: update it to run Test builds on it.`,
          })
        }
        const prepared = yield* environments.prepare(message.repo, message.draft)
        const id = TestBuildId.make(randomId())
        const needles = needlesOf(prepared.sensitiveValues.map(Redacted.value))
        yield* environments.recordTestBuild({
          id,
          repo: message.repo,
          runnerId: runner.id,
          digest: prepared.digest,
          startedBy: you.id,
          startedAt: at,
        })
        running.set(id, {
          id,
          repo: message.repo,
          runnerId: runner.id,
          startedBy: you,
          values: prepared.values,
          needles,
          log: new StreamRedactor(needles),
          flushing: false,
        })
        runner.peer.send(
          RunTestBuild.make({ testBuildId: id, repo: message.repo, recipe: prepared.recipe }),
        )
        return peer.send(
          HubToWeb.cases.TestBuildStarted.make({
            requestId,
            testBuild: {
              id,
              repo: message.repo,
              runnerId: runner.id,
              startedBy: you,
              startedAt: at,
            },
          }),
        )
      }

      case "ApplyEnvironment": {
        yield* environments.apply(message.repo, message.baseVersion, message.draft, you.id, at)
        const state = yield* environmentState(message.repo)
        host.sensitiveValuesChanged(message.repo)
        peer.send({ ...state, requestId })
        host.toWeb(state, othersWithAccess(message.repo))
        return yield* host.repoSessionsUpdated(message.repo)
      }

      case "GetSharedVariables":
        return peer.send({ ...(yield* sharedVariables), requestId })

      case "SetSharedVariable":
      case "DeleteSharedVariable": {
        if (message._tag === "SetSharedVariable") {
          yield* environments.setSharedVariable(message.variable, you.id, at)
        } else {
          yield* environments.deleteSharedVariable(message.name)
        }
        host.sensitiveValuesChanged()
        const shared = yield* sharedVariables
        peer.send({ ...shared, requestId })
        return host.toWeb(shared, others)
      }
    }
  })

  /** Handles a web command about Environments, answering a refusal with CommandFailed. */
  const receiveWeb = (client: EnvironmentWebClient, message: EnvironmentCommand) =>
    handleWeb(client, message).pipe(
      Effect.catchTag("EnvironmentRefused", (refused) =>
        Effect.sync(() =>
          client.peer.send(
            CommandFailed.make({
              command: message._tag,
              requestId: message.requestId,
              message: refused.message,
            }),
          ),
        ),
      ),
    )

  /** The values a Runner asks for, if they are for a Session or Test build it runs. */
  const valuesFor = Effect.fn("EnvironmentRelay.valuesFor")(function* (
    runner: EnvironmentRunner,
    message: Extract<EnvironmentReport, { readonly _tag: "FetchVariables" }>,
  ) {
    if (message.for._tag === "TestBuild") {
      const build = running.get(message.for.testBuildId)
      if (build === undefined || build.runnerId !== runner.id) {
        return yield* new EnvironmentRefused({ message: "Not a Test build this Runner runs." })
      }
      return build.values
    }
    const session = yield* sessions.get(message.for.sessionId)
    if (Option.isNone(session) || session.value.runnerId !== runner.id) {
      return yield* new EnvironmentRefused({ message: "Not a Session this Runner runs." })
    }
    if (session.value.state !== "Active") {
      return yield* new EnvironmentRefused({
        message: `The Session is ${session.value.state}: it gets no variables.`,
      })
    }
    return yield* environments.values(session.value.repo)
  })

  /** Sends the starter what of a Test build's log can be sent now, redacted. */
  const logged = Effect.fn("EnvironmentRelay.logged")(function* (
    build: RunningTestBuild,
    data: string,
  ) {
    const send = (text: string) => {
      if (text !== "") {
        toStarter(build, HubToWeb.cases.TestBuildLogged.make({ testBuildId: build.id, data: text }))
      }
    }
    send(build.log.push(data))
    if (!build.log.holding || build.flushing) return
    build.flushing = true
    yield* host.afterHold(
      Effect.sync(() => {
        build.flushing = false
        if (running.get(build.id) === build) send(build.log.flush())
      }),
    )
  })

  const receiveRunner = Effect.fn("EnvironmentRelay.receiveRunner")(function* (
    runner: EnvironmentRunner,
    message: EnvironmentReport,
  ) {
    switch (message._tag) {
      case "FetchVariables": {
        const { requestId } = message
        const reply = yield* valuesFor(runner, message).pipe(
          Effect.map((variables): HubToRunner => VariablesFetched.make({ requestId, variables })),
          Effect.catchTag("EnvironmentRefused", (refused) =>
            Effect.succeed(VariablesRefused.make({ requestId, message: refused.message })),
          ),
          Effect.catchTag("SqlError", (error) =>
            Effect.as(
              Effect.logError("Could not read variables for a Runner", error),
              VariablesRefused.make({
                requestId,
                message: "The Hub could not read them; try again.",
              }),
            ),
          ),
        )
        return runner.peer.send(reply)
      }
      case "TestBuildLog":
      case "TestBuildFinished": {
        const build = running.get(message.testBuildId)
        if (build === undefined || build.runnerId !== runner.id) {
          return yield* Effect.logWarning(
            `Runner ${runner.name} spoke of a Test build not its own`,
            message.testBuildId,
          )
        }
        if (message._tag === "TestBuildLog") return yield* logged(build, message.data)
        return yield* endTestBuild(build, message.result, message.message)
      }
    }
  })

  /** The Runner went offline: its Test builds failed. */
  const runnerGone = Effect.fn("EnvironmentRelay.runnerGone")(function* (
    runner: EnvironmentRunner,
  ) {
    for (const build of running.values()) {
      if (build.runnerId === runner.id) {
        yield* endTestBuild(build, "Failed", `${runner.name} went offline during the Test build.`)
      }
    }
  })

  /**
   * Why a Session can't be created on `repo` yet, or undefined when it can: a Repo needs an
   * applied Environment before its first Session (ADR 0009).
   */
  const missingEnvironment = Effect.fn("EnvironmentRelay.missingEnvironment")(function* (
    repo: string,
  ) {
    if (yield* environments.exists(repo)) return undefined
    return `${repo} has no Environment yet: set one up before its first Session.`
  })

  /** The Repo of a Test build the Runner runs, to clone it with; none for any other. */
  const testBuildRepo = (runner: EnvironmentRunner, testBuildId: TestBuildId) => {
    const build = running.get(testBuildId)
    return build === undefined || build.runnerId !== runner.id ? undefined : build.repo
  }

  return { receiveWeb, receiveRunner, runnerGone, missingEnvironment, testBuildRepo }
})
