// `claude-hub login`, `logout` and `whoami` (issue #179) against a fake Hub on a loopback port. The
// browser is played by the fake Shell that "opens" the login page: it approves at the fake Hub, as
// the page does, and goes back to the CLI's callback with the code, or doesn't, as over SSH, where
// the code is pasted instead. Every token is the fake Hub's; the config is in a temp dir.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { statSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { formatCliLoginCode, normalizeCliLoginCode } from "@claude-hub/protocol"
import { Cause, Console, Effect, Exit } from "effect"
import { readCliConfig, writeCliConfig } from "./CliConfig.ts"
import {
  CallbackPath,
  hubOrigin,
  type LoginContext,
  login,
  loginPageUrl,
  logout,
  newPkce,
  overSsh,
  whoami,
} from "./Login.ts"
import { Shell, type Step } from "./Shell.ts"
import { NoAnswer, scriptedUi, Ui, type UiShape } from "./Ui.ts"

/** A Hub's `/auth/cli/*` routes, as far as the CLI sees them. */
class FakeHub {
  readonly #server: Bun.Server<undefined>
  #codes = new Map<string, { machine: string; challenge: string }>()
  #tokens = new Map<string, { id: string; machine: string; createdAt: number; revoked: boolean }>()
  #next = 0
  /** Every token handed out, newest last. */
  readonly issued: Array<string> = []

  constructor() {
    this.#server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => this.#fetch(r) })
  }

  get url(): string {
    return `http://127.0.0.1:${this.#server.port}`
  }

  stop(): void {
    void this.#server.stop(true)
  }

  reset(): void {
    this.#codes.clear()
    this.#tokens.clear()
    this.issued.length = 0
  }

  /** What the `/cli-login` page does on Approve: a Login code for the machine and challenge. */
  approve(page: string): string {
    const url = new URL(page)
    const machine = url.searchParams.get("machine") ?? ""
    const challenge = url.searchParams.get("challenge") ?? ""
    const n = String(++this.#next).padStart(4, "0")
    const code = `ABCDEFGHJKMN${n}`
    this.#codes.set(code, { machine, challenge })
    return formatCliLoginCode(code)
  }

  isRevoked(token: string): boolean {
    return this.#tokens.get(token)?.revoked ?? true
  }

  async #fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""
    const held = this.#tokens.get(bearer)
    const live = held !== undefined && !held.revoked ? held : undefined
    const you = { id: "p-alice", login: "alice", name: "Alice Kim" }
    if (request.method === "POST" && url.pathname === "/auth/cli/token") {
      const body = (await request.json()) as { code: string; verifier: string }
      const code = normalizeCliLoginCode(body.code) ?? ""
      const approved = this.#codes.get(code)
      const challenge = createHash("sha256").update(body.verifier).digest("base64url")
      if (approved === undefined || approved.challenge !== challenge) {
        return Response.json(
          { error: "That code isn't one the Hub gave out, or it expired." },
          { status: 400 },
        )
      }
      this.#codes.delete(code)
      const id = `ct-${this.#next}`
      const token = `chc_${id}.secret${this.#next}`
      const createdAt = Date.UTC(2026, 9, 6)
      this.#tokens.set(token, { id, machine: approved.machine, createdAt, revoked: false })
      this.issued.push(token)
      return Response.json({ you, id, machine: approved.machine, createdAt, token })
    }
    if (request.method === "GET" && url.pathname === "/auth/cli/me") {
      if (live === undefined) return Response.json({ error: "Sign in." }, { status: 401 })
      return Response.json({ you, id: live.id, machine: live.machine, createdAt: live.createdAt })
    }
    if (request.method === "POST" && url.pathname === "/auth/cli/sign-out") {
      if (live === undefined) return Response.json({ error: "Sign in." }, { status: 401 })
      live.revoked = true
      return new Response(null, { status: 204 })
    }
    return new Response("not found", { status: 404 })
  }
}

const hub = new FakeHub()
afterAll(() => hub.stop())

