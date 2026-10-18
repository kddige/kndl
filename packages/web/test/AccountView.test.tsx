// The Account page against the fake Hub: pasting a Claude setup token, which the fake checks as the
// Hub does, seeing it write-only once saved, and removing it (ADR 0015, ADR 0026); and listing and
// revoking the CLI tokens `kndl login` made (issue #179); and connecting Providers, by a sign-in or
// an API key, and disconnecting them (ADR 0029). Every secret is made up.

import { afterEach, expect, test } from "bun:test"
import { act } from "react"
import { installDom } from "./dom.ts"
import { button, dialog, render, settle, step } from "./render.ts"

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

const section = () => document.querySelector('section[aria-labelledby="claude-credential"]')
const secretField = () => section()?.querySelector('input[type="password"]') as HTMLInputElement
const saved = () => section()?.querySelector('[aria-label="Your Claude credential"]')
const alert = () => section()?.querySelector('[role="alert"]')?.textContent ?? ""

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
  await step(() => button("Replace", section() as HTMLElement).click())
  expect(secretField()).not.toBeNull()
  // Replacing it puts the Sessions on it to sleep (ADR 0026): the form says so.
  expect(section()?.textContent).toContain("Your Sessions that are awake go to sleep")
  await step(() => button("Cancel", section() as HTMLElement).click())
  expect(saved()).not.toBeNull()

  await step(() => button("Remove", section() as HTMLElement).click())
  const confirm = dialog() as HTMLElement
  expect(confirm.textContent).toContain("Remove your Claude credential?")
  expect(confirm.textContent).toContain("none of them can start or wake")
  await step(() => button("Remove", confirm).click())
  await eventually(() => expect(secretField()).not.toBeNull())
  expect(saved()).toBeNull()
})

// Which Harness runs Claude's Models in new Sessions (ADR 0030), chosen on the Anthropic card.

const harnessChoice = () =>
  section()?.querySelector<HTMLElement>(
    '[role="radiogroup"][aria-label="Run Claude\'s Models with"]',
  )
const harnessRadios = () => [
  ...(harnessChoice()?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []),
]
const chosenHarness = () =>
  harnessRadios()
    .filter((radio) => radio.getAttribute("aria-checked") === "true")
    .map((radio) => radio.textContent)

test("the Anthropic card chooses which Harness runs Claude's Models in new Sessions", async () => {
  const { hub } = await openAccount({
    claudeCredential: { kind: "OAuthToken", last4: "c3d4", addedAt: 1_760_000_000_000 },
  })
  await eventually(() =>
    expect(harnessRadios().map((radio) => radio.textContent)).toEqual(["Claude Code", "pi"]),
  )
  // Claude Code unless chosen otherwise, said in one line.
  expect(chosenHarness()).toEqual(["Claude Code"])
  expect(section()?.textContent).toContain(
    "Claude Code: Claude's own tools, on your plan's limits. pi: the same tools and Subagents as your other Providers.",
  )

  await step(() => harnessRadios()[1]?.click())
  await eventually(() => expect(chosenHarness()).toEqual(["pi"]))
  expect(
    hub.received.flatMap((message) =>
      message._tag === "SetClaudeHarness" ? [message.harness] : [],
    ),
  ).toEqual(["Pi"])
})

test("without a Claude credential, the Anthropic card has no Harness to choose", async () => {
  await openAccount()
  await eventually(() => expect(secretField()).not.toBeNull())
  expect(harnessChoice()).toBeNull()
})

const tokensSection = () => document.querySelector('section[aria-labelledby="cli-tokens"]')
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

  await step(() => button("Revoke build-box").click())
  const confirm = dialog() as HTMLElement
  expect(confirm.textContent).toContain("Revoke the CLI token for build-box?")
  await step(() => button("Revoke", confirm).click())
  await eventually(() => expect(listedMachines()).toEqual(["laptop"]))
})

// Connected providers (ADR 0029): beside Claude, each Provider connected, then the rest to connect,
// a line each, by a sign-in with a subscription or an API key.

const providerSection = (provider: string) =>
  document.querySelector<HTMLElement>(`section[aria-labelledby="provider-${provider}"]`)
