// The Runners page against the fake Hub: the paired Runners, adding one with a Pairing code the
// fake then redeems, Re-pairing after a confirmation, and removing, refused while a Runner has
// Sessions that aren't Archived.

import { afterEach, expect, test } from "bun:test"
import { installDom } from "./dom.ts"
import { button, render, settle, step } from "./render.ts"

let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())
// Each test renders the app afresh, so the one before is taken down first.
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

// Loaded after installDom() and the StyleX compiler, so components see the DOM and compile.
const { createMemoryHistory, RouterProvider } = await import("@tanstack/react-router")
const { HubProvider } = await import("../src/app/hub.tsx")
const { HubClient } = await import("../src/hub/client.ts")
const { FakeHub } = await import("../src/hub/fake/FakeHub.ts")
const { createAppRouter } = await import("../src/router.tsx")

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

const dialog = () => document.querySelector('[role="dialog"]')
const runners = () => document.querySelector('[aria-label="Runners"]')

async function openRunners() {
  const hub = new FakeHub({ stepMs: 2, autoplay: false })
  const client = new HubClient(hub, { retryDelay: () => 1 })
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/runners"] }))
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
  await eventually(() => expect(runners()?.querySelectorAll("li").length).toBe(2))
  return { hub, page: view.container }
}

test("lists each Runner with its login, version, last connection and Sessions", async () => {
  const { page } = await openRunners()
  expect(page.querySelector("h1")?.textContent).toBe("Runners")
  const [studio, ci] = [...(runners()?.querySelectorAll("li") ?? [])].map((li) => li.textContent)
  expect(studio).toContain("studio")
  expect(studio).toContain("online")
  expect(studio).toContain("alice@example.com")
  expect(studio).toContain("824de4a1f0c3 (main)")
  expect(studio).toContain("2 Sessions")
  expect(ci).toContain("offline")
  expect(ci).toContain("behind the Hub")
  expect(ci).toContain("Last seen 3h ago")
  expect(ci).toContain("1 Session")
  // The sidebar's general nav marks the page.
  expect(document.querySelector('a[aria-current="page"]')?.textContent).toContain("Runners")
})

test("adds a Runner: shows the join command, then the Runner once the code is used", async () => {
  const { hub } = await openRunners()
  await step(() => button("Add a Runner").click())
  await eventually(() =>
    expect(document.querySelector('[aria-label="Pairing command"]')?.textContent).toMatch(
      /^claude-hub runner join 'http:\/\/[^#]+#[0-9A-Z]{5}(-[0-9A-Z]{5}){3}'$/,
    ),
  )
  expect(hub.received.filter((m) => m._tag === "CreatePairingCode")).toHaveLength(1)
  // The code waits on the page, without the code itself, so it can be revoked.
  await eventually(() =>
    expect(
      document.querySelector('[aria-label="Pairing codes not used yet"]')?.textContent,
    ).toContain("A new Runner"),
  )

  await step(() => hub.redeemPairingCode("mac-mini"))
  await eventually(() => expect(dialog()?.textContent).toContain("Paired mac-mini"))
  expect(dialog()?.textContent).toContain("mac-mini is online.")
  await step(() => button("Done").click())
  await eventually(() => expect(runners()?.textContent).toContain("mac-mini"))
  expect(document.querySelector('[aria-label="Pairing codes not used yet"]')).toBeNull()
})

test("Re-pairs a Runner only once that's confirmed", async () => {
  const { hub } = await openRunners()
  await step(() => button("Re-pair studio").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Re-pair studio"))
  expect(dialog()?.textContent).toContain("its current token stops working")
  expect(hub.received.some((m) => m._tag === "CreatePairingCode")).toBe(false)

  await step(() => button("Make a pairing code").click())
  await eventually(() =>
    expect(document.querySelector('[aria-label="Pairing command"]')).not.toBeNull(),
  )
  expect(hub.received.find((m) => m._tag === "CreatePairingCode")).toMatchObject({
    runnerId: "r-studio",
  })
  await eventually(() =>
    expect(
      document.querySelector('[aria-label="Pairing codes not used yet"]')?.textContent,
    ).toContain("Re-pair studio"),
  )
})

test("refuses to remove a Runner with open Sessions, and removes one without", async () => {
  const { hub } = await openRunners()
  await step(() => button("Remove studio").click())
  await eventually(() => expect(dialog()?.textContent).toContain("studio can't be removed yet"))
  expect(dialog()?.textContent).toContain("Archive them first")
  expect(hub.received.some((m) => m._tag === "RemoveRunner")).toBe(false)
  await step(() => button("OK").click())
  await settle()

  await step(() => button("Add a Runner").click())
  await eventually(() =>
    expect(document.querySelector('[aria-label="Pairing command"]')).not.toBeNull(),
  )
  await step(() => hub.redeemPairingCode("spare"))
  await step(() => button("Done").click())
  await eventually(() => expect(runners()?.querySelectorAll("li").length).toBe(3))
  await settle()

  await step(() => button("Remove spare").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Remove spare?"))
  await step(() => button("Remove").click())
  await eventually(() => expect(runners()?.textContent).not.toContain("spare"))
  expect(hub.received.find((m) => m._tag === "RemoveRunner")).toMatchObject({
    runnerId: expect.any(String),
  })
})
