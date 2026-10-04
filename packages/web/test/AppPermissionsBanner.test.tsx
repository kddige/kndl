// The GitHub App permissions banner: the whole app against the fake Hub, which says what the
// Hub's last check of the App found.

import { afterEach, expect, test } from "bun:test"
import { installDom } from "./dom.ts"
import { button, render, settle, step } from "./render.ts"

let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())

// Loaded after installDom() and the StyleX compiler, so components see the DOM and compile.
const { createMemoryHistory, RouterProvider } = await import("@tanstack/react-router")
const { HubProvider } = await import("../src/app/hub.tsx")
const { HubClient } = await import("../src/hub/client.ts")
const { FakeHub } = await import("../src/hub/fake/FakeHub.ts")
const { driftedAppPermissions } = await import("../src/hub/fake/script.ts")
const { createAppRouter } = await import("../src/router.tsx")

type Check = ReturnType<typeof driftedAppPermissions>

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

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

async function open(appPermissions: Check | null) {
  const hub = new FakeHub({ stepMs: 2, autoplay: false, appPermissions })
  const client = new HubClient(hub, { retryDelay: () => 1 })
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/"] }))
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
  // Once the app is in, with its sidebar.
  await eventually(() => expect(page.textContent).toContain("New Session"))
  const banner = () =>
    [...page.querySelectorAll('[role="status"]')].find((el) =>
      el.textContent?.includes("missing permissions"),
    )
  return { hub, page, banner }
}

const fixed = (): Check => ({ ...driftedAppPermissions(), missing: [], installations: [] })

test("says what the App and each installation lack, linking to where to fix it", async () => {
  const { banner } = await open(driftedAppPermissions())
  await eventually(() => expect(banner()).toBeDefined())
  const text = banner()?.textContent ?? ""
  expect(text).toContain("The GitHub App is missing permissions")
  expect(text).toContain("The App claude-hub-alice lacks Issues: read and write.")
  expect(text).toContain(
    "Then, on acme, accept Pull requests: read and write, Issues: read and write.",
  )
  const links = [...(banner()?.querySelectorAll("a") ?? [])]
  expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
    ["Edit its permissions", "https://github.com/settings/apps/claude-hub-alice/permissions"],
    [
      "Review the request",
      "https://github.com/organizations/acme/settings/installations/42/permissions/update",
    ],
  ])
  for (const link of links) {
    expect(link.getAttribute("target")).toBe("_blank")
    expect(link.getAttribute("rel")).toContain("noopener")
  }
})

test("an installation behind an App that has it all is the only step", async () => {
  const { banner } = await open({ ...driftedAppPermissions(), missing: [] })
  await eventually(() => expect(banner()).toBeDefined())
  const text = banner()?.textContent ?? ""
  expect(text).not.toContain("The App claude-hub-alice lacks")
  expect(text).toContain("On acme, accept")
})

test("isn't shown when nothing is missing, or the Hub has no App", async () => {
  for (const check of [fixed(), null]) {
    const { banner, hub } = await open(check)
    await settle(20)
    expect(banner()).toBeUndefined()
    expect(hub.received.map((message) => message._tag)).not.toContain("CheckAppPermissions")
    await cleanup?.()
    cleanup = undefined
  }
})

test("Check again asks the Hub to check now, and shows what it found", async () => {
  const { hub, banner } = await open(driftedAppPermissions())
  await eventually(() => expect(banner()).toBeDefined())
  await step(() => button("Check again").click())
  await eventually(() =>
    expect(hub.received.map((message) => message._tag)).toContain("CheckAppPermissions"),
  )
  // Still short: the banner stays, ready to check again.
  await eventually(() => expect(button("Check again").getAttribute("aria-busy")).toBeNull())
  expect(banner()).toBeDefined()
})

test("goes once a check finds it fixed, and comes back if it drifts again", async () => {
  const { hub, banner } = await open(driftedAppPermissions())
  await eventually(() => expect(banner()).toBeDefined())
  hub.setAppPermissions(fixed())
  await eventually(() => expect(banner()).toBeUndefined())
  hub.setAppPermissions(driftedAppPermissions())
  await eventually(() => expect(banner()).toBeDefined())
})
