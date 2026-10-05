import { expect, test } from "bun:test"
import type { BranchName, RepoName, SessionId } from "@claude-hub/protocol"
import { claudeLaunch, ModEnvironment } from "./ClaudeLaunch.ts"

test("the mod reads every variable the Runner sets for it, by the same name", async () => {
  // The loader lists a hooks module's variables from its literal `$.env.get` calls, so the mod
  // can't share these names as constants.
  const glue = await Bun.file(new URL("../../mod/hooks/register.ts", import.meta.url)).text()
  for (const name of Object.values(ModEnvironment)) expect(glue).toContain(`$.env.get("${name}")`)
})

const options = {
  claudeBin: "/usr/local/bin/claude",
  modDir: "/opt/claude-hub/mod",
  hubUrl: new URL("https://hub.example"),
  sessionId: "s-1" as SessionId,
  modToken: "mod-token",
  toolsSocket: "/tmp/tools.sock",
  repoFiles: "/tmp/repo-files",
  repo: "kddige/claude-hub" as RepoName,
  workBranch: "claude/s-1" as BranchName,
  conversation: { _tag: "New", id: "3c1f6f0e-claude" },
} as const

test("Claude Code's default model and effort are left to it", () => {
  const { argv } = claudeLaunch(options)
  expect(argv).not.toContain("--model")
  expect(argv).not.toContain("--effort")
})

test("the Session's model and effort go as flags, so they never reach settings.json", () => {
  const { argv } = claudeLaunch({ ...options, model: "opus[1m]", effort: "xhigh" })
  expect(argv.slice(-4)).toEqual(["--model", "opus[1m]", "--effort", "xhigh"])
  expect(claudeLaunch({ ...options, effort: "low" }).argv.slice(-2)).toEqual(["--effort", "low"])
})
