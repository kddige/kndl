// Onboard's questions and the env files they write, driven by a script of answers in a throwaway
// home. Nothing here runs a command: Shell is a stand-in.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type PairingTarget, RunnerId } from "@claude-hub/protocol"
import { Cause, Effect, Exit } from "effect"
import { envValues, parseEnv } from "./EnvFile.ts"
import { dateStamp } from "./HomeData.ts"
import { HubClient } from "./HubClient.ts"
import type { PairOutcome } from "./Join.ts"
import { type Layout, resolveLayout } from "./Layout.ts"
import { configure, type OnboardOptions } from "./OnboardFlow.ts"
import { Shell } from "./Shell.ts"
import { CancelAnswer, scriptedUi, Ui } from "./Ui.ts"

const none: OnboardOptions = {
  role: undefined,
  reach: undefined,
  port: undefined,
  publicUrl: undefined,
  insecureCookies: undefined,
  devLogin: undefined,
  githubApp: undefined,
  hubUrl: undefined,
  token: undefined,
  pair: undefined,
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
  scratch = await mkdtemp(join(tmpdir(), "claude-hub-onboard-"))
  const userHome = join(scratch, "user")
  layout = resolveLayout({ CLAUDE_HUB_HOME: join(userHome, ".claude-hub") }, userHome)
  mkdirSync(join(layout.app, ".git"), { recursive: true })
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

/** A Shell that runs nothing: every command it is asked to capture fails. */
const fakeShell = Shell.of({
  dryRun: true,
  capture: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "not run" }),
  attached: () => Effect.succeed(0),
})

/** The redemptions the stand-in Hub was asked for, in order. */
let redemptions: Array<{ readonly target: PairingTarget; readonly name: string }> = []

/** A Hub that answers every redemption with `outcome`, given the name asked for. */
const standInHub = (outcome: (name: string) => PairOutcome) =>
  HubClient.of({
    pair: (target, name) =>
      Effect.sync(() => {
        redemptions.push({ target, name })
        return outcome(name)
      }),
    connection: () => Effect.die(new Error("not asked in configure")),
  })

const paired = (name: string, repaired = false): PairOutcome => ({
  _tag: "Paired",
  paired: { runnerId: RunnerId.make("r-1"), name, token: "chr_paired", repaired },
})

beforeEach(() => {
  redemptions = []
})

/** Runs onboard's questions against `answers`. */
function run(
  answers: ReadonlyArray<unknown>,
  options: Partial<OnboardOptions> = {},
  settings: {
    readonly interactive?: boolean
    readonly hub?: (name: string) => PairOutcome
  } = {},
) {
  const { ui, transcript } = scriptedUi(answers, settings)
  return Effect.runPromiseExit(
    configure(layout, { ...none, ...options }).pipe(
      Effect.provideService(Ui, ui),
      Effect.provideService(Shell, fakeShell),
      Effect.provideService(HubClient, standInHub(settings.hub ?? paired)),
    ),
  ).then((exit) => ({ exit, transcript }))
}

const env = (role: "hub" | "runner") =>
  envValues(parseEnv(readFileSync(layout.envFile(role), "utf8")))

const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

