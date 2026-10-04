// Onboard's GitHub App step, against the stand-in GitHub (the Hub's testGitHubApi.ts): a browser
// played by fetch loads onboard's page, POSTs the manifest to the stand-in's "new App" page and
// follows its redirect back; onboard trades the code for the App's credentials and saves them.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appKeyPair, StandInGitHub } from "@claude-hub/hub/src/testGitHubApi.ts"
import { Cause, Effect, Exit } from "effect"
import { GitHubSiteRef } from "./AppSetup.ts"
import { envValues, parseEnv } from "./EnvFile.ts"
import { type Layout, resolveLayout } from "./Layout.ts"
import { configure, type OnboardOptions } from "./OnboardFlow.ts"
import { Shell } from "./Shell.ts"
import { NoAnswer, scriptedUi, Ui } from "./Ui.ts"

const github = StandInGitHub.start(appKeyPair().publicKey)
afterAll(() => github.stop())

const none: OnboardOptions = {
  role: "hub",
  reach: "local",
  port: undefined,
  publicUrl: undefined,
  insecureCookies: undefined,
  devLogin: false,
  githubApp: "create",
  hubUrl: undefined,
  token: undefined,
  runnerName: undefined,
  installPrerequisites: undefined,
  services: undefined,
  linger: undefined,
  nonInteractive: false,
  reset: false,
  moveOldData: false,
}

let scratch: string
let layout: Layout

beforeEach(async () => {
  github.reset()
  scratch = await mkdtemp(join(tmpdir(), "claude-hub-app-"))
  const userHome = join(scratch, "user")
  layout = resolveLayout({ CLAUDE_HUB_HOME: join(userHome, ".claude-hub") }, userHome)
  mkdirSync(join(layout.app, ".git"), { recursive: true })
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

/** A Shell that runs nothing; opening a browser fails, as on a machine without one. */
const fakeShell = (dryRun: boolean) =>
  Shell.of({
    dryRun,
    capture: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "no browser" }),
    attached: () => Effect.succeed(0),
  })

/** Runs onboard's questions against `answers`, with GitHub the stand-in. */
function start(
  answers: ReadonlyArray<unknown>,
  options: Partial<OnboardOptions> = {},
  settings: { readonly interactive?: boolean; readonly dryRun?: boolean } = {},
) {
  const { ui, transcript } = scriptedUi(answers, settings)
  const done = Effect.runPromiseExit(
    configure(layout, { ...none, ...options }).pipe(
      Effect.provideService(Ui, ui),
      Effect.provideService(Shell, fakeShell(settings.dryRun ?? false)),
      Effect.provideService(GitHubSiteRef, { web: github.url, api: github.url }),
    ),
  )
  return { done, transcript }
}

/** The page onboard says to open, once it says so. */
async function pageUrl(transcript: ReadonlyArray<string>): Promise<string> {
  for (let i = 0; i < 200; i++) {
    for (const line of transcript) {
      const url = /Open (http:\/\/127\.0\.0\.1:\d+\/) in a browser/.exec(line)?.[1]
      if (url !== undefined) return url
    }
    await Bun.sleep(10)
  }
  throw new Error(`onboard never said which page to open:\n${transcript.join("\n")}`)
}

/** An attribute's text, as the browser reads it. */
const unescape = (text: string) =>
  text
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")

/** A browser: loads the page, submits its form to GitHub, follows GitHub's redirect back. */
async function browse(url: string) {
  const page = await (await fetch(url)).text()
  const action = /<form id="manifest" method="post" action="([^"]+)"/.exec(page)?.[1]
  const value = /name="manifest" value="([^"]*)"/.exec(page)?.[1]
  if (action === undefined || value === undefined) throw new Error(`No form in:\n${page}`)
  const posted = await fetch(unescape(action), {
    method: "POST",
    body: new URLSearchParams({ manifest: unescape(value) }),
    redirect: "manual",
  })
  const back = posted.headers.get("location")
  if (back === null) throw new Error(`GitHub didn't redirect: ${posted.status}`)
  const landed = await fetch(back)
  return { status: landed.status, text: await landed.text() }
}

const env = () => envValues(parseEnv(readFileSync(layout.envFile("hub"), "utf8")))

const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

