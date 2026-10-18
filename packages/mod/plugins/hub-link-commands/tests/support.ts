// What the hub-link-commands tests share: a session linked to a faked Hub, and what the plugin
// says it delivers and steers. Its own file, since `claude plugin test` (Claude Code 2.1.296)
// hangs on a test file of more than 20 tests: each one leaves its held long poll behind.

import type { On } from "claude-code"
import { mock } from "claude-code/testing"

export const hubUrl = "http://hub.test"

type Fetched = { url: string; body?: string }

/** The welcome of a Hub that takes PromptAlreadySubmitted (#323). */
export const welcome = {
  status: 200,
  text: JSON.stringify({ _tag: "ModWelcome", protocolVersion: 4, alreadySubmitted: true }),
}

/** A Hub's from before #323, which refuses a PromptAlreadySubmitted. */
export const olderWelcome = {
  status: 200,
  text: JSON.stringify({ _tag: "ModWelcome", protocolVersion: 4 }),
}

/** The Hub's answer to a fetch. */
export const answer = (status: number, text: string) => ({
  value: { status, ok: status >= 200 && status < 300, headers: {}, text },
})

/**
 * A session a Runner started, linked to a Hub whose first poll answers `commands` once `ready`
 * settles, and whose later ones are held, as its long poll does; it answers for the attachments in
 * `files`, by id and then offset, and 404 for any other, its hello with `hello`, and its history
 * (ADR 0030) from `history`, by the query asked, and 404 for any other. Returns the requests, and the
 * events posted.
 */
export const linkedSession = (
  on: On,
  commands: Array<Record<string, unknown>> = [],
  ready: Promise<void> = Promise.resolve(),
  env: Record<string, string> = {},
  files: Record<string, Record<number, Record<string, unknown>>> = {},
  hello: { status: number; text: string } = welcome,
  history: Record<string, { status: number; text: string }> = {},
) => {
  mock.env(on, {
    KNDL_URL: hubUrl,
    KNDL_SESSION_ID: "s1",
    KNDL_MOD_TOKEN: "secret",
    KNDL_CONVERSATION_ID: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
    ...env,
  })
  on("session.id", () => ({ value: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f" }))
  on("session.model", () => ({ value: "claude-test" }))
  on("ui.log", () => ({ value: undefined }))
  on("session.start", (_, e) => ({ cwd: e.cwd }))
  const requests: Array<Fetched> = []
  let polled = 0
  on("http.fetch", async (_, e) => {
    requests.push({
      url: e.url,
      ...(typeof e.init?.body === "string" ? { body: e.init.body } : {}),
    })
    if (e.url.endsWith("/mod/hello")) return answer(hello.status, hello.text)
    if (e.url.endsWith("/mod/events")) return answer(204, "")
    const [, attachment, offset] = /\/mod\/attachments\/([^?]+)\?offset=(\d+)$/.exec(e.url) ?? []
    if (attachment !== undefined) {
      const file = files[attachment]?.[Number(offset)]
      return file === undefined
        ? answer(404, JSON.stringify({ error: "There is no such attachment." }))
        : answer(200, JSON.stringify(file))
    }
    const [, query] = /\/mod\/history\?(.*)$/.exec(e.url) ?? []
    if (query !== undefined) {
      const turns = history[query]
      return turns === undefined
        ? answer(404, JSON.stringify({ error: "There is no such Session." }))
        : answer(turns.status, turns.text)
    }
    polled++
    if (polled > 1) return new Promise(() => undefined)
    await ready
    const messages = commands.map((message, index) => ({ seq: index + 1, message }))
    return answer(200, JSON.stringify({ messages }))
  })
  const posted = () =>
    requests
      .filter((request) => request.url === `${hubUrl}/mod/events`)
      .flatMap((request) => JSON.parse(request.body ?? "").messages as Array<unknown>)
  return { requests, posted }
}

export const ada = { id: "p1", login: "ada", name: "Ada Lovelace" }
export const shot = { id: "att-1", name: "shot.png", mediaType: "image/png", size: 12 }

/** What the plugin says it delivered, each time it says it. */
export const deliveredWrites = (on: On) => {
  const writes: Array<unknown> = []
  on("state.set", { plugin: "hub-link-commands", key: "delivered" }, (_, e, next) => {
    writes.push(e.value)
    return next(e)
  })
  return writes
}

export function steeringWrites(on: On) {
  const writes: Array<unknown> = []
  on("state.set", { plugin: "hub-link-commands", key: "steering" }, (_, e, next) => {
    writes.push(e.value)
    return next(e)
  })
  return writes
}

/** The question tool's name in Claude Code, and the id its calls get in the tests. */
export const questionTool = "mcp__hub-link-commands__ask_user_question"
export const questionId = "toolu_q1"

/**
 * A session whose Hub answers the question tool's call (`questionId`) with each of `answers`, from
 * Ada, once `release` is called. Returns the events posted.
 */
export const answeredSession = (on: On, answers: Array<Record<string, unknown>>) => {
  let release: (() => void) | undefined
  const commands = answers.map((each) => ({
    _tag: "DeliverAnswer",
    sessionId: "s1",
    toolCallId: questionId,
    answer: each,
    sender: ada,
  }))
  const { posted } = linkedSession(on, commands, new Promise((resolve) => (release = resolve)))
  on("turn.start", (_, e) => ({ turnId: e.turnId }))
  return { posted, release: () => release?.() }
}
