// A smoke test of the Session view: the whole app, routed to the demo Session, against the fake
// Hub playing its script fast.

import { expect, test } from "bun:test"
import { hubMcpServerId, RequestId, type SessionId } from "@kndl/protocol"
import { Redacted } from "effect"
import { act } from "react"
import { installDom } from "./dom.ts"
import { button, dialog, menuItem, render, settle, step } from "./render.ts"

let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())

// Loaded after installDom() and the StyleX compiler, so components see the DOM and compile.
const { createMemoryHistory, RouterProvider } = await import("@tanstack/react-router")
const { HubProvider } = await import("../src/app/hub.tsx")
const { HubClient } = await import("../src/hub/client.ts")
const { FakeHub } = await import("../src/hub/fake/FakeHub.ts")
const { bob, bobsSessionId, demoSessionId, releaseSessionId, you } =
  await import("../src/hub/fake/script.ts")
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

/** Like `eventually`, for a check that has to open a menu first. */
async function eventuallyAsync(check: () => Promise<void>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await check()
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await settle(10)
    }
  }
}

/** The Session's ⋯ menu's item named `name`, opening the menu; undefined if it has none. */
async function sessionItem(page: ParentNode, name: string): Promise<HTMLElement | undefined> {
  if (!document.querySelector('[role="menu"]')) {
    await step(() => button("Session actions", page).click())
    await settle(20)
  }
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent?.trim() === name,
  )
}

async function closeMenu(page: ParentNode): Promise<void> {
  if (!document.querySelector('[role="menu"]')) return
  await step(() => button("Session actions", page).click())
  await settle(50)
}

/** Whether the Session's ⋯ menu offers `name`, enabled. */
async function offers(page: ParentNode, name: string): Promise<boolean> {
  const item = await sessionItem(page, name)
  const enabled = item !== undefined && !item.hasAttribute("data-disabled")
  await closeMenu(page)
  return enabled
}

/** Chooses `name` from the Session's ⋯ menu. */
async function choose(page: ParentNode, name: string): Promise<void> {
  const item = await sessionItem(page, name)
  if (!item) throw new Error(`no "${name}" in the Session's menu`)
  await step(() => item.click())
  await settle(50)
}

function typeInto(field: HTMLTextAreaElement, value: string): void {
  // React tracks the value it last saw; the prototype's setter goes around that, as typing does.
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
  setValue?.call(field, value)
  field.dispatchEvent(new Event("input", { bubbles: true }))
}

test("the Session view plays the fake Hub's scripted Session", async () => {
  // Slow enough steps that the first Turn still runs while the test opens who's here and queues a
  // prompt: Alice's follow-up from her other tab waits in the queue only for the Turn's last ~35
  // steps.
  const hub = new FakeHub({ stepMs: 20 })
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

  // Connected and joined: the Session's header, named by its work branch, with its Repo.
  await eventually(() => expect(page.querySelector("h1")?.textContent).toBe("claude/web-client"))
  expect(page.querySelector("h1")?.closest("header")?.textContent).toContain("kddige/kndl")
  // Alice started it, so she drives it (ADR 0026).
  expect(page.querySelector("h1")?.closest("header")?.textContent).toContain("you drive it")
  expect(hub.received.map((message) => message._tag)).toContain("JoinSession")
  // She keeps it awake (ADR 0016).
  expect(page.querySelector("h1")?.closest("header")?.textContent).toContain("Kept awake by you")

  // A second Participant joins to watch, and Alice's prompt from her other tab starts a Turn.
  await eventually(() =>
    expect(
      page.querySelector('[role="group"][aria-label^="Here now"]')?.getAttribute("aria-label"),
    ).toContain("Bob Lee"),
  )
  // Bob forwards its ports too (#180): the list of who's here says from where.
  const here = page.querySelector<HTMLButtonElement>('button[aria-label^="Here now"]')
  expect(here?.getAttribute("aria-label")).toBe(
    "Here now: Alice Kim, Bob Lee · forwarding from bob-mbp",
  )
  await step(() => here?.click())
  await eventually(() =>
    expect(
      [...document.querySelectorAll('ul[aria-label="Here now"] li')].map((li) => li.textContent),
    ).toEqual(["AKAlice Kim", "BLBob Leeforwarding from bob-mbp"]),
  )
  await step(() =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  )
  await eventually(() => expect(conversation()).toContain("Can you make tool calls collapse"))
  expect(conversation()).toContain("Alice Kim")

  // While it runs: Stop is offered, and her follow-up waits in the queue.
  await eventually(() => expect(hasButton("Stop")).toBe(true))
  await eventually(() => expect(queue()).toContain("Then add a line about it to the README"))

  // A prompt sent mid-Turn queues; cancelling it takes it out.
  const prompt = page.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')
  if (!prompt) throw new Error("no prompt field")
  await step(() => typeInto(prompt, "And a test for it"))
  await step(() => button("Queue prompt", page).click())
  await eventually(() => expect(queue()).toContain("And a test for it"))
  const queued = [...page.querySelectorAll('[aria-label="Prompt queue"] li')].find((row) =>
    row.textContent?.includes("And a test for it"),
  )
  if (!queued) throw new Error("not queued")
  await step(() => button("Cancel Alice Kim's prompt", queued).click())
  await eventually(() => expect(queue()).not.toContain("And a test for it"))
  expect(queue()).toContain("Then add a line about it to the README")
  expect(hub.received.map((message) => message._tag)).toContain("CancelPrompt")

  // The streamed answer arrives whole; then the queued prompt runs as its own Turn.
  await eventually(() => expect(conversation()).toContain("The tests pass."))
  await eventually(() => expect(conversation()).toContain("That's done."))
  await eventually(() => expect(page.querySelector('[aria-label="Prompt queue"]')).toBeNull())

  // The background agent works on in its worktree after its Turn; done, it starts a Turn of its own.
  expect(conversation()).toContain("worktree-agent-docs")
  await eventually(() => expect(conversation()).toContain("The docs agent found one page"))
  const fromAgent = page.querySelector('[data-turn] a[href$="?agent=agent-docs"]')
  expect(fromAgent?.textContent).toBe("Find docs that mention tool calls")
  await eventually(() => expect(hasButton("Stop")).toBe(false))

  // Tool calls and the finished subagents are collapsed: their summaries show, their details don't.
  const toggles = [...page.querySelectorAll('[aria-label="Conversation"] [aria-expanded]')]
  expect(toggles.length).toBeGreaterThan(4)
  expect(toggles.every((toggle) => toggle.getAttribute("aria-expanded") === "false")).toBe(true)
  expect(conversation()).toContain("Survey the UI kit")
  expect(conversation()).not.toContain("Disclosure is the one")
  expect(conversation()).not.toContain("58 pass")

  // Opening a subagent's card shows its own work, grouped under it.
  const agent = toggles.find((toggle) => toggle.textContent?.includes("Survey the UI kit"))
  await step(() => (agent as HTMLElement).click())
  await eventually(() => expect(conversation()).toContain("Disclosure is the one"))
})

