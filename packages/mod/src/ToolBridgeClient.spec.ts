import { describe, expect, test } from "bun:test"
import { MaxToolWaitMs } from "@claude-hub/protocol"
import {
  callDeadlineMs,
  newCallId,
  ReadBeforeEdit,
  runInSandbox,
  TimeoutGraceMs,
} from "./ToolBridgeClient.ts"
import type { BridgeExchange, BridgeRequest, RunOptions } from "./ToolBridgeClient.ts"

const socket = "/sessions/s1/tools.sock"
const callId = "toolu_1-abcd1234"

type Answer = { status: number; text: string }
const reply = (status: number, value: unknown): Answer => ({ status, text: JSON.stringify(value) })
const ran = (result: unknown) => reply(200, { _tag: "ToolRan", result })
const running = reply(202, { _tag: "ToolRunning", callId })

/** A bridge that answers each request with `answer`, noting the requests. */
const bridge = (answer: (request: BridgeRequest, index: number) => Answer | Promise<Answer>) => {
  const requests: Array<BridgeRequest> = []
  const exchange: BridgeExchange = async (socketPath, request) => {
    expect(socketPath).toBe(socket)
    requests.push(request)
    return answer(request, requests.length - 1)
  }
  return { exchange, requests }
}

/** How long a request asks to wait, in milliseconds. */
const waitMsOf = (request: BridgeRequest) =>
  Number(new URL(`http://bridge${request.path}`).searchParams.get("waitMs") ?? 0)

const run = (
  exchange: BridgeExchange,
  input: Record<string, unknown> = { command: "bun test" },
  options: Partial<RunOptions> = {},
  socketPath: string | null = socket,
) => runInSandbox(exchange, socketPath ?? undefined, "Bash", input, { callId, ...options })

/** The tool did not run, and the model is told so. */
const expectDidNotRun = (answer: Awaited<ReturnType<typeof run>>) => {
  expect(answer._tag).toBe("Refused")
  if (answer._tag !== "Ran") {
    expect(answer.message).toContain("did not run at all")
    expect(answer.message).toContain("never runs on the host")
  }
}

/** The tool may have run, and the model is told to check before running it again. */
const expectMayHaveRun = (answer: Awaited<ReturnType<typeof run>>) => {
  expect(answer._tag).toBe("Lost")
  if (answer._tag !== "Ran") {
    expect(answer.message).toContain("may have run")
    expect(answer.message).toMatch(/check before running it again/i)
    expect(answer.message).not.toContain("did not run")
    expect(answer.message).toContain("never runs on the host")
  }
}

/** A Runner from before long calls: it knows only `POST /tools/call`. */
const older = (legacy: () => Answer) =>
  bridge((request) =>
    request.path === "/tools/call" ? legacy() : { status: 404, text: "not found" },
  )

