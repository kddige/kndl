import { describe, test } from "bun:test"
import { ChildReply, ChildRequest } from "./Children.ts"
import { expectEveryTag, expectRejected, expectRoundTrips } from "./testSupport.ts"

const requests = [
  { _tag: "CreateChild", prompt: "Fix the flaky test in Hub.test.ts" },
  {
    _tag: "CreateChild",
    prompt: "Update the docs",
    name: "Docs",
    baseBranch: "claude/s-1",
  },
  { _tag: "MessageChild", childId: "s-2", text: "Also update the changelog." },
  { _tag: "ListChildren" },
  { _tag: "ReadChild", childId: "s-2" },
  { _tag: "ArchiveChild", childId: "s-2" },
  { _tag: "MessageParent", text: "Should the reference cover the deprecated v0 messages?" },
]

const child = {
  id: "s-2",
  title: "Docs",
  baseBranch: "main",
  workBranch: "claude/s-2",
  state: "Active",
  working: true,
  queued: 0,
}
const reported = { ...child, working: false, lastReport: { text: "Done.", at: 1_790_000_000_000 } }

const replies = [
  { _tag: "ChildCreated", child },
  { _tag: "ChildMessaged", child: { ...child, queued: 1 } },
  { _tag: "ChildList", children: [child, reported] },
  { _tag: "ChildList", children: [] },
  { _tag: "ChildRead", child: reported, conversation: "[Parent Session] Update the docs" },
  { _tag: "ChildArchived", child: { ...reported, state: "Archived" } },
  { _tag: "ParentMessaged", parent: { id: "s-1", title: "Release" }, working: false },
  { _tag: "ChildRefused", message: "A Child Session can't create Child Sessions." },
]

describe("ChildRequest", () => {
  test("round-trips every request", () => {
    expectEveryTag(ChildRequest, requests)
    expectRoundTrips(ChildRequest, requests)
  })

  test("rejects an empty task, and a name that isn't one", () => {
    expectRejected(ChildRequest, { _tag: "CreateChild", prompt: "" })
    expectRejected(ChildRequest, { _tag: "CreateChild", prompt: "go", name: " padded " })
    expectRejected(ChildRequest, { _tag: "CreateChild", prompt: "go", name: "x".repeat(81) })
    expectRejected(ChildRequest, { _tag: "MessageChild", childId: "s-2", text: "" })
    expectRejected(ChildRequest, { _tag: "MessageParent", text: "" })
  })
})

describe("ChildReply", () => {
  test("round-trips every reply", () => {
    expectEveryTag(ChildReply, replies)
    expectRoundTrips(ChildReply, replies)
  })
})
