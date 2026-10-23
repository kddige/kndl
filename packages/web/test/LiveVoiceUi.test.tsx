// Live voice in the Session view (ADR 0033): Send's place starts a call while there is nothing to
// send, and the call bar floats over the Composer while a call is up, with its controls.

import { afterEach, expect, test } from "bun:test"
import { installDom } from "./dom.ts"
import { button, render, step } from "./render.ts"

let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

// Loaded after installDom() and the StyleX compiler, so components see the DOM and compile.
const { Composer } = await import("../src/session/Composer.tsx")
const { LiveCallBar } = await import("../src/session/LiveCallBar.tsx")

function typeInto(field: HTMLTextAreaElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set
  setValue?.call(field, value)
  field.dispatchEvent(new Event("input", { bubbles: true }))
}

const has = (container: ParentNode, label: string) =>
  container.querySelector(`button[aria-label="${label}"]`) !== null

test("an empty prompt offers live voice in Send's place; text brings Send back", async () => {
  let started = 0
  const view = await render(
    <Composer
      onSend={() => true}
      running={false}
      voice={{ start: () => started++, inCall: false }}
    />,
  )
  cleanup = view.unmount
  const { container } = view
  expect(has(container, "Start live voice")).toBe(true)
  expect(has(container, "Send prompt")).toBe(false)
  await step(() => button("Start live voice", container).click())
  expect(started).toBe(1)

  const field = container.querySelector<HTMLTextAreaElement>("textarea")
  if (!field) throw new Error("no field")
  await step(() => typeInto(field, "Run the tests"))
  expect(has(container, "Send prompt")).toBe(true)
  expect(has(container, "Start live voice")).toBe(false)
})

test("during a call, or without live voice, an empty prompt shows Send, disabled", async () => {
  for (const voice of [{ start: () => {}, inCall: true }, undefined]) {
    const view = await render(<Composer onSend={() => true} running={false} voice={voice} />)
    expect(has(view.container, "Start live voice")).toBe(false)
    expect(button("Send prompt", view.container).disabled).toBe(true)
    await view.unmount()
  }
})

test("the call bar says the call is live, and mutes and hangs up", async () => {
  const muted: Array<boolean> = []
  let hungUp = 0
  const view = await render(
    <LiveCallBar
      status={{
        phase: "live",
        speaking: "The tests pass.",
        muted: false,
        since: Date.now() - 65_000,
      }}
      levels={() => false}
      onMute={(next) => muted.push(next)}
      onHangUp={() => hungUp++}
    />,
  )
  cleanup = view.unmount
  const { container } = view
  expect(container.textContent).toContain("Live")
  expect(container.textContent).toContain("01:05")
  expect(container.textContent).toContain("The tests pass.")
  await step(() => button("Mute", container).click())
  expect(muted).toEqual([true])
  await step(() => button("Hang up", container).click())
  expect(hungUp).toBe(1)
})

test("while connecting, the call bar can be hung up but not muted", async () => {
  const view = await render(
    <LiveCallBar
      status={{ phase: "connecting" }}
      levels={() => false}
      onMute={() => {}}
      onHangUp={() => {}}
    />,
  )
  cleanup = view.unmount
  expect(view.container.textContent).toContain("Connecting")
  expect(has(view.container, "Mute")).toBe(false)
  expect(has(view.container, "Hang up")).toBe(true)
})

test("the call bar shows what really went to the agent, and whether it answered a question", async () => {
  const base = { phase: "live", speaking: "", muted: false, since: Date.now() } as const
  for (const [handedOff, label] of [
    [{ text: "Run the tests", reply: false }, "Sent to the agent:"],
    [{ text: "SQLite", reply: true }, "Answered the agent:"],
  ] as const) {
    const view = await render(
      <LiveCallBar
        status={{ ...base, handedOff }}
        levels={() => false}
        onMute={() => {}}
        onHangUp={() => {}}
      />,
    )
    expect(view.container.textContent).toContain(`${label} ${handedOff.text}`)
    await view.unmount()
  }
  // Nothing handed off yet: no such line.
  const view = await render(
    <LiveCallBar status={base} levels={() => false} onMute={() => {}} onHangUp={() => {}} />,
  )
  cleanup = view.unmount
  expect(view.container.textContent).not.toContain("to the agent")
})
