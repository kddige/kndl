// Smoke tests of the app's sidebar and the Hub-wide pages it leads to: the whole app, routed
// there, against the fake Hub with its script not playing.

import { afterEach, expect, test } from "bun:test"
import { SessionId, ThreadId } from "@kndl/protocol"
import { installDom } from "./dom.ts"
import { button, chooseSessionAction, dialog, render, settle, step } from "./render.ts"

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

/** The sidebar's navigation, wherever it is: beside the page, or in the drawer; on a settings page,
 * the Settings nav that takes its place. */
function nav(): HTMLElement | null {
  return document.querySelector<HTMLElement>('nav[aria-label="Main"], nav[aria-label="Settings"]')
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
    { repo: "kddige/dotfiles", sessions: ["claude/zsh-prompt"] },
    {
      repo: "kddige/kndl",
      // Release 0.4's interrupted agent is under it.
      sessions: [
        "claude/readme-run",
        "claude/pi-harness",
        "claude/web-client",
        "Does it back off between retries, or hammer the Hub?",
        "Release 0.4",
        "Document the protocol",
        "claude/landing-copy",
      ],
    },
  ])
  expect(current()).toEqual(["claude/readme-run"])
  // No single "Sessions" heading over them, and no links out to GitHub.
  expect([...(nav()?.querySelectorAll("h2[id]") ?? [])].map((el) => el.textContent)).toEqual([
    "kddige/dotfiles",
    "kddige/kndl",
  ])
  expect(nav()?.querySelector("a[target='_blank']")).toBeNull()

  // Every row has its state's dot.
  expect(
    ["s-readme", "s-demo", "s-dotfiles"].map(
      (id) => row(id).querySelector('a [role="img"]')?.getAttribute("aria-label") ?? null,
    ),
  ).toEqual(["Asleep", "Active", "Frozen"])

  // Settings and Archived Sessions, pinned under the Sessions; the Hub-wide pages are Settings'.
  const links = [...document.querySelectorAll("a")].map((a) => [
    a.textContent,
    a.getAttribute("href"),
  ])
  expect(links).toContainEqual(["Settings", "/runners"])
  expect(links).toContainEqual(["Archived Sessions", "/archive"])
  expect(links.map(([, href]) => href)).not.toContain("/environments")
  // The Runners' status is the way to them.
  expect(links).toContainEqual(["2 of 3 Runners online", "/runners"])
  expect(button("Signed in as Alice Kim", document).getAttribute("aria-haspopup")).toBe("menu")
})

/** Who keeps a Session awake, as its sidebar row's sun says, or null without one. */
function keptAwake(sessionId: string): string | null {
  return (
    row(sessionId).querySelector('[aria-label^="Kept awake by"]')?.getAttribute("title") ?? null
  )
}

test("a Session kept awake is marked in its sidebar row, with who keeps it awake", async () => {
  const { client } = await open("/sessions/s-readme")
  await eventually(() => expect(groups().length).toBe(2))
  expect(["s-readme", "s-demo", "s-dotfiles"].map(keptAwake)).toEqual([
    null,
    "Kept awake by you",
    "Kept awake by you",
  ])

  // Turned on anywhere, every open tab marks it; turned off, the mark goes.
  await step(() => client.setKeepAwake(SessionId.make("s-readme"), true))
  await eventually(() => expect(keptAwake("s-readme")).toBe("Kept awake by you"))
  await step(() => client.setKeepAwake(SessionId.make("s-demo"), false))
  await eventually(() => expect(keptAwake("s-demo")).toBeNull())
})

