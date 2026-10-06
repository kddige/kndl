// The Account page against the fake Hub: pasting a Claude credential, which the fake checks as the
// Hub does, seeing it write-only once saved, and removing it (ADR 0015). Every secret is made up.

import { afterEach, expect, test } from "bun:test"
import { installDom } from "./dom.ts"
import { button, render, settle, step } from "./render.ts"

let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

const { createMemoryHistory, RouterProvider } = await import("@tanstack/react-router")
const { HubProvider } = await import("../src/app/hub.tsx")
const { HubClient } = await import("../src/hub/client.ts")
const { FakeHub } = await import("../src/hub/fake/FakeHub.ts")
const { createAppRouter } = await import("../src/router.tsx")

const fakeKey = "sk-ant-api03-FAKE_KEY_FOR_TESTS_ONLY_a1b2"
const fakeToken = "sk-ant-oat01-FAKE_TOKEN_FOR_TESTS_ONLY_c3d4"

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

const section = () => document.querySelector('section[aria-labelledby="claude-credential"]')
const secretField = () => section()?.querySelector('input[type="password"]') as HTMLInputElement
const saved = () => section()?.querySelector('[aria-label="Your Claude credential"]')
const alert = () => section()?.querySelector('[role="alert"]')?.textContent ?? ""

async function openAccount(options: ConstructorParameters<typeof FakeHub>[0] = {}) {
  const hub = new FakeHub({ stepMs: 2, autoplay: false, ...options })
  const client = new HubClient(hub, { retryDelay: () => 1 })
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/account"] }))
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
  await eventually(() => expect(section()).not.toBeNull())
  return { hub, page: view.container }
}

test("saves a pasted API key, then shows it write-only", async () => {
  const { page } = await openAccount()
  expect(page.querySelector("h1")?.textContent).toBe("Account")
  await eventually(() => expect(secretField()).not.toBeNull())
  expect(section()?.textContent).toContain("claude setup-token")
  await step(() => typeInto(secretField(), fakeKey))
  await step(() => button("Save").click())
  await eventually(() => expect(saved()).not.toBeNull())
  const shown = saved()?.textContent ?? ""
  expect(shown).toContain("API key")
  expect(shown).toContain("…a1b2")
  expect(shown).toContain("Billed per token")
  // The key itself never comes back to the page.
  expect(document.body.innerHTML).not.toContain(fakeKey)
})

test("asks for the plan of a subscription token before saving it", async () => {
  await openAccount()
  await eventually(() => expect(secretField()).not.toBeNull())
  expect(section()?.textContent).not.toContain("Pick a plan")
  await step(() => typeInto(secretField(), fakeToken))
  expect(section()?.textContent).toContain("Pick a plan")
  await step(() => button("Save").click())
  expect(section()?.textContent).toContain("Pick the plan your Claude account is on.")
  expect(saved()).toBeNull()
})

test("says why the Hub refused a credential Anthropic rejected, and keeps the form", async () => {
  await openAccount()
  await eventually(() => expect(secretField()).not.toBeNull())
  await step(() => typeInto(secretField(), "sk-ant-api03-REJECTED_FAKE_KEY_FOR_TESTS"))
  await step(() => button("Save").click())
  await eventually(() => expect(alert()).toContain("Anthropic rejected this API key"))
  expect(saved()).toBeNull()
})

test("shows a saved credential, replaces it, and removes it after asking", async () => {
  await openAccount({
    claudeCredential: {
      kind: "OAuthToken",
      last4: "c3d4",
      plan: "max20x",
      addedAt: 1_760_000_000_000,
    },
  })
  await eventually(() => expect(saved()?.textContent).toContain("Subscription token"))
  expect(saved()?.textContent).toContain("Max 20x")
  expect(saved()?.textContent).toContain("…c3d4")

  // Replace opens the form, and Cancel goes back to what is saved.
  await step(() => button("Replace").click())
  expect(secretField()).not.toBeNull()
  await step(() => button("Cancel").click())
  expect(saved()).not.toBeNull()

  await step(() => button("Remove").click())
  const dialog = document.querySelector('[role="dialog"]') as HTMLElement
  expect(dialog.textContent).toContain("Remove your Claude credential?")
  await step(() => button("Remove", dialog).click())
  await eventually(() => expect(secretField()).not.toBeNull())
  expect(saved()).toBeNull()
})
