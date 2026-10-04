// Smoke tests of the app's sidebar and the Hub-wide pages it leads to: the whole app, routed
// there, against the fake Hub with its script not playing.

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
  setWidth(1024)
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

/** Resizes happy-dom's window, which media queries follow. */
function setWidth(width: number): void {
  ;(
    window as unknown as { happyDOM: { setViewport(size: { width: number }): void } }
  ).happyDOM.setViewport({ width })
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
  return { hub, client, router, page: view.container }
}

/** The sidebar's navigation, wherever it is: beside the page, or in the drawer. */
function nav(): HTMLElement | null {
  return document.querySelector<HTMLElement>('nav[aria-label="Main"]')
}

/** The Sessions section's Repo groups: each one's name, whether it's open, and its Sessions. */
function groups() {
  const label = [...(nav()?.querySelectorAll("div[id]") ?? [])].find(
    (el) => el.textContent === "Sessions",
  )
  const list = nav()?.querySelector(`ul[aria-labelledby="${label?.id}"]`)
  return [...(list?.children ?? [])].map((group) => ({
    repo: group.querySelector("button")?.textContent ?? "",
    open: group.querySelector("button")?.getAttribute("aria-expanded") === "true",
    branches: [...group.querySelectorAll("a[href^='/sessions/']")].map((a) => a.textContent),
  }))
}

/** The labels of the sidebar's items marked as the current page. */
function current(): Array<string | null> {
  return [...(nav()?.querySelectorAll('[aria-current="page"]') ?? [])].map((el) => el.textContent)
}

test("the sidebar lists the listed Sessions by Repo, newest first, and marks the current one", async () => {
  await open("/sessions/s-readme")
  await eventually(() => expect(groups().length).toBe(2))

  // Archived Sessions aren't listed; each Repo is a group, in alphabetical order.
  expect(groups()).toEqual([
    { repo: "kddige/claude-hub", open: true, branches: ["claude/web-client", "claude/readme-run"] },
    { repo: "kddige/dotfiles", open: true, branches: ["claude/zsh-prompt"] },
  ])
  expect(current()).toEqual(["claude/readme-run"])

  // Each Repo links to GitHub in a new tab, apart from its toggle.
  const github = nav()?.querySelector<HTMLAnchorElement>(
    'a[aria-label="Open kddige/dotfiles on GitHub"]',
  )
  expect(github?.href).toBe("https://github.com/kddige/dotfiles")
  expect(github?.target).toBe("_blank")

  // The general nav and the footer.
  const links = [...(nav()?.querySelectorAll("a") ?? [])].map((a) => a.getAttribute("href"))
  expect(links).toContain("/environments")
  expect(links).toContain("/variables")
  expect(links).toContain("/archive")
  expect(document.body.textContent).toContain("1 of 2 Runners online")
  expect(button("Signed in as Alice Kim", document).getAttribute("aria-haspopup")).toBe("menu")
})

test("a collapsed Repo stays collapsed, and opens when one of its Sessions becomes current", async () => {
  await open("/")
  await eventually(() => expect(groups().length).toBe(2))
  await step(() => button("kddige/dotfiles", nav() ?? document).click())
  await eventually(() => expect(groups()[1]).toMatchObject({ open: false, branches: [] }))
  expect(groups()[0]?.open).toBe(true)
  await cleanup?.()
  cleanup = undefined

  // Remembered in this browser.
  const second = await open("/")
  await eventually(() => expect(groups().length).toBe(2))
  expect(groups()[1]).toMatchObject({ open: false, branches: [] })

  // Going to one of its Sessions opens it, so the current one is in view.
  await step(
    () =>
      void second.router.navigate({
        to: "/sessions/$sessionId",
        params: { sessionId: "s-dotfiles" },
      }),
  )
  await eventually(() => expect(groups()[1]?.open).toBe(true))
  await eventually(() => expect(current()).toEqual(["claude/zsh-prompt"]))
})

test("the start page points at the sidebar, and the general nav marks its page", async () => {
  const { page, router } = await open("/")
  await eventually(() =>
    expect(page.textContent).toContain("Pick a Session from the sidebar or start one"),
  )
  expect(current()).toEqual([])

  await step(() => void router.navigate({ to: "/variables" }))
  await eventually(() => expect(current()).toEqual(["Shared variables"]))
  // A Repo's own pages count as the Hub-wide ones.
  await step(
    () =>
      void router.navigate({
        to: "/repos/$owner/$repo/archived",
        params: { owner: "kddige", repo: "claude-hub" },
      }),
  )
  await eventually(() => expect(current()).toEqual(["Archived Sessions"]))
})

test("the Environments page lists every Repo with a Session, Archived ones included", async () => {
  const { page } = await open("/environments")
  const list = () => page.querySelector('ul[aria-label="Environments"]')
  await eventually(() => expect(list()?.querySelectorAll("a").length).toBe(2))
  expect(current()).toEqual(["Environments"])
  const rows = [...(list()?.querySelectorAll("a") ?? [])].map((a) => [
    a.getAttribute("href"),
    a.textContent,
  ])
  expect(rows).toEqual([
    ["/repos/kddige/claude-hub/environment", "kddige/claude-hub2 Sessions"],
    ["/repos/kddige/dotfiles/environment", "kddige/dotfiles1 Session"],
  ])
})

test("the Archive page lists every Repo's Archived Sessions, and restores them", async () => {
  const { page, client } = await open("/archive")
  const archived = () =>
    page.querySelector('ul[aria-label="Archived Sessions of kddige/claude-hub"]')?.textContent ?? ""
  await eventually(() => expect(archived()).toContain("claude/flaky-login"))
  expect(archived()).toContain("Deleted by Bob Lee 3d ago")
  expect(current()).toEqual(["Archived Sessions"])
  expect(page.querySelector("h2 a")?.getAttribute("href")).toBe("/repos/kddige/claude-hub/archived")

  await step(() => button("Restore claude/flaky-login", page).click())
  await eventually(() =>
    expect(client.getState().sessions?.find((s) => s.id === "s-flaky")?.state).toBe("Asleep"),
  )
  await eventually(() => expect(page.textContent).toContain("Nothing archived"))
})

test("on a narrow screen the sidebar is a drawer, closed by following a link", async () => {
  setWidth(400)
  const { page, router } = await open("/")
  await eventually(() => expect(button("Open navigation", page)).toBeTruthy())
  expect(nav()).toBeNull()

  await step(() => button("Open navigation", page).click())
  await eventually(() => expect(nav()).not.toBeNull())
  const link = nav()?.querySelector<HTMLAnchorElement>('a[href="/sessions/s-readme"]')
  await step(() => link?.click())
  await eventually(() => expect(router.state.location.pathname).toBe("/sessions/s-readme"))
  await eventually(() => expect(nav()).toBeNull())
})
