// A Turn's footer in the transcript: why it ended, and the tokens and cost its Harness reported.

import { afterEach, expect, test } from "bun:test"
import type { SessionId } from "@kndl/protocol"
import { installDom } from "./dom.ts"
import { alice, entries, fromAlice } from "./fixtures.ts"
import { render, settle } from "./render.ts"

let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  await settle()
})

// Loaded after installDom() and the StyleX compiler, so components see the DOM and compile.
const { HubProvider } = await import("../src/app/hub.tsx")
const { HubClient } = await import("../src/hub/client.ts")
const { FakeHub } = await import("../src/hub/fake/FakeHub.ts")
const { buildTranscript } = await import("../src/hub/transcript.ts")
const { Transcript } = await import("../src/session/Transcript.tsx")

type Event = Parameters<typeof entries>[0][number]

const usage = {
  model: "claude-opus-5-5",
  input: 1_200,
  output: 300,
  cacheRead: 40_000,
  cacheWrite: 0,
}

/** Each Turn in the transcript of these events, as text. */
async function turns(events: ReadonlyArray<Event>): Promise<ReadonlyArray<string>> {
  const { items } = buildTranscript(entries(events))
  // Not connected: the transcript only asks the client for attachments' addresses.
  const hub = new FakeHub({ autoplay: false })
  const client = new HubClient(hub, { retryDelay: () => 1 })
  const view = await render(
    <HubProvider client={client}>
      <Transcript sessionId={"s-1" as SessionId} items={items} />
    </HubProvider>,
  )
  cleanup = async () => {
    await view.unmount()
    hub.dispose()
  }
  return [...view.container.querySelectorAll("article")].map((turn) => turn.textContent ?? "")
}

/** A Turn Alice sent that ended as `end` says. */
const turn = (
  turnId: string,
  end: Omit<Extract<Event, { _tag: "TurnEnded" }>, "_tag" | "turnId">,
) =>
  [
    { _tag: "TurnStarted", turnId, text: "[Alice] go", sender: fromAlice },
    { _tag: "TurnEnded", turnId, ...end },
  ] as const

test("the token line counts what was read from the cache as input, and shows a reported cost", async () => {
  const [plain, cheap, dear] = await turns([
    ...turn("t-1", { reason: "stop", durationMs: 5_200, usage }),
    ...turn("t-2", { reason: "stop", durationMs: 5_200, usage: { ...usage, cost: 0.0372 } }),
    ...turn("t-3", { reason: "stop", durationMs: 5_200, usage: { ...usage, cost: 1.25 } }),
  ])
  expect(plain).toContain("41k in · 300 out")
  expect(plain).not.toContain("$")
  expect(cheap).toContain("41k in · 300 out · $0.0372")
  expect(dear).toContain("41k in · 300 out · $1.25")
})

test("a Turn that stopped has no badge; one aborted, cut at its limit or failed says so", async () => {
  const [stopped, aborted, cut, failed] = await turns([
    ...turn("t-1", { reason: "stop", durationMs: 1 }),
    { _tag: "TurnStarted", turnId: "t-2", text: "[Alice] go", sender: fromAlice },
    { _tag: "TurnStopRequested", by: alice },
    { _tag: "TurnEnded", turnId: "t-2", reason: "aborted", durationMs: 1 },
    ...turn("t-3", { reason: "length", durationMs: 1 }),
    ...turn("t-4", { reason: "error", durationMs: 1 }),
  ])
  for (const badge of ["Stopped", "Hit the output limit", "Failed"])
    expect(stopped).not.toContain(badge)
  expect(aborted).toContain("Stopped by Alice")
  expect(cut).toContain("Hit the output limit")
  expect(failed).toContain("Failed")
})
