// The pages `kndl login` opens (issue #179), against the fake Hub: approving the CLI on a
// machine, the browser sent back to the CLI with the Login code or the code shown to paste, going
// back a page to see it again, signing in first, and the page the CLI sends the browser to after.

import { afterEach, expect, test } from "bun:test"
import { installDom } from "./dom.ts"
import { button, render, settle, step } from "./render.ts"

let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  sessionStorage.clear()
})

const { createMemoryHistory, RouterProvider } = await import("@tanstack/react-router")
const { CliLoginPage, callbackUrl, readCliLoginSearch } =
  await import("../src/account/CliLogin.tsx")
const { HubProvider } = await import("../src/app/hub.tsx")
const { HubClient } = await import("../src/hub/client.ts")
const { FakeHub } = await import("../src/hub/fake/FakeHub.ts")
const { createAppRouter } = await import("../src/router.tsx")
const { UIProvider } = await import("../src/ui/UIProvider.tsx")

const challenge = "c".repeat(20) + "_-" + "C".repeat(21)

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
const shownCode = () => document.querySelector('[aria-label="Login code"]')?.textContent ?? ""

/** The page for `search`, against a fake Hub; `went` holds where it sent the browser. */
async function openPage(
  search: Record<string, unknown>,
  options: ConstructorParameters<typeof FakeHub>[0] = {},
) {
  const hub = new FakeHub({ stepMs: 2, autoplay: false, cliTokens: [], ...options })
  const client = new HubClient(hub, { retryDelay: () => 1 })
  const went: Array<string> = []
  const view = await render(
    <HubProvider client={client}>
      <UIProvider>
        <CliLoginPage search={readCliLoginSearch(search)} goTo={(url) => went.push(url)} />
      </UIProvider>
    </HubProvider>,
  )
  cleanup = async () => {
    await view.unmount()
    client.stop()
    hub.dispose()
  }
  return { hub, client, went, unmount: () => view.unmount() }
}

/** The tokens the fake Hub lists, as a web client sees them. */
async function listedMachines(client: InstanceType<typeof HubClient>) {
  client.start()
  await eventually(() => expect(client.getState().cliTokens).not.toBeNull())
  return client.getState().cliTokens?.map((token) => token.machine)
}

test("approves the CLI as whoever is signed in, and sends the browser back to it with the code", async () => {
  const { client, went } = await openPage({
    machine: "laptop",
    challenge,
    port: "52345",
    state: "abc123",
  })
  await eventually(() => expect(page()).toContain("Sign in kndl on laptop?"))
  expect(page()).toContain("Alice Kim (@alice)")
  expect(page()).toContain("Approve only if you just ran kndl login on laptop")

  await step(() => button("Approve").click())
  await eventually(() => expect(went).toHaveLength(1))
  const url = new URL(went[0] ?? "")
  expect(url.origin).toBe("http://127.0.0.1:52345")
  expect(url.pathname).toBe("/callback")
  expect(url.searchParams.get("state")).toBe("abc123")
  const code = url.searchParams.get("code") ?? ""
  expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/)
  // While it goes, and if it can't, the code is there to paste.
  expect(page()).toContain("Sending you back to kndl on laptop")
  expect(shownCode()).toBe(code)
  expect(await listedMachines(client)).toEqual(["laptop"])
})

test("shows the code to paste at once without a port, as with --no-browser", async () => {
  const { went } = await openPage({ machine: "devbox", challenge })
  await eventually(() => expect(page()).toContain("Sign in kndl on devbox?"))
  await step(() => button("Approve").click())
  await eventually(() => expect(page()).toContain("Paste this code in the terminal"))
  expect(shownCode()).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/)
  expect(page()).toContain("for the next 10 minutes")
  expect(went).toEqual([])
})

test("shows the same code again on coming back to the page, without approving again", async () => {
  const search = { machine: "laptop", challenge, port: "52345", state: "abc123" }
  const first = await openPage(search)
  await eventually(() => expect(page()).toContain("Sign in kndl on laptop?"))
  await step(() => button("Approve").click())
  await eventually(() => expect(first.went).toHaveLength(1))
  const code = shownCode()
  await cleanup?.()

  // The browser couldn't reach the CLI, and its Back button reloads the page.
  const again = await openPage(search)
  await eventually(() => expect(page()).toContain("Paste this code in the terminal"))
  expect(shownCode()).toBe(code)
  expect(again.went).toEqual([])
})

test("asks to sign in first, and comes back to the page after GitHub", async () => {
  const address = `/cli-login?machine=laptop&challenge=${challenge}`
  window.history.replaceState(null, "", address)
  await openPage({ machine: "laptop", challenge }, { signedIn: false })
  await eventually(() => expect(page()).toContain("Sign in to approve kndl on laptop."))
  const github = [...document.querySelectorAll("a")].find((a) =>
    a.textContent?.includes("Sign in with GitHub"),
  )
  const href = new URL(github?.getAttribute("href") ?? "", "http://hub.test")
  expect(href.pathname).toBe("/auth/github")
  expect(href.searchParams.get("return")).toBe(address)

  await step(() => button("Sign in as dev").click())
  await eventually(() => expect(page()).toContain("Sign in kndl on laptop?"))
  window.history.replaceState(null, "", "/")
})

test("cancelling approves nothing", async () => {
  const { client, went } = await openPage({ machine: "laptop", challenge })
  await eventually(() => expect(page()).toContain("Sign in kndl on laptop?"))
  await step(() => button("Cancel").click())
  expect(page()).toContain("Not approved")
  expect(went).toEqual([])
  expect(await listedMachines(client)).toEqual([])
})

test("says a link without its machine, challenge or both port and state isn't whole", async () => {
  for (const search of [
    { challenge },
    { machine: "laptop" },
    { machine: "laptop", challenge: "short" },
    { machine: "laptop", challenge, port: "52345" },
  ]) {
    await openPage(search)
    expect(page()).toContain("This sign-in link isn't whole")
    await cleanup?.()
    cleanup = undefined
  }
})

test("reads the port from the address, and drops one that isn't a port", () => {
  expect(readCliLoginSearch({ port: "52345", state: "abc" })).toEqual({ port: 52345, state: "abc" })
  expect(readCliLoginSearch({ port: "0" })).toEqual({})
  expect(readCliLoginSearch({ port: "65536" })).toEqual({})
  expect(readCliLoginSearch({ port: "80; evil" })).toEqual({})
  expect(readCliLoginSearch({ state: "a b" })).toEqual({})
  expect(callbackUrl({ port: 9, state: "s" }, "ABCD-EFGH-JKMN-PQRS")).toBe(
    "http://127.0.0.1:9/callback?code=ABCD-EFGH-JKMN-PQRS&state=s",
  )
})

test("the done page says the CLI is signed in, and forgets the code", async () => {
  sessionStorage.setItem(
    `kndl:cli-login:${challenge}`,
    JSON.stringify({ code: "ABCD-EFGH-JKMN-PQRS", expiresAt: Date.now() + 60_000 }),
  )
  const hub = new FakeHub({ stepMs: 2, autoplay: false })
  const client = new HubClient(hub, { retryDelay: () => 1 })
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: ["/cli-login/done?machine=laptop"] }),
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
  await eventually(() => expect(page()).toContain("kndl is signed in"))
  expect(page()).toContain("kndl on laptop is signed in to this Hub")
  expect(sessionStorage.length).toBe(0)
})
