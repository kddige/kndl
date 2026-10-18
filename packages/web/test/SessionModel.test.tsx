// A Session's model and thinking level in the whole app (#128), against the fake Hub with its
// script not playing unless a test asks: the picker in the composer, the transcript's notice and
// Turn footer, a switch asked about while an agent runs, and New Session; and a pi Session's,
// among its Creator's Models (ADR 0029); and a switch of Harness (ADR 0030).

import { afterEach, expect, test } from "bun:test"
import { installDom } from "./dom.ts"
import { button, dialog, render, settle, step } from "./render.ts"

let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

// Loaded after installDom() and the StyleX compiler, so components see the DOM and compile.
const { createMemoryHistory, RouterProvider } = await import("@tanstack/react-router")
const { HubProvider } = await import("../src/app/hub.tsx")
const { HubClient } = await import("../src/hub/client.ts")
const { FakeHub } = await import("../src/hub/fake/FakeHub.ts")
const { bob, demoSessionId, piSessionId } = await import("../src/hub/fake/script.ts")
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

async function open(
  path: string,
  autoplay = false,
  options: ConstructorParameters<typeof FakeHub>[0] = {},
) {
  const hub = new FakeHub({ stepMs: 2, autoplay, ...options })
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
    router,
    page,
    conversation: () => page.querySelector('[aria-label="Conversation"]')?.textContent ?? "",
    /** The composer's model picker, by its label. */
    picker: () =>
      [...page.querySelectorAll("button")].find((el) =>
        el.getAttribute("aria-label")?.startsWith("Model: "),
      ) ?? null,
  }
}

/** A row of the picker, which is a list to search (ADR 0030). */
const option = (label: string) => {
  const found = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (row) => row.textContent === label,
  )
  if (!found) throw new Error(`no "${label}" option`)
  return found
}

function typeInto(field: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value)
  field.dispatchEvent(new Event("input", { bubbles: true }))
}

test("a switch shows in the transcript, and a Turn run before it names its model", async () => {
  const { page, conversation, picker } = await open(`/sessions/${demoSessionId}`)
  await eventually(() => expect(conversation()).toContain("Alice Kim switched to Sonnet 5.5, High"))
  expect(picker()?.textContent).toBe("Sonnet 5.5")
  expect(button("Thinking: High", page).textContent).toBe("High")
  // The first Turn ran on Claude Code's default, before Alice's switch.
  const turnModels = [...page.querySelectorAll('[title="The model this Turn ran on"]')]
  expect(turnModels.map((el) => el.textContent)).toEqual(["Opus 5.5"])
})

test("its Creator switches the model from the composer; everyone sees who did", async () => {
  const { hub, page, conversation, picker } = await open("/sessions/s-readme")
  await eventually(() => expect(picker()?.textContent).toBe("Opus 5.5"))
  // Its Turn ran on the model it is set to: the footer doesn't say so.
  expect(page.querySelector('[title="The model this Turn ran on"]')).toBeNull()
  await step(() => picker()?.click())
  await settle()
  await step(() => option("Haiku 4.5").click())

  await eventually(() => expect(conversation()).toContain("Alice Kim switched to Haiku 4.5"))
  expect(picker()?.textContent).toBe("Haiku 4.5")
  const sent = hub.received.flatMap((m) =>
    m._tag === "SetSessionModel" ? [{ model: m.model, thinkingLevel: m.thinkingLevel }] : [],
  )
  expect(sent).toEqual([{ model: "haiku", thinkingLevel: undefined }])
})

test("while a switch is asked about, the picker shows it; Cancel goes back, Switch sends it", async () => {
  // The demo's script starts a background agent, which a switch would interrupt.
  const { hub, page, conversation, picker } = await open(`/sessions/${demoSessionId}`, true)
  // Held, the script stops with the agent running, for as long as the test takes.
  hub.hold()
  const agentStatus = () =>
    page.querySelector('nav a[href$="?agent=agent-docs"] [role="img"]')?.getAttribute("aria-label")
  while (agentStatus() !== "Running") {
    await step(() => hub.step())
    await settle(5)
  }
  const before = picker()?.textContent
  const switches = () => hub.received.filter((m) => m._tag === "SetSessionModel").length
  const pickFable = async () => {
    await step(() => picker()?.click())
    await settle()
    await step(() => option("Fable 5.1").click())
    await eventually(() => expect(dialog()?.textContent).toContain("Switch the model?"))
  }

  await pickFable()
  expect(picker()?.textContent).toBe("Fable 5.1")
  await step(() => button("Cancel", dialog() ?? document).click())
  await eventually(() => expect(dialog()).toBeNull())
  expect(picker()?.textContent).toBe(before)
  expect(switches()).toBe(0)

  await pickFable()
  await step(() => button("Switch", dialog() ?? document).click())
  expect(switches()).toBe(1)
  expect(picker()?.textContent).toBe("Fable 5.1")
  await eventually(() => expect(conversation()).toContain("Alice Kim switched to Fable 5.1"))
  expect(picker()?.textContent).toBe("Fable 5.1")
})

