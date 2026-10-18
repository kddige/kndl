// The Hub page and its banner (ADR 0028) against the fake Hub: the Owner of a Hub behind a Release
// sees the banner and the notes, dismisses the banner until a newer update, and checks now; a
// Member, and a Hub that doesn't check, have neither. The Owner updates the Hub from it, follows
// the update across the Hub's restart, and picks its Channel (#362).

import { afterEach, expect, test } from "bun:test"
import { installDom } from "./dom.ts"
import { button, dialog, render, settle, step } from "./render.ts"

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

/** Settings' Updates row, which leads to the Hub page; it may say "New" after its name. */
const hubLink = () =>
  [...document.querySelectorAll("nav a")].find((a) => a.textContent?.trim().startsWith("Updates"))
const banner = () =>
  [...document.querySelectorAll("[data-banner]")].find((el) => el.textContent?.includes("is out"))
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

  await step(() => void router.navigate({ to: "/hub" }))
  await eventually(() => expect(heading()).toBe("Updates"))
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
  // In Settings, its Updates row leads here and is marked current.
  expect(hubLink()?.getAttribute("href")).toBe("/hub")
  expect(hubLink()?.getAttribute("aria-current")).toBe("page")
  // The page says it all: no banner on it.
  expect(banner()).toBeUndefined()
})

