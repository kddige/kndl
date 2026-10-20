// Complete durable thread flows against the fake Hub, including two live conversations.
import { afterEach, expect, test } from "bun:test"
import { SessionId } from "@kndl/protocol"
import { installDom } from "./dom.ts"
import { button, render, settle, step } from "./render.ts"
let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())
const { createMemoryHistory, RouterProvider } = await import("@tanstack/react-router")
const { HubProvider } = await import("../src/app/hub.tsx")
const { HubClient } = await import("../src/hub/client.ts")
const { FakeHub } = await import("../src/hub/fake/FakeHub.ts")
const { bob } = await import("../src/hub/fake/script.ts")
const { createAppRouter } = await import("../src/router.tsx")
const session = SessionId.make("s-demo")
function width(value: number) {
  ;(
    window as unknown as { happyDOM: { setViewport(size: { width: number }): void } }
  ).happyDOM.setViewport({ width: value })
}
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  width(1024)
})
async function eventually(check: () => void) {
  const until = Date.now() + 3000
  for (;;) {
    try {
      check()
      return
    } catch (error) {
      if (Date.now() > until) throw error
      await settle(10)
    }
  }
}
function type(field: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, value)
  field.dispatchEvent(new Event("input", { bubbles: true }))
}
async function open(path = "/sessions/s-demo?thread=thr-backoff", size = 1440) {
  width(size)
  const hub = new FakeHub({
    stepMs: 50,
    autoplay: false,
    you: bob,
    reply: () => [{ kind: "pause", steps: 1e6 }],
  })
  const client = new HubClient(hub, { retryDelay: () => 1 })
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }))
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
  await eventually(() => expect(view.container.querySelector("h1")).not.toBeNull())
  const panel = () => view.container.querySelector<HTMLElement>("main aside") as HTMLElement
  const field = (label: string) =>
    view.container.querySelector<HTMLTextAreaElement>(
      `textarea[aria-label="${label}"]`,
    ) as HTMLTextAreaElement
  return { hub, client, router, page: view.container, panel, field }
}

test("main and thread run beside each other; posting steers only the thread, stopping it leaves main running", async () => {
  const { client, hub, page, panel, field } = await open()
  expect(panel().textContent).toContain("Does it back off")
  expect(page.querySelector('[aria-label="Conversation"]')).not.toBeNull()
  await step(() => client.sendPrompt(session, "main stays busy"))
  await eventually(() =>
    expect(button("Stop", page.querySelector("main > div > div") ?? page)).toBeDefined(),
  )
  const mainTurn = hub.sessions.get(session)?.summary.currentTurn
  await step(() => type(field("Reply"), "thread starts independently"))
  await step(() => button("Send reply", panel()).click())
  // A local preview appears before the server echo, never twice after the echo/TurnStarted.
  expect(panel().textContent).toContain("thread starts independently")
  await eventually(() => expect(button("Steer", panel())).toBeDefined())
  expect(panel().textContent?.split("thread starts independently")).toHaveLength(2)
  await step(() => type(field("Reply"), "use a shorter backoff"))
  await step(() => button("Steer", panel()).click())
  await eventually(() =>
    expect(panel().querySelector("[data-steered]")?.textContent).toContain("use a shorter backoff"),
  )
  expect(panel().textContent?.split("use a shorter backoff")).toHaveLength(2)
  expect(hub.sessions.get(session)?.summary.currentTurn).toBe(mainTurn)
  await step(() => button("Stop", panel()).click())
  await eventually(() => expect(button("Send reply", panel())).toBeDefined())
  expect(hub.sessions.get(session)?.summary.currentTurn).toBe(mainTurn)
  expect(field("Prompt").disabled).toBe(false)
  expect(hub.received.filter((message) => message._tag === "PromptThread")).toHaveLength(2)
  expect(hub.received.some((message) => message._tag === "StopTurn")).toBe(false)
})

test("any Participant forks an answer, selects a Creator-owned Model, and lands in the new thread", async () => {
  const { hub, panel, page, field, router } = await open("/sessions/s-demo")
  const reply = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
    (each) => each.textContent?.trim() === "Reply in thread",
  )
  await step(() => reply?.click())
  await eventually(() => expect(panel()?.querySelector("h2")?.textContent).toBe("New thread"))
  expect(document.activeElement).toBe(field("Reply"))
  const picker = panel().querySelector<HTMLButtonElement>('button[aria-label^="Model:"]')
  await step(() => picker?.click())
  await settle()
  const model = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (each) => each.textContent === "GPT-6-Sol",
  )
  await step(() => model?.click())
  await step(() => type(field("Reply"), "Try this in a fork"))
  await step(() => button("Start thread", panel()).click())
  await eventually(() => expect(router.state.location.search).toHaveProperty("thread"))
  expect(hub.received.find((message) => message._tag === "CreateThread")).toMatchObject({
    anchorTurnId: "t-seed-1",
    model: "openai/gpt-6-sol",
    text: "Try this in a fork",
  })
  await eventually(() => expect(panel().querySelectorAll("[data-turn]")).toHaveLength(1))
  expect(panel().textContent?.split("Try this in a fork")).toHaveLength(3) // title + one prompt
  expect(panel().querySelector("[data-pending-reply]")).toBeNull()
})

test("at narrow widths, closing the thread restores the main draft and its keyboard opener", async () => {
  const { panel, page, field } = await open("/sessions/s-demo", 400)
  await step(() => type(field("Prompt"), "keep this draft"))
  const reply = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
    (each) => each.textContent?.trim() === "Reply in thread",
  )
  await step(() => {
    reply?.focus()
    reply?.click()
  })
  await eventually(() => expect(panel()?.querySelector("h2")?.textContent).toBe("New thread"))
  expect(field("Prompt").closest("[hidden]")).not.toBeNull()
  await step(() => button("Back to the conversation", panel()).click())
  await eventually(() => expect(panel()).toBeNull())
  expect(field("Prompt").value).toBe("keep this draft")
  expect(field("Prompt").closest("[hidden]")).toBeNull()
  expect(document.activeElement).toBe(reply ?? null)
})

test("a new thread is preselected to the Session's Model, with no row that follows the Session's", async () => {
  const { hub, panel, page, field } = await open("/sessions/s-demo")
  const { model } = hub.sessions.get(session)?.summary ?? {}
  expect(model).toBeDefined()
  const reply = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
    (each) => each.textContent?.trim() === "Reply in thread",
  )
  await step(() => reply?.click())
  await eventually(() => expect(panel()?.querySelector("h2")?.textContent).toBe("New thread"))
  const picker = panel().querySelector<HTMLButtonElement>('button[aria-label^="Model:"]')
  await step(() => picker?.click())
  await settle()
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
  expect(options.length).toBeGreaterThan(0)
  expect(options.some((each) => each.textContent?.includes("Same as the Session"))).toBe(false)
  expect(panel().textContent).not.toContain("Same as the Session")
  // The Session's own Model is the one picked, and what is sent without picking another.
  expect(options.find((each) => each.getAttribute("aria-selected") === "true")).toBeDefined()
  await step(() => options[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })))
  await step(() => type(field("Reply"), "Keep the model"))
  await step(() => button("Start thread", panel()).click())
  await eventually(() =>
    expect(hub.received.find((message) => message._tag === "CreateThread")).toBeDefined(),
  )
  expect(hub.received.find((message) => message._tag === "CreateThread")).toMatchObject({
    model,
  })
})