let scratch: string
let configPath: string
beforeEach(async () => {
  hub.reset()
  scratch = await mkdtemp(join(tmpdir(), "claude-hub-login-"))
  configPath = join(scratch, "config", "claude-hub", "cli.json")
})
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

const laptop = (env: Record<string, string> = {}): LoginContext => ({
  configPath,
  env,
  platform: "darwin",
  machine: "laptop",
})
const overSshContext = () => laptop({ SSH_CONNECTION: "10.0.0.2 50000 10.0.0.3 22" })

/** What the browser did when the CLI opened the page. */
interface Browser {
  /** The page the CLI opened, if it did. */
  opened?: string
  /** How the CLI answered the browser coming back to it: its status and where it sent it. */
  answered?: Promise<{ status: number; location: string | null }>
}

/**
 * A Shell whose `open` is a browser: on `reachesCli` it approves at the fake Hub and goes back to
 * the CLI's callback with the code, as on a laptop; otherwise it only loads the page.
 */
function browserShell(browser: Browser, reachesCli: boolean) {
  return Shell.of({
    dryRun: false,
    capture: (s: Step) =>
      Effect.sync(() => {
        const page = s.args[0] ?? ""
        browser.opened = page
        if (reachesCli) {
          const url = new URL(page)
          const code = hub.approve(page)
          const back = new URL(`http://127.0.0.1:${url.searchParams.get("port")}${CallbackPath}`)
          back.searchParams.set("code", code)
          back.searchParams.set("state", url.searchParams.get("state") ?? "")
          browser.answered = fetch(back, { redirect: "manual" }).then((response) => ({
            status: response.status,
            location: response.headers.get("location"),
          }))
        }
        return { exitCode: 0, stdout: "", stderr: "" }
      }),
    attached: () => Effect.succeed(0),
  })
}

/**
 * A terminal where the person pastes what the page showed: each answer is a code, or `approve`,
 * the code the fake Hub gives on approving the page the CLI printed.
 */
function pastingUi(answers: ReadonlyArray<string | typeof approve>) {
  const scripted = scriptedUi([])
  const transcript = scripted.transcript as Array<string>
  const queue = [...answers]
  const ui: UiShape = {
    ...scripted.ui,
    text: (options) =>
      Effect.sync(() => {
        transcript.push(`? text: ${options.message}`)
        const answer = queue.shift()
        if (answer === undefined) throw new Error(`No answer for "${options.message}"`)
        if (answer !== approve) return answer
        const page = transcript.flatMap((line) => /(http:\/\/\S+\/cli-login\?\S+)/.exec(line) ?? [])
        return hub.approve(page.at(-1) ?? "")
      }),
  }
  return { ui, transcript }
}
const approve = Symbol("approve")

/** Runs `effect` with `ui` and `shell`, collecting what it prints to stdout and stderr. */
async function run<A, E>(
  effect: Effect.Effect<A, E, Ui | Shell>,
  ui: UiShape,
  shell = browserShell({}, false),
) {
  const printed: Array<string> = []
  const console = Object.assign(Object.create(globalThis.console), {
    log: (...args: ReadonlyArray<unknown>) => printed.push(args.join(" ")),
    error: (...args: ReadonlyArray<unknown>) => printed.push(`stderr: ${args.join(" ")}`),
  })
  const exit = await Effect.runPromiseExit(
    effect.pipe(
      Effect.provideService(Ui, ui),
      Effect.provideService(Shell, shell),
      Effect.provideService(Console.Console, console),
    ),
  )
  return { exit, printed }
}

const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "it succeeded"

const mode = (path: string) => statSync(path).mode & 0o777

