// Smoke tests of the Environment and shared variables screens: the whole app, routed there, against
// the fake Hub playing fast.

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
const { createAppRouter } = await import("../src/router.tsx")

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  localStorage.clear()
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

function typeInto(field: HTMLInputElement, value: string): void {
  // React tracks the value it last saw; the prototype's setter goes around that, as typing does.
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setValue?.call(field, value)
  field.dispatchEvent(new Event("input", { bubbles: true }))
}

async function open(
  path: string,
  stepMs = 2,
  before?: (hub: InstanceType<typeof FakeHub>) => void,
) {
  const hub = new FakeHub({ stepMs })
  before?.(hub)
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
  const section = (name: string) => {
    const found = page.querySelector(`section[aria-label="${name}"]`)
    if (!found) throw new Error(`no ${name} section`)
    return found
  }
  const status = () => section("Apply").querySelector('[role="status"]')?.textContent ?? ""
  return { hub, client, router, page, section, status }
}

test("a change to the image needs a passing Test build before it applies", async () => {
  const { page, section, status } = await open("/repos/kddige/kndl/environment")
  // Headed by the Repo while it loads, then with its version beside it.
  await eventually(() => expect(page.querySelector("h1")?.textContent).toBe("kddige/kndl"))
  await eventually(() => expect(page.textContent).toContain("Version 2"))
  expect(section("Version history").textContent).toContain("Changed the build")
  expect(status()).toContain("No changes to apply.")
  expect(button("Apply").disabled).toBe(true)
  // A saved Sensitive value shows as set, never as the value.
  expect(section("Variables").textContent).toContain("set")

  const image = section("Image and scripts").querySelector("input") as HTMLInputElement
  await step(() => typeInto(image, "ubuntu:24.04"))
  await eventually(() => expect(status()).toContain("Needs a Test build"))
  expect(button("Apply").disabled).toBe(true)

  await step(() => button("Test build").click())
  await eventually(() => expect(status()).toContain("Test build passed"))
  expect(page.querySelector('[aria-label="Test build log"]')?.textContent).toContain(
    "Pulling ubuntu:24.04",
  )
  expect(button("Apply").disabled).toBe(false)

  // Changed again, it needs a Test build of its own.
  await step(() => typeInto(image, "ubuntu:22.04"))
  await eventually(() => expect(status()).toContain("Needs a Test build"))
  expect(button("Apply").disabled).toBe(true)
  await step(() => typeInto(image, "ubuntu:24.04"))
  await eventually(() => expect(status()).toContain("Test build passed"))

  await step(() => button("Apply").click())
  await eventually(() => expect(page.textContent).toContain("Version 3"))
  expect(status()).toContain("No changes to apply.")
})

test("the draft survives a reload, without its Sensitive values", async () => {
  const first = await open("/repos/kddige/kndl/environment")
  await eventually(() => expect(first.status()).toContain("No changes to apply."))
  await step(() => button("Add variable").click())
  // The new row's name, then its value.
  const names = first.section("Variables").querySelectorAll('input[placeholder="NAME"]')
  const name = names[names.length - 1] as HTMLInputElement
  const texts = [...first.section("Variables").querySelectorAll("input")].filter(
    (input) => input.type === "text",
  )
  await step(() => typeInto(name, "LOG_LEVEL"))
  await step(() => typeInto(texts.at(-1) as HTMLInputElement, "debug"))
  const sensitive = first.section("Variables").querySelector('input[type="password"]')
  await step(() => typeInto(sensitive as HTMLInputElement, "made-up-new-secret"))
  const stored = JSON.stringify({ ...localStorage })
  expect(stored).toContain("LOG_LEVEL")
  expect(stored).not.toContain("made-up-new-secret")
  await cleanup?.()
  cleanup = undefined

  const second = await open("/repos/kddige/kndl/environment")
  const values = () =>
    [...second.section("Variables").querySelectorAll("input")].map((input) => input.value)
  await eventually(() => expect(values()).toContain("LOG_LEVEL"))
  expect(values()).toContain("debug")
  expect(values()).not.toContain("made-up-new-secret")
})

test("a draft made before someone else applied is refused, with a way to reload", async () => {
  const { hub, page, status } = await open("/repos/kddige/kndl/environment")
  await eventually(() => expect(status()).toContain("No changes to apply."))
  const cpus = page.querySelector('section[aria-label="Resources"] input') as HTMLInputElement
  await step(() => typeInto(cpus, "8"))
  await eventually(() => expect(status()).toContain("No Test build needed"))

  await step(() => hub.teammateApplies("kddige/kndl"))
  await eventually(() =>
    expect(page.textContent).toContain("applied version 3 since you started this draft"),
  )
  expect(button("Apply").disabled).toBe(true)
  await step(() => button("Reload").click())
  await eventually(() => expect(page.textContent).not.toContain("since you started this draft"))
  expect(cpus.isConnected ? cpus.value : "").not.toBe("8")
})

