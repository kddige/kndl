// Complete durable thread flows against the fake Hub, including two live conversations.
import { afterEach, expect, test } from "bun:test"
import { SessionId } from "@kndl/protocol"
import { installDom } from "./dom.ts"
import { button, render, settle, step } from "./render.ts"
let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())
const { createMemoryHistory, RouterProvider } = await import("@tanstack/react-router")
const { HubProvider } = await import("../src/app/hub.tsx")
const { CommandError, HubClient } = await import("../src/hub/client.ts")
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
    (each) => each.textContent?.trim() === "Reply in Thread",
  )
  await step(() => reply?.click())
  await eventually(() => expect(panel()?.querySelector("h2")?.textContent).toBe("New Thread"))
  expect(document.activeElement).toBe(field("Reply"))
  const picker = panel().querySelector<HTMLButtonElement>('button[aria-label^="Model:"]')
  await step(() => picker?.click())
  await settle()
  const model = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (each) => each.textContent === "GPT-6-Sol",
  )
  await step(() => model?.click())
  await step(() => type(field("Reply"), "Try this in a fork"))
  await step(() => button("Start Thread", panel()).click())
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
    (each) => each.textContent?.trim() === "Reply in Thread",
  )
  await step(() => {
    reply?.focus()
    reply?.click()
  })
  await eventually(() => expect(panel()?.querySelector("h2")?.textContent).toBe("New Thread"))
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
    (each) => each.textContent?.trim() === "Reply in Thread",
  )
  await step(() => reply?.click())
  await eventually(() => expect(panel()?.querySelector("h2")?.textContent).toBe("New Thread"))
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
  await step(() => button("Start Thread", panel()).click())
  await eventually(() =>
    expect(hub.received.find((message) => message._tag === "CreateThread")).toBeDefined(),
  )
  expect(hub.received.find((message) => message._tag === "CreateThread")).toMatchObject({
    model,
  })
})

test("starting a thread keeps the keyboard in the composer, not on the panel's heading", async () => {
  const { panel, page, field, router } = await open("/sessions/s-demo")
  const reply = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
    (each) => each.textContent?.trim() === "Reply in Thread",
  )
  await step(() => reply?.click())
  await eventually(() => expect(document.activeElement).toBe(field("Reply")))
  await step(() => type(field("Reply"), "Try this in a fork"))
  await step(() => button("Start Thread", panel()).click())
  await eventually(() => expect(router.state.location.search).toHaveProperty("thread"))
  await eventually(() => expect(panel().querySelectorAll("[data-turn]")).toHaveLength(1))
  expect(panel().querySelector("h2")?.textContent).not.toBe("New Thread")
  expect(document.activeElement).toBe(field("Reply"))
  expect(field("Reply").disabled).toBe(false)
})

test("Escape closes the thread panel from anywhere inside it, unless a menu or dialog took it", async () => {
  const { panel, field, router } = await open()
  await step(() => field("Reply").focus())
  // The composer doesn't use Escape, so it closes the panel.
  const menuTrigger = panel().querySelector<HTMLButtonElement>(
    'button[aria-label="Thread actions"]',
  )
  await step(() => menuTrigger?.click())
  await settle()
  const item = document.querySelector<HTMLElement>('[role="menuitem"]')
  expect(item).not.toBeNull()
  await step(() =>
    item?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  )
  await settle()
  expect(document.querySelector('[role="menuitem"]')).toBeNull()
  expect(router.state.location.search).toHaveProperty("thread")
  expect(panel()).not.toBeNull()
  await step(() => field("Reply").focus())
  await step(() =>
    field("Reply").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  )
  await eventually(() => expect(panel()).toBeNull())
  expect(router.state.location.search).not.toHaveProperty("thread")
})

test("the header says whose accounts pay, and its cost is the Session's total, broken down on click", async () => {
  const { page } = await open("/sessions/s-demo")
  const header = () => page.querySelector("h1")?.closest("header") as HTMLElement
  expect(header().textContent).toContain("Alice Kim's accounts pay")
  // The main conversation's $0.46 and the thread's $0.03.
  const total = button("$0.49 spent", header())
  expect(total.getAttribute("aria-haspopup")).toBe("dialog")
  await step(() => total.click())
  await eventually(() => expect(document.querySelector('[aria-label="Spent"]')).not.toBeNull())
  const rows = [...document.querySelectorAll('[aria-label="Spent"] li')].map(
    (row) => row.textContent,
  )
  expect(rows[0]).toBe("Main conversation$0.46")
  expect(rows[1]).toMatch(/^Thread: .*\$0\.03$/)
  expect(rows).toHaveLength(2)
})

test("a reply the agent couldn't take shows to everyone as not sent, with why", async () => {
  const { panel } = await open()
  await eventually(() => expect(panel().querySelector("[data-failed]")).not.toBeNull())
  const failed = panel().querySelector<HTMLElement>('[aria-label="Not sent"] [data-failed]')
  expect(failed?.textContent).toContain("Bob Lee")
  expect(failed?.textContent).toContain(
    "Reply not sent: The model refused the request: its context is full.",
  )
  expect(failed?.textContent).toContain("And does it back off the same way")
  expect(failed?.querySelector('[role="alert"]')).not.toBeNull()
})