describe("login", () => {
  test("on a laptop: the browser comes back with the code, and nothing is typed", async () => {
    const browser: Browser = {}
    const { ui, transcript } = scriptedUi([NoAnswer])
    const { exit } = await run(
      login({ hub: hub.url, noBrowser: false }, laptop()),
      ui,
      browserShell(browser, true),
    )
    expect(failure(exit)).toBe("it succeeded")

    const page = new URL(browser.opened ?? "")
    expect(page.origin).toBe(hub.url)
    expect(page.pathname).toBe("/cli-login")
    expect(page.searchParams.get("machine")).toBe("laptop")
    expect(page.searchParams.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Number(page.searchParams.get("port"))).toBeGreaterThan(0)

    // The browser goes on to the Hub's done page.
    expect(await browser.answered).toEqual({
      status: 302,
      location: `${hub.url}/cli-login/done?machine=laptop`,
    })
    const token = hub.issued[0] ?? ""
    expect(readCliConfig(configPath)).toEqual({ hub: hub.url, token })
    expect(mode(configPath)).toBe(0o600)
    expect(mode(dirname(configPath))).toBe(0o700)
    expect(transcript.join("\n")).toContain(`Signed in to ${hub.url} as alice, on laptop.`)
    expect(transcript.join("\n")).not.toContain(token)
  })

  test("without a terminal to paste into, still signs in through the browser", async () => {
    const browser: Browser = {}
    const { ui } = scriptedUi([], { interactive: false })
    const { exit } = await run(
      login({ hub: hub.url, noBrowser: false }, laptop()),
      ui,
      browserShell(browser, true),
    )
    expect(failure(exit)).toBe("it succeeded")
    expect((await browser.answered)?.status).toBe(302)
  })

  test("takes the pasted code when the browser can't come back to the CLI", async () => {
    const browser: Browser = {}
    const { ui, transcript } = pastingUi([approve])
    const { exit } = await run(
      login({ hub: hub.url, noBrowser: false }, laptop()),
      ui,
      browserShell(browser, false),
    )
    expect(failure(exit)).toBe("it succeeded")
    expect(browser.opened).toContain("port=")
    expect(transcript).toContain(
      "? text: Waiting for the browser. Or paste the code the page shows",
    )
    expect(readCliConfig(configPath).token).toBe(hub.issued[0] ?? "missing")
  })

  test("over SSH, opens no browser and asks for the code the page shows", async () => {
    const browser: Browser = {}
    const { ui, transcript } = pastingUi([approve])
    const { exit } = await run(
      login({ hub: hub.url, noBrowser: false }, overSshContext()),
      ui,
      browserShell(browser, true),
    )
    expect(failure(exit)).toBe("it succeeded")
    expect(browser.opened).toBeUndefined()
    const note = transcript.find((line) => line.startsWith("note:")) ?? ""
    const page = new URL(/(http:\/\/\S+)/.exec(note)?.[1] ?? "")
    expect(page.searchParams.get("machine")).toBe("laptop")
    expect(page.searchParams.has("port")).toBe(false)
    expect(transcript).toContain("? text: Paste the code the page shows")
    expect(readCliConfig(configPath).token).toBe(hub.issued[0] ?? "missing")
  })

  test("--no-browser goes straight to the code, and a mistyped one is asked for again", async () => {
    const browser: Browser = {}
    const { ui, transcript } = pastingUi(["ZZZZ-ZZZZ-ZZZZ-ZZZZ", approve])
    const { exit } = await run(
      login({ hub: hub.url, noBrowser: true }, laptop()),
      ui,
      browserShell(browser, true),
    )
    expect(failure(exit)).toBe("it succeeded")
    expect(browser.opened).toBeUndefined()
    expect(transcript).toContain("warn: That code isn't one the Hub gave out, or it expired.")
    expect(transcript).toContain(
      "? text: Paste the code again, or approve again on the page for a new one",
    )
    expect(hub.issued).toHaveLength(1)
  })

  test("refuses a code approved for another login's challenge", async () => {
    const other = loginPageUrl(hub.url, { machine: "laptop", challenge: newPkce().challenge })
    const stolen = hub.approve(other)
    const { ui } = pastingUi([stolen, stolen, stolen])
    const { exit } = await run(login({ hub: hub.url, noBrowser: true }, laptop()), ui)
    expect(failure(exit)).toContain("That code isn't one the Hub gave out")
    expect(hub.issued).toEqual([])
    expect(readCliConfig(configPath)).toEqual({})
  })

  test("--no-browser without a terminal says it needs one", async () => {
    const { ui } = scriptedUi([], { interactive: false })
    const { exit } = await run(login({ hub: hub.url, noBrowser: true }, laptop()), ui)
    expect(failure(exit)).toContain("claude-hub login needs a terminal to paste the code into")
  })

  test("signs in to the Hub the CLI was installed from when none is given", async () => {
    await Effect.runPromise(writeCliConfig(configPath, { hub: hub.url }))
    const { ui } = pastingUi([approve])
    const { exit } = await run(login({ hub: undefined, noBrowser: true }, laptop()), ui)
    expect(failure(exit)).toBe("it succeeded")
    expect(readCliConfig(configPath).hub).toBe(hub.url)
  })

  test("asks which Hub when it knows none", async () => {
    const { ui } = scriptedUi([])
    const { exit } = await run(login({ hub: undefined, noBrowser: true }, laptop()), ui)
    expect(failure(exit)).toContain("Say which Hub to sign in to")
    const bad = await run(login({ hub: "ftp://hub.test", noBrowser: true }, laptop()), ui)
    expect(failure(bad.exit)).toContain("isn't a Hub's http:// or https:// URL")
  })

  test("signing in again revokes the CLI token it had", async () => {
    for (let i = 0; i < 2; i++) {
      const { ui } = pastingUi([approve])
      const { exit } = await run(login({ hub: hub.url, noBrowser: true }, laptop()), ui)
      expect(failure(exit)).toBe("it succeeded")
    }
    const [first, second] = hub.issued
    expect(hub.isRevoked(first ?? "")).toBe(true)
    expect(hub.isRevoked(second ?? "")).toBe(false)
    expect(readCliConfig(configPath).token).toBe(second ?? "missing")
  })
})

