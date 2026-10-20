// The Account page against the fake Hub: pasting a Claude setup token, which the fake checks as the
// Hub does, seeing it write-only once saved, and removing it (ADR 0015, ADR 0026); and listing and
// revoking the CLI tokens `kndl login` made (issue #179); and connecting Providers, by a sign-in or
// an API key, and disconnecting them (ADR 0029). Every secret is made up.

import { afterEach, expect, test } from "bun:test"
import { act } from "react"
import { installDom } from "./dom.ts"
import { button, dialog, menuItem, render, settle, step } from "./render.ts"

let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

const { createMemoryHistory, RouterProvider } = await import("@tanstack/react-router")
const { HubProvider } = await import("../src/app/hub.tsx")
const { HubClient } = await import("../src/hub/client.ts")
const { FakeHub } = await import("../src/hub/fake/FakeHub.ts")
const { createAppRouter } = await import("../src/router.tsx")

const fakeKey = "sk-ant-api03-FAKE_KEY_FOR_TESTS_ONLY_a1b2"
const fakeToken = "sk-ant-oat01-FAKE_TOKEN_FOR_TESTS_ONLY_c3d4"

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

function typeInto(field: HTMLInputElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setValue?.call(field, value)
  field.dispatchEvent(new Event("input", { bubbles: true }))
}

/** Anthropic's row: the saved Claude credential, or the line to add one. */
const section = () => document.querySelector<HTMLElement>('li[aria-label="Anthropic"]')
const secretField = () => section()?.querySelector('input[type="password"]') as HTMLInputElement
const saved = () =>
  document.querySelector('ul[aria-label="Connected providers"] > li[aria-label="Anthropic"]')
const alert = () => section()?.querySelector('[role="alert"]')?.textContent ?? ""
/** Opens the form for a setup token, on Anthropic's line. */
const addSetupToken = async () => {
  await eventually(() => expect(section()).not.toBeNull())
  await step(() => button("Add setup token", section() as HTMLElement).click())
}
/** The section headed `title`. */
const sectionTitled = (title: string) =>
  [...document.querySelectorAll("main section")].find(
    (each) => each.querySelector("h2")?.textContent === title,
  )

/** The fake Hub the page last opened on. */
let opened: InstanceType<typeof FakeHub> | undefined
const fakeHub = () => opened as InstanceType<typeof FakeHub>

async function openAccount(options: ConstructorParameters<typeof FakeHub>[0] = {}) {
  const hub = new FakeHub({ stepMs: 2, autoplay: false, claudeCredential: null, ...options })
  opened = hub
  const client = new HubClient(hub, { retryDelay: () => 1 })
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/account"] }))
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
  await eventually(() => expect(section()).not.toBeNull())
  return { hub, page: view.container }
}

test("saves a pasted setup token, with no plan to pick, then shows it write-only", async () => {
  const { page } = await openAccount()
  expect(page.querySelector("h1")?.textContent).toBe("Account")
  await addSetupToken()
  await eventually(() => expect(secretField()).not.toBeNull())
  expect(section()?.textContent).toContain("claude setup-token")
  expect(section()?.textContent).not.toContain("plan")
  expect(section()?.textContent).not.toContain("API key")
  await step(() => typeInto(secretField(), fakeToken))
  await step(() => button("Save", section() as HTMLElement).click())
  await eventually(() => expect(saved()).not.toBeNull())
  const shown = saved()?.textContent ?? ""
  expect(shown).toContain("Setup token")
  expect(shown).toContain("…c3d4")
  // The token itself never comes back to the page.
  expect(document.body.innerHTML).not.toContain(fakeToken)
})

test("refuses an API key, asking for a setup token instead (#334)", async () => {
  const { hub } = await openAccount()
  await addSetupToken()
  await eventually(() => expect(secretField()).not.toBeNull())
  await step(() => typeInto(secretField(), fakeKey))
  await step(() => button("Save", section() as HTMLElement).click())
  expect(section()?.textContent).toContain("API keys aren't taken for now")
  expect(saved()).toBeNull()
  // Said before it is sent: the Hub never sees it.
  expect(hub.received.map((message) => message._tag)).not.toContain("SetClaudeCredential")
})

