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

/** The sidebar's Repo sections: each one's name, and its Sessions' rows as their links read. */
function groups() {
  return [...(nav()?.querySelectorAll("ul[aria-labelledby]") ?? [])].map((list) => ({
    repo: document.getElementById(list.getAttribute("aria-labelledby") ?? "")?.textContent ?? "",
    sessions: [...list.querySelectorAll("a[href^='/sessions/']")].map((a) => a.textContent),
  }))
}

/** A Session's row in the sidebar, by its link. */
function row(sessionId: string): HTMLElement {
  const link = nav()?.querySelector(`a[href="/sessions/${sessionId}"]`)
  const item = link?.closest("li")
  if (!item) throw new Error(`no sidebar row for ${sessionId}`)
  return item
}

/** Types into a field as a person does, past React's record of its value. */
function typeInto(field: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value)
  field.dispatchEvent(new Event("input", { bubbles: true }))
}

function press(field: HTMLElement, key: string): void {
  field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
}

function nameField(within: ParentNode = document): HTMLInputElement | null {
  return within.querySelector<HTMLInputElement>('input[aria-label="Session name"]')
}

/** The labels of the sidebar's items marked as the current page. */
function current(): Array<string | null> {
  return [...(nav()?.querySelectorAll('[aria-current="page"]') ?? [])].map((el) => el.textContent)
}

test("the sidebar lists the listed Sessions under their Repo, oldest first, and marks the current one", async () => {
  await open("/sessions/s-readme")
  await eventually(() => expect(groups().length).toBe(2))

  // Archived Sessions aren't listed; each Repo is a section under its name, in alphabetical order.
  expect(groups()).toEqual([
    {
      repo: "kddige/claude-hub",
      sessions: ["claude/readme-run", "claude/web-client", "Release 0.4", "API docs", "Changelog"],
    },
    { repo: "kddige/dotfiles", sessions: ["claude/zsh-prompt"] },
  ])
  expect(current()).toEqual(["claude/readme-run"])
  // No single "Sessions" heading over them, and no links out to GitHub.
  expect([...(nav()?.querySelectorAll("div[id]") ?? [])].map((el) => el.textContent)).toEqual([
    "kddige/claude-hub",
    "kddige/dotfiles",
  ])
  expect(nav()?.querySelector("a[target='_blank']")).toBeNull()

  // Every row has its state's dot.
  expect(
    ["s-readme", "s-demo", "s-dotfiles"].map(
      (id) => row(id).querySelector('a [role="img"]')?.getAttribute("aria-label") ?? null,
    ),
  ).toEqual(["Asleep", "Active", "Frozen"])

  // The general nav and the footer.
  const links = [...(nav()?.querySelectorAll("a") ?? [])].map((a) => a.getAttribute("href"))
  expect(links).toContain("/environments")
  expect(links).toContain("/variables")
  expect(links).toContain("/archive")
  expect(document.body.textContent).toContain("1 of 2 Runners online")
  expect(button("Signed in as Alice Kim", document).getAttribute("aria-haspopup")).toBe("menu")
})

