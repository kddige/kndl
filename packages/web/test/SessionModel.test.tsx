// Durable Sessions: one Creator-owned Model catalog, available to every Participant. Switching
// changes the next request in place, never relaunches the agent or interrupts background work.
import { afterEach, expect, test } from "bun:test"
import { SessionId } from "@kndl/protocol"
import { installDom } from "./dom.ts"
import { button, dialog, render, settle, step } from "./render.ts"

let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})
const { createMemoryHistory, RouterProvider } = await import("@tanstack/react-router")
const { HubProvider } = await import("../src/app/hub.tsx")
const { HubClient } = await import("../src/hub/client.ts")
const { FakeHub } = await import("../src/hub/fake/FakeHub.ts")
const { bob, demoSessionId, piSessionId } = await import("../src/hub/fake/script.ts")
const { createAppRouter } = await import("../src/router.tsx")
async function eventually(check: () => void): Promise<void> {
  const deadline = Date.now() + 3000
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
async function open(path: string, options: ConstructorParameters<typeof FakeHub>[0] = {}) {
  const hub = new FakeHub({ stepMs: 2, autoplay: false, ...options })
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
  const page = view.container
  return {
    hub,
    client,
    router,
    page,
    conversation: () => page.querySelector('[aria-label="Conversation"]')?.textContent ?? "",
    picker: () =>
      [...page.querySelectorAll("button")].find((el) =>
        el.getAttribute("aria-label")?.startsWith("Model: "),
      ) ?? null,
  }
}
const option = (label: string) => {
  const row = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (each) => each.textContent === label,
  )
  if (!row) throw new Error(`no ${label} option`)
  return row
}
const groupNames = () =>
  [...document.querySelectorAll('[role="listbox"] [role="group"]')].map(
    (group) => document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent,
  )
const switches = (hub: InstanceType<typeof FakeHub>) =>
  hub.received.flatMap((m) =>
    m._tag === "SetSessionModel" ? [{ model: m.model, thinkingLevel: m.thinkingLevel }] : [],
  )
async function pick(picker: () => HTMLButtonElement | null, label: string) {
  await step(() => picker()?.click())
  await settle()
  await step(() => option(label).click())
}

test("a switch names the Model, and older Turns retain the Model they ran on", async () => {
  const { page, conversation, picker } = await open(`/sessions/${demoSessionId}`)
  await eventually(() =>
    expect(conversation()).toContain("Alice Kim switched to Claude Sonnet 5.5, High"),
  )
  expect(picker()?.textContent).toBe("Claude Sonnet 5.5")
  expect(button("Thinking: High", page).textContent).toBe("High")
  await pick(picker, "GPT-6-Sol")
  await eventually(() => expect(picker()?.textContent).toBe("GPT-6-Sol"))
  expect(
    [...page.querySelectorAll('[title="The model this Turn ran on"]')].map((el) => el.textContent),
  ).toEqual(["Claude Sonnet 5.5", "Claude Sonnet 5.5"])
})

test("any Participant switches among the Creator's Models, in one list grouped only by Provider", async () => {
  const { hub, client, conversation, picker, page } = await open(`/sessions/${piSessionId}`, {
    you: bob,
  })
  await eventually(() => expect(picker()?.textContent).toBe("GPT-6-Sol"))
  expect(
    client
      .getState()
      .joined[SessionId.make(piSessionId)]?.models?.some(
        (model) => model.label === "Claude Opus 5.5",
      ),
  ).toBe(true)
  expect(page.textContent).toContain("Alice Kim's accounts pay")
  await step(() => picker()?.click())
  await settle()
  expect(groupNames()).toEqual(["Anthropic", "OpenAI"])
  expect(document.querySelector('[role="listbox"]')?.textContent).not.toContain("Claude Code")
  await step(() => option("Claude Opus 5.5").click())
  expect(dialog()).toBeNull()
  await eventually(() =>
    expect(conversation()).toContain("Bob Lee switched to Claude Opus 5.5, High"),
  )
  expect(switches(hub)).toEqual([{ model: "anthropic/claude-opus-5-5", thinkingLevel: "high" }])
})

test("switching while a Turn runs takes effect between Turns, with no handoff dialog", async () => {
  const { hub, page, picker } = await open(`/sessions/${piSessionId}`, {
    reply: () => [{ kind: "pause", steps: 1e6 }],
  })
  await eventually(() => expect(picker()?.textContent).toBe("GPT-6-Sol"))
  hub.creatorPrompts(piSessionId, "Keep going")
  await eventually(() => expect(hub.sessions.get(piSessionId)?.summary.currentTurn).not.toBeNull())
  await pick(picker, "Claude Opus 5.5")
  expect(dialog()).toBeNull()
  await eventually(() => expect(hub.sessions.get(piSessionId)?.summary.modelPending).toBe(true))
  expect(hub.sessions.get(piSessionId)?.summary.harness).toBe("Pi")
  expect(page.textContent).toContain("Claude Opus 5.5 takes over when this Turn ends.")
  expect(button("Stop", page)).toBeDefined()
})

test("a Model switch doesn't interrupt a background agent", async () => {
  const { hub, picker } = await open("/sessions/s-release")
  await eventually(() => expect(picker()).not.toBeNull())
  const before = hub.sessions.get("s-release")?.summary.agents
  await pick(picker, "GPT-6-Sol")
  await eventually(() => expect(switches(hub)).toHaveLength(1))
  expect(dialog()).toBeNull()
  expect(hub.sessions.get("s-release")?.summary.agents).toEqual(before)
})

test("New Session carries the selected provider/id Model through creation", async () => {
  const { hub, router, picker } = await open("/sessions/s-readme")
  await eventually(() => expect(picker()).not.toBeNull())
  await step(() => button("New Session", document).click())
  await settle()
  const form = dialog() as HTMLElement
  const repo = form.querySelector<HTMLInputElement>('input[placeholder="kddige/kndl"]')
  await step(() => {
    if (!repo) throw new Error("no Repo")
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      repo,
      "kddige/kndl",
    )
    repo.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await eventually(() =>
    expect(form.querySelectorAll<HTMLInputElement>('input[role="combobox"]')[1]?.value).toBe(
      "main",
    ),
  )
  await step(() => button("Model: Claude Opus 5.5", form).click())
  await settle()
  await step(() => option("Claude Sonnet 5.5").click())
  await settle()
  await step(() => button("Start Session", form).click())
  await eventually(() =>
    expect(hub.received.find((m) => m._tag === "CreateSession")).toMatchObject({
      model: "anthropic/claude-sonnet-5-5",
    }),
  )
  await eventually(() => expect(router.state.location.pathname).toStartWith("/sessions/s-new-"))
  await eventually(() => expect(picker()?.textContent).toBe("Claude Sonnet 5.5"))
  await settle(200)
})

test("without a Claude credential, other connected Models remain usable", async () => {
  const { picker, page } = await open(`/sessions/${piSessionId}`, { claudeCredential: null })
  await eventually(() => expect(picker()?.textContent).toBe("GPT-6-Sol"))
  await step(() => picker()?.click())
  await settle()
  expect(groupNames()).toEqual(["OpenAI"])
  expect(page.textContent).not.toContain("can't wake")
  expect(page.querySelector("textarea")?.getAttribute("placeholder")).toBe("Send a prompt")
})
