// Runs a tool call in the Session's Sandbox through the Runner's tool bridge (see the protocol's
// ToolBridge.ts), and turns the bridge's replies into what the mod answers Claude Code with.
//
// A call may run for up to 10 minutes, while one `$.http.fetch` gives up after 30 seconds. So the
// mod starts the call and waits for it in steps of at most MaxToolWaitMs (#109). Those waits are
// `$` calls, which don't count against the hook's 10-second budget. When the mod gives up on a
// call (past its time, or Claude Code interrupted the Turn), it cancels it, which stops its
// process in the Sandbox.
//
// It fails closed: unless the bridge answers with a well-formed ToolRan or ToolFailed, the call
// is refused. A hook that throws or passes the call on lets Claude Code run the tool on the host
// (spike #2), so nothing here throws and nothing calls `next`. And it says a call did not run
// only when it knows: the bridge said so, or never got it.

import { MaxToolWaitMs, ToolBridgeReply, ToolCallReply } from "@claude-hub/protocol"
import type { SandboxTool } from "@claude-hub/protocol"
import { Exit, Schema } from "effect"

/** One HTTP request to the bridge, on its socket. */
export interface BridgeRequest {
  readonly method: "GET" | "POST" | "DELETE"
  /** The path and query, such as `/tools/calls/<id>?waitMs=20000`. */
  readonly path: string
  readonly body?: string
}

/** One HTTP exchange with the bridge. Rejects when no complete answer came back. */
export type BridgeExchange = (
  socketPath: string,
  request: BridgeRequest,
) => Promise<{ readonly status: number; readonly text: string }>

/** How a tool call went. */
export type ToolAnswer =
  /** The tool ran in the Sandbox; `result` is its own record, for Claude Code. */
  | { readonly _tag: "Ran"; readonly result: unknown }
  /** The tool ran in the Sandbox and reported an error; the model reads `message`. */
  | { readonly _tag: "Failed"; readonly message: string }
  /** The tool did not run anywhere: no bridge, or the bridge said it didn't run it. */
  | { readonly _tag: "Refused"; readonly message: string }
  /** The bridge took the call but its result is gone: it may have run, wholly or in part. */
  | { readonly _tag: "Lost"; readonly message: string }

export interface RunOptions {
  /** The id to start the call under: unique to this call (newCallId). */
  readonly callId: string
  /** Aborts when Claude Code gives up on the call, as when the person interrupts the Turn. */
  readonly signal?: AbortSignal
  /** The time now, in milliseconds. */
  readonly now?: () => number
  /** The longest one exchange waits at the bridge for the call to end. */
  readonly stepMs?: number
}

/** Bash's own default and largest `timeout`, as Claude Code's Bash tool has them. */
export const BashDefaultTimeoutMs = 120_000
export const BashMaxTimeoutMs = 600_000
/** How long the other tools may run in the Sandbox before the mod gives up on them. */
export const OtherToolTimeoutMs = 300_000
/** Past a tool's own timeout, how long the mod still waits for the tool to answer that it timed out. */
export const TimeoutGraceMs = 30_000
/** How many exchanges in a row may fail before the mod gives up on a call. */
const MaxFailedExchanges = 3

/** How long the mod waits for a call to end before it cancels it. */
export const callDeadlineMs = (tool: SandboxTool, input: Readonly<Record<string, unknown>>) => {
  if (tool !== "Bash") return OtherToolTimeoutMs
  const asked = input["timeout"]
  const timeout =
    typeof asked === "number" && Number.isFinite(asked) && asked > 0
      ? Math.min(asked, BashMaxTimeoutMs)
      : BashDefaultTimeoutMs
  return timeout + TimeoutGraceMs
}

/** A fresh id to start a call under, from Claude Code's own id for it where there is one. */
export const newCallId = (toolUseId: string | undefined) => {
  const base = (toolUseId ?? "call").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "call"
  return `${base}-${crypto.randomUUID().slice(0, 8)}`
}

const decodeReply = Schema.decodeUnknownExit(Schema.fromJsonString(ToolCallReply))
const decodeLegacyReply = Schema.decodeUnknownExit(Schema.fromJsonString(ToolBridgeReply))

/** The tool did not run: it is safe to run it again. */
export const refusal = (tool: string, why: string) =>
  `${tool} could not run in this Session's Sandbox (${why}), so it did not run at all. ` +
  "It never runs on the host."

/** The tool may have run: running it again may do it twice. */
export const mayHaveRun = (tool: string, why: string) =>
  `${tool} may have run in this Session's Sandbox, but its result was lost (${why}). ` +
  "Check before running it again. It never runs on the host."

