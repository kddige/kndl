// The People page (#209) against the fake Hub: the Members and Invites, inviting someone and
// copying the link, revoking an Invite, removing a Member once that's confirmed, and the page and
// its sidebar item being the Owner's alone.

import { afterEach, expect, test } from "bun:test"
import { installDom } from "./dom.ts"
import { button, dialog, menuItem, render, settle, step } from "./render.ts"

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

const members = () => document.querySelector('[aria-label="Members"]')
const invites = () => document.querySelector('[aria-label="Invites not used yet"]')
const peopleLink = () =>
  [...document.querySelectorAll("a")].find((a) => a.textContent?.trim() === "People")

async function openPeople(owner = true) {
  const hub = new FakeHub({ stepMs: 2, autoplay: false, owner })
  const client = new HubClient(hub, { retryDelay: () => 1 })
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/people"] }))
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
  await eventually(() => expect(document.querySelector("h1")?.textContent).toBe("People"))
  return { hub, client }
}

test("lists the Members, the Owner first, and the Invites not used yet", async () => {
  await openPeople()
  await eventually(() => expect(members()?.querySelectorAll("li").length).toBe(2))
  const [alice, bob] = [...(members()?.querySelectorAll("li") ?? [])].map((li) => li.textContent)
  expect(alice).toContain("Alice Kim")
  expect(alice).toContain("Owner")
  expect(alice).toContain("You")
  expect(bob).toContain("@bob")
  // The Owner can't be removed, so has no menu for it.
  expect(() => button("Actions for Alice Kim")).toThrow()
  expect(button("Actions for Bob Lee")).toBeTruthy()

  expect(invites()?.textContent).toContain("@carol-dev")
  expect(invites()?.textContent).toContain("Expires in 5 days")
  expect(peopleLink()?.getAttribute("aria-current")).toBe("page")
})

test("invites someone, shows the link once, and lists the Invite without it", async () => {
  const { hub } = await openPeople()
  await eventually(() => expect(members()).not.toBeNull())
  await step(() => button("Invite someone").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Invite someone"))
  const input = dialog()?.querySelector("input") as HTMLInputElement
  await step(() => {
    // React reads the value through its own setter, so set it as a browser would.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    setter?.call(input, "@Dana-Lee")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await step(() => button("Make the link").click())
  await eventually(() =>
    expect(document.querySelector('[aria-label="Invite link"]')?.textContent).toMatch(
      /^http:\/\/[^#]+\/invite#chi_inv-\d+\.\w+$/,
    ),
  )
  expect(dialog()?.textContent).toContain("Only @Dana-Lee signs in with GitHub")
  expect(hub.received.find((m) => m._tag === "CreateInvite")).toMatchObject({ login: "Dana-Lee" })
  await eventually(() => expect(invites()?.textContent).toContain("@Dana-Lee"))
  expect(invites()?.textContent).not.toContain("chi_")

  // Someone uses it: they're a Member, and it's gone from the Invites.
  await step(() => button("Done").click())
  await step(() => hub.acceptInvite("dana-lee"))
  await eventually(() => expect(members()?.textContent).toContain("dana-lee"))
  expect(invites()?.textContent).not.toContain("@Dana-Lee")
})

test("refuses a login GitHub couldn't have", async () => {
  const { hub } = await openPeople()
  await step(() => button("Invite someone").click())
  const input = dialog()?.querySelector("input") as HTMLInputElement
  await step(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    setter?.call(input, "not a login")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  expect(dialog()?.textContent).toContain("letters, digits and single hyphens")
  expect(button("Make the link").disabled).toBe(true)
  expect(hub.received.some((m) => m._tag === "CreateInvite")).toBe(false)
})

test("revokes an Invite", async () => {
  const { hub } = await openPeople()
  await eventually(() => expect(invites()).not.toBeNull())
  await menuItem("Actions for @carol-dev", "Revoke the Invite")
  await eventually(() => expect(invites()).toBeNull())
  expect(hub.received.find((m) => m._tag === "RevokeInvite")).toMatchObject({
    inviteId: "inv-carol",
  })
})

test("removes a Member only once that's confirmed", async () => {
  const { hub } = await openPeople()
  await eventually(() => expect(members()?.querySelectorAll("li").length).toBe(2))
  await menuItem("Actions for Bob Lee", "Remove Bob Lee")
  await eventually(() => expect(dialog()?.textContent).toContain("Remove Bob Lee?"))
  expect(dialog()?.textContent).toContain("signed out everywhere at once")
  expect(dialog()?.textContent).toContain("Their Sessions, and the Claude credential they stored")
  expect(hub.received.some((m) => m._tag === "RemoveMember")).toBe(false)

  await step(() => button("Remove").click())
  await eventually(() => expect(members()?.querySelectorAll("li").length).toBe(1))
  expect(hub.received.find((m) => m._tag === "RemoveMember")).toMatchObject({
    participantId: "u-bob",
  })
})

test("is the Owner's alone: no sidebar item, no lists asked for, and a page that says so", async () => {
  const { hub } = await openPeople(false)
  await eventually(() =>
    expect(document.body.textContent).toContain("Only the Hub's Owner manages people"),
  )
  expect(peopleLink()).toBeUndefined()
  expect(members()).toBeNull()
  expect(hub.received.some((m) => m._tag === "ListMembers" || m._tag === "ListInvites")).toBe(false)
})
