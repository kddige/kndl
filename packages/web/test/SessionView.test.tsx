// A smoke test of the Session view: the whole app, routed to the demo Session, against the fake
// Hub playing its script fast.

import { expect, test } from "bun:test"
import { installDom } from "./dom.ts"
import { button, render, settle, step } from "./render.ts"

let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())

// Loaded after installDom() and the StyleX compiler, so components see the DOM and compile.
const { createMemoryHistory, RouterProvider } = await import("@tanstack/react-router")
const { HubProvider } = await import("../src/app/hub.tsx")
const { HubClient } = await import("../src/hub/client.ts")
const { FakeHub } = await import("../src/hub/fake/FakeHub.ts")
const { demoSessionId } = await import("../src/hub/fake/script.ts")
const { createAppRouter } = await import("../src/router.tsx")

/** Waits, letting React render, until `check` stops throwing. */
async function eventually(check: () => void, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      check()
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await settle(10)
    }
  }
}

function typeInto(field: HTMLTextAreaElement, value: string): void {
  // React tracks the value it last saw; the prototype's setter goes around that, as typing does.
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
  setValue?.call(field, value)
  field.dispatchEvent(new Event("input", { bubbles: true }))
}

test("the Session view plays the fake Hub's scripted Session", async () => {
  const hub = new FakeHub({ stepMs: 2 })
  const client = new HubClient(hub, { retryDelay: () => 1 })
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [`/sessions/${demoSessionId}`] }),
  )
  const view = await render(
    <HubProvider client={client}>
      <RouterProvider router={router} />
    </HubProvider>,
  )
  cleanup = async () => {
    await view.unmount()
    client.stop()
    hub.dispose()
  }
  const page = view.container
  const conversation = () => page.querySelector('[aria-label="Conversation"]')?.textContent ?? ""
  const queue = () => page.querySelector('[aria-label="Prompt queue"]')?.textContent ?? ""
  const hasButton = (name: string) =>
    [...page.querySelectorAll("button")].some((el) => el.textContent?.trim() === name)

  // Connected and joined: the Session's header, with the reader present.
  await eventually(() => expect(page.querySelector("h1")?.textContent).toBe("kddige/claude-hub"))
  expect(hub.received.map((message) => message._tag)).toContain("JoinSession")

  // A second Participant joins, and their prompt starts a Turn under their name.
  await eventually(() =>
    expect(
      page.querySelector('[role="group"][aria-label^="Here now"]')?.getAttribute("aria-label"),
    ).toContain("Bob Lee"),
  )
  await eventually(() => expect(conversation()).toContain("Can you make tool calls collapse"))
  expect(conversation()).toContain("Bob Lee")

  // While it runs: Stop is offered, and Bob's follow-up waits in the queue.
  await eventually(() => expect(hasButton("Stop")).toBe(true))
  await eventually(() => expect(queue()).toContain("Then add a line about it to the README"))

  // A prompt sent mid-Turn queues; cancelling it takes it out.
  const prompt = page.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')
  if (!prompt) throw new Error("no prompt field")
  await step(() => typeInto(prompt, "And a test for it"))
  await step(() => button("Queue prompt", page).click())
  await eventually(() => expect(queue()).toContain("And a test for it"))
  await step(() => button("Cancel Alice Kim's prompt", page).click())
  await eventually(() => expect(queue()).not.toContain("And a test for it"))
  expect(hub.received.map((message) => message._tag)).toContain("CancelPrompt")

  // The streamed answer arrives whole; then the queued prompt runs as its own Turn.
  await eventually(() => expect(conversation()).toContain("The tests pass."))
  await eventually(() => expect(conversation()).toContain("That's done."))
  // (Booleans, not elements: a failed check on an element prints all of happy-dom, slowly.)
  await eventually(() =>
    expect(page.querySelector('[aria-label="Prompt queue"]') === null).toBe(true),
  )
  await eventually(() => expect(hasButton("Stop")).toBe(false))

  // Tool calls and the subagent are collapsed: their summaries show, their details don't.
  const toggles = [...page.querySelectorAll('[aria-label="Conversation"] [aria-expanded]')]
  expect(toggles.length).toBeGreaterThan(4)
  expect(toggles.every((toggle) => toggle.getAttribute("aria-expanded") === "false")).toBe(true)
  expect(conversation()).toContain("agent-kit")
  expect(conversation()).not.toContain("Disclosure is the one")
  expect(conversation()).not.toContain("58 pass")

  // Opening the subagent shows its own work, grouped under it.
  const agent = toggles.find((toggle) => toggle.textContent?.includes("agent-kit"))
  await step(() => (agent as HTMLElement).click())
  await eventually(() => expect(conversation()).toContain("Disclosure is the one"))
})

