// Repo access as the web shows it (#104): the Repo is checked as it is entered for a new Session
// (and so a new Environment), and an Environment screen says why the person can't use the Repo,
// also once they lose access. The whole app against the fake Hub.

import { afterEach, expect, test } from "bun:test"
import { installDom } from "./dom.ts"
import { button, render, settle, step } from "./render.ts"

let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())

const { createMemoryHistory, RouterProvider } = await import("@tanstack/react-router")
const { HubProvider } = await import("../src/app/hub.tsx")
const { HubClient } = await import("../src/hub/client.ts")
const { FakeHub } = await import("../src/hub/fake/FakeHub.ts")
const { createAppRouter } = await import("../src/router.tsx")

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  localStorage.clear()
})

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

function typeInto(field: HTMLInputElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setValue?.call(field, value)
  field.dispatchEvent(new Event("input", { bubbles: true }))
}

async function open(path: string) {
  const hub = new FakeHub({ stepMs: 2 })
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
  return { hub, router, page: view.container }
}

const openDialog = () => document.querySelector('[role="dialog"]')

/** Opens "New Session" and types `repo` into its Repo field. */
async function enterRepo(repo: string) {
  const app = await open("/")
  await eventually(() => expect(app.page.textContent).toContain("New Session"))
  const newSession = [...app.page.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "New Session",
  )
  await step(() => newSession?.click())
  await eventually(() => expect(openDialog()).not.toBeNull())
  const field = openDialog()?.querySelector("input") as HTMLInputElement
  await step(() => typeInto(field, repo))
  return { ...app, dialog: () => openDialog() as HTMLElement, field }
}

test("New Session says, as the Repo is entered, that the App isn't installed on it", async () => {
  const { hub, dialog, field } = await enterRepo("someone-else/their-repo")
  await eventually(() =>
    expect(dialog().textContent).toContain(
      "The GitHub App isn't installed on someone-else/their-repo, or there's no such Repo.",
    ),
  )
  const link = [...dialog().querySelectorAll("a")].find((a) => a.textContent === "Install the App")
  expect(link?.getAttribute("href")).toBe("https://github.com/apps/kndl/installations/new")
  expect(link?.getAttribute("target")).toBe("_blank")
  expect(field.getAttribute("aria-invalid")).toBe("true")

  // Starting goes nowhere: neither the Environment nor a Session is asked for.
  await step(() => button("Start Session", dialog()).click())
  await settle(50)
  expect(hub.received.map((message) => message._tag)).not.toContain("GetEnvironment")

  // Installed meanwhile: "check again" asks GitHub afresh.
  hub.repoAccess.delete("someone-else/their-repo")
  await step(() => button("check again", dialog()).click())
  await eventually(() => expect(dialog().textContent).not.toContain("isn't installed"))
  expect(hub.received).toContainEqual(
    expect.objectContaining({ _tag: "CheckRepo", repo: "someone-else/their-repo", fresh: true }),
  )
})

test("New Session says when the person has no access to the Repo", async () => {
  const { dialog } = await enterRepo("kddige/secret")
  await eventually(() =>
    expect(dialog().textContent).toContain("You don't have access to kddige/secret on GitHub."),
  )
})

test("New Session checks a Repo once typing pauses, and says nothing of one in reach", async () => {
  const { hub, dialog, field } = await enterRepo("kddige/claude-h")
  await step(() => typeInto(field, "kddige/kndl"))
  await eventually(() =>
    expect(hub.received.filter((message) => message._tag === "CheckRepo")).toHaveLength(1),
  )
  expect(hub.received).toContainEqual(
    expect.objectContaining({ _tag: "CheckRepo", repo: "kddige/kndl" }),
  )
  expect(field.getAttribute("aria-invalid")).not.toBe("true")
  expect(dialog().textContent).not.toContain("access")
})

test("an Environment screen says why the person can't use its Repo", async () => {
  const { page } = await open("/repos/someone-else/their-repo/environment")
  await eventually(() =>
    expect(page.textContent).toContain(
      "The GitHub App isn't installed on someone-else/their-repo, or there's no such Repo.",
    ),
  )
  const install = 'a[href="https://github.com/apps/kndl/installations/new"]'
  expect(page.querySelector(install)).not.toBeNull()
})

test("an Environment screen goes once the person loses access to its Repo", async () => {
  const { hub, page } = await open("/repos/kddige/kndl/environment")
  await eventually(() => expect(page.textContent).toContain("Version 2"))

  await step(() => hub.revokeRepo("kddige/kndl"))
  await eventually(() =>
    expect(page.textContent).toContain("You don't have access to kddige/kndl on GitHub."),
  )
  expect(page.textContent).not.toContain("Version 2")
})