test("a queued prompt steered into the running Turn leaves the queue and joins it (#195)", async () => {
  // Slow enough steps that the Turn is still running when Steer is pressed.
  const hub = new FakeHub({ stepMs: 100, autoplay: false })
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
  const steerButtons = () =>
    [...page.querySelectorAll("button")].filter((el) => el.textContent?.trim() === "Steer")
  await eventually(() => expect(page.querySelector("h1")?.textContent).toBe("claude/web-client"))
  const prompt = page.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')
  if (!prompt) throw new Error("no prompt field")

  await step(() => typeInto(prompt, "Rename the flag"))
  await step(() => button("Send prompt", page).click())
  // Running: an empty prompt offers live voice, so the field says it queues.
  await eventually(() => expect(prompt.placeholder).toBe("Queue a prompt for after this Turn"))
  await step(() => typeInto(prompt, "And a line in the changelog"))
  await step(() => button("Queue prompt", page).click())
  await eventually(() => expect(queue()).toContain("And a line in the changelog"))
  expect(steerButtons()).toHaveLength(1)

  const steer = () => button("Steer Alice Kim's prompt into the running Turn", page)
  await step(() => steer().click())
  expect(hub.received.map((message) => message._tag)).toContain("SteerPrompt")
  // As on the Hub, it keeps its place in the queue, its Steer button spinning, until the mod
  // says it joined the Turn.
  expect(queue()).toContain("And a line in the changelog")
  expect(steer().getAttribute("aria-busy")).toBe("true")
  await eventually(() => expect(page.querySelector('[aria-label="Prompt queue"]')).toBeNull())
  // It joins the running Turn, the one Alice's first prompt started, under her name.
  const steered = () => page.querySelector("[data-steered]")
  await eventually(() => expect(steered()?.textContent).toContain("And a line in the changelog"))
  expect(steered()?.textContent).toContain("Alice Kim")
  expect(steered()?.closest("[data-turn]")?.textContent).toContain("Rename the flag")
  // Then Claude reads it, at the Turn's next step.
  await eventually(() => expect(steered()?.textContent).toContain("Steered into the Turn"))
  // It started no Turn of its own.
  expect(conversation().split("And a line in the changelog")).toHaveLength(2)
})

test("a steer the Turn ends before keeps the prompt in its place, and its spinner stops (#195)", async () => {
  const hub = new FakeHub({ stepMs: 100, autoplay: false })
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
  const queue = () => page.querySelector('[aria-label="Prompt queue"]')?.textContent ?? ""
  await eventually(() => expect(page.querySelector("h1")?.textContent).toBe("claude/web-client"))
  const prompt = page.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')
  if (!prompt) throw new Error("no prompt field")
  await step(() => typeInto(prompt, "Rename the flag"))
  await step(() => button("Send prompt", page).click())
  // Running: an empty prompt offers live voice, so the field says it queues.
  await eventually(() => expect(prompt.placeholder).toBe("Queue a prompt for after this Turn"))
  await step(() => typeInto(prompt, "And a line in the changelog"))
  await step(() => button("Queue prompt", page).click())
  await eventually(() => expect(queue()).toContain("And a line in the changelog"))

  // Stopped before the mod could append it, the Turn ends with the steer unanswered.
  const steer = "Steer Alice Kim's prompt into the running Turn"
  await step(() => button(steer, page).click())
  expect(button(steer, page).getAttribute("aria-busy")).toBe("true")
  await step(() => button("Stop", page).click())

  // The mod fails it, and the prompt waits as before; then it goes next, as a Turn of its own.
  await eventually(() =>
    expect(findToast("The prompt could not join the running Turn")).toBeDefined(),
  )
  expect(page.querySelector("[data-steered]")).toBeNull()
  const lastTurn = () => [...page.querySelectorAll("[data-turn]")].at(-1)?.textContent ?? ""
  await eventually(() => expect(lastTurn()).toContain("And a line in the changelog"))
  expect(page.querySelector("[data-steered]")).toBeNull()
  const { toast } = await import("../src/ui/index.ts")
  await step(() => toast.close())
})

/**
 * The whole app on one of the fake Hub's seeded Sessions, its script not playing, once a banner
 * starting with `bannerStart` shows.
 */
async function openSession(
  sessionId: string,
  bannerStart = "This Session is",
  stepMs = 2,
  owner = true,
) {
  const hub = new FakeHub({ stepMs, autoplay: false, owner })
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
    [...page.querySelectorAll("[data-banner]")]
      .map((el) => el.textContent ?? "")
      .find((content) => content.startsWith(bannerStart)) ?? ""
  await eventually(() => expect(banner()).not.toBe(""))
  return {
    hub,
    client,
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
  // Woken, it is started first: it can't be put to sleep until that is done (#70).
  expect(page.textContent).toContain("Starting…")
  // Read together, as opening the menu takes a moment in which it may finish starting.
  const sleepNow = await sessionItem(page, "Sleep now")
  if (page.textContent?.includes("Starting…")) {
    expect(sleepNow?.hasAttribute("data-disabled")).toBe(true)
  }
  await closeMenu(page)
  await eventuallyAsync(async () => expect(await offers(page, "Sleep now")).toBe(true))
  expect(page.textContent).not.toContain("Starting…")

  await choose(page, "Sleep now")
  expect(sent()).toContain("SleepSession")
  await eventually(() => expect(banner()).toContain("Put to sleep."))
  // Asleep, it has nothing to put to sleep.
  expect(await sessionItem(page, "Sleep now")).toBeUndefined()
  await closeMenu(page)
})

