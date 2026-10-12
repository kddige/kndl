// A prompt the Hub delivers again isn't run twice (#323): as after the Hub restarted, or lost the
// TurnStarted that takes the prompt out of its queue. Its own file, as support.ts says why.

import type { On } from "claude-code"
import { describe, expect, mock, test } from "claude-code/testing"
import { ada, linkedSession, olderWelcome } from "./support.ts"

const deliver = {
  _tag: "DeliverPrompt",
  sessionId: "s1",
  promptId: "pr-9",
  text: "Split the release notes.",
  sender: ada,
}

/** The prompts submitted, by text. */
const submissions = (on: On) => {
  const submitted: Array<string> = []
  on("prompt.submit", (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  return submitted
}

/**
 * A store in memory, as `mock.store` is, holding `submitted` at the start; returns what the plugin
 * keeps of the prompts it submitted, each time it keeps it.
 */
const keptSubmitted = (on: On, submitted: Array<string>) => {
  const store = new Map<string, unknown>([["submitted", submitted]])
  const writes: Array<unknown> = []
  on("store.get", (_, e) => ({ value: store.get(e.key) }))
  on("store.set", (_, e) => {
    store.set(e.key, e.value)
    if (e.key === "submitted") writes.push(e.value)
    return { value: undefined }
  })
  return writes
}

describe("a prompt delivered again (#323)", () => {
  test("isn't submitted twice, and the Hub is told it was given Claude Code already", async ($, on) => {
    mock.store(on)
    const { posted } = linkedSession(on, [deliver, deliver])
    const clock = mock.clock(on)
    const submitted = submissions(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(200)

    expect(submitted).toEqual(["[Ada Lovelace] Split the release notes."])
    expect(posted()).toEqual([{ _tag: "PromptAlreadySubmitted", promptId: "pr-9" }])
  })

  test("isn't submitted when an earlier Claude Code of the Session's submitted it", async ($, on) => {
    mock.store(on, { submitted: ["pr-9"] })
    const { posted } = linkedSession(on, [deliver])
    const clock = mock.clock(on)
    const submitted = submissions(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(200)

    expect(submitted).toEqual([])
    expect(posted()).toEqual([{ _tag: "PromptAlreadySubmitted", promptId: "pr-9" }])
  })

  test("isn't submitted twice for a Hub from before, which isn't told", async ($, on) => {
    mock.store(on)
    const { posted } = linkedSession(on, [deliver, deliver], undefined, {}, {}, olderWelcome)
    const clock = mock.clock(on)
    const submitted = submissions(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(200)

    expect(submitted).toEqual(["[Ada Lovelace] Split the release notes."])
    expect(posted()).toEqual([])
  })

  test("is kept as submitted before it is, and forgotten when it fails", async ($, on) => {
    const writes = keptSubmitted(on, ["pr-1"])
    const { posted } = linkedSession(on, [deliver])
    const clock = mock.clock(on)
    const kept: Array<unknown> = []
    on("prompt.submit", () => {
      kept.push(writes.at(-1))
      return { drop: "not now" }
    })

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(200)

    expect(kept).toEqual([["pr-1", "pr-9"]])
    expect(writes.at(-1)).toEqual(["pr-1"])
    expect(posted()).toEqual([
      { _tag: "PromptFailed", promptId: "pr-9", message: "a hook dropped the prompt: not now" },
    ])
  })
})