test("says why the Hub refused a token Anthropic rejected, and keeps the form", async () => {
  await openAccount()
  await addSetupToken()
  await eventually(() => expect(secretField()).not.toBeNull())
  await step(() => typeInto(secretField(), "sk-ant-oat01-REJECTED_FAKE_TOKEN_FOR_TESTS"))
  await step(() => button("Save", section() as HTMLElement).click())
  await eventually(() => expect(alert()).toContain("Anthropic rejected this token"))
  expect(saved()).toBeNull()
})

test("shows a saved token, replaces it, and removes it after asking", async () => {
  await openAccount({
    claudeCredential: { kind: "OAuthToken", last4: "c3d4", addedAt: 1_760_000_000_000 },
  })
  await eventually(() => expect(saved()?.textContent).toContain("Setup token"))
  expect(saved()?.textContent).toContain("…c3d4")

  // Replace opens the form, and Cancel goes back to what is saved.
  await menuItem("Actions for Anthropic", "Replace the setup token")
  expect(secretField()).not.toBeNull()
  // Replacing it puts the Sessions on it to sleep (ADR 0026): the form says so.
  expect(section()?.textContent).toContain("Your Sessions that are awake go to sleep")
  await step(() => button("Cancel", section() as HTMLElement).click())
  expect(secretField()).toBeNull()
  expect(saved()).not.toBeNull()

  await menuItem("Actions for Anthropic", "Remove the setup token")
  const confirm = dialog() as HTMLElement
  expect(confirm.textContent).toContain("Remove your Claude credential?")
  expect(confirm.textContent).toContain("Anyone in them can switch them to another of your Models")
  await step(() => button("Remove", confirm).click())
  // Back among the Providers to connect.
  await eventually(() => expect(saved()).toBeNull())
  expect(button("Add setup token", section() as HTMLElement)).toBeDefined()
})

const tokensSection = () => sectionTitled("CLI tokens")
const tokenList = () => tokensSection()?.querySelector('[aria-label="Your CLI tokens"]')
const listedMachines = () =>
  [...(tokenList()?.querySelectorAll("li") ?? [])].map(
    (row) => row.querySelector("[title]")?.textContent,
  )

test("lists the machines the CLI is signed in on, newest first, and revokes a token after asking", async () => {
  const now = Date.now()
  await openAccount({
    cliTokens: [
      { id: "ct-1", machine: "laptop", createdAt: now - 86_400_000, lastUsedAt: now - 120_000 },
      { id: "ct-2", machine: "build-box", createdAt: now - 30 * 86_400_000 },
    ],
  })
  await eventually(() => expect(tokenList()).not.toBeNull())
  expect(listedMachines()).toEqual(["laptop", "build-box"])
  const rows = [...(tokenList()?.querySelectorAll("li") ?? [])].map((row) => row.textContent)
  expect(rows[0]).toContain("last used 2m ago")
  expect(rows[1]).toContain("never used")

  await menuItem("Actions for build-box", "Revoke build-box's token")
  const confirm = dialog() as HTMLElement
  expect(confirm.textContent).toContain("Revoke the CLI token for build-box?")
  await step(() => button("Revoke", confirm).click())
  await eventually(() => expect(listedMachines()).toEqual(["laptop"]))
})

// Connected providers (ADR 0029): beside Claude, each Provider connected, then the rest to connect,
// a line each, by a sign-in with a subscription or an API key.

/** A Provider's row: in the Connected providers list, or a line to connect it. */
const providerSection = (name: string) =>
  document.querySelector<HTMLElement>(`main li[aria-label="${name}"]`)
const connection = (name: string) =>
  document.querySelector(`ul[aria-label="Connected providers"] > li[aria-label="${name}"]`)
const keyField = (name: string) =>
  providerSection(name)?.querySelector('input[type="password"]') as HTMLInputElement | null
const link = (within: ParentNode, text: string) =>
  [...within.querySelectorAll("a")].find((each) => each.textContent?.trim() === text)
/** The Providers offered to connect, in the group labelled `title`, by name. */
const offered = (title: string) => {
  const heading = [...document.querySelectorAll("h3")].find((each) => each.textContent === title)
  const group = heading?.closest('[role="group"]')
  return [...(group?.querySelectorAll("ul > li[aria-label]") ?? [])].map((each) =>
    each.getAttribute("aria-label"),
  )
}
/** Opens a Provider's API key field on its line: inline, or from its menu beside a sign-in. */
const openKey = async (name: string, from: "inline" | "menu" = "inline") => {
  if (from === "menu") await menuItem(`Actions for ${name}`, "Add API key")
  else await step(() => button("Add API key", providerSection(name) as HTMLElement).click())
  await eventually(() => expect(keyField(name)).not.toBeNull())
}