test("Keep awake wakes an Asleep Session, says who keeps it awake, and Sleep now turns it off", async () => {
  const { hub, page, banner, header, sent } = await openSession("s-readme")
  // Its toggle is at the Composer, where its Creator already is.
  const keepAwake = () => {
    const toggle = page.querySelector<HTMLElement>("form button[aria-pressed][aria-label*='awake']")
    if (!toggle) throw new Error("no Keep awake toggle")
    return toggle
  }
  expect(keepAwake().getAttribute("aria-label")).toBe("Keep awake")
  expect(header()).not.toContain("Kept awake by")
  expect(keepAwake().getAttribute("aria-pressed")).toBe("false")

  // On, it says who, and the Asleep Session wakes.
  await step(() => keepAwake().click())
  expect(sent()).toContain("SetKeepAwake")
  await eventually(() => expect(header()).toContain("Kept awake by you"))
  expect(keepAwake().getAttribute("aria-pressed")).toBe("true")
  await eventually(() => expect(banner()).toBe(""))

  // Sleep now turns it off.
  await eventuallyAsync(async () => expect(await offers(page, "Sleep now")).toBe(true))
  await choose(page, "Sleep now")
  await eventually(() => expect(banner()).toContain("Put to sleep."))
  expect(header()).not.toContain("Kept awake by")
  expect(keepAwake().getAttribute("aria-pressed")).toBe("false")

  // And off by the toggle, it stays Asleep.
  await step(() => keepAwake().click())
  await eventually(() => expect(header()).toContain("Kept awake by you"))
  await step(() => keepAwake().click())
  await eventually(() => expect(header()).not.toContain("Kept awake by"))
  const last = hub.received.findLast((message) => message._tag === "SetKeepAwake")
  expect(last?._tag === "SetKeepAwake" && last.on).toBe(false)
})