test("New Session starts on the model picked in its dialog", async () => {
  const { hub, router, picker } = await open("/sessions/s-readme")
  await eventually(() => expect(picker()).not.toBeNull())
  await step(() => button("New Session", document).click())
  await eventually(() => expect(dialog()).not.toBeNull())
  const newSession = dialog() as HTMLElement

  // Claude Code's default until one is picked.
  const choose = button("Model: Opus 5.5", newSession)
  const repo = newSession.querySelector<HTMLInputElement>('input[placeholder="kddige/kndl"]')
  await step(() => repo && typeInto(repo, "kddige/kndl"))
  // The Repo's default branch is filled in once the Hub has listed its branches.
  await eventually(() => {
    const inputs = [...newSession.querySelectorAll<HTMLInputElement>('input[role="combobox"]')]
    expect(inputs[1]?.value).toBe("main")
  })
  await step(() => choose.click())
  await settle()
  await step(() => option("Sonnet 5.5").click())
  await settle()
  expect(button("Model: Sonnet 5.5", newSession)).toBeDefined()

  await step(() => button("Start Session", newSession).click())
  await eventually(() => expect(hub.received.some((m) => m._tag === "CreateSession")).toBe(true))
  const created = hub.received.find((m) => m._tag === "CreateSession")
  expect(created && "model" in created ? created.model : undefined).toBe("sonnet")
  await eventually(() => expect(router.state.location.pathname).not.toBe("/sessions/s-readme"))
  await eventually(() => expect(picker()?.textContent).toBe("Sonnet 5.5"))
  // Lets the new Session finish starting while React is watching.
  await settle(200)
})

test("a pi Session's Creator switches among their Models, by Provider; the switch names the Model", async () => {
  const { hub, conversation, picker } = await open(`/sessions/${piSessionId}`)
  await eventually(() => expect(picker()?.textContent).toBe("GPT-6-Sol"))
  await step(() => picker()?.click())
  await settle()
  const groups = [...document.querySelectorAll('[role="listbox"] [role="group"]')].map(
    (group) => document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent,
  )
  expect(groups).toEqual(["Anthropic · Claude Code", "Anthropic · pi", "OpenAI"])
  // Nothing restarts for a switch: it isn't asked about, even with agents running.
  await step(() => option("Claude Opus 5.5").click())
  expect(document.querySelector('[role="dialog"]:not([data-type])')).toBeNull()

  await eventually(() =>
    expect(conversation()).toContain("Alice Kim switched to Claude Opus 5.5, High"),
  )
  expect(picker()?.textContent).toBe("Claude Opus 5.5")
  const sent = hub.received.flatMap((m) =>
    m._tag === "SetSessionModel" ? [{ model: m.model, thinkingLevel: m.thinkingLevel }] : [],
  )
  expect(sent).toEqual([{ model: "anthropic/claude-opus-5-5", thinkingLevel: "high" }])
})

// A Session switches Harness (ADR 0030): its Creator picks any Model the Session's Runner can
// run, and a pick of the other Harness's is said once, plainly, before it is sent.

/** The open list's group names. */
const groupNames = () =>
  [...document.querySelectorAll('[role="listbox"] [role="group"]')].map(
    (group) => document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent,
  )

const switches = (hub: InstanceType<typeof FakeHub>) =>
  hub.received.flatMap((m) =>
    m._tag === "SetSessionModel" ? [{ model: m.model, thinkingLevel: m.thinkingLevel }] : [],
  )

test("a Claude Code Session on a Runner that runs pi switches to a pi Model, after saying what that does", async () => {
  const { hub, page, conversation, picker } = await open("/sessions/s-readme")
  hub.patchRunner("r-studio", { harnesses: ["ClaudeCode", "Pi"] })
  await eventually(() => expect(picker()?.textContent).toBe("Opus 5.5"))
  const pickGpt = async () => {
    await step(() => picker()?.click())
    await settle()
    expect(groupNames()).toEqual(["Anthropic · Claude Code", "Anthropic · pi", "OpenAI"])
    await step(() => option("GPT-6-Sol").click())
    await eventually(() => expect(dialog()?.textContent).toContain("Switch to pi?"))
  }

  await pickGpt()
  expect(dialog()?.textContent).toContain(
    "Switching to pi continues in its own conversation, with a handoff of this one. The next prompt waits until it's up.",
  )
  expect(picker()?.textContent).toBe("GPT-6-Sol")
  await step(() => button("Cancel", dialog() ?? document).click())
  await eventually(() => expect(dialog()).toBeNull())
  expect(picker()?.textContent).toBe("Opus 5.5")
  expect(switches(hub)).toEqual([])

  await pickGpt()
  await step(() => button("Switch", dialog() ?? document).click())
  expect(switches(hub)).toEqual([{ model: "openai/gpt-6-sol", thinkingLevel: undefined }])
  await eventually(() => expect(conversation()).toContain("Alice Kim switched to GPT-6-Sol on pi"))
  expect(picker()?.textContent).toBe("GPT-6-Sol")
  // It's a pi Session now: its prompt box asks for a prompt, not for Claude.
  expect(page.querySelector("textarea")?.getAttribute("placeholder")).toBe("Send a prompt")
})