/** The whole app on one of the fake Hub's seeded Sessions, its script not playing. */
async function openSession(sessionId: string) {
  const hub = new FakeHub({ stepMs: 2, autoplay: false })
  const client = new HubClient(hub, { retryDelay: () => 1 })
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [`/sessions/${sessionId}`] }),
  )
  const view = await render(
    <HubProvider client={client}>
      <RouterProvider router={router} />
    </HubProvider>,
  )
  cleanup = async () => {
    await view.unmount()
    client.stop()
    hub.dispose()
  }
  const page = view.container
  /** The state banner's text, or "" without one. */
  const banner = () =>
    [...page.querySelectorAll('[role="status"]')]
      .map((el) => el.textContent ?? "")
      .find((content) => content.startsWith("This Session is")) ?? ""
  await eventually(() => expect(banner()).not.toBe(""))
  return {
    hub,
    page,
    banner,
    header: () => page.querySelector("h1")?.closest("header")?.textContent ?? "",
    sent: () => hub.received.map((message) => message._tag),
  }
}

test("an Asleep Session wakes from its banner, and an idle Active one sleeps on request", async () => {
  const { page, banner, header, sent } = await openSession("s-readme")
  expect(banner()).toContain("This Session is Asleep")
  expect(banner()).toContain("Idle for 15m.")

  await step(() => button("Wake now", page).click())
  expect(sent()).toContain("WakeSession")
  await eventually(() => expect(header()).toContain("Active"))
  expect(banner()).toBe("")

  await step(() => button("Sleep now", page).click())
  expect(sent()).toContain("SleepSession")
  await eventually(() => expect(banner()).toContain("Put to sleep."))
  expect([...page.querySelectorAll("button")].some((b) => b.textContent === "Sleep now")).toBe(
    false,
  )
})

test("a Frozen Session takes prompts, which wait in its queue", async () => {
  const { page, banner, sent } = await openSession("s-dotfiles")
  expect(banner()).toContain("ci-box went offline. Prompts sent now wait in the queue")

  const prompt = page.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')
  if (!prompt) throw new Error("no prompt field")
  expect(prompt.disabled).toBe(false)
  await step(() => typeInto(prompt, "Also show the exit code"))
  await step(() => button("Send prompt", page).click())

  expect(sent()).toContain("SendPrompt")
  await eventually(() =>
    expect(page.querySelector('[aria-label="Prompt queue"]')?.textContent ?? "").toContain(
      "Also show the exit code",
    ),
  )
  expect(page.textContent).not.toContain("The Hub refused that")
})

test("the Terminal tab mirrors the Session's terminal, and takes keystrokes", async () => {
  const hub = new FakeHub({ stepMs: 2, autoplay: false })
  const client = new HubClient(hub, { retryDelay: () => 1 })
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [`/sessions/${demoSessionId}`] }),
  )
  const view = await render(
    <HubProvider client={client}>
      <RouterProvider router={router} />
    </HubProvider>,
  )
  let mounted = true
  cleanup = async () => {
    if (mounted) await view.unmount()
    client.stop()
    hub.dispose()
  }
  const page = view.container
  const screen = () => page.querySelector(".xterm-rows")?.textContent ?? ""
  const terminalTab = () =>
    [...page.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "Terminal")

  // The terminal opens only once its tab is shown, and the URL says so.
  await eventually(() => expect(terminalTab() === undefined).toBe(false))
  expect(hub.received.map((message) => message._tag)).not.toContain("OpenTerminal")
  await step(() => (terminalTab() as HTMLElement).click())
  await eventually(() => expect(router.state.location.search).toEqual({ tab: "terminal" }))
  await eventually(() => expect(screen()).toContain("Do you want to proceed?"))
  expect(page.querySelector('[aria-label="Terminal size"]')?.textContent).toBe("120×40")

  // Keys typed into xterm reach the Session: Esc dismisses Claude Code's dialog.
  const input = page.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
  if (!input) throw new Error("no xterm input")
  await step(() =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }),
    ),
  )
  await eventually(() => expect(screen()).toContain("User rejected the command"))
  expect<unknown>(hub.received).toContainEqual({
    _tag: "TerminalInput",
    sessionId: demoSessionId,
    data: "\x1b",
  })

  // Leaving the view closes the terminal.
  await view.unmount()
  mounted = false
  await eventually(() => expect(hub.received.at(-1)?._tag).toBe("CloseTerminal"))
})
