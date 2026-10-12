// What the hub-link-commands tests share: a session linked to a faked Hub, and what the plugin
// says it delivers and steers. Its own file, since `claude plugin test` (Claude Code 2.1.296)
// hangs on a test file of more than 21 tests.

import type { On } from "claude-code"
import { mock } from "claude-code/testing"

export const hubUrl = "http://hub.test"

type Fetched = { url: string; body?: string }

/** The welcome of a Hub that takes PromptAlreadySubmitted (#323). */
export const welcome = {
  status: 200,
  text: JSON.stringify({ _tag: "ModWelcome", protocolVersion: 2, alreadySubmitted: true }),
}

/** A Hub's from before #323, which refuses a PromptAlreadySubmitted. */
export const olderWelcome = {
  status: 200,
  text: JSON.stringify({ _tag: "ModWelcome", protocolVersion: 2 }),
}

/** The Hub's answer to a fetch. */
export const answer = (status: number, text: string) => ({
  value: { status, ok: status >= 200 && status < 300, headers: {}, text },
})

/**
 * A session a Runner started, linked to a Hub whose first poll answers `commands` once `ready`
 * settles, and whose later ones are held, as its long poll does; it answers for the attachments in
 * `files`, by id and then offset, and 404 for any other, and its hello with `hello`. Returns the
 * requests, and the events posted.
 */
export const linkedSession = (
  on: On,
  commands: Array<Record<string, unknown>> = [],
  ready: Promise<void> = Promise.resolve(),
  env: Record<string, string> = {},
  files: Record<string, Record<number, Record<string, unknown>>> = {},
  hello: { status: number; text: string } = welcome,
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

/**
 * A session whose Hub answers the first AskUserQuestion call with `webAnswer` from Ada, once
 * Claude Code's dialog for it is open; the dialog answers with `atTerminal`, or stays open.
 * Returns the call's id, the dialog's signal, and the events posted.
 */
export const askedSession = (
  on: On,
  webAnswer: Record<string, unknown>,
  atTerminal?: Record<string, unknown>,
) => {
  const commands: Array<Record<string, unknown>> = []
  let opened: ((id: string) => void) | undefined
  const dialog = { id: "", signal: undefined as AbortSignal | undefined }
  const { posted } = linkedSession(
    on,
    commands,
    new Promise<void>((resolve) => {
      opened = (id) => {
        commands.push({
          _tag: "DeliverAnswer",
          sessionId: "s1",
          toolCallId: id,
          answer: webAnswer,
          sender: ada,
        })
        resolve()
      }
    }),
  )
  on("turn.start", (_, e) => ({ turnId: e.turnId }))
  on("tool.call", (_, e, next) => {
    dialog.id = e.tool_use_id ?? ""
    dialog.signal = next.signal
    opened?.(dialog.id)
    return (atTerminal === undefined ? new Promise(() => undefined) : atTerminal) as never
  })
  return { dialog, posted }
}
