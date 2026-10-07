// The pages a Setup link and an Invite open (#209), against the fake Hub: handing the Hub the
// link's secret and going to GitHub, taking the secret out of the address, a link that isn't
// whole, someone already signed in, and the page for anyone the Hub didn't let in.

import { afterEach, expect, test } from "bun:test"
import { installDom } from "./dom.ts"
import { button, render, settle, step } from "./render.ts"

let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  window.history.replaceState(null, "", "/")
})

const { createMemoryHistory, RouterProvider } = await import("@tanstack/react-router")
const { InviteOnlyMessage } = await import("@kndl/protocol")
const { HubProvider } = await import("../src/app/hub.tsx")
const { HubClient } = await import("../src/hub/client.ts")
const { FakeHub } = await import("../src/hub/fake/FakeHub.ts")
const { AdmissionPage } = await import("../src/people/AdmissionPages.tsx")
const { createAppRouter } = await import("../src/router.tsx")
const { UIProvider } = await import("../src/ui/UIProvider.tsx")

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

const page = () => document.body.textContent ?? ""

/** The page a link opens, against a fake Hub; `went` holds where it sent the browser. */
async function openLink(
  kind: "setup" | "invite",
  hash: string,
  options: ConstructorParameters<typeof FakeHub>[0] = { signedIn: false },
) {
  const hub = new FakeHub({ stepMs: 2, autoplay: false, ...options })
  const client = new HubClient(hub, { retryDelay: () => 1 })
  const went: Array<string> = []
  const view = await render(
    <HubProvider client={client}>
      <UIProvider>
        <AdmissionPage kind={kind} hash={hash} goTo={(url) => went.push(url)} />
      </UIProvider>
    </HubProvider>,
  )
  cleanup = async () => {
    await view.unmount()
    client.stop()
    hub.dispose()
  }
  return { hub, went }
}

/** The app at `path`, against a fake Hub. */
async function openRouted(path: string, options: ConstructorParameters<typeof FakeHub>[0]) {
  const hub = new FakeHub({ stepMs: 2, autoplay: false, ...options })
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
  return hub
}

test("an Invite hands the Hub its secret, takes it out of the address and goes to GitHub", async () => {
  window.history.replaceState(null, "", "/invite#chi_inv-1.secret")
  const { hub, went } = await openLink("invite", "#chi_inv-1.secret")
  await eventually(() => expect(page()).toContain("You're invited to kndl"))
  expect(hub.admissions).toEqual([])

  await step(() => button("Continue with GitHub").click())
  await eventually(() => expect(went).toEqual(["/auth/github"]))
  expect(hub.admissions).toEqual(["chi_inv-1.secret"])
  expect(window.location.pathname).toBe("/invite")
  expect(window.location.hash).toBe("")
})

test("a Setup link asks its holder to become the Owner", async () => {
  const { hub, went } = await openLink("setup", "#cho_s-1.secret")
  await eventually(() => expect(page()).toContain("Become this Hub's Owner"))
  await step(() => button("Continue with GitHub").click())
  await eventually(() => expect(went).toEqual(["/auth/github"]))
  expect(hub.admissions).toEqual(["cho_s-1.secret"])
})

test("a link without its secret says so, and hands the Hub nothing", async () => {
  const { hub } = await openLink("invite", "")
  await eventually(() => expect(page()).toContain("This link isn't whole"))
  expect(() => button("Continue with GitHub")).toThrow()
  expect(hub.admissions).toEqual([])
})

test("someone signed in already is told so, and the link stays unused", async () => {
  // Through the app's router, as the link opens it, with the secret in the address.
  window.history.replaceState(null, "", "/invite#chi_inv-1.secret")
  const hub = await openRouted("/invite", { signedIn: true })
  await eventually(() => expect(page()).toContain("You're signed in already"))
  expect(page()).toContain("@alice")
  expect(page()).toContain("It is still unused.")
  expect(hub.admissions).toEqual([])
})

test("says so when the Hub has no GitHub sign-in to admit anyone with", async () => {
  const { hub } = await openLink("invite", "#chi_inv-1.secret", {
    signedIn: false,
    signInOptions: { github: false, dev: true },
  })
  await eventually(() => expect(page()).toContain("GitHub sign-in is off"))
  expect(hub.admissions).toEqual([])
})

test("the Hub's page for anyone it didn't let in says the Hub is invite-only", async () => {
  await openRouted("/invite-only", { signedIn: false })
  await eventually(() => expect(page()).toContain(InviteOnlyMessage))
  expect(page()).toContain("You weren't let in")
})
