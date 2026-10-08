// A smoke test of the Session view: the whole app, routed to the demo Session, against the fake
// Hub playing its script fast.

import { expect, test } from "bun:test"
import { hubPluginId, RequestId } from "@kndl/protocol"
import { Redacted } from "effect"
import { installDom } from "./dom.ts"
import { button, render, settle, step } from "./render.ts"

let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())

// Loaded after installDom() and the StyleX compiler, so components see the DOM and compile.
const { createMemoryHistory, RouterProvider } = await import("@tanstack/react-router")
const { HubProvider } = await import("../src/app/hub.tsx")
const { HubClient } = await import("../src/hub/client.ts")
const { FakeHub } = await import("../src/hub/fake/FakeHub.ts")
const { demoSessionId, releaseSessionId, you } = await import("../src/hub/fake/script.ts")
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

  // Connected and joined: the Session's header, named by its work branch, with its Repo.
  await eventually(() => expect(page.querySelector("h1")?.textContent).toBe("claude/web-client"))
  expect(page.querySelector("h1")?.closest("header")?.textContent).toContain("kddige/kndl")
  // Its Creator has stored no Claude credential, so it runs on the Runner's (ADR 0015).
  expect(page.querySelector("h1")?.closest("header")?.textContent).toContain(
    "on the Runner's Claude account",
  )
  expect(hub.received.map((message) => message._tag)).toContain("JoinSession")
  // Bob keeps it awake (ADR 0016).
  expect(page.querySelector("h1")?.closest("header")?.textContent).toContain(
    "Kept awake by Bob Lee",
  )

  // A second Participant joins, and their prompt starts a Turn under their name.
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
  await eventually(() => expect(button("Queue prompt", page)).toBeDefined())
  await step(() => typeInto(prompt, "And a line in the changelog"))
  await step(() => button("Queue prompt", page).click())
  await eventually(() => expect(queue()).toContain("And a line in the changelog"))
  expect(steerButtons()).toHaveLength(1)

  await step(() => button("Steer Alice Kim's prompt into the running Turn", page).click())
  expect(hub.received.map((message) => message._tag)).toContain("SteerPrompt")
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
    [...page.querySelectorAll('[role="status"]')]
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
  expect(button("Sleep now", page).disabled).toBe(true)
  await eventually(() => expect(button("Sleep now", page).disabled).toBe(false))
  expect(page.textContent).not.toContain("Starting…")

  await step(() => button("Sleep now", page).click())
  expect(sent()).toContain("SleepSession")
  await eventually(() => expect(banner()).toContain("Put to sleep."))
  expect([...page.querySelectorAll("button")].some((b) => b.textContent === "Sleep now")).toBe(
    false,
  )
})

