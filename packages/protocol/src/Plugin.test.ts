import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  clearedHeaderSecrets,
  GatewayServer,
  gatewayPath,
  type HeaderSecret,
  headerValueProblem,
  hubPluginId,
  installationReposProblem,
  mcpServerNames,
  type PluginAuth,
  pluginAuthProblem,
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

const headers = (...declared: Array<HeaderSecret>): PluginAuth => ({
  _tag: "Headers",
  headers: declared,
})

describe("a Plugin's header secrets", () => {
  const apiKey: HeaderSecret = {
    key: "api_key",
    title: "API key",
    header: "Authorization",
    template: "Bearer {value}",
  }
  const team: HeaderSecret = { key: "team", title: "Team", header: "X-Team", template: "{value}" }

  test("are declared with a key, a title, a header and a template holding {value} once", () => {
    expect(pluginAuthProblem({ _tag: "None" })).toBeUndefined()
    expect(pluginAuthProblem(headers(apiKey))).toBeUndefined()
    expect(pluginAuthProblem(headers({ ...apiKey, template: "{value}" }))).toBeUndefined()
    expect(pluginAuthProblem(headers())).toBe("Declare at least one header secret, or none.")
    expect(pluginAuthProblem(headers({ ...apiKey, key: "1st" }))).toBe(
      '"1st" isn\'t a key: use letters, digits and underscores, starting with a letter.',
    )
    expect(pluginAuthProblem(headers({ ...apiKey, title: " " }))).toBe(
      "A header secret needs a title.",
    )
    expect(pluginAuthProblem(headers({ ...apiKey, header: "Bad Header" }))).toBe(
      '"Bad Header" isn\'t a header name.',
    )
    expect(pluginAuthProblem(headers({ ...apiKey, header: "Content-Length" }))).toBe(
      "The Gateway sets Content-Length itself: use another header.",
    )
    expect(pluginAuthProblem(headers({ ...apiKey, template: "Bearer" }))).toBe(
      "API key's template must hold {value} exactly once, as in Bearer {value}.",
    )
    expect(pluginAuthProblem(headers({ ...apiKey, template: "{value}{value}" }))).toContain(
      "exactly once",
    )
    expect(pluginAuthProblem(headers({ ...apiKey, template: "Bearer\n{value}" }))).toBe(
      "API key's template must be one line of plain characters.",
    )
  })

  test("have keys and headers unique in the Plugin, headers by any case", () => {
    expect(pluginAuthProblem(headers(apiKey, team))).toBeUndefined()
    expect(pluginAuthProblem(headers(apiKey, { ...team, key: "api_key" }))).toBe(
      "The key api_key is declared twice.",
    )
    expect(pluginAuthProblem(headers(apiKey, { ...team, header: "authorization" }))).toBe(
      "The header authorization is declared twice.",
    )
  })

  test("take a value of plain characters, long enough to redact", () => {
    expect(headerValueProblem("API key", "lin_api_1234")).toBeUndefined()
    expect(headerValueProblem("API key", "abc")).toBe(
      "The value of API key is under 4 characters: too short to redact from output.",
    )
    expect(headerValueProblem("API key", "abc\ndef")).toBe(
      "The value of API key must be one line of plain characters.",
    )
  })

  test("lose their values when the URL's origin changes, or their header", () => {
    const before = { url: "https://mcp.example.com/mcp", auth: headers(apiKey, team) }
    const keys = (after: { readonly url: string; readonly auth: PluginAuth }) =>
      clearedHeaderSecrets(before, after).map((secret) => secret.key)
    // The path, a title or a template may change, and the header's case.
    expect(keys({ ...before, url: "https://MCP.example.com:443/v2/mcp?x=1" })).toEqual([])
    expect(
      keys({
        ...before,
        auth: headers({ ...apiKey, title: "Key", template: "Tok {value}" }, team),
      }),
    ).toEqual([])
    expect(
      keys({ ...before, auth: headers({ ...apiKey, header: "AUTHORIZATION" }, team) }),
    ).toEqual([])
    // Another scheme, host or port would send them elsewhere.
    for (const url of [
      "http://mcp.example.com/mcp",
      "https://evil.example.com/mcp",
      "https://mcp.example.com:8443/mcp",
    ]) {
      expect(keys({ ...before, url })).toEqual(["api_key", "team"])
    }
    // So would another header; a key removed or renamed loses its value.
    expect(keys({ ...before, auth: headers({ ...apiKey, header: "X-Api-Key" }, team) })).toEqual([
      "api_key",
    ])
    expect(keys({ ...before, auth: headers(team) })).toEqual(["api_key"])
    expect(keys({ ...before, auth: headers({ ...apiKey, key: "key" }, team) })).toEqual(["api_key"])
    expect(keys({ ...before, auth: { _tag: "None" } })).toEqual(["api_key", "team"])
  })
})
