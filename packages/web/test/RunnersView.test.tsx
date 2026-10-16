// The Runners page against the fake Hub: the paired Runners, adding one with a Pairing code the
// fake then redeems, Re-pairing after a confirmation, and removing, refused while a Runner has
// Sessions that aren't Archived.

import { afterEach, expect, test } from "bun:test"
import { installDom } from "./dom.ts"
import { button, dialog, render, settle, step } from "./render.ts"

let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())
// Each test renders the app afresh, so the one before is taken down first.
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

const runners = () => document.querySelector('[aria-label="Runners"]')
const ciBox = () => runners()?.querySelector('[aria-label="ci-box"]')?.textContent ?? ""

async function openRunners() {
  const hub = new FakeHub({ stepMs: 2, autoplay: false })
  const client = new HubClient(hub, { retryDelay: () => 1 })
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/runners"] }))
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
  await eventually(() => expect(runners()?.querySelectorAll("li").length).toBe(2))
  return { hub, page: view.container }
}

test("lists each Runner with its version, last connection and Sessions, and no credential of its own", async () => {
  const { page } = await openRunners()
  expect(page.querySelector("h1")?.textContent).toBe("Runners")
  const [studio, ci] = [...(runners()?.querySelectorAll("li") ?? [])].map((li) => li.textContent)
  expect(studio).toContain("studio")
  expect(studio).toContain("online")
  // Sessions run on their Creators' setup tokens, not the Runner's (ADR 0026).
  expect(studio).not.toContain("Claude")
  expect(studio).toContain("824de4a1f0c3 (main)")
  expect(studio).toContain("4 Sessions")
  expect(ci).toContain("offline")
  expect(ci).toContain("behind the Hub")
  expect(ci).toContain("Last seen 3h ago")
  expect(ci).toContain("1 Session")
  // Each marks its Sessions kept awake (ADR 0016).
  expect(studio).toContain("1 kept awake")
  expect(ci).toContain("1 kept awake")
  // The sidebar's general nav marks the page.
  expect(document.querySelector('a[aria-current="page"]')?.textContent).toContain("Runners")
})

const studioBox = () => runners()?.querySelector('[aria-label="studio"]')?.textContent ?? ""
const monitorOf = (name: string) =>
  runners()?.querySelector<HTMLElement>(`section[aria-label="${name}'s monitor"]`) ?? null
const historyAsked = (hub: InstanceType<typeof FakeHub>) =>
  hub.received.filter((m) => m._tag === "GetRunnerHistory")

/** Opens a Runner's Monitor, and waits for the history it asks for to be charted. */
async function openMonitor(name: string) {
  await step(() => button(`Monitor ${name}`).click())
  await eventually(() =>
    expect(
      monitorOf(name)?.querySelector('[aria-label^="Free disk over the last 7 days"]') ?? null,
    ).not.toBeNull(),
  )
  return monitorOf(name) as HTMLElement
}

test("keeps a Runner's row to itself, its host behind a Monitor that is closed and asks nothing (#356)", async () => {
  const { hub } = await openRunners()
  expect(button("Monitor studio").getAttribute("aria-expanded")).toBe("false")
  expect(monitorOf("studio")).toBeNull()
  expect(studioBox()).not.toContain("free of")
  expect(studioBox()).not.toContain("GiB")
  await settle()
  expect(historyAsked(hub)).toEqual([])
})

test("opens a Runner's Monitor: its host as tiles, and charts of its last week, then closes it (#356)", async () => {
  const { hub } = await openRunners()
  const monitor = await openMonitor("studio")
  expect(button("Monitor studio").getAttribute("aria-expanded")).toBe("true")
  expect(button("Monitor studio").getAttribute("aria-controls")).toBe(monitor.id)
  const host = monitor.textContent ?? ""
  expect(host).toContain("Free disk186 GiBof 500 GiB (37%)")
  expect(host).toContain("Available memory19 GiBof 32 GiB (59%)")
  expect(host).toContain("Load, 1 minute1.42on 10 cores5 min 1.18 · 15 min 0.96")
  expect(host).toContain("Up12d 5hlinux arm64")
  expect(host).toMatch(/As of \d+s ago/)
  expect(host).not.toContain("Low:")
  expect(historyAsked(hub)).toMatchObject([{ runnerId: "r-studio" }])
  // A chart each for disk, with the low-disk line, memory and load, named by what it shows.
  for (const title of ["Free disk", "Available memory", "Load, 1 minute"]) {
    expect(
      monitor.querySelector(`[aria-label^="${title} over the last 7 days: from "]`),
    ).not.toBeNull()
  }
  expect(host).toContain("Low disk, under 50 GiB")

  await step(() => button("Monitor studio").click())
  expect(monitorOf("studio")).toBeNull()
  expect(button("Monitor studio").getAttribute("aria-expanded")).toBe("false")
})

