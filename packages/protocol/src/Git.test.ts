import { describe, expect, test } from "bun:test"
import {
  GitCommitInput,
  GitPushInput,
  GitToolCall,
  GitTools,
  OpenPrInput,
  ReviewPrInput,
  wipRef,
} from "./Git.ts"
import { expectRejected, expectRoundTrips } from "./testSupport.ts"

describe("GitToolCall", () => {
  test("round-trips a call to every git tool", () => {
    expectRoundTrips(
      GitToolCall,
      GitTools.map((tool) => ({ tool, input: { message: "Add a health check" } })),
    )
  })

  test("refuses tools that aren't git tools", () => {
    expectRejected(GitToolCall, { tool: "Bash", input: {} })
    expectRejected(GitToolCall, { tool: "git_force_push", input: {} })
    expectRejected(GitToolCall, { tool: "git_commit" })
  })
})

describe("git tool inputs", () => {
  test("round-trip", () => {
    expectRoundTrips(GitCommitInput, [
      { message: "Add a health check" },
      { message: "Fix the build", paths: ["src/a.ts", "README.md"] },
      { message: "Everything", all: true },
    ])
    expectRoundTrips(GitPushInput, [{}])
    expectRoundTrips(OpenPrInput, [
      { title: "Add a health check" },
      { title: "WIP", body: "Not done yet", draft: true },
    ])
    expectRoundTrips(ReviewPrInput, [
      { number: 7, body: "Looks good" },
      { number: 7, body: "Please add a test", event: "REQUEST_CHANGES" },
    ])
  })

  test("reject what the model got wrong", () => {
    expectRejected(GitCommitInput, {})
    expectRejected(GitCommitInput, { message: "" })
    expectRejected(GitCommitInput, { message: "x", paths: "src/a.ts" })
    expectRejected(OpenPrInput, { title: "" })
    expectRejected(ReviewPrInput, { number: 1.5, body: "x" })
    expectRejected(ReviewPrInput, { number: 7, body: "x", event: "MERGE" })
  })
})

test("the WIP ref is per Session, outside refs/heads", () => {
  expect(wipRef("s-1")).toBe("refs/claude-hub/wip/s-1")
})