test("a Session is renamed from its sidebar row, and every open tab sees the name", async () => {
  const { hub } = await open("/sessions/s-readme")
  await eventually(() => expect(groups().length).toBe(2))
  // Another tab, on the same Hub.
  const other = new HubClient(hub, { retryDelay: () => 1 })
  other.start()
  const otherName = () => other.getState().sessions?.find((s) => s.id === "s-dotfiles")?.name
  try {
    // The row's Rename turns it into a field holding its Work branch.
    await step(() => button("Rename claude/zsh-prompt", row("s-dotfiles")).click())
    const field = nameField(nav() ?? document)
    expect(field?.value).toBe("claude/zsh-prompt")
    expect(field?.placeholder).toBe("claude/zsh-prompt")
    expect(field?.maxLength).toBe(80)

    // Escape drops the edit.
    await step(() => field && press(field, "Escape"))
    expect(nameField()).toBeNull()
    expect(hub.received.some((m) => m._tag === "RenameSession")).toBe(false)

    // Enter renames it, trimmed, here and in the other tab.
    await step(() => button("Rename claude/zsh-prompt", row("s-dotfiles")).click())
    const again = nameField(nav() ?? document)
    await step(() => again && typeInto(again, "  Prompt colours "))
    await step(() => again && press(again, "Enter"))
    await eventually(() =>
      expect(groups()[1]).toEqual({ repo: "kddige/dotfiles", sessions: ["Prompt colours"] }),
    )
    await eventually(() => expect(otherName()).toBe("Prompt colours"))
    expect(row("s-dotfiles").querySelector("a")?.title).toBe("Prompt colours · claude/zsh-prompt")

    // Leaving it unchanged sends nothing; clearing it goes back to the Work branch.
    const renames = () => hub.received.filter((m) => m._tag === "RenameSession").length
    await step(() => button("Rename Prompt colours", row("s-dotfiles")).click())
    await step(() => nameField()?.blur())
    expect(renames()).toBe(1)
    await step(() => button("Rename Prompt colours", row("s-dotfiles")).click())
    const cleared = nameField(nav() ?? document)
    await step(() => cleared && typeInto(cleared, ""))
    await step(() => cleared && press(cleared, "Enter"))
    await eventually(() => expect(groups()[1]?.sessions).toEqual(["claude/zsh-prompt"]))
    await eventually(() => expect(otherName()).toBeUndefined())
  } finally {
    other.stop()
  }
})

