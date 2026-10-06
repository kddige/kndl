// A Session's Open ports in the Session view (#175), against the fake Hub with its script not
// playing: the demo Session has a dev server, one on `::1` only, and a Docker port.

import { afterEach, expect, test } from "bun:test"
import { installDom } from "./dom.ts"
import { button, render, settle, step } from "./render.ts"

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
const { forwardCommand, shortSessionId } = await import("../src/session/OpenPorts.tsx")

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

async function open(sessionId: string) {
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
  return {
    page,
    header: () => page.querySelector("header")?.textContent ?? "",
    /** The header's Open ports button, if it shows. */
    portsButton: () =>
      [...page.querySelectorAll("button")].find((el) =>
        el.getAttribute("aria-label")?.startsWith("Open ports: "),
      ) ?? null,
  }
}

/** The rows of the open list, as their text. */
const rows = () =>
  [...document.querySelectorAll('[aria-label="Open ports"] li')].map((li) => li.textContent)

test("the short id is a Session id's first 6 characters", () => {
  const summary = { id: "0b9256b9c0609f5a73defb11" } as Parameters<typeof shortSessionId>[0]
  expect(shortSessionId(summary)).toBe("0b9256")
  expect(forwardCommand(summary)).toBe("claude-hub forward 0b9256")
})

test("lists an Active Session's Open ports, a Docker one labelled, with the command to forward them", async () => {
  const { portsButton } = await open(demoSessionId)
  await eventually(() =>
    expect(portsButton()?.getAttribute("aria-label")).toBe("Open ports: 3 ports"),
  )
  await step(() => portsButton()?.click())
  await eventually(() => expect(rows()).toHaveLength(3))

  expect(rows()).toEqual([
    "3000bun server0.0.0.0, ::",
    // Only on `::1`, as `localhost` binds under Node 22: that's the address it shows.
    "5173node vite::1",
    "5432docker-proxyDocker0.0.0.0, ::",
  ])
  const command = document.querySelector('[aria-label="Forward command"]')?.textContent
  expect(command).toBe(`claude-hub forward ${demoSessionId.slice(0, 6)}`)

  const copied: Array<string> = []
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void copied.push(text) },
  })
  await step(() => button("Copy command").click())
  expect(copied).toEqual([command ?? ""])
})

test("a Session that isn't Active shows no Open ports, and none once it sleeps", async () => {
  const asleep = await open("s-readme")
  await eventually(() => expect(asleep.header()).toContain("Asleep"))
  expect(asleep.portsButton()).toBeNull()
  await cleanup?.()
  cleanup = undefined

  const { page, portsButton } = await open(demoSessionId)
  await eventually(() => expect(portsButton()).not.toBeNull())
  await eventually(() => expect(button("Sleep now", page).disabled).toBe(false))
  await step(() => button("Sleep now", page).click())
  await eventually(() => expect(portsButton()).toBeNull())
})
