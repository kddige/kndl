// New Session against the fake Hub with its script not playing. A Session runs on its Creator's
// own setup token (ADR 0026): without one, it says so up front, leading to the Account page.

import { afterEach, expect, test } from "bun:test"
import { installDom } from "./dom.ts"
import { button, dialog as findDialog, render, settle, step } from "./render.ts"

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

/** Opens New Session as alice, who has stored a setup token unless `withToken` is false. */
async function openDialog(withToken = true) {
  const hub = new FakeHub({
    stepMs: 2,
    autoplay: false,
    ...(!withToken && { claudeCredential: null }),
  })
  return open(hub)
}

async function open(hub: InstanceType<typeof FakeHub>) {
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
  await settle(50)
  await step(() => button("New Session", document).click())
  await settle()
  const opened = findDialog() as HTMLElement
  return { dialog: opened, hub, router, start: button("Start Session", opened) }
}

/** Waits until `check` stops throwing, or fails with its last error. */
async function eventually(check: () => void, timeoutMs = 3_000): Promise<void> {
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

/** Types into the field labelled `label`, as a person does. */
async function type(dialog: HTMLElement, label: string, value: string) {
  const field = [...dialog.querySelectorAll("label")].find((each) => each.textContent === label)
  const input = dialog.querySelector(
    `input[id="${field?.getAttribute("for")}"]`,
  ) as HTMLInputElement
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await step(() => {
    input.focus()
    setValue?.call(input, value)
    // With an inputType, as typing has: Base UI opens the list for typing, not for autofill.
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
  })
  return input
}

const inputOf = (dialog: HTMLElement, label: string) =>
  dialog.querySelector(
    `input[id="${[...dialog.querySelectorAll("label")].find((each) => each.textContent === label)?.getAttribute("for")}"]`,
  ) as HTMLInputElement | null

test("needs your own setup token, and without one says so before the form is filled in", async () => {
  const withToken = await openDialog()
  expect(withToken.dialog.textContent).not.toContain("Add your setup token first")
  expect(withToken.start.disabled).toBe(false)
  await cleanup?.()

  const { dialog, router, start } = await openDialog(false)
  expect(dialog.textContent).toContain("Add your setup token first")
  expect(start.disabled).toBe(true)
  // Its link goes to the Account page, where the token is added.
  const account = [...dialog.querySelectorAll("a")].find((link) => link.textContent === "Account")
  await step(() => account?.click())
  await eventually(() => expect(router.state.location.pathname).toBe("/account"))
})

test("the Branch is disabled until a Repo is picked, then prefills the Repo's default branch", async () => {
  const { dialog } = await openDialog()
  expect(inputOf(dialog, "Branch")?.disabled).toBe(true)

  await type(dialog, "Repo", "kddige/kndl")
  await eventually(() => expect(inputOf(dialog, "Branch")?.value).toBe("main"))
  expect(inputOf(dialog, "Branch")?.disabled).toBe(false)

  // Another Repo resets it.
  await type(dialog, "Repo", "kddige/other")
  expect(inputOf(dialog, "Branch")?.value).toBe("")
  expect(inputOf(dialog, "Branch")?.disabled).toBe(true)
})

test("starts a Session directly on the branch when Work on a new branch is off, noting a branch GitHub doesn't list", async () => {
  const { dialog, hub, start } = await openDialog()
  await type(dialog, "Repo", "kddige/kndl")
  await eventually(() => expect(inputOf(dialog, "Branch")?.value).toBe("main"))
  expect(dialog.textContent).not.toContain("Branch not found on GitHub")
  // A branch not on GitHub's list is noted, without stopping.
  await type(dialog, "Branch", "nope")
  expect(dialog.textContent).toContain("Branch not found on GitHub. Pick one, or create it.")
  expect(start.disabled).toBe(false)
  await type(dialog, "Branch", "dev")
  const box = dialog.querySelector('input[type="checkbox"]') as HTMLElement
  await step(() => box.click())
  expect(dialog.textContent).toContain("Claude commits directly to dev.")
  await step(() => start.click())
  await settle(100)

  const sent = hub.received.find((message) => message["_tag"] === "CreateSession")
  expect(sent).toMatchObject({
    repo: "kddige/kndl",
    branch: { _tag: "Existing", name: "dev", newWorkBranch: false },
  })
})

test("offers to create a branch that is none of the Repo's, from one of them", async () => {
  const { dialog, hub, start } = await openDialog()
  await type(dialog, "Repo", "kddige/kndl")
  await eventually(() => expect(inputOf(dialog, "Branch")?.value).toBe("main"))
  await type(dialog, "Branch", "feature/health")
  await eventually(() => expect(document.querySelector('[role="option"]')).not.toBeNull())
  const create = [...document.querySelectorAll('[role="option"]')].find((option) =>
    option.textContent?.includes("Create branch 'feature/health'"),
  ) as HTMLElement
  await step(() => create.click())
  expect(inputOf(dialog, "From")?.value).toBe("main")
  // A new branch is its own Work branch: there is nothing to choose.
  expect(dialog.querySelector('[role="checkbox"]')).toBeNull()

  await type(dialog, "From", "nowhere")
  expect(dialog.textContent).toContain("Pick one of the Repo's branches.")
  await type(dialog, "From", "dev")
  await step(() => start.click())
  await settle(100)
  expect(hub.received.find((message) => message["_tag"] === "CreateSession")).toMatchObject({
    branch: { _tag: "Create", name: "feature/health", from: "dev" },
  })
})

test("without the GitHub App, suggests from Sessions, says so, offers no retry, and never blocks", async () => {
  const hub = new FakeHub({ stepMs: 2, autoplay: false })
  hub.listingDown = true
  const { dialog, start } = await open(hub)
  await eventually(() => expect(dialog.textContent).toContain("Couldn't load the Repos"))
  expect(dialog.textContent).not.toContain("Retry")
  await type(dialog, "Repo", "kddige/kndl")
  await eventually(() => expect(dialog.textContent).toContain("Couldn't load the branches"))
  // The branch is taken as existing: the usual default, and no Create entry to offer.
  await eventually(() => expect(inputOf(dialog, "Branch")?.value).toBe("main"))
  await type(dialog, "Branch", "whatever")
  expect(document.querySelector('[role="option"]')).toBeNull()
  expect(start.disabled).toBe(false)
})

test("when GitHub can't answer, says so and offers a retry that asks again", async () => {
  const hub = new FakeHub({ stepMs: 2, autoplay: false })
  hub.listingFails = true
  const { dialog } = await open(hub)
  await eventually(() =>
    expect(dialog.textContent).toContain("Could not list your Repos; try again."),
  )
  hub.listingFails = false
  await step(() => button("Retry", dialog).click())
  await eventually(() => expect(dialog.textContent).not.toContain("Couldn't load the Repos"))
})

test("warns when sessions are already on the branch it would commit to", async () => {
  const hub = new FakeHub({ stepMs: 2, autoplay: false })
  // One of kddige/kndl's Active Sessions works on main itself.
  const session = [...hub.sessions.values()].find(
    ({ summary }) => summary.repo === "kddige/kndl" && summary.state === "Active",
  )
  if (session) session.summary = { ...session.summary, workBranch: "main" }
  const { dialog } = await open(hub)
  await type(dialog, "Repo", "kddige/kndl")
  await eventually(() => expect(inputOf(dialog, "Branch")?.value).toBe("main"))
  await step(() => (dialog.querySelector('input[type="checkbox"]') as HTMLElement).click())
  expect(dialog.textContent).toMatch(/\d+ active Sessions? (is|are) already on main/)
})

test("suggests the Repos from the Hub, with the person's own Sessions' Repos on top", async () => {
  const { dialog } = await openDialog()
  await type(dialog, "Repo", "kddige/")
  await eventually(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull())
  const listbox = document.querySelector('[role="listbox"]') as HTMLElement
  expect(listbox.textContent).toContain("Recent")
  expect(listbox.textContent).toContain("kddige/kndl")
  // Narrowed in the browser by what is typed.
  expect(listbox.textContent).not.toContain("someone-else")
})

test("carries the whole branch choice through the Environment setup of a Repo's first Session", async () => {
  const { dialog, router, start } = await openDialog()
  await type(dialog, "Repo", "acme/fresh")
  await eventually(() => expect(inputOf(dialog, "Branch")?.value).toBe("main"))
  await step(() => (dialog.querySelector('input[type="checkbox"]') as HTMLElement).click())
  await step(() => start.click())
  await eventually(() =>
    expect(router.state.location.pathname).toBe("/repos/acme/fresh/environment"),
  )
  expect(router.state.location.search).toMatchObject({ branch: "main", direct: true })
  await eventually(() => expect(document.body.textContent).toContain("Your Session on main"))
})

test("says why a branch's name can't be used, existing or new, and sends nothing", async () => {
  const { dialog, hub, start } = await openDialog()
  await type(dialog, "Repo", "kddige/kndl")
  await eventually(() => expect(inputOf(dialog, "Branch")?.value).toBe("main"))
  await type(dialog, "Branch", "feature..x")
  expect(dialog.textContent).toContain("A branch name can't have two dots in a row.")
  await step(() => start.click())
  await settle(100)
  expect(hub.received.map((message) => message["_tag"])).not.toContain("CreateSession")
  expect(hub.received.map((message) => message["_tag"])).not.toContain("GetEnvironment")

  // A new branch is checked too, here against the names kndl keeps for itself.
  await type(dialog, "Branch", "claude/mine")
  await eventually(() => expect(document.querySelector('[role="option"]')).not.toBeNull())
  const create = [...document.querySelectorAll('[role="option"]')].find((option) =>
    option.textContent?.includes("Create branch"),
  ) as HTMLElement
  await step(() => create.click())
  expect(dialog.textContent).toContain("Names under claude/ are for the Work branches kndl makes.")
})

test("leaves a branch git would refuse out of the Environment setup's search", async () => {
  const { router } = await openDialog()
  await step(() =>
    router.navigate({ href: "/repos/acme/fresh/environment?branch=a%20b&from=main" }),
  )
  await eventually(() =>
    expect(router.state.location.pathname).toBe("/repos/acme/fresh/environment"),
  )
  // As if it had no branch: no Session is waiting on the setup.
  await settle(100)
  expect(document.body.textContent).not.toContain("starts once it's applied")
})