const connection = (provider: string) =>
  providerSection(provider)?.querySelector('dl[aria-label^="Your "]')
const keyField = (provider: string) =>
  providerSection(provider)?.querySelector('input[type="password"]') as HTMLInputElement | null
const link = (within: ParentNode, text: string) =>
  [...within.querySelectorAll("a")].find((each) => each.textContent?.trim() === text)
/** The Providers offered to connect, in the group titled `title`, by name. */
const offered = (title: string) => {
  const heading = [...document.querySelectorAll("h4")].find((each) => each.textContent === title)
  const group = heading?.closest('[role="group"]')
  return [...(group?.querySelectorAll("section[aria-labelledby^='provider-']") ?? [])].map(
    (each) => each.querySelector("span")?.textContent,
  )
}
/** Opens a Provider's API key field on its line. */
const openKey = async (provider: string, label = "Add API key") => {
  await step(() => button(label, providerSection(provider) as HTMLElement).click())
  await eventually(() => expect(keyField(provider)).not.toBeNull())
}

test("lists the Providers beside Claude: one connected with its Models, the rest to connect", async () => {
  await openAccount()
  await eventually(() => expect(connection("openai")).not.toBeNull())
  expect(document.querySelector("#providers")?.textContent).toBe("Providers")
  const openai = providerSection("openai") as HTMLElement
  expect(connection("openai")?.getAttribute("aria-label")).toBe("Your OpenAI connection")
  expect(connection("openai")?.textContent).toContain("alice@example.com")
  expect(connection("openai")?.textContent).toContain("Subscription")
  expect(openai.textContent).toContain("3 Models")
  expect(openai.textContent).toContain("checked 2h ago")
  // The Models are listed on asking.
  expect(openai.textContent).not.toContain("GPT-6-Sol mini")
  await step(() => button("3 Models · checked 2h ago", openai).click())
  await settle()
  expect(openai.textContent).toContain("GPT-6-Sol mini")

  await step(() => button("Refresh models", openai).click())
  await eventually(() =>
    expect(fakeHub().received.at(-1)).toMatchObject({
      _tag: "RefreshProviderModels",
      provider: "openai",
    }),
  )

  // The rest, a line each: those with a sign-in, then the first few that take a key.
  expect(document.querySelector("#connect-provider")?.textContent).toBe("Connect another Provider")
  expect(offered("Subscriptions")).toEqual([
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
  const xai = providerSection("xai") as HTMLElement
  expect(button("Sign in with SuperGrok or X Premium", xai)).toBeDefined()
  // Its key's field opens on asking.
  expect(keyField("xai")).toBeNull()
  expect(button("API key", xai)).toBeDefined()
  // GitHub Copilot signs in only.
  const copilot = providerSection("github-copilot") as HTMLElement
  expect(button("Sign in with GitHub Copilot", copilot)).toBeDefined()
  expect(copilot.textContent).not.toContain("API key")
  expect(connection("xai")).toBeNull()

  // The rest that take a key are behind Show more.
  expect(providerSection("xiaomi-token-plan-cn")).toBeNull()
  await step(() => button("Show 21 more", document.body).click())
  expect(offered("API keys")).toContain("Xiaomi Token Plan CN")
  expect(offered("API keys")).toHaveLength(27)
})

test("connects a Provider with an API key, shown by its last 4 characters, and says why one is refused", async () => {
  await openAccount()
  await eventually(() => expect(providerSection("xai")).not.toBeNull())
  const xai = providerSection("xai") as HTMLElement
  await openKey("xai", "API key")
  expect(xai.textContent).toContain("xAI API key")
  await step(() => typeInto(keyField("xai") as HTMLInputElement, "xai-REJECTED-made-up-key"))
  await step(() => button("Connect", xai).click())
  await eventually(() =>
    expect(xai.querySelector('[role="alert"]')?.textContent).toContain("xAI rejected this key."),
  )
  await step(() => typeInto(keyField("xai") as HTMLInputElement, "xai-made-up-key-for-tests-9z8y"))
  await step(() => button("Connect", xai).click())
  await eventually(() => expect(connection("xai")?.textContent).toContain("…9z8y"))
  expect(connection("xai")?.textContent).toContain("API key")
  expect(document.body.innerHTML).not.toContain("made-up-key-for-tests")
})

test("connects one of many Providers by its key: Google's, named as Google names it", async () => {
  await openAccount({ providers: [] })
  await eventually(() => expect(providerSection("google")).not.toBeNull())
  expect(document.querySelector("#connect-provider")?.textContent).toBe("Connect a Provider")
  const google = providerSection("google") as HTMLElement
  await openKey("google")
  expect(google.textContent).toContain("Gemini API key")
  // Cancel closes the field, and nothing is sent.
  await step(() => button("Cancel", google).click())
  expect(keyField("google")).toBeNull()
  await openKey("google")
  await step(() => typeInto(keyField("google") as HTMLInputElement, "gemini-made-up-key-5x7w"))
  await step(() => button("Connect", google).click())
  // Connected, it moves up among the connected, with its own card.
  await eventually(() => expect(connection("google")?.textContent).toContain("…5x7w"))
  expect(providerSection("google")?.querySelector("h3")?.textContent).toBe("Google")
  expect(offered("API keys")).not.toContain("Google")
  expect(fakeHub().received.find((m) => m._tag === "ConnectProviderKey")).toMatchObject({
    provider: "google",
  })
})

test("signs in to GitHub Copilot with a code, from its line, and it moves up once connected", async () => {
  await openAccount({ providers: [] })
  await eventually(() => expect(providerSection("github-copilot")).not.toBeNull())
  const copilot = providerSection("github-copilot") as HTMLElement
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
    expect(connection("github-copilot")?.textContent).toContain("GitHub Copilot subscription"),
  )
  expect(offered("Subscriptions")).not.toContain("GitHub Copilot")
})

test("signs in with ChatGPT: a page to open, then the address it lands on pasted back", async () => {
  await openAccount({ providers: [] })
  await eventually(() => expect(providerSection("openai")).not.toBeNull())
  const openai = providerSection("openai") as HTMLElement
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
  await eventually(() => expect(connection("openai")?.textContent).toContain("alice@example.com"))
  expect(fakeHub().received.find((m) => m._tag === "AnswerSignIn")).toBeDefined()
  expect(link(providerSection("openai") as HTMLElement, "Open the sign-in page")).toBeUndefined()
})

test("signs in to xAI with a code to enter, and Cancel stops it", async () => {
  await openAccount({ providers: [] })
  await eventually(() => expect(providerSection("xai")).not.toBeNull())
  const xai = providerSection("xai") as HTMLElement
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
  expect(connection("xai")).toBeNull()
})

test("a sign-in that fails says why, and can be tried again", async () => {
  await openAccount({ providers: [] })
  await eventually(() => expect(providerSection("openai")).not.toBeNull())
  const openai = providerSection("openai") as HTMLElement
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
  await eventually(() => expect(providerSection("openai")).not.toBeNull())
  const openai = providerSection("openai") as HTMLElement
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
  await eventually(() => expect(connection("openai")).not.toBeNull())
  await step(() => button("Disconnect", providerSection("openai") as HTMLElement).click())
  const confirm = dialog() as HTMLElement
  expect(confirm.textContent).toContain("Disconnect OpenAI?")
  await step(() => button("Disconnect", confirm).click())
  await eventually(() => expect(connection("openai")).toBeNull())
  // Back among those to connect.
  expect(button("Sign in with ChatGPT", providerSection("openai") as HTMLElement)).toBeDefined()
  expect(offered("Subscriptions")[0]).toBe("OpenAI")
})

test("without CLI tokens, shows the command that signs the CLI in", async () => {
  await openAccount({ cliTokens: [] })
  await eventually(() => expect(tokensSection()?.textContent).toContain("None yet"))
  const command = tokensSection()?.querySelector('[aria-label="Sign-in command"]')
  expect(command?.textContent).toBe(`kndl login ${window.location.origin}`)
  expect(tokenList()).toBeNull()
})