test("Keep awake wakes an Asleep Session, says who keeps it awake, and Sleep now turns it off", async () => {
  const { hub, page, banner, header, sent } = await openSession("s-readme")
  const keepAwake = () => {
    const toggle = page.querySelector<HTMLElement>("header [role=switch]")
    if (!toggle) throw new Error("no Keep awake switch")
    return toggle
  }
  expect(header()).toContain("Keep awake")
  expect(header()).not.toContain("Kept awake by")
  expect(keepAwake().getAttribute("aria-checked")).toBe("false")

  // On, it says who, and the Asleep Session wakes.
  await step(() => keepAwake().click())
  expect(sent()).toContain("SetKeepAwake")
  await eventually(() => expect(header()).toContain("Kept awake by you"))
  expect(keepAwake().getAttribute("aria-checked")).toBe("true")
  await eventually(() => expect(banner()).toBe(""))

  // Sleep now turns it off.
  await eventually(() => expect(button("Sleep now", page).disabled).toBe(false))
  await step(() => button("Sleep now", page).click())
  await eventually(() => expect(banner()).toContain("Put to sleep."))
  expect(header()).not.toContain("Kept awake by")
  expect(keepAwake().getAttribute("aria-checked")).toBe("false")

  // And off by the switch, it stays Asleep.
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
  await eventually(() => expect(button("Sleep now", page).disabled).toBe(false))

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
  await eventually(() => expect(button("Sleep now", page).disabled).toBe(false))
  await step(() => button("Sleep now", page).click())
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
  step(() => client.createInstallation(hubPluginId("linear"), "Linear", repos))

const linearOf = (hub: InstanceType<typeof FakeHub>) =>
  hub.plugins.state(() => true).installations.find((one) => one.name === "Linear")

test("a Session an Installation keeps from starting takes its Repo off it, and starts (#216)", async () => {
  const { hub, client, page, banner, header, sent } = await openSession("s-readme", "This Session")
  await installLinear(client, ["kddige/kndl", "kddige/website"])

  await step(() => button("Wake now", page).click())
  await eventually(() => expect(banner()).toContain("This Session can't start"))
  expect(banner()).toContain("Linear needs a value for API key.")
  expect(banner()).toContain("Prompts sent now wait in the queue until it starts.")
  expect(header()).toContain("Asleep")
  // Fix opens that Installation on the Plugins page.
  expect(page.querySelector('a[aria-label="Fix Linear"]')?.getAttribute("href")).toBe(
    `/plugins?installation=${linearOf(hub)?.id}`,
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
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "kddige/kndl is the only Repo it is on in",
    ),
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
  await step(() => client.createInstallation(hubPluginId("linear"), "Linear", [], [], true))
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
  hub.plugins.change(
    {
      _tag: "CreateInstallation",
      requestId: RequestId.make("seed"),
      pluginId: hubPluginId("linear"),
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
  await eventually(() => expect(page.querySelector("h1")?.textContent).toBe("Plugins"))
  await eventually(() =>
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Edit Linear"),
  )
})

test("an Installation that fails mid-Session shows as an error in it, which runs on (#216)", async () => {
  const { hub, page, header } = await openSession(releaseSessionId)
  await step(() => button("Wake now", page).click())
  await eventually(() => expect(button("Sleep now", page).disabled).toBe(false))

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
  expect(fix?.getAttribute("href")).toStartWith("/plugins?installation=")
  expect(header()).toContain("Active")
})

test("a restart for a changed Environment shows its progress until the Session is back", async () => {
  // Slow enough to see each step of the restart.
  const { page, banner, sent } = await openSession(demoSessionId, "Environment changed", 15)
  expect(banner()).toContain("version 2 is the latest")
  const statuses = () =>
    [...page.querySelectorAll('[role="status"]')].map((el) => el.textContent ?? "").join("\n")

  await step(() => button("Restart", page).click())
  expect(sent()).toContain("RestartSession")
  // Stopping it first, then starting it on the latest version, with its log.
  await eventually(() => expect(statuses()).toContain("Restarting…"))
  expect(statuses()).toContain("You asked for a restart.")
  expect(banner()).toBe("")
  expect(button("Sleep now", page).disabled).toBe(true)
  await eventually(() => expect(statuses()).toContain("Starting the Sandbox on version 2"))
  expect(statuses()).toContain("Restarting…")
  await step(() => button("Show log", page).click())
  await eventually(() =>
    expect(page.querySelector('[aria-label="Start log"]')?.textContent).toContain(
      "Building version 2 of kddige/kndl's Environment",
    ),
  )

  // Back, on the latest version: no banner.
  await eventually(() => expect(statuses()).not.toContain("Restarting…"))
  expect(banner()).toBe("")
  expect(button("Sleep now", page).disabled).toBe(false)
})

/** The Plugins button in `page`'s header, if it shows. */
const pluginsButton = (page: HTMLElement) =>
  [...page.querySelectorAll("header button")].find((el) =>
    el.getAttribute("aria-label")?.startsWith("Plugins: "),
  ) as HTMLButtonElement | undefined

/** The open list of the Session's Installations, as their rows' text. */
const installationRows = () =>
  [...document.querySelectorAll('[aria-label="Installations this Session runs with"] li')].map(
    (li) => li.textContent ?? "",
  )

test("a Session shows the Installations it runs with, as Claude Code names their servers (ADR 0020)", async () => {
  const { page } = await openSession(demoSessionId, "Environment changed")
  await eventually(() =>
    expect(pluginsButton(page)?.getAttribute("aria-label")).toBe("Plugins: 2 Installations"),
  )
  await step(() => pluginsButton(page)?.click())
  await eventually(() => expect(installationRows()).toHaveLength(2))
  expect(installationRows()[0]).toContain("Docs")
  expect(installationRows()[0]).toContain("Docs search")
  expect(installationRows()[0]).toContain("plugin:kndl:docs")
  expect(installationRows()[1]).toContain("plugin:kndl:sentry")
})

test("a change to its Repo's Installations shows that a Restart applies it, and the Restart does", async () => {
  const { client, page, banner } = await openSession(releaseSessionId)
  await step(() => button("Wake now", page).click())
  await eventually(() => expect(button("Sleep now", page).disabled).toBe(false))
  await eventually(() =>
    expect(pluginsButton(page)?.getAttribute("aria-label")).toBe("Plugins: 2 Installations"),
  )
  const plugins = await client.getPlugins()
  const linear = plugins.plugins.find((plugin) => plugin.name === "Linear")
  if (linear === undefined) throw new Error("No Plugin Linear")
  // With its API key: one without keeps the Session from starting (#216).
  const key = [{ key: "api_key", value: Redacted.make("made-up-linear-key") }]
  await step(() => client.createInstallation(linear.id, "Linear", ["kddige/kndl"], key))

  const changed = () =>
    [...page.querySelectorAll('[role="status"]')]
      .map((el) => el.textContent ?? "")
      .find((content) => content.startsWith("Plugins changed")) ?? ""
  await eventually(() => expect(changed()).toContain("A Restart applies the change"))
  expect(banner()).toBe("")
  // It runs with what it started with until then.
  expect(pluginsButton(page)?.getAttribute("aria-label")).toBe("Plugins: 2 Installations, changed")

  await step(() => button("Restart", page).click())
  await eventually(() =>
    expect(pluginsButton(page)?.getAttribute("aria-label")).toBe("Plugins: 3 Installations"),
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
    page: view.container,
    sent: () => hub.received.map((message) => message._tag),
    find: (id: string) => client.getState().sessions?.find((session) => session.id === id),
  }
}

test("deleting a Session archives it, hides it from the sidebar, and Undo restores it", async () => {
  const { page, router, sent, find } = await openApp("/sessions/s-readme")
  await eventually(() => expect(page.querySelector("h1")?.textContent).toBe("claude/readme-run"))

  await step(() => button("Delete Session", page).click())
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
  const { page, sent } = await openApp("/sessions/s-release?agent=a-bump", 40)
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
  expect(archived()).toContain("Deleted by Bob Lee 3d ago")
  expect(archived()).toContain("Purged in 27 days")

  await step(() => button("Restore claude/flaky-login", page).click())
  expect(sent()).toContain("RestoreSession")
  await eventually(() => expect(find("s-flaky")?.state).toBe("Asleep"))
  await eventually(() => expect(page.textContent).toContain("Nothing archived"))
})

test("an Archived Session can't take prompts or open its terminal, and offers a restore", async () => {
  const { page, sent, find } = await openApp("/sessions/s-flaky?tab=terminal")
  const banner = () =>
    [...page.querySelectorAll('[role="status"]')]
      .map((el) => el.textContent ?? "")
      .find((content) => content.startsWith("This Session is")) ?? ""
  await eventually(() => expect(banner()).toContain("This Session is Archived"))
  expect(banner()).toContain("Bob Lee deleted it.")
  const prompt = page.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')
  expect(prompt?.disabled).toBe(true)
  const labels = [...page.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))
  expect(labels).not.toContain("Delete Session")
  // Nor can it be kept awake (ADR 0016).
  expect(page.querySelector("header [role=switch]")).toBeNull()
  // Even asked for in the URL, the terminal stays shut: its tab is disabled.
  const terminalTab = [...page.querySelectorAll('[role="tab"]')].find(
    (tab) => tab.textContent === "Terminal",
  )
  expect(terminalTab?.hasAttribute("data-disabled")).toBe(true)
  expect(sent()).not.toContain("OpenTerminal")

  await step(() => button("Restore", page).click())
  expect(sent()).toContain("RestoreSession")
  await eventually(() => expect(find("s-flaky")?.state).toBe("Asleep"))
  await eventually(() => expect(banner()).toContain("This Session is Asleep"))
})
