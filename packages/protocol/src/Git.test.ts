import { describe, expect, test } from "bun:test"
import { GitAsk, wipRef } from "./Git.ts"
import * as Protocol from "./index.ts"
import { expectRejected, expectRoundTrips } from "./testSupport.ts"

test("the WIP ref is per Session, outside refs/heads", () => {
  expect(wipRef("s-1")).toBe("refs/kndl/wip/s-1")
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