test("a link to a thread or a Turn the Session doesn't have says so, with a way back and no composer", async () => {
  for (const path of ["/sessions/s-demo?thread=thr-nope", "/sessions/s-demo?fork=t-nope"]) {
    const { panel, router } = await open(path)
    await eventually(() => expect(panel().textContent).toContain("No such"))
    expect(panel().querySelector("textarea")).toBeNull()
    expect(panel().querySelector('button[aria-label^="Model:"]')).toBeNull()
    await step(() => button("Back to the conversation", panel()).click())
    await eventually(() => expect(panel()).toBeNull())
    expect(router.state.location.search).not.toHaveProperty("thread")
    expect(router.state.location.search).not.toHaveProperty("fork")
    await cleanup?.()
    cleanup = undefined
  }
})

test("an Archived Session offers no Reply in thread, as its palette doesn't", async () => {
  const { page } = await open("/sessions/s-flaky", 1440)
  await eventually(() => expect(page.querySelector("[data-turn]")).not.toBeNull())
  expect(
    [...page.querySelectorAll("button")].some(
      (each) => each.textContent?.trim() === "Reply in Thread",
    ),
  ).toBe(false)
})

test("a thread says what it is doing in words, not only in a tooltip", async () => {
  const { panel, field } = await open()
  await step(() => type(field("Reply"), "keep going"))
  await step(() => button("Send reply", panel()).click())
  await eventually(() => expect(button("Steer", panel())).toBeDefined())
  expect(panel().querySelector("header")?.textContent).toMatch(/(Thinking|Writing|Running \w+)…/)
  expect(panel().querySelector("header [title$='…']")).toBeNull()
})

test("a thread being started is announced by a region that was empty first, and the visible copy keeps out of the reader's way", async () => {
  const { client, panel, page, field } = await open("/sessions/s-demo")
  // The Hub hasn't made it yet.
  client.createThread = () => new Promise(() => {})
  const reply = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
    (each) => each.textContent?.trim() === "Reply in Thread",
  )
  await step(() => reply?.click())
  await eventually(() => expect(panel()?.querySelector("h2")?.textContent).toBe("New Thread"))
  await step(() => type(field("Reply"), "Try this in a fork"))
  await step(() => button("Start Thread", panel()).click())
  const note = panel().querySelector<HTMLElement>("span[class*='sentNote']")
  expect(panel().querySelector('[role="status"]')?.textContent).toBe("Starting the Thread…")
  expect(note?.getAttribute("aria-hidden")).toBe("true")
})

test("a refused reply shows in the panel only, not also as a toast", async () => {
  const { hub, panel, field } = await open()
  // The Session was archived under this tab, which hasn't heard yet.
  const fake = hub.sessions.get(session)
  if (fake) fake.summary = { ...fake.summary, state: "Archived" }
  await step(() => type(field("Reply"), "too late"))
  await step(() => button("Send reply", panel()).click())
  await eventually(() =>
    expect(panel().querySelector("[data-pending-reply]")?.textContent).toContain(
      "Reply not sent: The Session is archived: restore it first.",
    ),
  )
  expect(document.querySelector("[data-type]")).toBeNull()
})

test("a thread whose answer the dropped connection took may exist: it says to check, not that it didn't start", async () => {
  const { client, panel, page, field } = await open("/sessions/s-demo")
  client.createThread = () =>
    Promise.reject(new CommandError("Lost the connection to the Hub.", true))
  const reply = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
    (each) => each.textContent?.trim() === "Reply in Thread",
  )
  await step(() => reply?.click())
  await eventually(() => expect(panel()?.querySelector("h2")?.textContent).toBe("New Thread"))
  await step(() => type(field("Reply"), "Try this in a fork"))
  await step(() => button("Start Thread", panel()).click())
  await eventually(() => expect(panel().querySelector('[role="alert"]')?.textContent).toBeTruthy())
  expect(panel().querySelector('[role="alert"]')?.textContent).toBe(
    "Thread may have started: Lost the connection to the Hub. Check the Threads list before retrying.",
  )
  expect(panel().textContent).not.toContain("Thread not started")
})

test("a thread forked off a Turn that was running says its answer has grown since", async () => {
  const { client, page, panel, field } = await open("/sessions/s-demo")
  await step(() => client.sendPrompt(session, "main stays busy"))
  await eventually(() =>
    expect(button("Stop", page.querySelector("main > div > div") ?? page)).toBeDefined(),
  )
  const replies = () =>
    [...page.querySelectorAll<HTMLButtonElement>("button")].filter(
      (each) => each.textContent?.trim() === "Reply in Thread",
    )
  await step(() => replies().at(-1)?.click())
  await eventually(() => expect(panel()?.querySelector("h2")?.textContent).toBe("New Thread"))
  expect(panel().textContent).toContain(
    "This Turn is still running: the Thread forks from where it has got to.",
  )
  await step(() => type(field("Reply"), "Try this in a fork"))
  await step(() => button("Start Thread", panel()).click())
  await eventually(() =>
    expect(panel().textContent).toContain("Forked while this Turn was running"),
  )
})