/**
 * Whether a failed exchange never reached the bridge, so the bridge can't have taken the call: no
 * socket, or nothing listening on it. Anything else, such as no answer in time, may have.
 */
export const neverReached = (error: unknown) =>
  /ENOENT|ECONNREFUSED|ENOTSOCK|no such file|connection refused/i.test(String(error))

type Outcome<A> = { readonly _tag: "Answered"; readonly value: A } | { readonly _tag: "Aborted" }

/** Settles with `promise`, or as `Aborted` as soon as `signal` aborts. */
const unlessAborted = <A>(promise: Promise<A>, signal: AbortSignal | undefined) =>
  new Promise<Outcome<A>>((resolve, reject) => {
    if (signal?.aborted) return resolve({ _tag: "Aborted" })
    const onAbort = () => resolve({ _tag: "Aborted" })
    signal?.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal?.removeEventListener("abort", onAbort)
        resolve({ _tag: "Answered", value })
      },
      (error: unknown) => {
        signal?.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })

const minutes = (ms: number) => {
  const value = Math.round((ms / 60_000) * 10) / 10
  return `${value} minute${value === 1 ? "" : "s"}`
}

/** Runs one tool call in the Sandbox. Never throws. */
export const runInSandbox = async (
  exchange: BridgeExchange,
  socketPath: string | undefined,
  tool: SandboxTool,
  input: Readonly<Record<string, unknown>>,
  options: RunOptions,
): Promise<ToolAnswer> => {
  if (socketPath === undefined || socketPath === "")
    return { _tag: "Refused", message: refusal(tool, "this Session has no tool bridge") }
  const { callId, signal } = options
  const now = options.now ?? Date.now
  const stepMs = Math.min(options.stepMs ?? MaxToolWaitMs, MaxToolWaitMs)
  const deadline = now() + callDeadlineMs(tool, input)
  const send = (request: BridgeRequest) => exchange(socketPath, request)
  const path = `/tools/calls/${encodeURIComponent(callId)}`

  /** What a reply to a start or a wait comes to; undefined while the call runs. */
  const answerOf = (status: number, reply: ToolCallReply): ToolAnswer | undefined => {
    switch (reply._tag) {
      case "ToolRan":
        return status === 200
          ? { _tag: "Ran", result: reply.result }
          : { _tag: "Lost", message: mayHaveRun(tool, `the tool bridge answered ${status}`) }
      case "ToolFailed":
        return { _tag: "Failed", message: reply.message }
      case "BridgeUnavailable":
        return { _tag: "Refused", message: refusal(tool, reply.message) }
      case "ToolLost":
        return { _tag: "Lost", message: mayHaveRun(tool, reply.message) }
      case "ToolRunning":
        return undefined
    }
  }

  /** Cancels the call; its result if it ended meanwhile, else `stopped`. */
  const cancel = async (stopped: string): Promise<ToolAnswer> => {
    try {
      const { status, text } = await send({ method: "DELETE", path })
      const reply = decodeReply(text)
      if (
        Exit.isSuccess(reply) &&
        (reply.value._tag === "ToolRan" || reply.value._tag === "ToolFailed")
      )
        return answerOf(status, reply.value) ?? { _tag: "Lost", message: stopped }
    } catch {
      // The bridge cancels a call nothing waits for by itself.
    }
    return { _tag: "Lost", message: stopped }
  }

  const interrupted = () =>
    cancel(
      `${tool} was interrupted, and stopped in this Session's Sandbox. It may have run in part: ` +
        "check before running it again. It never runs on the host.",
    )

  // Start it. Starting again under the same id starts nothing, so a start whose answer was lost
  // is sent again.
  const failures: Array<unknown> = []
  let started: { status: number; reply: ToolCallReply } | undefined
  while (started === undefined) {
    let response: { readonly status: number; readonly text: string }
    try {
      const outcome = await unlessAborted(
        send({
          method: "POST",
          path: `/tools/calls?waitMs=${stepMs}`,
          body: JSON.stringify({ callId, tool, input }),
        }),
        signal,
      )
      if (outcome._tag === "Aborted") return await interrupted()
      response = outcome.value
    } catch (error) {
      failures.push(error)
      if (failures.length < MaxFailedExchanges) continue
      return failures.every(neverReached)
        ? { _tag: "Refused", message: refusal(tool, `the tool bridge is unreachable: ${error}`) }
        : { _tag: "Lost", message: mayHaveRun(tool, `the tool bridge gave no answer: ${error}`) }
    }
    const reply = decodeReply(response.text)
    if (Exit.isSuccess(reply)) {
      started = { status: response.status, reply: reply.value }
      break
    }
    // A Runner from before #109 knows only the single POST /tools/call.
    if (response.status === 404 && failures.length === 0) return runOnOlderRunner(send, tool, input)
    failures.push(`it answered ${response.status} with no tool reply`)
    if (failures.length >= MaxFailedExchanges)
      return {
        _tag: "Lost",
        message: mayHaveRun(tool, `the tool bridge answered ${response.status} with no tool reply`),
      }
  }

  // Wait for it to end, in steps.
  let answer = answerOf(started.status, started.reply)
  let failed = 0
  while (answer === undefined) {
    const left = deadline - now()
    if (left <= 0)
      return cancel(
        `${tool} did not finish within ${minutes(callDeadlineMs(tool, input))}, so it was ` +
          "stopped in this Session's Sandbox. It may have run in part: check before running it " +
          "again. It never runs on the host.",
      )
    let response: { readonly status: number; readonly text: string }
    try {
      const outcome = await unlessAborted(
        send({ method: "GET", path: `${path}?waitMs=${Math.min(stepMs, left)}` }),
        signal,
      )
      if (outcome._tag === "Aborted") return await interrupted()
      response = outcome.value
    } catch (error) {
      if (++failed < MaxFailedExchanges) continue
      void cancel("")
      return {
        _tag: "Lost",
        message: mayHaveRun(tool, `the tool bridge stopped answering: ${error}`),
      }
    }
    const reply = decodeReply(response.text)
    if (Exit.isFailure(reply)) {
      if (++failed < MaxFailedExchanges) continue
      void cancel("")
      return {
        _tag: "Lost",
        message: mayHaveRun(tool, `the tool bridge answered ${response.status} with no tool reply`),
      }
    }
    failed = 0
    answer = answerOf(response.status, reply.value)
  }
  return answer
}

