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
//
// It runs under the Session relay's lock, as part of it.

import {
  CommandFailed,
  type HubToRunner,
  HubToWeb,
  type Participant,
  type RunnerId,
  RunTestBuild,
  type RunnerToHub,
  TestBuildId,
  type VariableValue,
  VariablesFetched,
  VariablesRefused,
  type WebToHub,
} from "@claude-hub/protocol"
import { Clock, Effect, Option } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { EnvironmentRefused, Environments } from "./Environments.ts"
import type { Peer } from "./SessionRelay.ts"
import { Sessions } from "./Sessions.ts"
import { randomId } from "./Tokens.ts"

/**
 * TODO(#50): turn on once the web UI can set up a Repo's Environment. Until then a Repo without
 * one still gets Sessions, on the Runner's default image, or every Session would be refused.
 */
export const refuseSessionsWithoutEnvironment = false

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
}

/** A Runner online, as the relay knows it. */
export interface EnvironmentRunner {
  readonly id: RunnerId
  readonly name: string
  readonly peer: Peer<HubToRunner>
}

interface RunningTestBuild {
  readonly id: TestBuildId
  readonly repo: string
  readonly runnerId: RunnerId
  readonly startedBy: Participant
  readonly values: ReadonlyArray<VariableValue>
}

/** What the Environment relay needs of the Session relay. */
export interface EnvironmentRelayHost {
  readonly onlineRunner: (id: RunnerId) => EnvironmentRunner | undefined
  readonly toWeb: (message: HubToWeb, to: (client: EnvironmentWebClient) => boolean) => void
  /** Tells web clients the Repo's Sessions changed, as when its Environment has a new version. */
  readonly repoSessionsUpdated: (repo: string) => Effect.Effect<void, SqlError>
}

export const makeEnvironmentRelay = Effect.fnUntraced(function* (host: EnvironmentRelayHost) {
  const environments = yield* Environments
  const sessions = yield* Sessions
  const running = new Map<TestBuildId, RunningTestBuild>()

  // A Hub that restarted lost the Test builds it was running, and their drafts' values.
  yield* environments.failUnfinishedTestBuilds(yield* Clock.currentTimeMillis)

  const toStarter = (build: RunningTestBuild, message: HubToWeb) =>
    host.toWeb(message, (client) => client.you.id === build.startedBy.id)

  const endTestBuild = Effect.fn("EnvironmentRelay.endTestBuild")(function* (
    build: RunningTestBuild,
    result: "Passed" | "Failed",
    message: string | undefined,
  ) {
    running.delete(build.id)
    yield* environments.finishTestBuild(build.id, result, yield* Clock.currentTimeMillis)
    toStarter(
      build,
      HubToWeb.cases.TestBuildEnded.make({
        testBuildId: build.id,
        repo: build.repo,
        result,
        ...(message !== undefined && { message }),
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
        const prepared = yield* environments.prepare(message.repo, message.draft)
        const id = TestBuildId.make(randomId())
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
        peer.send({ ...state, requestId })
        host.toWeb(state, others)
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
        if (message._tag === "TestBuildLog") {
          return toStarter(
            build,
            HubToWeb.cases.TestBuildLogged.make({ testBuildId: build.id, data: message.data }),
          )
        }
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
   * applied Environment before its first Session (ADR 0009). See refuseSessionsWithoutEnvironment.
   */
  const missingEnvironment = Effect.fn("EnvironmentRelay.missingEnvironment")(function* (
    repo: string,
  ) {
    if (yield* environments.exists(repo)) return undefined
    return `${repo} has no Environment yet: set one up before its first Session.`
  })

  return { receiveWeb, receiveRunner, runnerGone, missingEnvironment }
})