test("a Session whose Claude Code exited on its own shows what it printed, folded (#105)", async () => {
  const { hub, page, banner, header } = await openSession("s-readme")
  await step(() => button("Wake now", page).click())
  await eventuallyAsync(async () => expect(await offers(page, "Sleep now")).toBe(true))

  const output = "error: The current working directory was deleted, so that command didn't work."
  await step(() => hub.claudeExits("s-readme", 1, output))
  await eventually(() => expect(banner()).toContain("Claude Code exited with code 1."))
  expect(header()).toContain("Asleep")
  // Folded until asked for.
  expect(banner()).not.toContain(output)
  await step(() => button("Show Claude Code's last output", page).click())
  expect(page.querySelector('[aria-label="Claude Code\'s last output"]')?.textContent).toBe(output)

  // Started again, it is gone.
  await step(() => button("Wake now", page).click())
  await eventuallyAsync(async () => expect(await offers(page, "Sleep now")).toBe(true))
  await choose(page, "Sleep now")
  await eventually(() => expect(banner()).toContain("Put to sleep."))
  expect([...page.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
    "Show Claude Code's last output",
  )
})

test("a Session that can't start for values a secrets-reset cleared leads to its Environment", async () => {
  const { hub, page, banner, header, sent } = await openSession("s-readme", "This Session")
  hub.environments.resetSecrets()

  await step(() => button("Wake now", page).click())
  expect(sent()).toContain("WakeSession")
  await eventually(() => expect(banner()).toContain("This Session can't start"))
  expect(banner()).toContain(
    "kddige/kndl's Sessions can't start: NPM_TOKEN and GITHUB_TOKEN (the shared variable GH_READ_TOKEN) need values.",
  )
  expect(banner()).toContain("Prompts sent now wait in the queue until it starts.")
  expect(header()).toContain("Asleep")

  await step(() => button("Enter values", page).click())
  await eventually(() => expect(page.querySelector("h1")?.textContent).toContain("kddige/kndl"))
  await eventually(() => expect(page.textContent).toContain("NPM_TOKEN needs a value: enter one."))
})

/** Puts Linear, an Installation without its API key, on in `repos` (#216). */
const installLinear = (client: InstanceType<typeof HubClient>, repos: ReadonlyArray<string>) =>
  step(() => client.createInstallation(hubMcpServerId("linear"), "Linear", repos))

const linearOf = (hub: InstanceType<typeof FakeHub>) =>
  hub.mcpServers.state(() => true).installations.find((one) => one.name === "Linear")

test("a Session an Installation keeps from starting takes its Repo off it, and starts (#216)", async () => {
  const { hub, client, page, banner, header, sent } = await openSession("s-readme", "This Session")
  await installLinear(client, ["kddige/kndl", "kddige/website"])

  await step(() => button("Wake now", page).click())
  await eventually(() => expect(banner()).toContain("This Session can't start"))
  expect(banner()).toContain("Linear needs a value for API key.")
  expect(banner()).toContain("Prompts sent now wait in the queue until it starts.")
  expect(header()).toContain("Asleep")
  // Fix opens that Installation on the MCP page.
  expect(page.querySelector('a[aria-label="Fix Linear"]')?.getAttribute("href")).toBe(
    `/mcp?installation=${linearOf(hub)?.id}`,
  )

  // Retry checks it again: still no value.
  const wakes = () => sent().filter((tag) => tag === "WakeSession").length
  await step(() => button("Retry", page).click())
  await eventually(() => expect(wakes()).toBe(2))
  expect(header()).toContain("Asleep")

  // Whoever may change it takes this Repo off it in one click, and the Session starts.
  await eventually(() => expect(button("Take kddige/kndl off Linear", page)).toBeDefined())
  await step(() => button("Take kddige/kndl off Linear", page).click())
  await eventually(() => expect(header()).toContain("Active"))
  expect(sent()).toContain("EditInstallation")
  expect(linearOf(hub)?.repos).toEqual(["kddige/website"])
})

test("a prompt queued while an Installation keeps the Session from starting runs once it starts (#216)", async () => {
  const { hub, client, page, banner, sent } = await openSession("s-readme", "This Session")
  await installLinear(client, ["kddige/kndl"])

  const prompt = page.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')
  if (!prompt) throw new Error("no prompt field")
  await step(() => typeInto(prompt, "Summarize the open issues"))
  await step(() => button("Send prompt", page).click())
  await eventually(() => expect(banner()).toContain("This Session can't start"))
  const queue = () => page.querySelector('[aria-label="Prompt queue"]')?.textContent ?? ""
  expect(queue()).toContain("Summarize the open issues")

  // Its only Repo: taking it off deletes the Installation, so that is confirmed first.
  await eventually(() => expect(button("Take kddige/kndl off Linear", page)).toBeDefined())
  await step(() => button("Take kddige/kndl off Linear", page).click())
  expect(sent()).not.toContain("DeleteInstallation")
  await eventually(() =>
    expect(dialog()?.textContent).toContain("kddige/kndl is the only Repo it is on in"),
  )
  await step(() => button("Delete Installation").click())
  await eventually(() => expect(sent()).toContain("DeleteInstallation"))
  expect(linearOf(hub)).toBeUndefined()
  await eventually(() => expect(queue()).toBe(""))
  const conversation = () => page.querySelector('[aria-label="Conversation"]')?.textContent ?? ""
  await eventually(() => expect(conversation()).toContain("Summarize the open issues"))
})

test("a Session a global Installation keeps from starting turns it off for its Repo, and starts (#219)", async () => {
  const { hub, client, page, banner, header, sent } = await openSession("s-readme", "This Session")
  await step(() => client.createInstallation(hubMcpServerId("linear"), "Linear", [], [], true))
  await eventually(() => expect(linearOf(hub)?.global).toBe(true))

  await step(() => button("Wake now", page).click())
  await eventually(() => expect(banner()).toContain("This Session can't start"))
  expect(banner()).toContain("Fix it, or turn it off for kddige/kndl, then retry.")
  // The Owner can fix it.
  expect(page.querySelector('a[aria-label="Fix Linear"]')).not.toBeNull()

  // Anyone in the Session turns it off for its Repo in one click, and the Session starts.
  await eventually(() => expect(button("Turn Linear off for kddige/kndl", page)).toBeDefined())
  await step(() => button("Turn Linear off for kddige/kndl", page).click())
  await eventually(() => expect(header()).toContain("Active"))
  expect(sent()).toContain("TurnGlobalInstallation")
  expect(linearOf(hub)?.off).toEqual(["kddige/kndl"])
  expect(linearOf(hub)?.global).toBe(true)
})

test("only the Owner can fix a global Installation that keeps a Session from starting (#219)", async () => {
  const { hub, page, banner } = await openSession("s-readme", "This Session", 2, false)
  hub.mcpServers.change(
    {
      _tag: "CreateInstallation",
      requestId: RequestId.make("seed"),
      mcpServerId: hubMcpServerId("linear"),
      name: "Linear",
      global: true,
      repos: [],
    },
    you,
    () => true,
    true,
  )
  await step(() => button("Wake now", page).click())
  await eventually(() => expect(banner()).toContain("This Session can't start"))
  expect(banner()).toContain("It is global: only the Hub's Owner can fix it.")
  expect(page.querySelector('a[aria-label="Fix Linear"]')).toBeNull()
  await eventually(() => expect(button("Turn Linear off for kddige/kndl", page)).toBeDefined())
})

test("Fix opens the Installation that keeps a Session from starting (#216)", async () => {
  const { client, page, banner } = await openSession("s-readme", "This Session")
  await installLinear(client, ["kddige/kndl"])
  await step(() => button("Wake now", page).click())
  await eventually(() => expect(banner()).toContain("This Session can't start"))

  await step(() => page.querySelector<HTMLAnchorElement>('a[aria-label="Fix Linear"]')?.click())
  await eventually(() => expect(page.querySelector("h1")?.textContent).toBe("MCP servers"))
  await eventually(() => expect(dialog()?.textContent).toContain("Edit Linear"))
})

test("an Installation that fails mid-Session shows as an error in it, which runs on (#216)", async () => {
  const { hub, page, header } = await openSession(releaseSessionId)
  await step(() => button("Wake now", page).click())
  await eventuallyAsync(async () => expect(await offers(page, "Sleep now")).toBe(true))

  await step(() => hub.installationFails(releaseSessionId, "Sentry", 401))
  const notes = () =>
    [...page.querySelectorAll('[aria-label="Conversation"] [role="note"]')].map(
      (note) => note.textContent ?? "",
    )
  await eventually(() =>
    expect(
      notes().some((note) =>
        note.includes(
          "Sentry's MCP server refused its credential (401). Its tools fail until the Installation is fixed and the Session restarted.",
        ),
      ),
    ).toBe(true),
  )
  const fix = page.querySelector<HTMLAnchorElement>(
    '[aria-label="Conversation"] a[aria-label="Fix Sentry"]',
  )
  expect(fix?.getAttribute("href")).toStartWith("/mcp?installation=")
  expect(header()).toContain("Active")
})

test("a restart for a changed Environment shows its progress until the Session is back", async () => {
  const { hub, page, banner, sent } = await openSession(demoSessionId, "Environment changed")
  expect(banner()).toContain("version 2 is the latest")
  const statuses = () =>
    [...page.querySelectorAll("[data-banner]")].map((el) => el.textContent ?? "").join("\n")
  // Each step of the restart waits for the test, so a slow machine can't skip past one (#315).
  hub.hold()

  await step(() => button("Restart", page).click())
  expect(sent()).toContain("RestartSession")
  // Stopping it first...
  await eventually(() => expect(statuses()).toContain("Restarting…"))
  expect(statuses()).toContain("You asked for a restart.")
  expect(banner()).toBe("")
  expect(await offers(page, "Sleep now")).toBe(false)
  // ...then, once its Runner has stopped it, starting it on the latest version, with its log.
  await act(() => hub.step())
  await act(() => hub.step())
  await eventually(() => expect(statuses()).toContain("Starting the Sandbox on version 2"))
  expect(statuses()).toContain("Restarting…")
  await act(() => hub.step())
  await step(() => button("Show log", page).click())
  await eventually(() =>
    expect(page.querySelector('[aria-label="Start log"]')?.textContent).toContain(
      "Building version 2 of kddige/kndl's Environment",
    ),
  )

  // Back, on the latest version: no banner.
  hub.resume()
  await eventually(() => expect(statuses()).not.toContain("Restarting…"))
  expect(banner()).toBe("")
  expect(await offers(page, "Sleep now")).toBe(true)
})

/** The MCP servers button in `page`'s header, if it shows. */
const mcpServersButton = (page: HTMLElement) =>
  [...page.querySelectorAll("header button")].find((el) =>
    el.getAttribute("aria-label")?.startsWith("MCP servers: "),
  ) as HTMLButtonElement | undefined

/** The open list of the Session's Installations, as their rows' text. */
const installationRows = () =>
  [...document.querySelectorAll('[aria-label="Installations this Session runs with"] li')].map(
    (li) => li.textContent ?? "",
  )

test("a Session shows the Installations it runs with, as Claude Code names their servers (ADR 0020)", async () => {
  const { page } = await openSession(demoSessionId, "Environment changed")
  await eventually(() =>
    expect(mcpServersButton(page)?.getAttribute("aria-label")).toBe("MCP servers: 2 Installations"),
  )
  await step(() => mcpServersButton(page)?.click())
  await eventually(() => expect(installationRows()).toHaveLength(2))
  expect(installationRows()[0]).toContain("Docs")
  expect(installationRows()[0]).toContain("Docs search")
  expect(installationRows()[0]).toContain("plugin:kndl:docs")
  expect(installationRows()[1]).toContain("plugin:kndl:sentry")
})

test("a change to its Repo's Installations shows that a Restart applies it, and the Restart does", async () => {
  const { client, page, banner } = await openSession(releaseSessionId)
  await step(() => button("Wake now", page).click())
  await eventuallyAsync(async () => expect(await offers(page, "Sleep now")).toBe(true))
  await eventually(() =>
    expect(mcpServersButton(page)?.getAttribute("aria-label")).toBe("MCP servers: 2 Installations"),
  )
  const mcpServers = await client.getMcpServers()
  const linear = mcpServers.mcpServers.find((mcpServer) => mcpServer.name === "Linear")
  if (linear === undefined) throw new Error("No MCP server Linear")
  // With its API key: one without keeps the Session from starting (#216).
  const key = [{ key: "api_key", value: Redacted.make("made-up-linear-key") }]
  await step(() => client.createInstallation(linear.id, "Linear", ["kddige/kndl"], key))

  const changed = () =>
    [...page.querySelectorAll("[data-banner]")]
      .map((el) => el.textContent ?? "")
      .find((content) => content.startsWith("MCP servers changed")) ?? ""
  await eventually(() => expect(changed()).toContain("A Restart applies the change"))
  expect(banner()).toBe("")
  // It runs with what it started with until then.
  expect(mcpServersButton(page)?.getAttribute("aria-label")).toBe(
    "MCP servers: 2 Installations, changed",
  )

  await step(() => button("Restart", page).click())
  await eventually(() =>
    expect(mcpServersButton(page)?.getAttribute("aria-label")).toBe("MCP servers: 3 Installations"),
  )
  await eventually(() => expect(changed()).toBe(""))
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

test("a pasted image goes with the prompt, and shows in its Turn, opening full size (#276)", async () => {
  const { page } = await openSession("s-dotfiles")
  const prompt = page.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')
  if (!prompt) throw new Error("no prompt field")
  const clipboardData = new DataTransfer()
  clipboardData.items.add(new File([new Uint8Array(8)], "shot.png", { type: "image/png" }))
  await step(() => typeInto(prompt, "What broke?"))
  await step(() =>
    prompt.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
    ),
  )
  await eventually(() => expect(button("Send prompt", page).disabled).toBe(false))
  await step(() => button("Send prompt", page).click())

  await eventually(() =>
    expect(page.querySelector('[aria-label="Prompt queue"]')?.textContent ?? "").toContain(
      "What broke? · 1 image",
    ),
  )
  expect(page.querySelector('[aria-label="Attachments"]')).toBeNull()
})

test("a Turn shows the images its prompt carried, each opening full size (#276)", async () => {
  const { page, client } = await openSession("s-readme")
  const id = await client.uploadAttachment(
    "s-readme" as SessionId,
    new File([new Uint8Array(8)], "shot.png", { type: "image/png" }),
    { onProgress: () => {}, signal: new AbortController().signal },
  )
  client.sendPrompt("s-readme" as SessionId, "", [id])

  await eventually(() => {
    const thumbnail = page.querySelector<HTMLImageElement>(
      '[aria-label="Conversation"] img[alt="shot.png"]',
    )
    expect(thumbnail?.src).toBe(client.attachmentUrl("s-readme" as SessionId, id))
    expect(thumbnail?.closest("a")?.getAttribute("href")).toBe(thumbnail?.getAttribute("src"))
  })
})

test("a Turn shows a PDF its prompt carried as a chip, its name and size, that downloads (#277)", async () => {
  const { page, client } = await openSession("s-readme")
  const id = await client.uploadAttachment(
    "s-readme" as SessionId,
    new File([new Uint8Array(1_536)], "spec.pdf", { type: "application/pdf" }),
    { onProgress: () => {}, signal: new AbortController().signal },
  )
  client.sendPrompt("s-readme" as SessionId, "read it", [id])

  await eventually(() => {
    const chip = page.querySelector<HTMLAnchorElement>(
      '[aria-label="Conversation"] a[download="spec.pdf"]',
    )
    expect(chip?.getAttribute("href")).toBe(client.attachmentUrl("s-readme" as SessionId, id))
    expect(chip?.textContent).toContain("spec.pdf")
    expect(chip?.textContent).toContain("1.5 KB")
  })
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
  // The Composer's Terminal button opens it, as a sheet under the conversation.
  const terminalTab = () =>
    [...page.querySelectorAll("form button[aria-pressed]")].find(
      (toggle) => toggle.textContent === "Terminal",
    )

  // The terminal opens only once its sheet is shown, and the URL says so.
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

/** The open toast whose text includes `title`. */
function findToast(title: string): HTMLElement | undefined {
  const roots = document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')
  return [...roots].find(
    (el) => !el.hasAttribute("data-ending-style") && el.textContent?.includes(title),
  )
}

/** The whole app at `path`, against the fake Hub with its script not playing. */
async function openApp(path: string, stepMs = 2) {
  const { toast } = await import("../src/ui/index.ts")
  const hub = new FakeHub({ stepMs, autoplay: false })
  const client = new HubClient(hub, { retryDelay: () => 1 })
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }))
  const view = await render(
    <HubProvider client={client}>
      <RouterProvider router={router} />
    </HubProvider>,
  )
  cleanup = async () => {
    await step(() => toast.close())
    await view.unmount()
    client.stop()
    hub.dispose()
  }
  return {
    router,
    hub,
    client,
    page: view.container,
    sent: () => hub.received.map((message) => message._tag),
    find: (id: string) => client.getState().sessions?.find((session) => session.id === id),
  }
}

test("deleting a Session archives it, hides it from the sidebar, and Undo restores it", async () => {
  const { page, router, sent, find } = await openApp("/sessions/s-readme")
  await eventually(() => expect(page.querySelector("h1")?.textContent).toBe("claude/readme-run"))

  await choose(page, "Delete Session")
  expect(sent()).toContain("ArchiveSession")
  await eventually(() => expect(find("s-readme")?.state).toBe("Archived"))
  // Back on the start page; the sidebar no longer lists it.
  await eventually(() => expect(router.state.location.pathname).toBe("/"))
  const list = () =>
    [...page.querySelectorAll("ul[aria-labelledby]")].map((ul) => ul.textContent).join("\n")
  await eventually(() => expect(list()).toContain("claude/web-client"))
  expect(list()).not.toContain("claude/readme-run")

  const deleted = findToast("Session deleted")
  if (!deleted) throw new Error("no undo toast")
  await step(() => button("Undo", deleted).click())
  expect(sent()).toContain("RestoreSession")
  await eventually(() => expect(find("s-readme")?.state).toBe("Asleep"))
  await eventually(() => expect(list()).toContain("claude/readme-run"))
})

test("a Turn a finished agent started shows the agent it's from, not Claude Code's notification", async () => {
  const { page } = await openApp("/sessions/s-release")
  await eventually(() => expect(page.querySelector('[data-turn="t-release-2"]')).not.toBeNull())
  const turn = page.querySelector('[data-turn="t-release-2"]')
  const link = turn?.querySelector<HTMLAnchorElement>(
    'a[href="/sessions/s-release?agent=a-changelog"]',
  )
  expect(link?.textContent).toBe("Write the 0.4 changelog")
  expect(turn?.textContent).toContain("Agent")
  expect(turn?.textContent).toContain('Agent "Write the 0.4 changelog" finished')
  expect(page.textContent).not.toContain("<task-notification>")
})

test("an agent's view resumes it, messages it while it runs, and stops it", async () => {
  // Slow enough steps that the resumed agent, one short text, still runs when the test messages it.
  const { page, sent } = await openApp("/sessions/s-release?agent=a-bump", 100)
  const heading = () => page.querySelector('section[aria-label="Agent"] h2')?.textContent ?? ""
  const agentText = () => page.querySelector('section[aria-label="Agent"]')?.textContent ?? ""
  await eventually(() => expect(heading()).toContain("Bump the package versions"))
  expect(heading()).toContain("Stopped")
  // The message it was sent before it stopped shows in its run.
  expect(agentText()).toContain("Hold off: we bump once the docs land.")
  const field = () => page.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')

  // A message to a stopped agent of an Asleep Session wakes the Session and resumes the agent.
  await step(() => typeInto(field() as HTMLTextAreaElement, "The docs landed: go ahead"))
  await step(() => button("Resume", page).click())
  expect(sent()).toContain("MessageAgent")
  await eventually(() => expect(heading()).toContain("Running"), 10_000)

  // While it runs, a message reaches it, and Stop stops it.
  await step(() => typeInto(field() as HTMLTextAreaElement, "Bump the docs too"))
  await step(() => button("Send message", page).click())
  await eventually(() => expect(agentText()).toContain("Got your message"))
  await step(() => button("Stop agent", page).click())
  expect(sent()).toContain("StopAgent")
  await eventually(() => expect(heading()).toContain("Stopped"))
})

test("a Turn from another Session, from before subagents, shows that Session", async () => {
  const { page } = await openApp("/sessions/s-readme")
  const conversation = () => page.querySelector('[aria-label="Conversation"]')
  await eventually(() => expect(conversation()?.textContent).toContain("VITE_FAKE_HUB=1"))
  const from = [...(conversation()?.querySelectorAll("a") ?? [])].find(
    (link) => link.textContent === "claude/web-client",
  )
  expect(from?.getAttribute("href")).toBe(`/sessions/${demoSessionId}`)
})

test("an Interrupted agent's tool call that never ended was cut short, not running", async () => {
  const { page } = await openApp("/sessions/s-release?agent=a-docs")
  const agent = () => page.querySelector('section[aria-label="Agent"]')
  await eventually(() => expect(agent()?.textContent).toContain("Interrupted"))
  expect(agent()?.querySelector('[aria-label="Cut short"]')).not.toBeNull()
  expect(agent()?.querySelector('[aria-label="Running"]')).toBeNull()
})

test("a Repo's Archived screen lists who deleted each Session, and restores it", async () => {
  const { page, sent, find } = await openApp("/repos/kddige/kndl/archived")
  const archived = () => page.querySelector('ul[aria-label="Archived Sessions"]')?.textContent ?? ""
  await eventually(() => expect(archived()).toContain("claude/flaky-login"))
  expect(archived()).toContain("Deleted by Alice Kim 3d ago")
  expect(archived()).toContain("Purged in 27 days")

  await step(() => button("Restore claude/flaky-login", page).click())
  expect(sent()).toContain("RestoreSession")
  await eventually(() => expect(find("s-flaky")?.state).toBe("Asleep"))
  await eventually(() => expect(page.textContent).toContain("Nothing archived"))
})

/** The open dialog that asks to purge Sessions; another test's may linger in the document. */
function purgeDialog(): HTMLElement | undefined {
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]:not([data-type])')
  return [...dialogs].find((el) => el.textContent?.includes("This can't be undone."))
}