describe("the callback", () => {
  test("is refused without the state the CLI made, or for another host name", async () => {
    const opened = Promise.withResolvers<string>()
    const shell = Shell.of({
      dryRun: false,
      capture: (s: Step) =>
        Effect.sync(() => {
          opened.resolve(s.args[0] ?? "")
          return { exitCode: 0, stdout: "", stderr: "" }
        }),
      attached: () => Effect.succeed(0),
    })
    // The prompt is answered only once the probes below are done, with a code approved for real.
    const probes = Promise.withResolvers<void>()
    const scripted = pastingUi([approve])
    const ui: UiShape = {
      ...scripted.ui,
      text: (options) =>
        Effect.andThen(
          Effect.promise(() => probes.promise),
          scripted.ui.text(options),
        ),
    }
    const done = run(login({ hub: hub.url, noBrowser: false }, laptop()), ui, shell)
    const port = new URL(await opened.promise).searchParams.get("port")
    const base = `http://127.0.0.1:${port}${CallbackPath}`

    const wrongState = await fetch(`${base}?code=ABCD-EFGH-JKMN-0001&state=nope`)
    expect(wrongState.status).toBe(400)
    const otherHost = await fetch(`${base}?code=x&state=y`, {
      headers: { host: "evil.test" },
    })
    expect(otherHost.status).toBe(404)
    const otherPath = await fetch(`http://127.0.0.1:${port}/`)
    expect(otherPath.status).toBe(404)

    probes.resolve()
    expect(failure((await done).exit)).toBe("it succeeded")
    expect(hub.issued).toHaveLength(1)
  })
})

/** Signs the CLI in with a pasted code; the token it got. */
async function signedIn() {
  const { ui } = pastingUi([approve])
  const { exit } = await run(login({ hub: hub.url, noBrowser: true }, laptop()), ui)
  expect(failure(exit)).toBe("it succeeded")
  return hub.issued.at(-1) ?? ""
}