test("warns of a low disk in the row, under 10 GiB free or a tenth of it, and greys the host of a Runner that is offline", async () => {
  const { hub } = await openRunners()
  // ci-box is offline, and was nearly full when last heard from.
  expect(ciBox()).toContain("low disk")
  const monitor = await openMonitor("ci-box")
  expect(monitor.textContent).toContain("Offline, as of 3h ago")
  expect(monitor.textContent).toContain("8.0 GiBof 120 GiB (7%)")
  expect(monitor.textContent).toContain("Low: under 12 GiB")
  expect(monitor.querySelector("[data-offline]")).not.toBeNull()
  expect(studioBox()).not.toContain("low disk")

  const GiB = 1024 ** 3
  const studio = hub.runners.find((runner) => runner.id === "r-studio")
  const sysinfo = studio?.sysinfo
  if (sysinfo === undefined) throw new Error("the fake Runner has no sysinfo")
  // Over 10 GiB, but under a tenth of a 500 GiB disk.
  await step(() =>
    hub.patchRunner("r-studio", { sysinfo: { ...sysinfo, diskFreeBytes: 49 * GiB } }),
  )
  await eventually(() => expect(studioBox()).toContain("low disk"))
  await step(() =>
    hub.patchRunner("r-studio", { sysinfo: { ...sysinfo, diskFreeBytes: 51 * GiB } }),
  )
  await eventually(() => expect(studioBox()).not.toContain("low disk"))
})

test("opens the Monitor of a Runner that sent no sysinfo with a note in place of its tiles", async () => {
  const { hub } = await openRunners()
  await step(() => {
    hub.runners = hub.runners.map(({ sysinfo: _sampled, ...runner }) => runner)
    hub.patchRunner("r-ci", { isOnline: true })
  })
  await eventually(() => expect(ciBox()).toContain("online"))
  expect(ciBox()).not.toContain("low disk")
  await step(() => button("Monitor ci-box").click())
  await eventually(() =>
    expect(monitorOf("ci-box")?.textContent).toContain("Not enough history yet"),
  )
  expect(monitorOf("ci-box")?.textContent).toContain("It hasn't sent a sample of its host")
})

test("shows a Runner on a Release by its Release, before its commit (ADR 0025)", async () => {
  const { hub } = await openRunners()
  const commit = "5d2b9e07c41a8f3362e0d9b7a1c4f58e2b6d0a93"
  await step(() => hub.patchRunner("r-ci", { version: { commit, release: "2026.10.1" } }))
  await eventually(() => expect(ciBox()).toContain("2026.10.1 (5d2b9e07c41a)"))
})

test("adds a Runner: shows the join command, then the Runner once the code is used", async () => {
  const { hub } = await openRunners()
  await step(() => button("Add a Runner").click())
  await eventually(() =>
    expect(document.querySelector('[aria-label="Pairing command"]')?.textContent).toMatch(
      /^kndl runner join 'http:\/\/[^#]+#[0-9A-Z]{5}(-[0-9A-Z]{5}){3}'$/,
    ),
  )
  expect(hub.received.filter((m) => m._tag === "CreatePairingCode")).toHaveLength(1)
  // The code waits on the page, without the code itself, so it can be revoked.
  await eventually(() =>
    expect(
      document.querySelector('[aria-label="Pairing codes not used yet"]')?.textContent,
    ).toContain("A new Runner"),
  )

  await step(() => hub.redeemPairingCode("mac-mini"))
  await eventually(() => expect(dialog()?.textContent).toContain("Paired mac-mini"))
  expect(dialog()?.textContent).toContain("mac-mini is online.")
  await step(() => button("Done").click())
  await eventually(() => expect(runners()?.textContent).toContain("mac-mini"))
  expect(document.querySelector('[aria-label="Pairing codes not used yet"]')).toBeNull()
})