test("a dismissed banner stays away until the check finds a newer update", async () => {
  await open("/")
  await eventually(() => expect(banner()).toBeDefined())
  await step(() => button("Dismiss update notice").click())
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
  await eventually(() => expect(heading()).toBe("Updates"))
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
  await eventually(() => expect(heading()).toBe("Updates"))
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

// ── Updating the Hub (#362) ────────────────────────────────────────────────

const main = () => document.querySelector("main")?.textContent ?? ""
const latest = () =>
  [...document.querySelectorAll("main section")].find(
    (section) => section.querySelector("h2")?.textContent === "Latest update",
  )?.textContent ?? ""
const restartingBanner = () =>
  [...document.querySelectorAll("[data-banner]")].find((el) =>
    el.textContent?.includes("Updating the Hub"),
  )

test("the Owner updates the Hub: its steps, Hub restarting while it's down, then Updated to", async () => {
  const { hub } = await open("/hub")
  await eventually(() => expect(heading()).toBe("Updates"))
  hub.hold()
  await step(() => button("Update").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Update the Hub?"))
  expect(dialog()?.textContent).toContain("It moves to kndl 2026.10.4")
  // studio has a Session: Update now is there too, to stop its Turns at once.
  expect(button("Update now", dialog() ?? document)).toBeTruthy()
  await step(() => button("Update", dialog() ?? document).click())
  expect(hub.received.find((m) => m._tag === "UpdateHub")).toMatchObject({ now: false })
  await eventually(() => expect(latest()).toContain("Starting the update…"))

  for (const label of ["Starting", "Fetching", "Checking out"]) {
    await hub.step()
    await eventually(() => expect(latest()).toContain(`Updating… ${label}`))
  }
  // While one runs, nothing offers another.
  expect(
    [...document.querySelectorAll("main button")].some((b) => b.textContent === "Update"),
  ).toBe(false)
  for (let i = 0; i < 3; i++) await hub.step()
  await eventually(() => expect(latest()).toContain("Updating… Restarting the Hub"))

  // The Hub goes down under it, and the page says why.
  await hub.step()
  await eventually(() => expect(latest()).toContain("Updating… Hub restarting"))
  expect(restartingBanner()?.textContent).toContain("Updating the Hub…")

  // Back on the new version, it says how it ended.
  hub.resume()
  await eventually(() => expect(latest()).toContain("Updated to 2026.10.4"))
  expect(latest()).toContain("from this page")
  expect(main()).toContain("2026.10.4 (777777777777)")
  expect(main()).toContain("kndl is up to date")
  expect(restartingBanner()).toBeUndefined()
})

test("an update that failed shows it rolled back, with its error and the end of its log", async () => {
  await open("/hub", { hubUpdateOutcome: "RolledBack" })
  await eventually(() => expect(heading()).toBe("Updates"))
  await step(() => button("Update").click())
  await eventually(() => expect(dialog()).not.toBeNull())
  await step(() => button("Update", dialog() ?? document).click())
  await eventually(() => expect(latest()).toContain("Update rolled back"), 10_000)
  expect(latest()).toContain("The Hub went back to the commit it ran")
  expect(document.querySelector('main [role="alert"]')?.textContent).toContain(
    "Building the web UI failed",
  )
  const log = document.querySelector('[aria-label="The end of the update\'s log"]')
  expect(log?.textContent).toContain("error: vite exited with 1")
  // Still on the version it ran, with the update still offered.
  expect(main()).toContain("2026.10.2 (824de4a1f0c3)")
  expect(button("Update")).toBeTruthy()
})

test("an update started at a terminal shows too, and offers no second one while it runs", async () => {
  await open("/hub", {
    hubUpdateRun: {
      status: {
        id: "cli-1",
        source: "cli",
        startedAt: Date.now() - 30_000,
        from: { commit: stableHubVersion.commit, version: "2026.10.2" },
        target: { ref: "v2026.10.4" },
        step: "Installing dependencies",
        state: "Running",
      },
    },
  })
  await eventually(() => expect(latest()).toContain("Updating… Installing dependencies"))
  expect(latest()).toContain("with kndl update on the Hub's machine")
  expect(
    [...document.querySelectorAll("main button")].some((b) => b.textContent === "Update"),
  ).toBe(false)
  expect(button("Switch to dev").disabled).toBe(true)
})

test("once the Hub moved, Update now stops the Turns its Runners wait for", async () => {
  const { hub } = await open("/hub", {
    hubUpdateRun: {
      status: {
        id: "u-1",
        source: "hub",
        startedAt: Date.now() - 60_000,
        finishedAt: Date.now() - 10_000,
        from: { commit: "a".repeat(40) },
        target: { ref: "v2026.10.2", commit: stableHubVersion.commit },
        step: "Checking the Hub's health",
        state: "Succeeded",
      },
    },
  })
  await eventually(() => expect(latest()).toContain("Updated to 2026.10.2"))
  const since = Date.now()
  await step(() =>
    hub.patchRunner("r-studio", {
      versionStatus: "Behind",
      update: {
        _tag: "Draining",
        target: stableHubVersion,
        since,
        deadline: since + 600_000,
        now: false,
        waitingFor: 1,
      },
    }),
  )
  await eventually(() => expect(latest()).toContain("studio waits for its running Turns to end"))
  await step(() => button("Update now").click())
  await eventually(() =>
    expect(dialog()?.textContent).toContain("Stop the Runners' running Turns?"),
  )
  await step(() => button("Stop Turns and update").click())
  await eventually(() =>
    expect(hub.received.find((m) => m._tag === "UpdateRunner")).toMatchObject({
      runnerId: "r-studio",
      now: true,
    }),
  )
})

test("moving from dev to stable records the Channel, and the Hub stays on its commit", async () => {
  const { hub } = await open("/hub", {
    hubVersion: { commit: "a".repeat(40), branch: "main", channel: "dev" },
    hubUpdate: {
      follows: { _tag: "Channel", channel: "dev" },
      checked: { at: Date.now(), found: { _tag: "UpToDate" } },
    },
  })
  await eventually(() => expect(heading()).toBe("Updates"))
  await step(() => button("Switch to stable").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Follow stable?"))
  expect(dialog()?.textContent).toContain("stays on this commit until a newer Release is out")
  await step(() => button("Follow stable").click())
  expect(hub.received.find((m) => m._tag === "UpdateHub")).toMatchObject({
    now: false,
    channel: "stable",
  })
  await eventually(() =>
    expect(main()).toContain("On stable. You'll move at the next Release newer than this commit."),
  )
  expect(latest()).toContain("Nothing to move to")
  expect(button("Switch to dev")).toBeTruthy()
})

test("on a pinned Hub, picking a Channel unpins it, once that's confirmed", async () => {
  const { hub } = await open("/hub", {
    hubVersion: { commit: "a".repeat(40), branch: "fix-login" },
    hubUpdate: { follows: { _tag: "Pinned", ref: "fix-login" } },
  })
  await eventually(() => expect(main()).toContain("Pinned to fix-login"))
  await step(() => button("Follow dev").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Unpin the Hub, and follow dev?"))
  expect(dialog()?.textContent).toContain("The Hub leaves fix-login")
  await step(() => button("Cancel").click())
  expect(hub.received.some((m) => m._tag === "UpdateHub")).toBe(false)

  await settle()
  await step(() => button("Follow dev").click())
  await eventually(() => expect(dialog()).not.toBeNull())
  await step(() => button("Unpin and follow dev").click())
  expect(hub.received.find((m) => m._tag === "UpdateHub")).toMatchObject({ channel: "dev" })
})