describe("creating the GitHub App from the manifest", () => {
  test("on the person's account: hub.env gets its settings, the home its key, 0600", async () => {
    const { done, transcript } = start(["Personal", NoAnswer])
    const url = await pageUrl(transcript)
    const landed = await browse(url)
    const exit = await done

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(landed.status).toBe(200)
    expect(landed.text).toContain("Go back to the terminal")
    const app = github.manifests[0]
    expect(app?.organization).toBeUndefined()
    expect(app?.manifest).toMatchObject({
      url: "http://127.0.0.1:7777",
      callback_urls: ["http://127.0.0.1:7777/auth/github/callback"],
      redirect_url: `${url}github-app/created`,
      default_permissions: { contents: "write", metadata: "read" },
    })

    const keyPath = join(layout.home.dir, "github-app-1000.pem")
    expect(env()).toMatchObject({
      GITHUB_APP_ID: "1000",
      GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
      GITHUB_CLIENT_ID: "Iv23li1000",
      GITHUB_CLIENT_SECRET: "standin-client-secret-1000",
    })
    expect(env()).not.toHaveProperty("GITHUB_WEBHOOK_SECRET")
    expect(readFileSync(keyPath, "utf8")).toStartWith("-----BEGIN RSA PRIVATE KEY-----")
    expect(statSync(keyPath).mode & 0o777).toBe(0o600)
    expect(transcript).toContainEqual(
      expect.stringContaining("https://github.com/apps/claude-hub-new-1000/installations/new"),
    )
    // The secrets are written, never shown.
    const shown = transcript.join("\n")
    expect(shown).not.toContain("standin-client-secret")
    expect(shown).not.toContain("PRIVATE KEY")
    // The page is gone once onboard has the code.
    await expect(fetch(url)).rejects.toThrow()
  })

  test("on an organization: GitHub's page for it", async () => {
    const { done, transcript } = start(["Organization", "acme", NoAnswer])
    await browse(await pageUrl(transcript))

    expect(Exit.isSuccess(await done)).toBe(true)
    expect(github.manifests[0]?.organization).toBe("acme")
    expect(env().GITHUB_APP_ID).toBe("1000")
  })

  test("the address GitHub sent the browser to, or its code, can be pasted instead", async () => {
    const { code } = github.registerApp({ code: "pastedcode1234" })
    const { done } = start(["Personal", code])

    expect(Exit.isSuccess(await done)).toBe(true)
    expect(env().GITHUB_CLIENT_ID).toBe("Iv23li1000")
  })

  test("a redirect from another attempt is refused, and the page waits on", async () => {
    const { done, transcript } = start(["Personal", NoAnswer])
    const url = await pageUrl(transcript)
    const stray = await fetch(`${url}github-app/created?code=strayc0de&state=other`)
    expect(stray.status).toBe(400)
    await browse(url)

    expect(Exit.isSuccess(await done)).toBe(true)
    expect(github.manifests).toHaveLength(1)
  })

  test("a code GitHub won't take fails, saving nothing", async () => {
    const { done } = start(["Personal", "usedorexpired1"])
    const exit = await done

    expect(failure(exit)).toMatchObject({ _tag: "CliFailure" })
    expect(String((failure(exit) as { message: string }).message)).toContain("A code works once")
    expect(existsSync(layout.envFile("hub"))).toBe(false)
  })

  test("a dry run says what it would do, and makes nothing", async () => {
    const { done, transcript } = start(["Personal"], {}, { dryRun: true })

    expect(Exit.isSuccess(await done)).toBe(true)
    expect(transcript).toContainEqual(expect.stringContaining("[dry run] the GitHub App isn't"))
    expect(github.manifests).toHaveLength(0)
    expect(env()).not.toHaveProperty("GITHUB_APP_ID")
  })

  test("without a terminal it fails, naming why", async () => {
    const { done } = start([], {}, { interactive: false })
    const exit = await done

    expect(String((failure(exit) as { message: string }).message)).toContain("needs a terminal")
    expect(existsSync(layout.envFile("hub"))).toBe(false)
  })
})

describe("an App made by hand", () => {
  test("its settings, pasted, go into hub.env; the key stays where it is", async () => {
    const keyPath = join(scratch, "my-app.private-key.pem")
    writeFileSync(keyPath, "key", { mode: 0o600 })
    const { done, transcript } = start(["42", "Iv1.abc", "sekret", keyPath], {
      githubApp: "manual",
    })

    expect(Exit.isSuccess(await done)).toBe(true)
    expect(env()).toMatchObject({
      GITHUB_APP_ID: "42",
      GITHUB_CLIENT_ID: "Iv1.abc",
      GITHUB_CLIENT_SECRET: "sekret",
      GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
    })
    expect(transcript.join("\n")).not.toContain("sekret")
    expect(transcript).toContain("? password: A client secret")
  })

  test("a key readable by others is pointed out", async () => {
    const keyPath = join(scratch, "open.pem")
    writeFileSync(keyPath, "key", { mode: 0o644 })
    const { done, transcript } = start(["42", "Iv1.abc", "sekret", keyPath], {
      githubApp: "manual",
    })

    expect(Exit.isSuccess(await done)).toBe(true)
    expect(transcript).toContainEqual(expect.stringContaining(`chmod 600 ${keyPath}`))
  })
})