test("an Archived Session is purged now once it's confirmed, warning that it can't be undone (#351)", async () => {
  const { page, sent, find } = await openApp("/repos/kddige/kndl/archived")
  const archived = () => page.querySelector('ul[aria-label="Archived Sessions"]')?.textContent ?? ""
  await eventually(() => expect(archived()).toContain("claude/flaky-login"))

  await menuItem("Actions for claude/flaky-login", "Purge claude/flaky-login", page)
  await eventually(() => expect(purgeDialog()?.textContent).toContain("Purge claude/flaky-login?"))
  const asked = purgeDialog()?.textContent ?? ""
  expect(asked).toContain("1 Session")
  expect(asked).toContain("work not pushed")
  expect(asked).toContain("can't be undone")
  // Nothing is sent until it's confirmed.
  expect(sent()).not.toContain("PurgeArchivedSession")

  await step(() => button("Purge", purgeDialog() as HTMLElement).click())
  expect(sent()).toContain("PurgeArchivedSession")
  await eventually(() => expect(find("s-flaky")).toBeUndefined())
  await eventually(() => expect(page.textContent).toContain("Nothing archived"))
  await eventually(() => expect(findToast("Purged claude/flaky-login")).toBeDefined())
})

test("several Archived Sessions are purged at once, and an offline Runner frees its disk when back", async () => {
  const { page, hub, client, sent, find } = await openApp("/archive")
  const archived = () =>
    page.querySelector('ul[aria-label="Archived Sessions of kddige/kndl"]')?.textContent ?? ""
  await eventually(() => expect(archived()).toContain("claude/flaky-login"))
  await step(() => client.archiveSession("s-readme" as SessionId))
  await eventually(() => expect(archived()).toContain("claude/readme-run"))
  await step(() => hub.patchRunner("r-studio", { isOnline: false }))

  const purgeSelected = () =>
    [...page.querySelectorAll("button")].find((el) => el.textContent?.startsWith("Purge selected"))
  expect(purgeSelected()?.disabled).toBe(true)
  await step(() => select("claude/flaky-login"))
  await step(() => select("claude/readme-run"))
  await eventually(() => expect(purgeSelected()?.textContent).toBe("Purge selected (2)"))
  await step(() => purgeSelected()?.click())
  await eventually(() => expect(purgeDialog()?.textContent).toContain("Purge 2 Sessions?"))
  const asked = purgeDialog()?.textContent ?? ""
  expect(asked).toContain("claude/flaky-login")
  expect(asked).toContain("claude/readme-run")
  expect(asked).toContain("can't be undone")

  await step(() => button("Purge 2 Sessions", purgeDialog() as HTMLElement).click())
  expect(sent().filter((tag) => tag === "PurgeArchivedSession")).toHaveLength(2)
  await eventually(() => expect(find("s-flaky")).toBeUndefined())
  expect(find("s-readme")).toBeUndefined()
  await eventually(() => expect(page.textContent).toContain("Nothing archived"))
  await eventually(() =>
    expect(findToast("Purged 2 Sessions")?.textContent).toContain(
      "studio is offline: its disk frees when it reconnects.",
    ),
  )

  /** Ticks the Archived Session's checkbox. */
  function select(title: string): void {
    const row = [...page.querySelectorAll("li")].find((li) => li.textContent?.includes(title))
    const box = row?.querySelector('input[type="checkbox"]') as HTMLElement | null
    if (!box) throw new Error(`no checkbox for ${title}`)
    box.click()
  }
})

