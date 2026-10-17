// The Hub page and its banner (ADR 0028) against the fake Hub: the Owner of a Hub behind a Release
// sees the banner and the notes, dismisses the banner until a newer update, and checks now; a
// Member, and a Hub that doesn't check, have neither.

import { afterEach, expect, test } from "bun:test"
import { installDom } from "./dom.ts"
import { button, render, settle, step } from "./render.ts"

let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  localStorage.clear()
})

// Loaded after installDom() and the StyleX compiler, so components see the DOM and compile.
const { createMemoryHistory, RouterProvider } = await import("@tanstack/react-router")
const { HubProvider } = await import("../src/app/hub.tsx")
const { HubClient } = await import("../src/hub/client.ts")
const { FakeHub } = await import("../src/hub/fake/FakeHub.ts")
const { seedHubUpdate, stableHubVersion } = await import("../src/hub/fake/script.ts")
const { createAppRouter } = await import("../src/router.tsx")

type Options = NonNullable<ConstructorParameters<typeof FakeHub>[0]>

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

const hubLink = () =>
  [...document.querySelectorAll("a")].find((a) => a.textContent?.trim() === "Hub")
const banner = () =>
  [...document.querySelectorAll('[role="status"]')].find((el) => el.textContent?.includes("is out"))
const heading = () => document.querySelector("h1")?.textContent

async function open(at: string, options: Options = {}) {
  const hub = new FakeHub({
    stepMs: 2,
    autoplay: false,
    hubVersion: stableHubVersion,
    hubUpdate: seedHubUpdate(),
    ...options,
  })
  const client = new HubClient(hub, { retryDelay: () => 1 })
  const router = createAppRouter(createMemoryHistory({ initialEntries: [at] }))
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
  return { hub, router }
}

test("the Owner of a Hub behind a Release sees the banner, and the notes on the Hub page", async () => {
  const { router } = await open("/")
  await eventually(() => expect(banner()?.textContent).toContain("kndl 2026.10.4 is out"))
  expect(banner()?.textContent).toContain("This Hub runs 2026.10.2, 2 Releases behind.")
  expect(hubLink()?.getAttribute("href")).toBe("/hub")

  await step(() => void router.navigate({ to: "/hub" }))
  await eventually(() => expect(heading()).toBe("Hub"))
  const page = document.querySelector("main")?.textContent ?? ""
  expect(page).toContain("2026.10.2 (824de4a1f0c3)")
  expect(page).toContain("stable")
  expect(page).toContain("Last checked1h ago")
  expect(page).toContain("kndl 2026.10.4 is out")
  // Each newer Release, newest first, its notes rendered with their Highlights first.
  const releases = [...document.querySelectorAll("article")].map((a) =>
    a.getAttribute("aria-label"),
  )
  expect(releases).toEqual(["2026.10.4", "2026.10.3"])
  expect(document.querySelector("article h4")?.textContent).toBe("Highlights")
  expect(page).toContain("Archived Sessions show the disk they take.")
  const compare = [...document.querySelectorAll("a")].find((a) =>
    a.textContent?.includes("Compare on GitHub"),
  )
  expect(compare?.getAttribute("href")).toBe(
    "https://github.com/kddige/kndl/compare/v2026.10.2...v2026.10.4",
  )
  expect(hubLink()?.getAttribute("aria-current")).toBe("page")
  // The page says it all: no banner on it.
  expect(banner()).toBeUndefined()
})

test("a dismissed banner stays away until the check finds a newer update", async () => {
  await open("/")
  await eventually(() => expect(banner()).toBeDefined())
  await step(() => button("Dismiss").click())
  await eventually(() => expect(banner()).toBeUndefined())

  // Reloaded, it stays dismissed: the dismissal is kept in the browser.
  await cleanup?.()
  const reopened = await open("/")
  await settle(50)
  expect(banner()).toBeUndefined()

  // A newer Release brings it back.
  const update = seedHubUpdate()
  const found = update.checked?.found
  if (found?._tag !== "NewerRelease") throw new Error("the seed has a newer Release")
  const [newest] = found.releases
  reopened.hub.setHubUpdate({
    ...update,
    checked: {
      at: Date.now(),
      found: { ...found, releases: [{ ...newest, version: "2026.10.5" }, ...found.releases] },
    },
  })
  await eventually(() => expect(banner()?.textContent).toContain("kndl 2026.10.5 is out"))
})

test("Check now asks the Hub, and shows when it checked", async () => {
  const { hub } = await open("/hub")
  await eventually(() => expect(heading()).toBe("Hub"))
  await step(() => button("Check now").click())
  await eventually(() =>
    expect(document.querySelector("main")?.textContent).toContain("Last checkedjust now"),
  )
  expect(hub.received.some((message) => message._tag === "CheckHubUpdate")).toBe(true)
})

test("on dev, lists the titles of main's new commits", async () => {
  const head = "f".repeat(40)
  await open("/hub", {
    hubVersion: { commit: "a".repeat(40), branch: "main", channel: "dev" },
    hubUpdate: {
      follows: { _tag: "Channel", channel: "dev" },
      checked: {
        at: Date.now(),
        found: {
          _tag: "NewerCommits",
          head,
          behindBy: 52,
          commits: [
            { commit: head, title: "web: the Hub page (#361)" },
            { commit: "e".repeat(40), title: "cli: a lock for kndl update (#360)" },
          ],
          compareUrl: `https://github.com/kddige/kndl/compare/${"a".repeat(40)}...${head}`,
        },
      },
    },
  })
  await eventually(() => expect(heading()).toBe("Hub"))
  const page = document.querySelector("main")?.textContent ?? ""
  expect(page).toContain("aaaaaaaaaaaa")
  expect(page).toContain("main is 52 commits ahead")
  const commits = document.querySelector('[aria-label="Commits since this Hub\'s"]')
  expect(commits?.querySelectorAll("li")).toHaveLength(2)
  expect(commits?.textContent).toContain("web: the Hub page (#361)")
  expect(page).toContain("And 50 more on GitHub.")
})

test("a Member has no Hub page, no nav item and no banner", async () => {
  await open("/hub", { owner: false })
  await eventually(() =>
    expect(document.querySelector("main")?.textContent).toContain(
      "Only the Hub's Owner sees this page",
    ),
  )
  expect(hubLink()).toBeUndefined()
  expect(banner()).toBeUndefined()
})

test("a Hub that doesn't check, as one run from a checkout, has no Hub page", async () => {
  await open("/hub", { hubUpdate: null })
  await eventually(() =>
    expect(document.querySelector("main")?.textContent).toContain(
      "This Hub doesn't check for updates",
    ),
  )
  expect(hubLink()).toBeUndefined()
  expect(banner()).toBeUndefined()
})