test("lists the Providers beside Claude: one connected with its Models, the rest to connect", async () => {
  await openAccount()
  await eventually(() => expect(connection("OpenAI")).not.toBeNull())
  expect(sectionTitled("Providers")).toBeDefined()
  const openai = providerSection("OpenAI") as HTMLElement
  expect(connection("OpenAI")?.textContent).toContain("alice@example.com")
  expect(connection("OpenAI")?.textContent).toContain("Subscription")
  expect(openai.textContent).toContain("3 Models")
  expect(openai.textContent).toContain("checked 2h ago")
  // The Models are listed on asking, from its menu or by a click on its row.
  expect(openai.textContent).not.toContain("GPT-6-Sol mini")
  await menuItem("Actions for OpenAI", "Show OpenAI's Models")
  expect(openai.textContent).toContain("GPT-6-Sol mini")
  await step(() => (openai.firstElementChild as HTMLElement).click())
  expect(openai.textContent).not.toContain("GPT-6-Sol mini")

  await menuItem("Actions for OpenAI", "Refresh OpenAI's Models")
  await eventually(() =>
    expect(fakeHub().received.at(-1)).toMatchObject({
      _tag: "RefreshProviderModels",
      provider: "openai",
    }),
  )

  // The rest, a line each: those with a sign-in, Anthropic first while it has no setup token,
  // then the first few that take a key.
  expect(sectionTitled("Connect another Provider")).toBeDefined()
  expect(offered("Subscriptions")).toEqual([
    "Anthropic",
    "xAI",
    "GitHub Copilot",
    "OpenRouter",
    "Kimi For Coding",
    "Meta",
  ])
  expect(offered("API keys")).toEqual([
    "Google",
    "Mistral",
    "DeepSeek",
    "Groq",
    "Cerebras",
    "Moonshot AI",
  ])
  const xai = providerSection("xAI") as HTMLElement
  expect(button("Sign in with SuperGrok or X Premium", xai)).toBeDefined()
  // Its key's field opens on asking, from its menu.
  expect(keyField("xAI")).toBeNull()
  expect(button("Actions for xAI", xai)).toBeDefined()
  // GitHub Copilot signs in only.
  const copilot = providerSection("GitHub Copilot") as HTMLElement
  expect(button("Sign in with GitHub Copilot", copilot)).toBeDefined()
  expect(() => button("Actions for GitHub Copilot", copilot)).toThrow()
  expect(connection("xAI")).toBeNull()

  // The rest that take a key are behind Show more.
  expect(providerSection("Xiaomi Token Plan CN")).toBeNull()
  await step(() => button("Show 21 more", document.body).click())
  expect(offered("API keys")).toContain("Xiaomi Token Plan CN")
  expect(offered("API keys")).toHaveLength(27)
})

test("connects a Provider with an API key, shown by its last 4 characters, and says why one is refused", async () => {
  await openAccount()
  await eventually(() => expect(providerSection("xAI")).not.toBeNull())
  const xai = providerSection("xAI") as HTMLElement
  await openKey("xAI", "menu")
  expect(xai.textContent).toContain("xAI API key")
  await step(() => typeInto(keyField("xAI") as HTMLInputElement, "xai-REJECTED-made-up-key"))
  await step(() => button("Connect", xai).click())
  await eventually(() =>
    expect(xai.querySelector('[role="alert"]')?.textContent).toContain("xAI rejected this key."),
  )
  await step(() => typeInto(keyField("xAI") as HTMLInputElement, "xai-made-up-key-for-tests-9z8y"))
  await step(() => button("Connect", xai).click())
  await eventually(() => expect(connection("xAI")?.textContent).toContain("…9z8y"))
  expect(connection("xAI")?.textContent).toContain("API key")
  expect(document.body.innerHTML).not.toContain("made-up-key-for-tests")
})