/**
 * Runs a call with the single exchange a Runner from before #109 serves, which Claude Code gives
 * up on after 30 seconds while the call runs on.
 */
const runOnOlderRunner = async (
  send: (request: BridgeRequest) => Promise<{ readonly status: number; readonly text: string }>,
  tool: SandboxTool,
  input: Readonly<Record<string, unknown>>,
): Promise<ToolAnswer> => {
  let response: { readonly status: number; readonly text: string }
  try {
    response = await send({
      method: "POST",
      path: "/tools/call",
      body: JSON.stringify({ tool, input }),
    })
  } catch (error) {
    return neverReached(error)
      ? { _tag: "Refused", message: refusal(tool, `the tool bridge is unreachable: ${error}`) }
      : {
          _tag: "Lost",
          message: mayHaveRun(
            tool,
            `the tool bridge gave no answer: ${error}. This Session's Runner is older than its ` +
              "mod and can't wait on a call for longer than 30 seconds; update the Runner",
          ),
        }
  }
  const reply = decodeLegacyReply(response.text)
  if (Exit.isFailure(reply))
    return {
      _tag: "Lost",
      message: mayHaveRun(tool, `the tool bridge answered ${response.status} with no tool reply`),
    }
  switch (reply.value._tag) {
    case "ToolRan":
      return response.status === 200
        ? { _tag: "Ran", result: reply.value.result }
        : { _tag: "Lost", message: mayHaveRun(tool, `the tool bridge answered ${response.status}`) }
    case "ToolFailed":
      return { _tag: "Failed", message: reply.value.message }
    case "BridgeUnavailable":
      return { _tag: "Refused", message: refusal(tool, reply.value.message) }
  }
}

/**
 * Claude Code's rule that a file must be read before it is edited. Core checks it before a tool
 * runs, which a hook that answers the call skips, and `claude mcp serve` doesn't check it either
 * (spike #2), so the mod keeps it: the paths read or written since the mod loaded.
 */
export class ReadBeforeEdit {
  private readonly known = new Set<string>()

  /** The reason to refuse an edit of a file not read yet, or undefined to let it run. */
  check(tool: SandboxTool, input: Readonly<Record<string, unknown>>): string | undefined {
    if (tool !== "Edit" && tool !== "NotebookEdit") return undefined
    const path = input["file_path"] ?? input["notebook_path"]
    if (typeof path !== "string" || this.known.has(path)) return undefined
    return "File has not been read yet. Read it first before writing to it."
  }

  /** Notes the file a tool that ran read or wrote. */
  record(tool: SandboxTool, input: Readonly<Record<string, unknown>>, result: unknown) {
    if (tool === "Bash") return
    const record = (result ?? {}) as {
      filePath?: unknown
      file?: { filePath?: unknown }
      notebook_path?: unknown
    }
    for (const path of [
      record.filePath,
      record.file?.filePath,
      record.notebook_path,
      input["file_path"],
      input["notebook_path"],
    ])
      if (typeof path === "string") this.known.add(path)
  }
}
