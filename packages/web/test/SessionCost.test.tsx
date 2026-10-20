// What a Session has spent in all, and whose accounts pay for it.
import { expect, test } from "bun:test"
import { installDom } from "./dom.ts"

installDom()
const { accountsOf, accountsPay, sentence } = await import("../src/app/copy.ts")
const { sessionCost } = await import("../src/session/SessionCost.tsx")

const spent = (cost: number) => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost })

test("the Creator's accounts are yours, and anyone else's are named, in every place that says it", () => {
  const session = { creator: { id: "u-1", name: "Alice" } }
  expect(accountsOf(session, { id: "u-1" })).toBe("your accounts")
  expect(accountsOf(session, { id: "u-2" })).toBe("Alice's accounts")
  expect(accountsOf(session, null)).toBe("Alice's accounts")
  expect(accountsPay(session, { id: "u-1" })).toBe("Your accounts pay")
  expect(accountsPay(session, { id: "u-2" })).toBe("Alice's accounts pay")
})

test("a reason becomes a sentence with a space after it, once", () => {
  expect(sentence("The Session has no such thread.")).toBe("The Session has no such thread. ")
  expect(sentence("the connection dropped")).toBe("the connection dropped. ")
})

test("the Session's cost is its main conversation's, its threads' and its agents' together", () => {
  const transcript = {
    usage: spent(0.4),
    threads: new Map([
      ["thr-1", { threadId: "thr-1", title: "What about Windows?", usage: spent(0.1) }],
      ["thr-2", { threadId: "thr-2", title: "Never spent", usage: undefined }],
    ]),
    agents: new Map([["a-1", { agentId: "a-1", description: "Search", usage: spent(0.25) }]]),
  }
  const { total, parts } = sessionCost(transcript as never)
  expect(total).toBeCloseTo(0.75)
  expect(parts).toEqual([
    { id: "main", label: "Main conversation", cost: 0.4 },
    { id: "thread-thr-1", label: "Thread: What about Windows?", cost: 0.1 },
    { id: "agent-a-1", label: "Agent: Search", cost: 0.25 },
  ])
  expect(sessionCost({ usage: undefined, threads: new Map(), agents: new Map() })).toEqual({
    total: 0,
    parts: [],
  })
})