test("connects one of many Providers by its key: Google's, named as Google names it", async () => {
  await openAccount({ providers: [] })
  await eventually(() => expect(providerSection("Google")).not.toBeNull())
  expect(sectionTitled("Connect a Provider")).toBeDefined()
  const google = providerSection("Google") as HTMLElement
  await openKey("Google")
  expect(google.textContent).toContain("Gemini API key")
  // Cancel closes the field, and nothing is sent.
  await step(() => button("Cancel", google).click())
  expect(keyField("Google")).toBeNull()
  await openKey("Google")
  await step(() => typeInto(keyField("Google") as HTMLInputElement, "gemini-made-up-key-5x7w"))
  await step(() => button("Connect", google).click())
  // Connected, it moves up among the connected.
  await eventually(() => expect(connection("Google")?.textContent).toContain("…5x7w"))
  expect(offered("API keys")).not.toContain("Google")
  expect(fakeHub().received.find((m) => m._tag === "ConnectProviderKey")).toMatchObject({
    provider: "google",
  })
})

test("signs in to GitHub Copilot with a code, from its line, and it moves up once connected", async () => {
  await openAccount({ providers: [] })
  await eventually(() => expect(providerSection("GitHub Copilot")).not.toBeNull())
  const copilot = providerSection("GitHub Copilot") as HTMLElement
  await step(() => button("Sign in with GitHub Copilot", copilot).click())
  // It asks which GitHub first.
  await eventually(() =>
    expect(copilot.textContent).toContain("Which GitHub is your Copilot subscription on?"),
  )
  await step(() => button("GitHub.com", copilot).click())
  expect(fakeHub().received.find((m) => m._tag === "AnswerSignIn")).toBeDefined()
  await eventually(() =>
    expect(copilot.querySelector('[aria-label="Sign-in code"]')?.textContent).toBe("WDJB-MJHT"),
  )
  expect(link(copilot, "Open the sign-in page")?.getAttribute("href")).toBe(
    "https://github.com/login/device",
  )
  // While it runs, the line's buttons give way to its steps.
  expect(copilot.textContent).not.toContain("Sign in with GitHub Copilot")
  await eventually(() =>
    expect(connection("GitHub Copilot")?.textContent).toContain("GitHub Copilot subscription"),
  )
  expect(offered("Subscriptions")).not.toContain("GitHub Copilot")
})

test("signs in with ChatGPT: a page to open, then the address it lands on pasted back", async () => {
  await openAccount({ providers: [] })
  await eventually(() => expect(providerSection("OpenAI")).not.toBeNull())
  const openai = providerSection("OpenAI") as HTMLElement
  await step(() => button("Sign in with ChatGPT", openai).click())
  await eventually(() => expect(link(openai, "Open the sign-in page")).toBeDefined())
  const page = link(openai, "Open the sign-in page")
  expect(page?.getAttribute("href")).toContain("https://auth.openai.com/")
  expect(page?.getAttribute("target")).toBe("_blank")
  // Two steps, numbered: the page, then the address it lands on, which won't load, pasted back.
  expect(openai.querySelector("ol")?.children).toHaveLength(2)
  expect(openai.textContent).toContain("Sign in to ChatGPT in the page this opens.")
  expect(openai.textContent).toContain("that's expected")

  const pasteLabel = "Address of the page you landed on"
  await eventually(() => expect(openai.textContent).toContain(pasteLabel))
  expect(openai.textContent).toContain("it starts with http://127.0.0.1:1455/")
  const field = openai.querySelector<HTMLInputElement>(
    'input[placeholder^="http://127.0.0.1:1455"]',
  )
  await step(() =>
    typeInto(field as HTMLInputElement, "http://localhost:1455/auth/callback?code=made-up&state=x"),
  )
  await step(() => button("Continue", openai).click())
  await eventually(() => expect(connection("OpenAI")?.textContent).toContain("alice@example.com"))
  expect(fakeHub().received.find((m) => m._tag === "AnswerSignIn")).toBeDefined()
  expect(link(providerSection("OpenAI") as HTMLElement, "Open the sign-in page")).toBeUndefined()
})

