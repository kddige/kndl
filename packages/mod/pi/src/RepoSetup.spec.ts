import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claudeSkills, installationServers } from "./RepoSetup.ts"

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("the Session's MCP servers (ADR 0020, ADR 0029)", () => {
  test("each Installation's is at the Gateway, through the relay, on the Session token pi reads from its environment", () => {
    const servers = installationServers(
      JSON.stringify([
        { installationId: "inst-1", server: "linear" },
        { installationId: "in st/2", server: "linear-2" },
      ]),
      "http://relay.test:7778/",
    )
    expect(servers).toEqual([
      {
        name: "kndl-linear",
        config: {
          url: "http://relay.test:7778/gateway/inst-1",
          headers: { Authorization: "Bearer ${KNDL_MOD_TOKEN}" },
        },
      },
      {
        name: "kndl-linear-2",
        config: {
          url: "http://relay.test:7778/gateway/in%20st%2F2",
          headers: { Authorization: "Bearer ${KNDL_MOD_TOKEN}" },
        },
      },
    ])
    // Nothing secret in them: the token stays in pi's environment.
    expect(JSON.stringify(servers)).not.toContain("tok")
  })

  test("none when the Runner gave none, or gave what isn't a list of them", () => {
    const said: Array<string> = []
    expect(installationServers(undefined, "http://relay.test")).toEqual([])
    expect(installationServers("", "http://relay.test")).toEqual([])
    expect(installationServers("not json", "http://relay.test", (text) => said.push(text))).toEqual(
      [],
    )
    expect(
      installationServers('[{"installationId":"i","server":"Bad Name"}]', "http://relay.test"),
    ).toEqual([])
    expect(said).toEqual([expect.stringContaining("KNDL_MCP_SERVERS")])
  })
})

describe("the Repo's Claude Code skills (ADR 0029)", () => {
  test("load from the Workspace's .claude/skills, when it has one", () => {
    const workspace = mkdtempSync(join(tmpdir(), "kndl-repo-"))
    dirs.push(workspace)
    expect(claudeSkills(workspace)).toBeUndefined()
    mkdirSync(join(workspace, ".claude", "skills"), { recursive: true })
    expect(claudeSkills(workspace)).toBe(join(workspace, ".claude", "skills"))
  })
})
