// New Session for someone with no Claude credential of their own (ADR 0015), against the fake Hub
// with its script not playing: it runs on its Runner's, and with none there, it says so up front.

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
const { createAppRouter } = await import("../src/router.tsx")

/** Opens New Session as alice, who has stored no Claude credential. */
async function openDialog(runnerHasOwn: boolean) {
  const hub = new FakeHub({ stepMs: 2, autoplay: false })
  hub.patchRunner("r-studio", { ownClaudeCredential: runnerHasOwn })
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
  await settle(50)
  await step(() => button("New Session", document).click())
  await settle()
  const dialog = document.querySelector('[role="dialog"]') as HTMLElement
  return { dialog, start: button("Start Session", dialog) }
}

test("runs on its Runner's own credential when the Runner has one", async () => {
  const { dialog, start } = await openDialog(true)
  expect(dialog.textContent).toContain("Until then, this one runs on its Runner's own.")
  expect(start.disabled).toBe(false)
})

test("says before the form is filled in that no Runner can run it, and can't be started", async () => {
  const { dialog, start } = await openDialog(false)
  expect(dialog.textContent).toContain("Add your Claude credential first")
  expect(dialog.textContent).toContain(
    "No online Runner has a Claude credential of its own to run this one on.",
  )
  expect(start.disabled).toBe(true)
})