describe("runInSandbox", () => {
  test("starts the call on the socket, and hands back the tool's record", async () => {
    const { exchange, requests } = bridge(() => ran({ stdout: "hi" }))
    const answer = await run(exchange, { command: "echo hi" })
    expect(answer).toEqual({ _tag: "Ran", result: { stdout: "hi" } })
    expect(requests).toEqual([
      {
        method: "POST",
        path: `/tools/calls?waitMs=${MaxToolWaitMs}`,
        body: JSON.stringify({ callId, tool: "Bash", input: { command: "echo hi" } }),
      },
    ])
  })

  test("a 45-second call is waited for in steps no fetch gives up on", async () => {
    let clock = 0
    const { exchange, requests } = bridge((request) => {
      if (request.method === "DELETE") throw new Error("must not cancel")
      clock = Math.min(clock + waitMsOf(request), 45_000)
      return clock >= 45_000 ? ran({ stdout: "149 pass" }) : running
    })
    const answer = await run(exchange, { command: "bun test" }, { now: () => clock })
    expect(answer).toEqual({ _tag: "Ran", result: { stdout: "149 pass" } })
    expect(requests.map((request) => request.method)).toEqual(["POST", "GET", "GET"])
    expect(requests[1]?.path).toBe(`/tools/calls/${callId}?waitMs=${MaxToolWaitMs}`)
    // Claude Code's fetch gives up after 30 seconds.
    for (const request of requests) expect(waitMsOf(request)).toBeLessThan(30_000)
  })

  test("passes on a tool's own error", async () => {
    const { exchange } = bridge(() =>
      reply(200, { _tag: "ToolFailed", message: "File does not exist." }),
    )
    expect(await run(exchange)).toEqual({ _tag: "Failed", message: "File does not exist." })
  })

  test("a call past its timeout is cancelled in the Sandbox", async () => {
    let clock = 0
    const { exchange, requests } = bridge((request) => {
      if (request.method === "DELETE")
        return reply(200, { _tag: "ToolLost", message: "it was cancelled" })
      clock += waitMsOf(request)
      return running
    })
    const answer = await run(
      exchange,
      { command: "sleep 999", timeout: 1_000 },
      { now: () => clock },
    )
    expect(requests.at(-1)).toEqual({ method: "DELETE", path: `/tools/calls/${callId}` })
    expect(clock).toBe(1_000 + TimeoutGraceMs)
    expectMayHaveRun(answer)
    if (answer._tag === "Lost") expect(answer.message).toContain("did not finish within")
  })

  test("an interrupted call is cancelled in the Sandbox", async () => {
    const stop = new AbortController()
    const { exchange, requests } = bridge((request) => {
      if (request.method === "DELETE")
        return reply(200, { _tag: "ToolLost", message: "it was cancelled" })
      if (request.method === "GET") {
        // The person interrupts while the mod waits; this fetch never answers.
        stop.abort()
        return new Promise<Answer>(() => {})
      }
      return running
    })
    const answer = await run(exchange, { command: "sleep 999" }, { signal: stop.signal })
    expect(requests.map((request) => request.method)).toEqual(["POST", "GET", "DELETE"])
    expectMayHaveRun(answer)
    if (answer._tag === "Lost") expect(answer.message).toContain("interrupted")
  })

  test("a call that ended as it was cancelled answers its result", async () => {
    const stop = new AbortController()
    stop.abort()
    const { exchange } = bridge((request) =>
      request.method === "DELETE" ? ran({ stdout: "done" }) : running,
    )
    expect(await run(exchange, { command: "ls" }, { signal: stop.signal })).toEqual({
      _tag: "Ran",
      result: { stdout: "done" },
    })
  })

  test("a start whose answer was lost is sent again under the same id", async () => {
    const { exchange, requests } = bridge((_request, index) => {
      if (index === 0) throw new Error("no complete answer within 30000ms")
      return ran({ stdout: "once" })
    })
    expect(await run(exchange)).toEqual({ _tag: "Ran", result: { stdout: "once" } })
    expect(requests.map((request) => request.body)).toEqual([requests[0]?.body, requests[0]?.body])
  })

  describe("says it may have run once the bridge may have taken it", () => {
    test("when the bridge stops answering a running call", async () => {
      const { exchange } = bridge((request) => {
        if (request.method === "POST") return running
        throw new Error("$.http.fetch aborted: no complete answer within 30000ms")
      })
      expectMayHaveRun(await run(exchange))
    })

    test("when no start got an answer", async () => {
      const { exchange } = bridge(() => {
        throw new Error("$.http.fetch aborted: no complete answer within 30000ms")
      })
      expectMayHaveRun(await run(exchange))
    })

    test("when the bridge lost it", async () => {
      const { exchange } = bridge((request) =>
        request.method === "POST"
          ? running
          : reply(404, { _tag: "ToolLost", message: "the tool bridge doesn't know this call" }),
      )
      expectMayHaveRun(await run(exchange))
    })

    test("when the bridge answers something that isn't a reply", async () => {
      for (const answer of [
        { status: 200, text: "" },
        { status: 200, text: "not json" },
        { status: 200, text: "{}" },
        { status: 500, text: "Internal Server Error" },
        { status: 502, text: "<html>bad gateway</html>" },
        reply(500, { _tag: "ToolRan", result: {} }),
      ])
        expectMayHaveRun(await run(bridge(() => answer).exchange))
    })
  })

  describe("says it did not run only when the bridge never took it", () => {
    test("without a socket", async () => {
      const { exchange, requests } = bridge(() => ran({}))
      expectDidNotRun(await run(exchange, {}, {}, null))
      expectDidNotRun(await run(exchange, {}, {}, ""))
      expect(requests).toHaveLength(0)
    })

    test("when nothing listens on the socket", async () => {
      const { exchange } = bridge(() => {
        throw new Error("connect ENOENT /sessions/s1/tools.sock")
      })
      expectDidNotRun(await run(exchange))
    })

    test("when the bridge is unavailable", async () => {
      const { exchange } = bridge(() =>
        reply(503, { _tag: "BridgeUnavailable", message: "the Sandbox is stopped" }),
      )
      const answer = await run(exchange)
      expectDidNotRun(answer)
      expect(answer).toMatchObject({ message: expect.stringContaining("the Sandbox is stopped") })
    })
  })

  describe("on a Runner from before long calls", () => {
    test("runs the call with the single exchange it knows", async () => {
      const { exchange, requests } = older(() => ran({ stdout: "hi" }))
      expect(await run(exchange, { command: "echo hi" })).toEqual({
        _tag: "Ran",
        result: { stdout: "hi" },
      })
      expect(requests.at(-1)).toEqual({
        method: "POST",
        path: "/tools/call",
        body: JSON.stringify({ tool: "Bash", input: { command: "echo hi" } }),
      })
    })

    test("says a call it gave up on may have run, and to update the Runner", async () => {
      const { exchange } = older(() => {
        throw new Error("$.http.fetch aborted: no complete answer within 30000ms")
      })
      const answer = await run(exchange)
      expectMayHaveRun(answer)
      if (answer._tag === "Lost") expect(answer.message).toContain("update the Runner")
    })
  })
})

