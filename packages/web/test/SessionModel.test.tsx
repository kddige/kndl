// A Session's model and effort in the whole app (#128), against the fake Hub with its script not
// playing: the picker in the composer, the transcript's notice and Turn footer, and New Session.

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

async function open(path: string) {
  const hub = new FakeHub({ stepMs: 2, autoplay: false })
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

const radio = (start: string) => {
  const found = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((row) =>
    row.textContent?.startsWith(start),
  )
  if (!found) throw new Error(`no "${start}" row`)
  return found
}

function typeInto(field: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value)
  field.dispatchEvent(new Event("input", { bubbles: true }))
}

test("a switch shows in the transcript, and a Turn run before it names its model", async () => {
  const { page, conversation, picker } = await open(`/sessions/${demoSessionId}`)
  await eventually(() => expect(conversation()).toContain("Bob Lee switched to Sonnet 5.5, High"))
  expect(picker()?.textContent).toBe("Sonnet 5.5")
  expect(button("Effort: High", page).textContent).toBe("High")
  // The first Turn ran on Claude Code's default, before Bob's switch.
  const turnModels = [...page.querySelectorAll('[title="The model this Turn ran on"]')]
  expect(turnModels.map((el) => el.textContent)).toEqual(["Opus 5.5"])
})

test("anyone switches the model from the composer; everyone sees who did", async () => {
  const { hub, page, conversation, picker } = await open("/sessions/s-readme")
  await eventually(() => expect(picker()?.textContent).toBe("Opus 5.5"))
  // Its Turn ran on the model it is set to: the footer doesn't say so.
  expect(page.querySelector('[title="The model this Turn ran on"]')).toBeNull()
  await step(() => picker()?.click())
  await settle()
  await step(() => radio("Haiku 4.5").click())

  await eventually(() => expect(conversation()).toContain("Alice Kim switched to Haiku 4.5"))
  expect(picker()?.textContent).toBe("Haiku 4.5")
  const sent = hub.received.flatMap((m) =>
    m._tag === "SetSessionModel" ? [{ model: m.model, effort: m.effort }] : [],
  )
  expect(sent).toEqual([{ model: "haiku", effort: undefined }])
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
  await step(() => radio("Sonnet 5.5").click())
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