test("a Session is renamed from its sidebar row, and every open tab sees the name", async () => {
  const { hub } = await open("/sessions/s-readme")
  await eventually(() => expect(groups().length).toBe(2))
  // Another tab, on the same Hub.
  const other = new HubClient(hub, { retryDelay: () => 1 })
  other.start()
  const otherName = () => other.getState().sessions?.find((s) => s.id === "s-dotfiles")?.name
  try {
    // F2 on the row turns it into a field holding its Work branch.
    const rename = () => press(row("s-dotfiles").querySelector("a") as HTMLElement, "F2")
    await step(rename)
    const field = nameField(nav() ?? document)
    expect(field?.value).toBe("claude/zsh-prompt")
    expect(field?.placeholder).toBe("claude/zsh-prompt")
    expect(field?.maxLength).toBe(80)

    // Escape drops the edit.
    await step(() => field && press(field, "Escape"))
    expect(nameField()).toBeNull()
    expect(hub.received.some((m) => m._tag === "RenameSession")).toBe(false)

    // Enter renames it, trimmed, here and in the other tab.
    await step(rename)
    const again = nameField(nav() ?? document)
    await step(() => again && typeInto(again, "  Prompt colours "))
    await step(() => again && press(again, "Enter"))
    await eventually(() =>
      expect(groups()[0]).toEqual({ repo: "kddige/dotfiles", sessions: ["Prompt colours"] }),
    )
    await eventually(() => expect(otherName()).toBe("Prompt colours"))
    expect(row("s-dotfiles").querySelector("a")?.title).toBe("Prompt colours · claude/zsh-prompt")

    // Leaving it unchanged sends nothing; clearing it goes back to the Work branch.
    const renames = () => hub.received.filter((m) => m._tag === "RenameSession").length
    await step(rename)
    await step(() => nameField()?.blur())
    expect(renames()).toBe(1)
    await step(rename)
    const cleared = nameField(nav() ?? document)
    await step(() => cleared && typeInto(cleared, ""))
    await step(() => cleared && press(cleared, "Enter"))
    await eventually(() => expect(groups()[0]?.sessions).toEqual(["claude/zsh-prompt"]))
    await eventually(() => expect(otherName()).toBeUndefined())
  } finally {
    other.stop()
  }
})

test("a Session is renamed in place from its header, and New Session doesn't ask for a name", async () => {
  const { page, hub } = await open("/sessions/s-readme")
  const title = () => page.querySelector("main header h1")?.textContent
  const description = () => page.querySelector("main header p")?.textContent ?? ""
  await eventually(() => expect(title()).toBe("claude/readme-run"))
  expect(description()).not.toContain("claude/readme-run")

  await chooseSessionAction("Rename", page)
  const field = nameField(page.querySelector("main header") ?? page)
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
  await eventually(() => expect(dialog()).not.toBeNull())
  const labels = [...(dialog()?.querySelectorAll("label") ?? [])]
  expect(labels.map((label) => label.textContent).join(" ")).not.toMatch(/name/i)
})

test("each page beside the sidebar opens with its one header, holding its only h1", async () => {
  const { page, router } = await open("/")
  const pages = [
    ["/sessions/s-readme", "claude/readme-run"],
    ["/environments", "Environments"],
    ["/repos/kddige/kndl/environment", "kddige/kndl"],
    ["/variables", "Shared variables"],
    ["/archive", "Archived Sessions"],
    ["/repos/kddige/kndl/archived", "Archived Sessions"],
  ] as const
  for (const [path, title] of pages) {
    await step(() => router.history.push(path))
    await eventually(() => expect(page.querySelector("main header h1")?.textContent).toBe(title))
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
    ["/repos/kddige/dotfiles/environment", "kddige/dotfiles1 Session"],
    ["/repos/kddige/kndl/environment", "kddige/kndl5 Sessions"],
  ])
})