describe("onboard, answered from a script", () => {
  test("a Hub on the LAN: hub.env from the answers, readable only by its user", async () => {
    const { exit, transcript } = await run(["hub", "lan", "http://192.168.1.20:7777", true, "skip"])

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(env("hub")).toMatchObject({
      HOST: "0.0.0.0",
      PORT: "7777",
      HUB_PUBLIC_URL: "http://192.168.1.20:7777",
      HUB_INSECURE_COOKIES: "1",
    })
    expect(env("hub").HUB_SECRETS_KEY).toMatch(/^\S{40,}$/)
    expect(statSync(layout.envFile("hub")).mode & 0o777).toBe(0o600)
    expect(existsSync(layout.envFile("runner"))).toBe(false)
    expect(transcript).toContain("? confirm: Set HUB_INSECURE_COOKIES=1?")
  })

  test("a Runner for a Hub elsewhere: runner.env from the URL and token", async () => {
    const { exit } = await run(["runner", "token", "https://hub.example.com", "chr_secret"], {
      runnerName: "mac",
    })

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(env("runner")).toEqual({
      HUB_URL: "https://hub.example.com",
      RUNNER_TOKEN: "chr_secret",
      RUNNER_NAME: "mac",
    })
    expect(existsSync(layout.envFile("hub"))).toBe(false)
  })

  test("both on one machine: the Runner gets a token issued by the new Hub", async () => {
    const { exit } = await run(["both", "local", true, "skip"], { runnerName: "mac" })

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(env("hub")).toMatchObject({
      HOST: "127.0.0.1",
      HUB_PUBLIC_URL: "http://127.0.0.1:7777",
      CLAUDE_HUB_DEV_LOGIN: "1",
    })
    expect(env("runner")).toMatchObject({ HUB_URL: "http://127.0.0.1:7777", RUNNER_NAME: "mac" })
    expect(env("runner").RUNNER_TOKEN).toMatch(/^chr_/)
  })

  test("a run again keeps the settings, and asks nothing", async () => {
    await run(["hub", "lan", "http://192.168.1.20:7777", false, "skip"])
    const key = env("hub").HUB_SECRETS_KEY
    const { exit, transcript } = await run([])

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(transcript.filter((line) => line.startsWith("?"))).toEqual([])
    expect(env("hub").HUB_SECRETS_KEY).toBe(key)
  })

  test("cancelled at a question: nothing is written", async () => {
    const { exit } = await run(["both", "lan", CancelAnswer])

    expect(failure(exit)).toMatchObject({ _tag: "Cancelled" })
    expect(readdirSync(layout.home.dir).toSorted()).toEqual(["app"])
  })

  test("without a terminal, a missing answer fails naming its flag", async () => {
    const { exit } = await run([], {}, { interactive: false })

    expect(failure(exit)).toMatchObject({ _tag: "CliFailure" })
    expect(String((failure(exit) as { message: string }).message)).toContain("--role")
  })
})

const link = "https://hub.example.com#7K3QH-WM2PA-B4XZC-9DFGR"
const code = "7K3QHWM2PAB4XZC9DFGR"

