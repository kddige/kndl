// The ⌘K palette (#399): the whole app, routed, against the fake Hub with its script not playing.

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
  sessionStorage.clear()
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
  await eventually(() => expect(document.querySelector("nav")).not.toBeNull())
  return { router }
}

const input = () => document.querySelector<HTMLInputElement>('input[role="combobox"]')
const options = () => [...document.querySelectorAll('[role="option"]')].map((el) => el.textContent)

function typeInto(field: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value)
  field.dispatchEvent(new Event("input", { bubbles: true }))
}

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
  )
}

test("Ctrl+K opens the palette, typing narrows it, and Enter goes there", async () => {
  const { router } = await open("/archive")
  await step(() => press(window, "k", { ctrlKey: true }))
  await eventually(() => expect(input()).not.toBeNull())
  // A combobox over a listbox, the first option active as you type.
  expect(document.querySelector('[role="listbox"]')).not.toBeNull()
  expect(options()).toContain("New Session")

  await step(() => typeInto(input() as HTMLInputElement, "rel"))
  await eventually(() => expect(options()).toEqual(["Release 0.4kddige/kndl"]))
  await step(() => press(input() as HTMLInputElement, "Enter"))
  await eventually(() => expect(router.state.location.pathname).toBe("/sessions/s-release"))
  expect(input()).toBeNull()
})

test("every word must match, the Repo too; settings show once you type", async () => {
  await open("/archive")
  await step(() => button("Search (Ctrl K)").click())
  await eventually(() => expect(input()).not.toBeNull())
  expect(options()).not.toContain("Runners")

  await step(() => typeInto(input() as HTMLInputElement, "dotfiles zsh"))
  await eventually(() => expect(options()).toEqual(["claude/zsh-promptkddige/dotfiles"]))
  await step(() => typeInto(input() as HTMLInputElement, "run"))
  await eventually(() => expect(options()).toContain("Runners"))
})

test("on a Session's page it offers that Session's actions first", async () => {
  await open("/sessions/s-readme")
  await eventually(() => expect(document.querySelector("main h1")).not.toBeNull())
  await step(() => press(window, "k", { ctrlKey: true }))
  await eventually(() => expect(input()).not.toBeNull())
  const labels = [...document.querySelectorAll('[role="group"] > div:first-child')].map(
    (el) => el.textContent,
  )
  expect(labels[0]).toBe("This Session")
  expect(options()).toContain("Delete Session")
})

test("New Session opens from a settings page, which has no New Session button", async () => {
  await open("/runners")
  await step(() => press(window, "k", { ctrlKey: true }))
  await eventually(() => expect(input()).not.toBeNull())
  await step(() => typeInto(input() as HTMLInputElement, "new session"))
  await step(() => press(input() as HTMLInputElement, "Enter"))
  await eventually(() =>
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "A Session works on a branch of the Repo",
    ),
  )
})
