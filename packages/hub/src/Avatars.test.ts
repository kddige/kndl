// Where a Participant's GitHub avatar is stored and where it comes back out: SignIns, and the
// Participants that Sessions and the Prompt queue show.

import { describe, expect, test } from "bun:test"
import { Participant, ParticipantId, PromptId, QueuedPrompt, SessionId } from "@kndl/protocol"
import { Effect, Layer, Option } from "effect"
import { DatabaseTest } from "./Database.ts"
import { PromptQueue } from "./PromptQueue.ts"
import { RunnerTokens } from "./RunnerTokens.ts"
import { Sessions } from "./Sessions.ts"
import { SignIns } from "./SignIns.ts"
import { SessionsTest } from "./testSupport.ts"

const Stores = Layer.mergeAll(
  SignIns.layer,
  RunnerTokens.layer,
  SessionsTest,
  PromptQueue.layer,
).pipe(Layer.provideMerge(DatabaseTest))

const run = <A, E>(effect: Effect.Effect<A, E, SignIns | RunnerTokens | Sessions | PromptQueue>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Stores)))

const avatarUrl = "https://avatars.githubusercontent.com/u/583231?v=4"

const octocat = Participant.make({
  id: ParticipantId.make("github:583231"),
  login: "octocat",
  name: "The Octocat",
  avatarUrl,
})

describe("avatars", () => {
  test("come back with the signed-in Participant", () =>
    run(
      Effect.gen(function* () {
        const signIns = yield* SignIns
        const { token } = yield* signIns.signIn(octocat)

        expect(yield* signIns.authenticate(token)).toEqual(Option.some(octocat))
      }),
    ))

  test("follow the latest sign-in, and are cleared when it has none", () =>
    run(
      Effect.gen(function* () {
        const signIns = yield* SignIns
        const changed = "https://avatars.githubusercontent.com/u/583231?v=5"
        yield* signIns.signIn({ ...octocat, avatarUrl: changed })
        const second = yield* signIns.signIn({ ...octocat, avatarUrl: changed })
        expect(Option.getOrThrow(yield* signIns.authenticate(second.token)).avatarUrl).toBe(changed)

        const { avatarUrl: _, ...without } = octocat
        const third = yield* signIns.signIn(without)
        const participant = Option.getOrThrow(yield* signIns.authenticate(third.token))
        expect("avatarUrl" in participant).toBe(false)
      }),
    ))

  test("show on a Session's Creator and on a queued prompt's sender", () =>
    run(
      Effect.gen(function* () {
        const signIns = yield* SignIns
        yield* signIns.signIn(octocat)
        const runnerId = (yield* (yield* RunnerTokens).issue("mac")).runnerId
        const sessions = yield* Sessions
        const sessionId = SessionId.make("s-1")
        const created = yield* sessions.create({
          id: sessionId,
          repo: "kddige/kndl",
          baseBranch: "main",
          workBranch: "claude/s-1",
          state: "Active",
          runnerId,
          runnerLogin: { account: "alice@example.com" },
          creatorId: octocat.id,
          createdAt: 1_790_000_000_000,
        })
        const queue = yield* PromptQueue
        yield* queue.add(
          sessionId,
          QueuedPrompt.make({
            id: PromptId.make("p-1"),
            text: "hello",
            sender: octocat,
            queuedAt: 1_790_000_000_001,
          }),
        )

        expect(created.creator).toEqual(octocat)
        expect((yield* sessions.list)[0]?.creator).toEqual(octocat)
        expect((yield* queue.list(sessionId))[0]?.sender).toEqual(octocat)
      }),
    ))
})