describe("onboard with a pairing link", () => {
  test("redeems it, without asking anything, and writes runner.env from the Hub's answer", async () => {
    const { exit, transcript } = await run(
      [],
      { pair: link, runnerName: "mac" },
      { interactive: false },
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(redemptions).toEqual([
      { target: { hubUrl: "https://hub.example.com", code }, name: "mac" },
    ])
    expect(env("runner")).toEqual({
      HUB_URL: "https://hub.example.com",
      RUNNER_TOKEN: "chr_paired",
      RUNNER_NAME: "mac",
    })
    expect(statSync(layout.envFile("runner")).mode & 0o777).toBe(0o600)
    expect(transcript.filter((line) => line.startsWith("?"))).toEqual([])
  })

  test("a Re-pair's code keeps the Runner's own name, whatever was asked for", async () => {
    const { exit } = await run(
      [],
      { pair: link, runnerName: "mac" },
      {
        interactive: false,
        hub: () => paired("studio", true),
      },
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(env("runner").RUNNER_NAME).toBe("studio")
  })

  test("replaces the token and Hub of a Runner set up before", async () => {
    writeFileSync(
      layout.envFile("runner"),
      "HUB_URL=http://old-hub:7777\nRUNNER_TOKEN=chr_old\nRUNNER_NAME=mac\nRUNNER_SESSIONS_ROOT=/work\n",
    )
    const { exit } = await run([], { pair: link }, { interactive: false })

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(redemptions.map((r) => r.name)).toEqual(["mac"])
    expect(env("runner")).toEqual({
      HUB_URL: "https://hub.example.com",
      RUNNER_TOKEN: "chr_paired",
      RUNNER_NAME: "mac",
      RUNNER_SESSIONS_ROOT: "/work",
    })
  })

  test("a refused code fails with the Hub's reason, writing nothing", async () => {
    const { exit } = await run(
      [],
      { pair: link },
      {
        interactive: false,
        hub: () => ({ _tag: "Refused", message: "That pairing code can't be used" }),
      },
    )

    expect(String((failure(exit) as { message: string }).message)).toBe(
      "That pairing code can't be used",
    )
    expect(existsSync(layout.envFile("runner"))).toBe(false)
  })

  test("a link that isn't one fails before the Hub is asked", async () => {
    const { exit } = await run([], { pair: "https://hub.example.com#nope" }, { interactive: false })

    expect(String((failure(exit) as { message: string }).message)).toContain(
      "isn't a whole pairing code",
    )
    expect(redemptions).toEqual([])
  })

  test("a code alone needs --hub-url", async () => {
    const alone = await run([], { pair: "7k3qh-wm2pa-b4xzc-9dfgr" }, { interactive: false })
    expect(String((failure(alone.exit) as { message: string }).message)).toContain("Hub's URL")

    const withUrl = await run(
      [],
      { pair: "7k3qh-wm2pa-b4xzc-9dfgr", hubUrl: "http://10.0.0.5:7777/" },
      { interactive: false },
    )
    expect(Exit.isSuccess(withUrl.exit)).toBe(true)
    expect(redemptions.at(-1)?.target).toEqual({ hubUrl: "http://10.0.0.5:7777", code })
  })

  test("goes only with --role runner", async () => {
    const { exit } = await run([], { pair: link, role: "both" }, { interactive: false })

    expect(String((failure(exit) as { message: string }).message)).toContain("--role runner")
    expect(redemptions).toEqual([])
  })

  test("asked for: a Runner chooses a pairing link over a token", async () => {
    const { exit, transcript } = await run(["runner", "pair", link], { runnerName: "mac" })

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(transcript).toContain("? select: How does this Runner get its token?")
    expect(env("runner").RUNNER_TOKEN).toBe("chr_paired")
  })

  test("without a terminal or flags, a Runner fails naming --pair", async () => {
    const { exit } = await run([], { role: "runner" }, { interactive: false })

    expect(String((failure(exit) as { message: string }).message)).toContain("--pair")
  })
})

/** A home as a checkout's Runner left it, before checkouts had a dev home. */
const oldHome = () => {
  mkdirSync(join(layout.sessions, "s1"), { recursive: true })
  writeFileSync(join(layout.sessions, "s1", "work.txt"), "old work")
  mkdirSync(layout.claudeCode, { recursive: true })
  writeFileSync(join(layout.claudeCode, "settings.json"), "{}")
  writeFileSync(join(layout.home.dir, "github-app.pem"), "key")
}

describe("onboard on a home with old data", () => {
  const stamp = dateStamp(new Date())

  test("moves it aside after a choice and a confirmation, deleting nothing", async () => {
    oldHome()
    const { exit, transcript } = await run(
      ["runner", "move", true, "token", "https://hub.example.com", "chr_secret"],
      { runnerName: "mac" },
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(transcript.some((line) => line.startsWith("note: Old claude-hub data:"))).toBe(true)
    expect(
      readFileSync(join(layout.home.dir, `sessions.old-${stamp}`, "s1", "work.txt"), "utf8"),
    ).toBe("old work")
    expect(existsSync(join(layout.home.dir, `claude-code.old-${stamp}`, "settings.json"))).toBe(
      true,
    )
    expect(existsSync(layout.sessions)).toBe(false)
    expect(existsSync(join(layout.home.dir, "github-app.pem"))).toBe(true)
    expect(env("runner").RUNNER_TOKEN).toBe("chr_secret")
  })

  test("stops when the person picks another home, changing nothing", async () => {
    oldHome()
    const { exit } = await run(["runner", "stop"])

    expect(failure(exit)).toMatchObject({ _tag: "CliFailure" })
    expect(readdirSync(layout.home.dir).toSorted()).toEqual([
      "app",
      "claude-code",
      "github-app.pem",
      "sessions",
    ])
  })

  test("cancelled at a later question: nothing is moved yet", async () => {
    oldHome()
    const { exit } = await run(["runner", "move", true, CancelAnswer])

    expect(failure(exit)).toMatchObject({ _tag: "Cancelled" })
    expect(existsSync(join(layout.sessions, "s1", "work.txt"))).toBe(true)
    expect(existsSync(layout.envFile("runner"))).toBe(false)
  })

  test("a no at the confirmation changes nothing", async () => {
    oldHome()
    const { exit } = await run(["runner", "move", false])

    expect(failure(exit)).toMatchObject({ _tag: "CliFailure" })
    expect(existsSync(join(layout.sessions, "s1", "work.txt"))).toBe(true)
  })

  test("without a terminal it fails naming --move-old-data, and moves nothing", async () => {
    oldHome()
    const { exit } = await run([], { role: "runner" }, { interactive: false })

    expect(String((failure(exit) as { message: string }).message)).toContain("--move-old-data")
    expect(existsSync(join(layout.sessions, "s1", "work.txt"))).toBe(true)
  })

  test("with --move-old-data it moves it without asking", async () => {
    oldHome()
    const { exit } = await run(
      [],
      {
        role: "runner",
        moveOldData: true,
        hubUrl: "https://hub.example.com",
        token: "chr_secret",
      },
      { interactive: false },
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(existsSync(join(layout.home.dir, `sessions.old-${stamp}`, "s1", "work.txt"))).toBe(true)
  })
})