test("signs in to xAI with a code to enter, and Cancel stops it", async () => {
  await openAccount({ providers: [] })
  await eventually(() => expect(providerSection("xAI")).not.toBeNull())
  const xai = providerSection("xAI") as HTMLElement
  // Held, so the code isn't entered before Cancel, however slow the machine: two steps show it.
  fakeHub().hold()
  await step(() => button("Sign in with SuperGrok or X Premium", xai).click())
  for (const _ of [1, 2]) await act(() => fakeHub().step())
  await eventually(() =>
    expect(xai.querySelector('[aria-label="Sign-in code"]')?.textContent).toBe("WDJB-MJHT"),
  )
  expect(button("Copy code", xai)).toBeDefined()
  expect(link(xai, "Open the sign-in page")?.getAttribute("href")).toBe(
    "https://accounts.x.ai/device",
  )
  await step(() => button("Cancel", xai).click())
  await eventually(() => expect(xai.querySelector('[aria-label="Sign-in code"]')).toBeNull())
  expect(fakeHub().received.some((m) => m._tag === "CancelSignIn")).toBe(true)
  expect(button("Sign in with SuperGrok or X Premium", xai)).toBeDefined()
  expect(connection("xAI")).toBeNull()
})

test("a sign-in that fails says why, and can be tried again", async () => {
  await openAccount({ providers: [] })
  await eventually(() => expect(providerSection("OpenAI")).not.toBeNull())
  const openai = providerSection("OpenAI") as HTMLElement
  await step(() => button("Sign in with ChatGPT", openai).click())
  await eventually(() =>
    expect(openai.querySelector('input[placeholder^="http://127.0.0.1:1455"]')).not.toBeNull(),
  )
  const field = openai.querySelector<HTMLInputElement>(
    'input[placeholder^="http://127.0.0.1:1455"]',
  )
  await step(() => typeInto(field as HTMLInputElement, "http://localhost:1455/"))
  await step(() => button("Continue", openai).click())
  await eventually(() => expect(openai.textContent).toContain("The sign-in failed"))
  expect(openai.textContent).toContain("That address has no code in it")
  expect(button("Sign in with ChatGPT", openai)).toBeDefined()
})

test("the focus follows a sign-in: to its page, to the box to paste in, and back once it ends", async () => {
  await openAccount({ providers: [] })
  await eventually(() => expect(providerSection("OpenAI")).not.toBeNull())
  const openai = providerSection("OpenAI") as HTMLElement
  const signIn = button("Sign in with ChatGPT", openai)
  signIn.focus()
  await step(() => signIn.click())
  // The button goes; the sign-in's page takes the focus, as what to do next.
  await eventually(() =>
    expect(document.activeElement).toBe(link(openai, "Open the sign-in page") ?? null),
  )
  await eventually(() =>
    expect(openai.querySelector('input[placeholder^="http://127.0.0.1:1455"]')).not.toBeNull(),
  )
  // Opening it readies the box for the address, to paste into on coming back.
  await step(() => link(openai, "Open the sign-in page")?.click())
  expect(document.activeElement).toBe(
    openai.querySelector('input[placeholder^="http://127.0.0.1:1455"]'),
  )
  // Cancelled, the focus is back on the button that starts it.
  await step(() => button("Cancel", openai).click())
  await eventually(() =>
    expect(document.activeElement).toBe(button("Sign in with ChatGPT", openai)),
  )
})

test("disconnects a Provider after asking", async () => {
  await openAccount()
  await eventually(() => expect(connection("OpenAI")).not.toBeNull())
  await menuItem("Actions for OpenAI", "Disconnect OpenAI")
  const confirm = dialog() as HTMLElement
  expect(confirm.textContent).toContain("Disconnect OpenAI?")
  await step(() => button("Disconnect", confirm).click())
  await eventually(() => expect(connection("OpenAI")).toBeNull())
  // Back among those to connect, after Anthropic's setup token.
  expect(button("Sign in with ChatGPT", providerSection("OpenAI") as HTMLElement)).toBeDefined()
  expect(offered("Subscriptions").slice(0, 2)).toEqual(["Anthropic", "OpenAI"])
})

test("without CLI tokens, shows the command that signs the CLI in", async () => {
  await openAccount({ cliTokens: [] })
  await eventually(() => expect(tokensSection()?.textContent).toContain("No CLI tokens yet"))
  const command = tokensSection()?.querySelector('[aria-label="Sign-in command"]')
  expect(command?.textContent).toBe(`kndl login ${window.location.origin}`)
  expect(tokenList()).toBeNull()
})