test("a Session is renamed in place from its header, and New Session doesn't ask for a name", async () => {
  const { page, hub } = await open("/sessions/s-readme")
  const title = () => page.querySelector("main > header h1")?.textContent
  const description = () => page.querySelector("main > header p")?.textContent ?? ""
  await eventually(() => expect(title()).toBe("claude/readme-run"))
  expect(description()).not.toContain("claude/readme-run")

  await step(() => button("Rename Session", page).click())
  const field = nameField(page.querySelector("main > header") ?? page)
  expect(field?.value).toBe("claude/readme-run")
  await step(() => field && typeInto(field, "README: how to run it"))
  await step(() => field && press(field, "Enter"))

  // The header and the sidebar both show it; the header keeps the Work branch in its description.
  await eventually(() => expect(title()).toBe("README: how to run it"))
  expect(description()).toContain("claude/readme-run from main")
  expect(current()).toEqual(["README: how to run it"])
  const renames = hub.received.flatMap((m) =>
    m._tag === "RenameSession" ? [{ sessionId: String(m.sessionId), name: m.name }] : [],
  )
  expect(renames).toEqual([{ sessionId: "s-readme", name: "README: how to run it" }])

  // New Session has no name field: a Session is named once it exists.
  await step(() => button("New Session", document).click())
  await eventually(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
  const labels = [...(document.querySelector('[role="dialog"]')?.querySelectorAll("label") ?? [])]
  expect(labels.map((label) => label.textContent).join(" ")).not.toMatch(/name/i)
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

test("each page beside the sidebar opens with the one PageHeader, holding its only h1", async () => {
  const { page, router } = await open("/")
  const pages = [
    ["/sessions/s-readme", "claude/readme-run"],
    ["/environments", "Environments"],
    ["/repos/kddige/claude-hub/environment", "kddige/claude-hub"],
    ["/variables", "Shared variables"],
    ["/archive", "Archived Sessions"],
    ["/repos/kddige/claude-hub/archived", "Archived Sessions"],
  ] as const
  for (const [path, title] of pages) {
    await step(() => router.history.push(path))
    await eventually(() =>
      expect(page.querySelector("main > header:first-child h1")?.textContent).toBe(title),
    )
    expect(page.querySelectorAll("h1").length).toBe(1)
  }
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
    ["/repos/kddige/claude-hub/environment", "kddige/claude-hub5 Sessions"],
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

/** The Sessions nested under a Session's row, as their links read. */
function nestedUnder(sessionId: string): Array<string | null> {
  const list = row(sessionId).querySelector(":scope > ul")
  return [...(list?.querySelectorAll("a") ?? [])].map((a) => a.textContent)
}

test("Child Sessions nest under their Parent Session, which only its chevron folds", async () => {
  const { router } = await open("/sessions/s-readme")
  await eventually(() => expect(groups().length).toBe(2))

  // In the order they were created, each with its dot and name only.
  expect(nestedUnder("s-release")).toEqual(["API docs", "Changelog"])
  expect(
    ["s-api-docs", "s-changelog"].map((id) =>
      row(id).querySelector('a [role="img"]')?.getAttribute("aria-label"),
    ),
  ).toEqual(["Active", "Asleep"])
  // Only a row with children has a chevron, open to start with, naming the list it controls.
  const chevron = button("Child Sessions of Release 0.4", nav() ?? document)
  expect(chevron.getAttribute("aria-expanded")).toBe("true")
  const controlled = document.getElementById(chevron.getAttribute("aria-controls") ?? "")
  expect(controlled?.querySelectorAll("a").length).toBe(2)
  expect(nav()?.querySelectorAll("button[aria-expanded]").length).toBe(1)

  // The chevron folds them, and the fold is kept for this viewer.
  await step(() => chevron.click())
  expect(chevron.getAttribute("aria-expanded")).toBe("false")
  expect(nestedUnder("s-release")).toEqual([])
  expect(controlled?.hidden).toBe(true)
  expect(router.state.location.pathname).toBe("/sessions/s-readme")
  expect(JSON.parse(localStorage.getItem("claude-hub:sidebar-folded") ?? "[]")).toEqual([
    "s-release",
  ])

  // A click on the row itself opens the Session and leaves the fold alone.
  await step(() => row("s-release").querySelector("a")?.click())
  await eventually(() => expect(router.state.location.pathname).toBe("/sessions/s-release"))
  expect(nestedUnder("s-release")).toEqual([])

  // Opened again, the chevron shows them.
  await step(() => button("Child Sessions of Release 0.4", nav() ?? document).click())
  expect(nestedUnder("s-release")).toEqual(["API docs", "Changelog"])
  expect(JSON.parse(localStorage.getItem("claude-hub:sidebar-folded") ?? "[]")).toEqual([])
})

test("a fold lasts across reloads, and opens when one of its Child Sessions becomes current", async () => {
  localStorage.setItem("claude-hub:sidebar-folded", JSON.stringify(["s-release"]))
  const { router } = await open("/sessions/s-readme")
  await eventually(() => expect(groups().length).toBe(2))
  expect(nestedUnder("s-release")).toEqual([])
  expect(
    button("Child Sessions of Release 0.4", nav() ?? document).getAttribute("aria-expanded"),
  ).toBe("false")

  // Opening a child, as from a link in a transcript, opens its parent so it shows as current.
  await step(() => router.history.push("/sessions/s-changelog"))
  await eventually(() => expect(current()).toEqual(["Changelog"]))
  expect(nestedUnder("s-release")).toEqual(["API docs", "Changelog"])
  expect(localStorage.getItem("claude-hub:sidebar-folded")).toBe("[]")
})

test("a Child Session whose parent is archived stands under its Repo on its own", async () => {
  const { client } = await open("/sessions/s-readme")
  await eventually(() => expect(groups().length).toBe(2))
  await step(() => client.archiveSession("s-release" as never))
  await eventually(() =>
    expect(groups()[0]?.sessions).toEqual(["claude/readme-run", "claude/web-client"]),
  )

  await step(() => client.restoreSession("s-api-docs" as never))
  await eventually(() =>
    expect(groups()[0]?.sessions).toEqual(["claude/readme-run", "claude/web-client", "API docs"]),
  )
  expect(row("s-api-docs").closest("ul")?.hasAttribute("aria-labelledby")).toBe(true)
  expect(nav()?.querySelectorAll("button[aria-expanded]").length).toBe(0)

  // Its parent restored, it nests again.
  await step(() => client.restoreSession("s-release" as never))
  await eventually(() => expect(nestedUnder("s-release")).toEqual(["API docs"]))
})

test("on a narrow screen the drawer nests and folds Child Sessions too", async () => {
  setWidth(400)
  const { page } = await open("/")
  await eventually(() => expect(button("Open navigation", page)).toBeTruthy())
  await step(() => button("Open navigation", page).click())
  await eventually(() => expect(nav()).not.toBeNull())

  expect(nestedUnder("s-release")).toEqual(["API docs", "Changelog"])
  await step(() => button("Child Sessions of Release 0.4", nav() ?? document).click())
  expect(nestedUnder("s-release")).toEqual([])
  // Folding doesn't follow a link, so the drawer stays open.
  expect(nav()).not.toBeNull()
})