test("the Archived screen shows the disk each Session takes, and what purging the ticked ones frees (#352)", async () => {
  const { page, hub, client } = await openApp("/archive")
  const row = (title: string) =>
    [...page.querySelectorAll("li")].find((li) => li.textContent?.includes(title))
  const toolbar = () => page.textContent ?? ""
  await eventually(() => expect(row("claude/flaky-login")?.textContent).toContain("1.8 GiB"))
  // A screen reader hears whose size it is, in text: a label on a plain span isn't read out.
  expect(row("claude/flaky-login")?.textContent).toContain(
    "Disk used by claude/flaky-login: 1.8 GiB",
  )
  expect(row("claude/flaky-login")?.querySelector('[aria-label^="Disk used"]')).toBeNull()
  hub.diskBytes.set("s-readme", 512 * 1024 ** 2)
  await step(() => client.archiveSession("s-readme" as SessionId))
  await eventually(() => expect(row("claude/readme-run")?.textContent).toContain("512 MiB"))
  // Nothing ticked, nothing to free.
  expect(toolbar()).not.toContain("Frees")

  await step(() => tick("claude/flaky-login"))
  await eventually(() => expect(toolbar()).toContain("Frees 1.8 GiB"))
  await step(() => tick("claude/readme-run"))
  await eventually(() => expect(toolbar()).toContain("Frees 2.3 GiB"))

  const purgeSelected = [...page.querySelectorAll("button")].find((el) =>
    el.textContent?.startsWith("Purge selected"),
  )
  await step(() => purgeSelected?.click())
  await eventually(() => expect(purgeDialog()?.textContent).toContain("Purge 2 Sessions?"))
  const asked = purgeDialog()?.textContent ?? ""
  expect(asked).toContain("Frees 2.3 GiB")
  expect(asked).toContain("1.8 GiB")
  expect(asked).toContain("512 MiB")

  function tick(title: string): void {
    const box = row(title)?.querySelector('input[type="checkbox"]') as HTMLElement | null
    if (!box) throw new Error(`no checkbox for ${title}`)
    box.click()
  }
})