/** A reply whose Turn runs until it is stopped. */
const working = () => [{ kind: "pause", steps: 1e6 }] as const

test("a switch of Harness waiting for the Turn to end names the model it switches to", async () => {
  const { hub, page, picker } = await open(`/sessions/${piSessionId}`, false, { reply: working })
  await eventually(() => expect(picker()?.textContent).toBe("GPT-6-Sol"))
  hub.creatorPrompts(piSessionId, "Keep going")
  await eventually(() => expect(hub.sessions.get(piSessionId)?.summary.currentTurn).not.toBeNull())

  await step(() => picker()?.click())
  await settle()
  await step(() => option("Default · Opus 5.5").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Switch to Claude Code?"))
  await step(() => button("Switch", dialog() ?? document).click())
  expect(switches(hub)).toEqual([{ model: undefined, thinkingLevel: "high" }])

  // pi runs the Turn on, but the Session is set to Claude Code's default, by its own name.
  await eventually(() => expect(hub.sessions.get(piSessionId)?.summary.modelPending).toBe(true))
  expect(hub.sessions.get(piSessionId)?.summary.harness).toBe("Pi")
  await settle(100)
  expect(picker()?.textContent).toBe("Opus 5.5")
  expect(page.textContent).toContain("Opus 5.5 takes over when this Turn ends.")
})

test("a switch to pi waiting for Claude Code's Turn to end names the Model it switches to", async () => {
  const { hub, page, picker } = await open("/sessions/s-readme", false, { reply: working })
  hub.patchRunner("r-studio", { harnesses: ["ClaudeCode", "Pi"] })
  await eventually(() => expect(picker()?.textContent).toBe("Opus 5.5"))
  hub.creatorPrompts("s-readme", "Keep going")
  await eventually(() => expect(hub.sessions.get("s-readme")?.summary.currentTurn).not.toBeNull())

  await step(() => picker()?.click())
  await settle()
  await step(() => option("GPT-6-Sol").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Switch to pi?"))
  await step(() => button("Switch", dialog() ?? document).click())

  await eventually(() => expect(hub.sessions.get("s-readme")?.summary.modelPending).toBe(true))
  expect(hub.sessions.get("s-readme")?.summary.harness).toBe("ClaudeCode")
  await settle(100)
  expect(picker()?.textContent).toBe("GPT-6-Sol")
  expect(page.textContent).toContain("GPT-6-Sol takes over when this Turn ends.")
})

test("a pi Session switches to Claude Code's model, keeping a level it takes, after saying so", async () => {
  const { hub, conversation, picker } = await open(`/sessions/${piSessionId}`)
  await eventually(() => expect(picker()?.textContent).toBe("GPT-6-Sol"))
  await step(() => picker()?.click())
  await settle()
  await step(() => option("Sonnet 5.5").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Switch to Claude Code?"))
  expect(dialog()?.textContent).toContain(
    "Switching to Claude Code continues in its own conversation, with a handoff of this one.",
  )
  await step(() => button("Switch", dialog() ?? document).click())
  expect(switches(hub)).toEqual([{ model: "sonnet", thinkingLevel: "high" }])
  await eventually(() =>
    expect(conversation()).toContain("Alice Kim switched to Sonnet 5.5 on Claude Code, High"),
  )
  expect(picker()?.textContent).toBe("Sonnet 5.5")
})

test("a Creator without a Claude credential isn't offered Claude Code's models in a pi Session", async () => {
  const { picker } = await open(`/sessions/${piSessionId}`, false, { claudeCredential: null })
  await eventually(() => expect(picker()?.textContent).toBe("GPT-6-Sol"))
  await step(() => picker()?.click())
  await settle()
  expect(groupNames()).toEqual(["OpenAI"])
})

test("someone watching a pi Session sees its Model as the transcript names it, not their own Models", async () => {
  const { page, picker } = await open(`/sessions/${piSessionId}`, false, { you: bob })
  const shown = () =>
    page.querySelector('[title="The model and thinking level this Session runs on"]')?.textContent
  await eventually(() => expect(shown()).toBe("GPT-6-Sol·High"))
  expect(picker()).toBeNull()
})

test("a pi Session names its Model, not Claude or Claude Code, and wakes without a setup token", async () => {
  const { page, conversation } = await open(`/sessions/${piSessionId}`, false, {
    claudeCredential: null,
  })
  await eventually(() => expect(conversation()).toContain("pi sends each model call"))
  // Its reply is the Model's, by the name its Creator's Models give it.
  const speakers = [...page.querySelectorAll("article span")].map((span) => span.textContent)
  expect(speakers).toContain("GPT-6-Sol")
  expect(speakers).not.toContain("Claude")
  expect(page.querySelector("textarea")?.getAttribute("placeholder")).toBe("Send a prompt")
  // It runs on the Creator's Connected providers, so it wakes as any Asleep Session does.
  expect(page.textContent).toContain("This Session is Asleep")
  expect(page.textContent).not.toContain("can't wake")
  expect(page.textContent).not.toContain("Claude Code")
})
