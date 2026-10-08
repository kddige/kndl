import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  GatewayServer,
  gatewayPath,
  hubPluginId,
  installationReposProblem,
  mcpServerNames,
  pluginNameProblem,
  pluginSlug,
  pluginUrlProblem,
} from "./Plugin.ts"
import { WebToHub } from "./Web.ts"

describe("a Hub-only Plugin's id", () => {
  test("is hub: and a slug of its name", () => {
    expect(hubPluginId(pluginSlug("Docs Search"))).toBe(hubPluginId("docs-search"))
    expect(hubPluginId("docs-search") as string).toBe("hub:docs-search")
    expect(pluginSlug("  Linear (Work) ")).toBe("linear-work")
    expect(pluginSlug("Ünïcode Ñame")).toBe("unicode-name")
    expect(pluginSlug("!!!")).toBe("plugin")
    expect(pluginSlug("a".repeat(100))).toHaveLength(40)
  })

  test("is no npm package name: those can't hold a colon", () => {
    const npmName = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
    expect(npmName.test(hubPluginId(pluginSlug("Docs")))).toBe(false)
  })
})

describe("the rules the web UI shows before sending", () => {
  test("a name is one non-empty line", () => {
    expect(pluginNameProblem("Docs search")).toBeUndefined()
    expect(pluginNameProblem("  ")).toBe("A Plugin needs a name.")
    expect(pluginNameProblem("a\nb", "An Installation")).toBe(
      "An Installation's name must be one line.",
    )
    expect(pluginNameProblem("a".repeat(81))).toContain("longer than 80")
  })

  test("a URL is http(s), without credentials or a fragment", () => {
    expect(pluginUrlProblem("https://mcp.example.com/mcp")).toBeUndefined()
    expect(pluginUrlProblem("http://127.0.0.1:8931/mcp")).toBeUndefined()
    expect(pluginUrlProblem("mcp.example.com")).toContain("isn't a URL")
    expect(pluginUrlProblem("ftp://mcp.example.com")).toContain("https://")
    expect(pluginUrlProblem("https://me:secret@mcp.example.com")).toContain("user name")
    expect(pluginUrlProblem("https://mcp.example.com/#x")).toContain("fragment")
  })

  test("an Installation lists each Repo once, by any spelling", () => {
    expect(installationReposProblem(["kddige/kndl"])).toBeUndefined()
    expect(installationReposProblem([])).toContain("at least one Repo")
    expect(installationReposProblem(["kddige/kndl", "KDDIGE/kndl"])).toBe(
      "KDDIGE/kndl is listed twice.",
    )
  })
})

test("a Plugin command is a web command", () => {
  const decode = Schema.decodeUnknownSync(WebToHub)
  expect(decode({ _tag: "GetPlugins", requestId: "r1" })).toEqual({
    _tag: "GetPlugins",
    requestId: "r1",
  } as never)
  expect(WebToHub.cases.CreateInstallation).toBeDefined()
})

test("an MCP server's name is a slug, and its path the Installation's", () => {
  const decode = Schema.decodeUnknownSync(GatewayServer)
  expect(decode({ installationId: "i1", server: "docs-search" }).server).toBe("docs-search")
  expect(() => decode({ installationId: "i1", server: "Docs Search" })).toThrow()
  expect(gatewayPath("i 1")).toBe("/gateway/i%201")
  expect(mcpServerNames(["Docs", "docs", "Linear Work", "DOCS"])).toEqual([
    "docs",
    "docs-2",
    "linear-work",
    "docs-3",
  ])
})
