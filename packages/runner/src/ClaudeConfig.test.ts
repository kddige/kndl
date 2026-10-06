import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import {
  claudeConfigPath,
  forgetDirectories,
  hostTranscriptPath,
  accountFromClaudeConfig,
  planFromClaudeConfig,
} from "./ClaudeConfig.ts"

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "kndl-config-")))

const forget = (configPath: string, directories: ReadonlyArray<string>) =>
  Effect.runPromise(forgetDirectories(configPath, directories))

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>

/** A config file shaped like Claude Code's. */
const setup = (config: Record<string, unknown>) => {
  const dir = tempDir()
  const path = join(dir, ".claude.json")
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return { dir, path }
}

describe("forgetting directories", () => {
  test("removes their entries, keeping other projects, top-level keys, the mode and the format", async () => {
    const { dir, path } = setup({
      numStartups: 107,
      oauthAccount: { emailAddress: "a@example.com" },
      projects: {
        "/home/a/app": { allowedTools: ["Bash"], hasTrustDialogAccepted: true },
        "/sessions/s-1/claude": { allowedTools: [], lastCost: 1.5 },
      },
    })

    await forget(path, ["/sessions/s-1/claude", "/sessions/s-2/claude"])

    expect(readJson(path)).toEqual({
      numStartups: 107,
      oauthAccount: { emailAddress: "a@example.com" },
      projects: { "/home/a/app": { allowedTools: ["Bash"], hasTrustDialogAccepted: true } },
    })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, "utf8")).toStartWith('{\n  "numStartups": 107,')
    expect(readFileSync(path, "utf8")).toEndWith("}\n")
    // The temp file is gone.
    expect(readdirSync(dir)).toEqual([".claude.json"])
  })

  test("does nothing when none of them is there", async () => {
    const { path } = setup({ projects: { "/home/a/app": {} } })
    // Written compactly, so any rewrite would show.
    writeFileSync(path, JSON.stringify(readJson(path)))
    const before = readFileSync(path, "utf8")

    await forget(path, ["/sessions/s-1/claude"])

    expect(readFileSync(path, "utf8")).toBe(before)
  })

  test("never creates a missing config file", async () => {
    const path = join(tempDir(), ".claude.json")

    await forget(path, ["/sessions/s-1/claude"])

    expect(existsSync(path)).toBe(false)
  })

  test("writes through a symlinked config file, keeping the link", async () => {
    const { dir, path } = setup({ projects: { "/sessions/s-1/claude": {} } })
    const link = join(dir, "linked.json")
    symlinkSync(path, link)

    await forget(link, ["/sessions/s-1/claude"])

    expect(realpathSync(link)).toBe(path)
    expect(readJson(path)).toEqual({ projects: {} })
  })

  test("refuses a config file that isn't a JSON object, leaving it alone", async () => {
    const { path } = setup({})
    writeFileSync(path, "[1, 2")

    const result = await Effect.runPromise(
      Effect.result(forgetDirectories(path, ["/sessions/s-1/claude"])),
    )

    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ClaudeConfigError" } })
    expect(readFileSync(path, "utf8")).toBe("[1, 2")
  })
})

const none = () => false
const legacyOnly = (path: string) => path.endsWith("/.config.json")

describe("Claude Code's config file", () => {
  test("is ~/.claude.json by default", () => {
    expect(claudeConfigPath({}, none)).toBe(join(homedir(), ".claude.json"))
  })

  test("is in CLAUDE_CONFIG_DIR when set, as Claude Code reads it", () => {
    expect(claudeConfigPath({ CLAUDE_CONFIG_DIR: "/cfg" }, none)).toBe("/cfg/.claude.json")
  })

  test("is a legacy .config.json in the config directory when one exists", () => {
    expect(claudeConfigPath({ CLAUDE_CONFIG_DIR: "/cfg" }, legacyOnly)).toBe("/cfg/.config.json")
    expect(claudeConfigPath({}, legacyOnly)).toBe(join(homedir(), ".claude", ".config.json"))
  })

  test("has a suffix under a custom OAuth URL", () => {
    expect(
      claudeConfigPath(
        { CLAUDE_CONFIG_DIR: "/cfg", CLAUDE_CODE_CUSTOM_OAUTH_URL: "https://x" },
        none,
      ),
    ).toBe("/cfg/.claude-custom-oauth.json")
  })
})

describe("planFromClaudeConfig", () => {
  test("is the signed-in account's plan, with its rate-limit tier", () => {
    expect(
      planFromClaudeConfig({
        oauthAccount: {
          organizationType: "claude_max",
          organizationRateLimitTier: "default_claude_max_20x",
        },
      }),
    ).toEqual({ subscriptionType: "max", rateLimitTier: "default_claude_max_20x" })
    expect(planFromClaudeConfig({ oauthAccount: { organizationType: "claude_pro" } })).toEqual({
      subscriptionType: "pro",
    })
  })

  test("is unknown without a subscription", () => {
    expect(planFromClaudeConfig({})).toBeUndefined()
    expect(planFromClaudeConfig({ oauthAccount: { organizationType: "api" } })).toBeUndefined()
    expect(
      planFromClaudeConfig({ oauthAccount: { organizationType: "constructor" } }),
    ).toBeUndefined()
  })
})

describe("accountFromClaudeConfig", () => {
  test("is the signed-in account", () => {
    expect(accountFromClaudeConfig({ oauthAccount: { emailAddress: "a@example.com" } })).toBe(
      "a@example.com",
    )
    expect(accountFromClaudeConfig({})).toBeUndefined()
  })
})

/** A Session's `claude` directory, also reached through a symlink, as macOS's /tmp is. */
function setupProjects() {
  const dir = tempDir()
  const real = join(dir, "real", "s-1", "claude")
  mkdirSync(real, { recursive: true })
  symlinkSync(join(dir, "real"), join(dir, "link"))
  return { projects: join(dir, "projects"), real, linked: join(dir, "link", "s-1", "claude") }
}

function writeTranscript(projects: string, cwd: string, id: string) {
  const folder = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"))
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, `${id}.jsonl`), "{}\n")
}

describe("hostTranscriptPath", () => {
  test("is undefined until Claude Code wrote the conversation's transcript for the directory", () => {
    const { projects, real } = setupProjects()
    expect(hostTranscriptPath(real, "conv-1", projects)).toBeUndefined()
    writeTranscript(projects, real, "conv-2")
    expect(hostTranscriptPath(real, "conv-1", projects)).toBeUndefined()
    writeTranscript(projects, real, "conv-1")
    expect(hostTranscriptPath(real, "conv-1", projects)).toBe(
      join(projects, real.replace(/[^a-zA-Z0-9]/g, "-"), "conv-1.jsonl"),
    )
  })

  test("finds the transcript under the directory's real path", () => {
    const { projects, real, linked } = setupProjects()
    writeTranscript(projects, real, "conv-1")
    expect(hostTranscriptPath(linked, "conv-1", projects)).toBe(
      join(projects, real.replace(/[^a-zA-Z0-9]/g, "-"), "conv-1.jsonl"),
    )
  })

  test("finds none for a directory too long to name the way Claude Code does", () => {
    const { projects } = setupProjects()
    expect(hostTranscriptPath(`/${"a".repeat(240)}`, "conv-1", projects)).toBeUndefined()
  })
})