test("Re-pairs a Runner only once that's confirmed", async () => {
  const { hub } = await openRunners()
  await step(() => button("Re-pair studio").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Re-pair studio"))
  expect(dialog()?.textContent).toContain("its current token stops working")
  expect(hub.received.some((m) => m._tag === "CreatePairingCode")).toBe(false)

  await step(() => button("Make a pairing code").click())
  await eventually(() =>
    expect(document.querySelector('[aria-label="Pairing command"]')).not.toBeNull(),
  )
  expect(hub.received.find((m) => m._tag === "CreatePairingCode")).toMatchObject({
    runnerId: "r-studio",
  })
  await eventually(() =>
    expect(
      document.querySelector('[aria-label="Pairing codes not used yet"]')?.textContent,
    ).toContain("Re-pair studio"),
  )
})

test("refuses to remove a Runner with open Sessions, and removes one without", async () => {
  const { hub } = await openRunners()
  await step(() => button("Remove studio").click())
  await eventually(() => expect(dialog()?.textContent).toContain("studio can't be removed yet"))
  expect(dialog()?.textContent).toContain("Archive them first")
  expect(hub.received.some((m) => m._tag === "RemoveRunner")).toBe(false)
  await step(() => button("OK").click())
  await settle()

  await step(() => button("Add a Runner").click())
  await eventually(() =>
    expect(document.querySelector('[aria-label="Pairing command"]')).not.toBeNull(),
  )
  await step(() => hub.redeemPairingCode("spare"))
  await step(() => button("Done").click())
  await eventually(() => expect(runners()?.querySelectorAll("li").length).toBe(3))
  await settle()

  await step(() => button("Remove spare").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Remove spare?"))
  await step(() => button("Remove").click())
  await eventually(() => expect(runners()?.textContent).not.toContain("spare"))
  expect(hub.received.find((m) => m._tag === "RemoveRunner")).toMatchObject({
    runnerId: expect.any(String),
  })
})

test("updates a Runner behind the Hub, following the update to the Hub's commit", async () => {
  const { hub } = await openRunners()
  await step(() => hub.patchRunner("r-ci", { isOnline: true }))
  await eventually(() => expect(button("Update ci-box")).toBeTruthy())
  await step(() => button("Update ci-box").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Update ci-box?"))
  expect(dialog()?.textContent).toContain("824de4a1f0c3, the Hub's commit")
  // It has a Session: Update now is there too, to stop its Turns at once.
  expect(button("Update now")).toBeTruthy()
  await step(() => button("Update").click())
  expect(hub.received.find((m) => m._tag === "UpdateRunner")).toMatchObject({
    runnerId: "r-ci",
    now: false,
  })
  await eventually(() => expect(ciBox()).toContain("updating"))
  await eventually(() => expect(ciBox()).toContain("824de4a1f0c3 (main)"), 10_000)
  expect(ciBox()).not.toContain("behind the Hub")
  expect(ciBox()).not.toContain("updating")
})

test("shows a refused or failed update, and offers nothing to a Runner updated by hand", async () => {
  const { hub } = await openRunners()
  const target = { commit: "824de4a1f0c3b6e2d9a7c5b48e1f02a3c6d7e9b1", branch: "main" }
  await step(() =>
    hub.patchRunner("r-ci", {
      isOnline: true,
      update: {
        _tag: "Refused",
        target,
        at: Date.now(),
        refusal: { reason: "NotOnMain", message: "824de4a1f0c3 isn't on origin/main." },
      },
    }),
  )
  await eventually(() => expect(ciBox()).toContain("refuses: not on main"))
  expect(ciBox()).toContain("isn't on origin/main")

  await step(() =>
    hub.patchRunner("r-ci", {
      update: {
        _tag: "Failed",
        failure: {
          target,
          message:
            "Updating to 824de4a1f0c3 failed while installing and building. It went back to the commit it ran.",
          rolledBack: true,
          at: Date.now(),
        },
      },
    }),
  )
  await eventually(() => expect(ciBox()).toContain("update failed"))
  expect(ciBox()).toContain("It went back to the commit it ran.")

  await step(() =>
    hub.patchRunner("r-ci", {
      updater: { self: false, reason: "it runs from a developer's checkout" },
    }),
  )
  await settle()
  expect(document.querySelector('[aria-label="Update ci-box"]')).toBeNull()
})
