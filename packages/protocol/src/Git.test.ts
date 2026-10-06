import { describe, expect, test } from "bun:test"
import { GitAsk } from "./Git.ts"
import * as Protocol from "./index.ts"
import { HubToRunner, RunnerToHub } from "./Runner.ts"
import { expectRejected, expectRoundTrips } from "./testSupport.ts"
import { HubToWeb, SessionEvent } from "./Web.ts"

describe("the WIP ref (#194) is gone", () => {
  test("no channel carries its messages, which a peer from before drops", () => {
    expectRejected(HubToRunner, { _tag: "SessionTurnEnded", sessionId: "s-1" })
    expectRejected(RunnerToHub, { _tag: "WipPushFailed", sessionId: "s-1", message: "x" })
    expectRejected(SessionEvent, { _tag: "WipNotPushed", message: "x" })
    expectRejected(HubToWeb, {
      _tag: "SessionEventLogged",
      sessionId: "s-1",
      entry: { seq: 0, at: 1, event: { _tag: "WipNotPushed", message: "x" } },
    })
  })

  test("the protocol exports none of it", () => {
    for (const name of ["SessionTurnEnded", "WipPushFailed", "WipNotPushed", "wipRef"])
      expect(Object.keys(Protocol)).not.toContain(name)
  })
})

describe("the git tools (#13) are gone", () => {
  test("the Runner can ask only for Repo access and a Sandbox token", () => {
    expectRoundTrips(GitAsk, [{ _tag: "GitAccess" }, { _tag: "SandboxToken" }])
    expectRejected(GitAsk, { _tag: "CoAuthors" })
    expectRejected(GitAsk, { _tag: "OpenPullRequest", title: "x", body: "", draft: false })
    expectRejected(GitAsk, { _tag: "ReviewPullRequest", number: 1, body: "x", event: "COMMENT" })
  })

  test("the protocol exports none of their messages", () => {
    for (const name of [
      "GitTools",
      "GitToolCall",
      "GitCommitInput",
      "GitPushInput",
      "OpenPrInput",
      "ReviewPrInput",
      "ReviewEvent",
      "CoAuthorsCommitted",
    ])
      expect(Object.keys(Protocol)).not.toContain(name)
  })
})