test("the Archive page lists every Repo's Archived Sessions, and restores them", async () => {
  const { page, client, router } = await open("/archive")
  const archived = () =>
    page.querySelector('ul[aria-label="Archived Sessions of kddige/kndl"]')?.textContent ?? ""
  await eventually(() => expect(archived()).toContain("claude/flaky-login"))
  expect(archived()).toContain("Deleted by Alice Kim 3d ago")
  expect(current()).toEqual(["Archived Sessions"])
  expect(page.querySelector("h2 a")?.getAttribute("href")).toBe("/repos/kddige/kndl/archived")

  await step(() => button("Restore claude/flaky-login", page).click())
  await eventually(() =>
    expect(client.getState().sessions?.find((s) => s.id === "s-flaky")?.state).toBe("Asleep"),
  )
  await eventually(() => expect(page.textContent).toContain("Nothing archived"))

  // A Repo's own pages count as the Hub-wide ones.
  await step(
    () =>
      void router.navigate({
        to: "/repos/$owner/$repo/archived",
        params: { owner: "kddige", repo: "kndl" },
      }),
  )
  await eventually(() => expect(router.state.location.pathname).toBe("/repos/kddige/kndl/archived"))
  expect(current()).toEqual(["Archived Sessions"])
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

/** The agents nested under a Session's row, as their links read. */
function nestedUnder(sessionId: string): Array<string | null> {
  const list = row(sessionId).querySelector(":scope > ul")
  return [...(list?.querySelectorAll("a") ?? [])].map((a) => a.textContent)
}

const releaseAgents = [
  "Write the 0.4 changelog",
  "Document the protocol",
  "Bump the package versions",
]

test("a Session's running and interrupted agents nest under it, which only its chevron folds", async () => {
  const { router } = await open("/sessions/s-readme")
  await eventually(() => expect(groups().length).toBe(2))

  // Another Session lists only the agents still running or interrupted, each with its status.
  expect(nestedUnder("s-release")).toEqual(["Document the protocol"])
  expect(
    nav()
      ?.querySelector('a[href="/sessions/s-release?agent=a-docs"] [role="img"]')
      ?.getAttribute("aria-label"),
  ).toBe("Interrupted")
  // Only a row with agents has a chevron, open to start with, naming the list it controls.
  const chevron = button("Threads and agents of Release 0.4", nav() ?? document)
  expect(chevron.getAttribute("aria-expanded")).toBe("true")
  const controlled = document.getElementById(chevron.getAttribute("aria-controls") ?? "")
  expect(controlled?.querySelectorAll("a").length).toBe(1)
  // The Repos' ⋯ menus aside.
  expect(nav()?.querySelectorAll("button[aria-expanded]:not([aria-haspopup])").length).toBe(2)

  // The chevron folds them, and the fold is kept for this viewer.
  await step(() => chevron.click())
  expect(chevron.getAttribute("aria-expanded")).toBe("false")
  expect(nestedUnder("s-release")).toEqual([])
  expect(controlled?.hidden).toBe(true)
  expect(router.state.location.pathname).toBe("/sessions/s-readme")
  expect(JSON.parse(localStorage.getItem("kndl:sidebar-folded") ?? "[]")).toEqual(["s-release"])

  // A click on the row itself opens the Session and leaves the fold alone.
  await step(() => row("s-release").querySelector("a")?.click())
  await eventually(() => expect(router.state.location.pathname).toBe("/sessions/s-release"))
  expect(nestedUnder("s-release")).toEqual([])

  // Opened again, the chevron shows them: the open Session's finished agents too.
  await step(() => button("Threads and agents of Release 0.4", nav() ?? document).click())
  await eventually(() => expect(nestedUnder("s-release")).toEqual(releaseAgents))
  expect(JSON.parse(localStorage.getItem("kndl:sidebar-folded") ?? "[]")).toEqual([])
})

test("an agent's row opens its view, and is the current one", async () => {
  const { router, page } = await open("/sessions/s-release")
  await eventually(() => expect(nestedUnder("s-release")).toEqual(releaseAgents))
  expect(current()).toEqual(["Release 0.4"])

  const link = nav()?.querySelector<HTMLAnchorElement>(
    'a[href="/sessions/s-release?agent=a-changelog"]',
  )
  await step(() => link?.click())
  await eventually(() =>
    expect(router.state.location.search).toEqual({ agent: "a-changelog" } as never),
  )
  expect(current()).toEqual(["Write the 0.4 changelog"])
  await eventually(() => expect(page.querySelector("main h2")?.textContent).toContain("Done"))

  // Leaving for another Session, its finished agents fold away.
  await step(() => router.history.push("/sessions/s-readme"))
  await eventually(() => expect(nestedUnder("s-release")).toEqual(["Document the protocol"]))
})

test("a fold lasts across reloads, and opens when one of its agents' views opens", async () => {
  localStorage.setItem("kndl:sidebar-folded", JSON.stringify(["s-release"]))
  const { router } = await open("/sessions/s-readme")
  await eventually(() => expect(groups().length).toBe(2))
  expect(nestedUnder("s-release")).toEqual([])
  expect(
    button("Threads and agents of Release 0.4", nav() ?? document).getAttribute("aria-expanded"),
  ).toBe("false")

  // Opening an agent, as from its card in a transcript, opens its Session so it shows as current.
  await step(() => router.history.push("/sessions/s-release?agent=a-docs"))
  await eventually(() => expect(current()).toEqual(["Document the protocol"]))
  await eventually(() => expect(nestedUnder("s-release")).toEqual(releaseAgents))
  expect(localStorage.getItem("kndl:sidebar-folded")).toBe("[]")
})

test("the Sessions are one Tab stop: arrows move, ← → fold, and each row has a menu", async () => {
  await open("/sessions/s-readme")
  await eventually(() => expect(groups().length).toBe(2))
  const links = () =>
    [...(nav()?.querySelectorAll<HTMLAnchorElement>("li a[href^='/sessions/']") ?? [])].filter(
      (link) => link.closest("[hidden]") === null,
    )
  // One row takes Tab, the current one; the rest, their ⋯ and the chevrons, don't.
  await eventually(() =>
    expect(
      links()
        .filter((link) => link.tabIndex === 0)
        .map((link) => link.textContent),
    ).toEqual(["claude/readme-run"]),
  )
  expect(button("Threads and agents of Release 0.4", nav() ?? document).tabIndex).toBe(-1)
  expect(button("claude/readme-run actions", nav() ?? document).tabIndex).toBe(-1)

  // ↓ moves to the next row, and it becomes the one Tab enters at.
  const readme = row("s-readme").querySelector("a") as HTMLAnchorElement
  await step(() => readme.focus())
  await step(() => press(readme, "ArrowDown"))
  const next = document.activeElement as HTMLAnchorElement
  expect(next.textContent).toBe("claude/pi-harness")
  expect(next.tabIndex).toBe(0)
  expect(readme.tabIndex).toBe(-1)

  // ← on a row with agents folds them, → opens them again and then moves in.
  const release = row("s-release").querySelector("a") as HTMLAnchorElement
  const chevron = () => button("Threads and agents of Release 0.4", nav() ?? document)
  await step(() => release.focus())
  await step(() => press(release, "ArrowLeft"))
  expect(chevron().getAttribute("aria-expanded")).toBe("false")
  await step(() => press(release, "ArrowRight"))
  expect(chevron().getAttribute("aria-expanded")).toBe("true")
  await step(() => press(release, "ArrowRight"))
  expect((document.activeElement as HTMLElement).closest("ul[id]")).not.toBeNull()

  // Its ⋯ offers what the right-click does: Rename, Copy link, Delete Session for its Creator.
  await step(() => button("claude/readme-run actions", nav() ?? document).click())
  await eventually(() => expect(document.querySelector('[role="menu"]')).not.toBeNull())
  const items = [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent)
  expect(items).toEqual(expect.arrayContaining(["RenameF2", "Copy link", "Delete Session"]))
})

const thread = (id: string, at: number, running = false) => ({
  id: ThreadId.make(id),
  title: id,
  running,
  at,
})
const ids = (shown: ReadonlyArray<{ id: string }>) => shown.map((each) => each.id)

test("a Session's threads keep the order they were started in as they stream", async () => {
  const { recentThreads } = await import("../src/app/AppSidebar.tsx")
  const threads = [
    thread("a", 1),
    thread("b", 2, true),
    thread("c", 3),
    thread("d", 4),
    thread("e", 5),
    thread("f", 6, true),
  ]
  // Running ones stay among the others, rather than first; the three latest idle ones show.
  expect(ids(recentThreads(threads, undefined))).toEqual(["b", "c", "d", "e", "f"])
  // The open one shows, wherever it sits.
  expect(ids(recentThreads(threads, ThreadId.make("a")))).toEqual(["a", "b", "c", "d", "e", "f"])
  // Replying or finishing changes which show, never the order they are in.
  const replied = threads.map((each) => (each.id === "c" ? { ...each, running: true } : each))
  expect(ids(recentThreads(replied, undefined))).toEqual(["a", "b", "c", "d", "e", "f"])
  const finished = threads.map((each) => (each.id === "b" ? { ...each, running: false } : each))
  expect(ids(recentThreads(finished, undefined))).toEqual(["c", "d", "e", "f"])
})