test("a Session whose Runner is offline has an unknown size, which the total says (#352)", async () => {
  const { page, hub } = await openApp("/repos/kddige/kndl/archived")
  const row = () =>
    [...page.querySelectorAll("li")].find((li) => li.textContent?.includes("claude/flaky-login"))
  await eventually(() => expect(row()?.textContent).toContain("1.8 GiB"))

  await step(() => hub.patchRunner("r-studio", { isOnline: false }))
  await eventually(() => expect(row()?.textContent).toContain("Size unknown"))
  expect(row()?.textContent).not.toContain("1.8 GiB")

  await step(() => {
    const box = row()?.querySelector('input[type="checkbox"]') as HTMLElement | null
    box?.click()
  })
  await eventually(() => expect(page.textContent).toContain("Disk use unknown"))
  const purge = [...page.querySelectorAll("button")].find((el) =>
    el.textContent?.startsWith("Purge selected"),
  )
  await step(() => purge?.click())
  await eventually(() => {
    const asked = [...document.querySelectorAll<HTMLElement>('[role="dialog"]:not([data-type])')]
    expect(
      asked.find((el) => el.textContent?.includes("Purge claude/flaky-login?"))?.textContent,
    ).toContain("Disk use unknown")
  })

  // Back online, the next ask finds it.
  await step(() => hub.patchRunner("r-studio", { isOnline: true }))
  await eventually(() => expect(row()?.textContent).toContain("1.8 GiB"))
})