describe("logout and whoami", () => {
  test("whoami says the Hub, the account and the machine", async () => {
    const token = await signedIn()
    const { exit, printed } = await run(whoami(laptop()), scriptedUi([]).ui)
    expect(failure(exit)).toBe("it succeeded")
    expect(printed).toEqual([
      `Hub:     ${hub.url}\nAccount: alice (Alice Kim)\nMachine: laptop, signed in 2026-10-06`,
    ])
    expect(printed.join("\n")).not.toContain(token)
  })

  test("logout revokes the token and forgets it, keeping the Hub the CLI updates from", async () => {
    const token = await signedIn()
    const { exit, printed } = await run(logout(laptop()), scriptedUi([]).ui)
    expect(failure(exit)).toBe("it succeeded")
    expect(hub.isRevoked(token)).toBe(true)
    expect(readCliConfig(configPath)).toEqual({ hub: hub.url })
    expect(mode(configPath)).toBe(0o600)
    expect(printed[0]).toStartWith(`Signed out of ${hub.url}`)

    const after = await run(whoami(laptop()), scriptedUi([]).ui)
    expect(failure(after.exit)).toContain("The CLI isn't signed in to a Hub")
    const again = await run(logout(laptop()), scriptedUi([]).ui)
    expect(again.printed).toEqual(["The CLI isn't signed in to a Hub."])
  })

  test("whoami says when the token was revoked on the Account page", async () => {
    const token = await signedIn()
    await fetch(`${hub.url}/auth/cli/sign-out`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    })
    const { exit } = await run(whoami(laptop()), scriptedUi([]).ui)
    expect(failure(exit)).toContain("doesn't accept this machine's CLI token: it was revoked")
  })

  test("logout still forgets the token when the Hub can't be reached", async () => {
    await Effect.runPromise(
      writeCliConfig(configPath, { hub: "http://127.0.0.1:9", token: "chc_x.unreachable" }),
    )
    const { exit, printed } = await run(logout(laptop()), scriptedUi([]).ui)
    expect(failure(exit)).toBe("it succeeded")
    expect(readCliConfig(configPath)).toEqual({ hub: "http://127.0.0.1:9" })
    expect(printed[0]).toStartWith("stderr: Couldn't revoke the CLI token")
    expect(printed.join("\n")).not.toContain("chc_x.unreachable")
  })
})

describe("the CLI's config", () => {
  test("is written 0600 in a 0700 directory, replacing a file anyone could read", async () => {
    await Effect.runPromise(writeCliConfig(configPath, { hub: "https://hub.test" }))
    await writeFile(configPath, '{"hub":"https://hub.test"}\n', {
      mode: 0o644,
    })
    await Effect.runPromise(writeCliConfig(configPath, { hub: "https://hub.test", token: "t" }))
    expect(mode(configPath)).toBe(0o600)
    expect(mode(dirname(configPath))).toBe(0o700)
    // Compact, so the install script still finds "hub":"<url>" in it.
    expect(await readFile(configPath, "utf8")).toBe('{"hub":"https://hub.test","token":"t"}\n')
  })
})

describe("helpers", () => {
  test("reads a Hub's origin from what was typed", () => {
    expect(hubOrigin("hub.example.com")).toBe("https://hub.example.com")
    expect(hubOrigin("http://127.0.0.1:8787/some/page")).toBe("http://127.0.0.1:8787")
    expect(hubOrigin("ftp://hub.example.com")).toBeUndefined()
    expect(hubOrigin("  ")).toBeUndefined()
  })

  test("makes a PKCE verifier and its S256 challenge", () => {
    const { verifier, challenge } = newPkce(() => new Uint8Array(32))
    expect(verifier).toBe("A".repeat(43))
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"))
    expect(newPkce().challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test("knows when it runs over SSH", () => {
    expect(overSsh({ SSH_TTY: "/dev/pts/0" })).toBe(true)
    expect(overSsh({ SSH_CLIENT: "10.0.0.2 50000 22" })).toBe(true)
    expect(overSsh({})).toBe(false)
  })
})