describe("callDeadlineMs", () => {
  test("is Bash's own timeout, at most 10 minutes, and a grace", () => {
    expect(callDeadlineMs("Bash", {})).toBe(120_000 + TimeoutGraceMs)
    expect(callDeadlineMs("Bash", { timeout: 300_000 })).toBe(300_000 + TimeoutGraceMs)
    expect(callDeadlineMs("Bash", { timeout: 3_600_000 })).toBe(600_000 + TimeoutGraceMs)
    expect(callDeadlineMs("Bash", { timeout: "soon" })).toBe(120_000 + TimeoutGraceMs)
    expect(callDeadlineMs("Read", {})).toBe(300_000)
  })
})

describe("newCallId", () => {
  test("is unique, and a valid id however Claude Code names the call", () => {
    const pattern = /^[A-Za-z0-9_.-]{1,128}$/
    expect(newCallId("toolu_01AB")).toMatch(/^toolu_01AB-[0-9a-f]{8}$/)
    expect(newCallId("toolu_01AB")).not.toBe(newCallId("toolu_01AB"))
    expect(newCallId(undefined)).toMatch(pattern)
    expect(newCallId("a/b c")).toMatch(pattern)
    expect(newCallId("x".repeat(500))).toMatch(pattern)
  })
})

describe("ReadBeforeEdit", () => {
  test("refuses an edit of a file not read yet, and allows it once read", () => {
    const rule = new ReadBeforeEdit()
    const edit = { file_path: "/workspace/a.ts", old_string: "a", new_string: "b" }
    expect(rule.check("Edit", edit)).toBeDefined()
    rule.record(
      "Read",
      { file_path: "/workspace/a.ts" },
      { type: "text", file: { filePath: "/workspace/a.ts" } },
    )
    expect(rule.check("Edit", edit)).toBeUndefined()
  })

  test("counts a file written as known", () => {
    const rule = new ReadBeforeEdit()
    rule.record(
      "Write",
      { file_path: "/workspace/b.ts", content: "x" },
      { filePath: "/workspace/b.ts" },
    )
    expect(rule.check("Edit", { file_path: "/workspace/b.ts" })).toBeUndefined()
  })

  test("leaves the other tools alone", () => {
    const rule = new ReadBeforeEdit()
    expect(rule.check("Write", { file_path: "/workspace/c.ts" })).toBeUndefined()
    expect(rule.check("Bash", { command: "ls" })).toBeUndefined()
  })
})