test("an Archived Session can't take prompts or open its terminal, and offers a restore", async () => {
  const { page, sent, find } = await openApp("/sessions/s-flaky?tab=terminal")
  const banner = () =>
    [...page.querySelectorAll("[data-banner]")]
      .map((el) => el.textContent ?? "")
      .find((content) => content.startsWith("This Session is")) ?? ""
  await eventually(() => expect(banner()).toContain("This Session is Archived"))
  expect(banner()).toContain("Alice Kim deleted it.")
  const prompt = page.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')
  expect(prompt?.disabled).toBe(true)
  // No menu to delete it from, and no Keep awake (ADR 0016).
  const labels = [...page.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))
  expect(labels).not.toContain("Session actions")
  expect(page.querySelector("form button[aria-pressed]")).toBeNull()
  // Even asked for in the URL, the terminal stays shut: there's no sheet and no button for it.
  expect(page.querySelector('section[aria-label="Terminal"]')).toBeNull()
  expect(sent()).not.toContain("OpenTerminal")

  await step(() => button("Restore", page).click())
  expect(sent()).toContain("RestoreSession")
  await eventually(() => expect(find("s-flaky")?.state).toBe("Asleep"))
  await eventually(() => expect(banner()).toContain("This Session is Asleep"))
})

test("an image pasted into a message to an agent goes with it, and shows in its card (#278)", async () => {
  const { page, sent } = await openApp("/sessions/s-release?agent=a-bump", 100)
  const heading = () => page.querySelector('section[aria-label="Agent"] h2')?.textContent ?? ""
  await eventually(() => expect(heading()).toContain("Bump the package versions"))
  const field = page.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')
  if (!field) throw new Error("no message field")
  const clipboardData = new DataTransfer()
  clipboardData.items.add(new File([new Uint8Array(8)], "shot.png", { type: "image/png" }))
  await step(() =>
    field.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
    ),
  )
  // An image alone is a message.
  await eventually(() => expect(button("Resume", page).disabled).toBe(false))
  await step(() => button("Resume", page).click())
  expect(sent()).toContain("MessageAgent")
  await eventually(() =>
    expect(
      page.querySelector(
        'section[aria-label="Agent"] [aria-label="The message\'s attachments"] img[alt="shot.png"]',
      ),
    ).not.toBeNull(),
  )
})

test("someone watching a Session reads it, but can't drive it or see its terminal (ADR 0026)", async () => {
  const { router, page, sent } = await openApp(`/sessions/${bobsSessionId}?tab=terminal`)
  const header = () => page.querySelector("h1")?.closest("header")?.textContent ?? ""
  const banner = () =>
    [...page.querySelectorAll("[data-banner]")]
      .map((el) => el.textContent ?? "")
      .find((content) => content.startsWith("This Session is")) ?? ""
  await eventually(() => expect(banner()).toContain("This Session is Asleep"))
  expect(header()).toContain("Bob Lee drives it")
  // It waits on Bob to wake it: nothing here wakes it.
  expect(banner()).toContain("Its Sandbox is stopped until Bob Lee wakes it.")
  const labels = () =>
    [...page.querySelectorAll("button")].map(
      (each) => each.getAttribute("aria-label") ?? each.textContent?.trim(),
    )
  for (const control of ["Wake now", "Rename Session", "Delete Session", "Sleep now", "Attach"])
    expect(labels()).not.toContain(control)
  // Its model shows as the picker names it, but doesn't open: Claude Code's default here.
  expect(labels().some((label) => label?.startsWith("Model:"))).toBe(false)
  const model = page.querySelector('[title="The model and thinking level this Session runs on"]')
  expect(model?.textContent).toBe("Opus 5.5")
  expect(model?.closest("button")).toBeNull()
  expect(page.querySelector("header [role=switch]")).toBeNull()
  // Nor rename it from the sidebar.
  expect(labels()).not.toContain("Rename claude/landing-copy")

  // The composer is disabled, saying who drives it and why.
  const prompt = page.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')
  expect(prompt?.disabled).toBe(true)
  expect(prompt?.placeholder).toBe(
    "Only Bob Lee, who started this Session, can drive it: it runs on their Claude credential.",
  )

  // There's no terminal, even asked for in the URL: no tab, and it's never opened.
  expect(page.querySelector('[role="tab"]')).toBeNull()
  expect(page.querySelector(".xterm")).toBeNull()
  expect(router.state.location.search).toEqual({ tab: "terminal" })
  expect(sent()).not.toContain("OpenTerminal")

  // The prompt the Hub cancelled shows, as cancelled, with why.
  const cancelled = page.querySelector('[data-cancelled="p-seed-alice"]')?.textContent ?? ""
  expect(cancelled).toContain("Alice Kim")
  expect(cancelled).toContain("And make the install command copyable")
  expect(cancelled).toContain("Cancelled · Only the Session's Creator prompts it now")
})

test("someone watching a live Session sees its Turn and queue, with nothing to stop, steer or cancel", async () => {
  const hub = new FakeHub({ stepMs: 20, you: bob })
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
  const queue = () => page.querySelector('[aria-label="Prompt queue"]')
  const conversation = () => page.querySelector('[aria-label="Conversation"]')?.textContent ?? ""
  // Alice's prompt runs, and her follow-up waits in the queue.
  await eventually(() => expect(conversation()).toContain("Can you make tool calls collapse"))
  await eventually(() =>
    expect(queue()?.textContent).toContain("Then add a line about it to the README"),
  )
  expect(queue()?.querySelector("button")).toBeNull()
  const labels = [...page.querySelectorAll("button")].map((each) => each.textContent?.trim())
  expect(labels).not.toContain("Stop")
  expect(page.querySelector('[role="tab"]')).toBeNull()
  // Its model and thinking level show, as the picker names them, with nothing to pick.
  expect(
    page.querySelector('[title="The model and thinking level this Session runs on"]')?.textContent,
  ).toBe("Sonnet 5.5·High")
  expect(page.querySelector('button[aria-label^="Model:"]')).toBeNull()
  expect(page.querySelector('button[aria-label^="Thinking:"]')).toBeNull()
  expect(page.querySelector("h1")?.closest("header")?.textContent).toContain("Alice Kim drives it")
})

test("the Creator's Session can't wake without their setup token, and leads to the Account page", async () => {
  const hub = new FakeHub({ stepMs: 2, autoplay: false, claudeCredential: null })
  const client = new HubClient(hub, { retryDelay: () => 1 })
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/sessions/s-readme"] }))
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
  const banner = () =>
    [...page.querySelectorAll("[data-banner]")]
      .map((el) => el.textContent ?? "")
      .find((content) => content.startsWith("This Session can't wake")) ?? ""
  await eventually(() => expect(banner()).toContain("you have none on this Hub"))
  await step(() => button("Add a setup token", page).click())
  await eventually(() => expect(router.state.location.pathname).toBe("/account"))
})