test("a Repo without an Environment is set up before its first Session", async () => {
  // Slow enough to see the new Session's start.
  const { page, router, status } = await open("/repos/acme/new/environment?branch=main", 15)
  await eventually(() =>
    expect(page.textContent).toContain("Set up acme/new to start your Session"),
  )
  expect(page.textContent).toContain("Not set up")
  await eventually(() => expect(status()).toContain("Needs a Test build"))
  await step(() => button("Test build").click())
  await eventually(() => expect(status()).toContain("Test build passed"))
  await step(() => button("Apply and start Session").click())
  await eventually(() => expect(router.state.location.pathname).toStartWith("/sessions/"))

  // The new Session shows it is starting, with its build's log, not a changed Environment (#70).
  await eventually(() => expect(page.textContent).toContain("Starting…"))
  expect(page.textContent).toContain("Starting the Sandbox on version 1 of acme/new's Environment")
  expect(page.textContent).not.toContain("Environment changed")
  expect(button("Sleep now").disabled).toBe(true)
  await step(() => button("Show log").click())
  const log = () => page.querySelector('[aria-label="Start log"]')?.textContent ?? ""
  await eventually(() => expect(log()).toContain("Building version 1 of acme/new's Environment"))
  // Shown as text: the build's colours are dropped.
  expect(log()).not.toContain("\u001b")

  // Started, it shows neither.
  await eventually(() => expect(page.textContent).not.toContain("Starting…"))
  expect(page.textContent).not.toContain("Environment changed")
  expect(button("Sleep now").disabled).toBe(false)
})

test("shared variables: linked ones show who links them, and can't be deleted", async () => {
  const { page } = await open("/variables")
  await eventually(() => expect(page.querySelector("h1")?.textContent).toBe("Shared variables"))
  await eventually(() =>
    expect(page.querySelector('li[aria-label="GH_READ_TOKEN"]')).not.toBeNull(),
  )
  const row = page.querySelector('li[aria-label="GH_READ_TOKEN"]')
  expect(row?.textContent).toContain("Linked by")
  expect(row?.textContent).toContain("kddige/kndl as GITHUB_TOKEN")
  expect(row?.textContent).toContain("set")

  await step(() => button("Delete GH_READ_TOKEN").click())
  await eventually(() => expect(button("Delete").disabled).toBe(false))
  await step(() => button("Delete").click())
  await eventually(() =>
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "GH_READ_TOKEN is linked in kddige/kndl",
    ),
  )
})

const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement

/** The "needs a value" badges in `within`. */
const needsValueBadges = (within: ParentNode) =>
  [...within.querySelectorAll("span")].filter((span) => span.textContent === "needs a value")

test("after a secrets-reset, the Environment asks for the cleared values again", async () => {
  const { page, section, status } = await open("/repos/kddige/kndl/environment", 2, (hub) =>
    hub.environments.resetSecrets(),
  )
  await eventually(() =>
    expect(page.textContent).toContain(
      "kddige/kndl's Sessions can't start: NPM_TOKEN and GITHUB_TOKEN (the shared variable GH_READ_TOKEN) need values",
    ),
  )
  await eventually(() => expect(needsValueBadges(section("Variables"))).toHaveLength(2))
  expect(section("Variables").textContent).toContain("NPM_TOKEN needs a value: enter one.")
  expect(section("Variables").textContent).toContain(
    "GITHUB_TOKEN (the shared variable GH_READ_TOKEN) needs a value: set it on the Shared variables screen.",
  )
  const banner = [...page.querySelectorAll('[role="status"]')].find((shown) =>
    shown.textContent?.includes("Sessions can't start"),
  )
  expect(banner?.querySelector('a[href="/variables"]')?.textContent).toBe("Shared variables")

  // Entering one clears it on its row; the link's waits for the shared variable.
  const sensitive = section("Variables").querySelector('input[type="password"]')
  expect(sensitive?.getAttribute("placeholder")).toBe("Cleared: enter it again")
  await step(() => typeInto(sensitive as HTMLInputElement, "made-up-new-npm-token"))
  expect(needsValueBadges(section("Variables"))).toHaveLength(1)
  expect(section("Variables").textContent).not.toContain("NPM_TOKEN needs a value")
  expect(status()).not.toContain("No changes to apply.")
})

test("after a secrets-reset, a shared variable asks for its value, and entering it clears that", async () => {
  const { page } = await open("/variables", 2, (hub) => hub.environments.resetSecrets())
  await eventually(() => expect(page.textContent).toContain("GH_READ_TOKEN needs a value"))
  const row = () => page.querySelector('li[aria-label="GH_READ_TOKEN"]')
  expect(needsValueBadges(row() as Element)).toHaveLength(1)

  await step(() => button("Edit GH_READ_TOKEN").click())
  await eventually(() => expect(dialog()).not.toBeNull())
  const value = dialog().querySelector('input[type="password"]') as HTMLInputElement
  expect(value.getAttribute("placeholder")).toBe("Cleared: enter it again")
  // Kept blank, it is refused: there is nothing to keep.
  await step(() => button("Save", dialog()).click())
  expect(dialog().textContent).toContain("under 4 characters")
  await step(() => typeInto(value, "made-up-new-gh-token"))
  await step(() => button("Save", dialog()).click())
  await eventually(() => expect(row()?.textContent).toContain("set"))
  expect(needsValueBadges(row() as Element)).toHaveLength(0)
  expect(page.textContent).not.toContain("GH_READ_TOKEN needs a value")
})
