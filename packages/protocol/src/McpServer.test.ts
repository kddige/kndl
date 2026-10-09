import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { InstallationId } from "./Ids.ts"
import {
  clearedHeaderSecrets,
  failureBlocksStart,
  GatewayServer,
  gatewayPath,
  type HeaderSecret,
  headerValueProblem,
  hubMcpServerId,
  type InstallationFailure,
  installationFailureText,
  installationReposProblem,
  installationsCantStartText,
  installationsFor,
  isLoopback,
  isOn,
  mcpServerNames,
  oauthClientProblem,
  type McpServerAuth,
  mcpServerAuthProblem,
  mcpServerNameProblem,
  mcpServerSlug,
  mcpServerUrlProblem,
  mcpServerUrlUnencrypted,
} from "./McpServer.ts"
import { SandboxNoted, SessionStateChanged, WebToHub } from "./Web.ts"

describe("a Hub-only MCP server's id", () => {
  test("is hub: and a slug of its name", () => {
    expect(hubMcpServerId(mcpServerSlug("Docs Search"))).toBe(hubMcpServerId("docs-search"))
    expect(hubMcpServerId("docs-search") as string).toBe("hub:docs-search")
    expect(mcpServerSlug("  Linear (Work) ")).toBe("linear-work")
    expect(mcpServerSlug("Ünïcode Ñame")).toBe("unicode-name")
    expect(mcpServerSlug("!!!")).toBe("mcp-server")
    expect(mcpServerSlug("a".repeat(100))).toHaveLength(40)
  })

  test("is no npm package name: those can't hold a colon", () => {
    const npmName = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
    expect(npmName.test(hubMcpServerId(mcpServerSlug("Docs")))).toBe(false)
  })
})

describe("the rules the web UI shows before sending", () => {
  test("a name is one non-empty line", () => {
    expect(mcpServerNameProblem("Docs search")).toBeUndefined()
    expect(mcpServerNameProblem("  ")).toBe("An MCP server needs a name.")
    expect(mcpServerNameProblem("a\nb", "An Installation")).toBe(
      "An Installation's name must be one line.",
    )
    expect(mcpServerNameProblem("a".repeat(81))).toContain("longer than 80")
  })

  test("a URL is http(s), without credentials or a fragment", () => {
    expect(mcpServerUrlProblem("https://mcp.example.com/mcp")).toBeUndefined()
    expect(mcpServerUrlProblem("http://127.0.0.1:8931/mcp")).toBeUndefined()
    expect(mcpServerUrlProblem("mcp.example.com")).toContain("isn't a URL")
    expect(mcpServerUrlProblem("ftp://mcp.example.com")).toContain("https://")
    expect(mcpServerUrlProblem("https://me:secret@mcp.example.com")).toContain("user name")
    expect(mcpServerUrlProblem("https://mcp.example.com/#x")).toContain("fragment")
  })

  test("a URL is sent unencrypted when it is http to a host other than loopback", () => {
    expect(mcpServerUrlUnencrypted("http://192.168.1.20:8931/mcp")).toBe(true)
    expect(mcpServerUrlUnencrypted("http://10.0.0.5/mcp")).toBe(true)
    expect(mcpServerUrlUnencrypted("http://mcp.example.com/mcp")).toBe(true)
    expect(mcpServerUrlUnencrypted("http://nas.local:3000/mcp")).toBe(true)
    expect(mcpServerUrlUnencrypted("http://[fe80::1]/mcp")).toBe(true)
    // Only a literal loopback host counts, never a name that may resolve to one.
    expect(mcpServerUrlUnencrypted("http://localhost.example.com/mcp")).toBe(true)
    expect(mcpServerUrlUnencrypted("http://localhost:8931/mcp")).toBe(false)
    expect(mcpServerUrlUnencrypted("http://LOCALHOST/mcp")).toBe(false)
    expect(mcpServerUrlUnencrypted("http://127.0.0.1:8931/mcp")).toBe(false)
    expect(mcpServerUrlUnencrypted("http://127.42.0.9/mcp")).toBe(false)
    expect(mcpServerUrlUnencrypted("http://[::1]:8931/mcp")).toBe(false)
    expect(mcpServerUrlUnencrypted("https://mcp.example.com/mcp")).toBe(false)
    expect(mcpServerUrlUnencrypted("https://192.168.1.20/mcp")).toBe(false)
    expect(mcpServerUrlUnencrypted("mcp.example.com")).toBe(false)
    expect(mcpServerUrlUnencrypted("")).toBe(false)
  })

  test("a host is loopback when it is localhost or a loopback address, literally", () => {
    expect(isLoopback("localhost")).toBe(true)
    expect(isLoopback("127.0.0.1")).toBe(true)
    expect(isLoopback("127.255.0.1")).toBe(true)
    expect(isLoopback("[::1]")).toBe(true)
    expect(isLoopback("::1")).toBe(true)
    expect(isLoopback("0:0:0:0:0:0:0:1")).toBe(true)
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true)
    expect(isLoopback("0.0.0.0")).toBe(false)
    expect(isLoopback("192.168.1.20")).toBe(false)
    expect(isLoopback("localhost.example.com")).toBe(false)
  })

  test("an Installation lists each Repo once, by any spelling", () => {
    expect(installationReposProblem(["kddige/kndl"])).toBeUndefined()
    expect(installationReposProblem([])).toContain("at least one Repo")
    expect(installationReposProblem(["kddige/kndl", "KDDIGE/kndl"])).toBe(
      "KDDIGE/kndl is listed twice.",
    )
  })
})

test("an MCP server command is a web command", () => {
  const decode = Schema.decodeUnknownSync(WebToHub)
  expect(decode({ _tag: "GetMcpServers", requestId: "r1" })).toEqual({
    _tag: "GetMcpServers",
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

const headers = (...declared: Array<HeaderSecret>): McpServerAuth => ({
  _tag: "Headers",
  headers: declared,
})

describe("an MCP server's header secrets", () => {
  const apiKey: HeaderSecret = {
    key: "api_key",
    title: "API key",
    header: "Authorization",
    template: "Bearer {value}",
  }
  const team: HeaderSecret = { key: "team", title: "Team", header: "X-Team", template: "{value}" }

  test("are declared with a key, a title, a header and a template holding {value} once", () => {
    expect(mcpServerAuthProblem({ _tag: "None" })).toBeUndefined()
    expect(mcpServerAuthProblem(headers(apiKey))).toBeUndefined()
    expect(mcpServerAuthProblem(headers({ ...apiKey, template: "{value}" }))).toBeUndefined()
    expect(mcpServerAuthProblem(headers())).toBe("Declare at least one header secret, or none.")
    expect(mcpServerAuthProblem(headers({ ...apiKey, key: "1st" }))).toBe(
      '"1st" isn\'t a key: use letters, digits and underscores, starting with a letter.',
    )
    expect(mcpServerAuthProblem(headers({ ...apiKey, title: " " }))).toBe(
      "A header secret needs a title.",
    )
    expect(mcpServerAuthProblem(headers({ ...apiKey, header: "Bad Header" }))).toBe(
      '"Bad Header" isn\'t a header name.',
    )
    expect(mcpServerAuthProblem(headers({ ...apiKey, header: "Content-Length" }))).toBe(
      "The Gateway sets Content-Length itself: use another header.",
    )
    expect(mcpServerAuthProblem(headers({ ...apiKey, template: "Bearer" }))).toBe(
      "API key's template must hold {value} exactly once, as in Bearer {value}.",
    )
    expect(mcpServerAuthProblem(headers({ ...apiKey, template: "{value}{value}" }))).toContain(
      "exactly once",
    )
    expect(mcpServerAuthProblem(headers({ ...apiKey, template: "Bearer\n{value}" }))).toBe(
      "API key's template must be one line of plain characters.",
    )
  })

  test("have keys and headers unique in the MCP server, headers by any case", () => {
    expect(mcpServerAuthProblem(headers(apiKey, team))).toBeUndefined()
    expect(mcpServerAuthProblem(headers(apiKey, { ...team, key: "api_key" }))).toBe(
      "The key api_key is declared twice.",
    )
    expect(mcpServerAuthProblem(headers(apiKey, { ...team, header: "authorization" }))).toBe(
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

  test("take an OAuth client entered by hand of one word each, a secret long enough to redact (#218)", () => {
    expect(oauthClientProblem("Iv1.0a1b2c3d4e5f")).toBeUndefined()
    expect(oauthClientProblem("Iv1.0a1b2c3d4e5f", "0123456789abcdef")).toBeUndefined()
    expect(oauthClientProblem("  ")).toBe("Enter the client ID.")
    expect(oauthClientProblem("my client")).toBe(
      "The client ID must be one word of plain characters, with no spaces.",
    )
    expect(oauthClientProblem("Iv1", "abc")).toBe(
      "The client secret is under 4 characters: too short to redact from output.",
    )
    expect(oauthClientProblem("Iv1", "abc\ndef")).toBe(
      "The client secret must be one word of plain characters, with no spaces.",
    )
  })

  test("lose their values when the URL's origin changes, or their header", () => {
    const before = { url: "https://mcp.example.com/mcp", auth: headers(apiKey, team) }
    const keys = (after: { readonly url: string; readonly auth: McpServerAuth }) =>
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

/** Linear failing a Session, as `fields` say. */
const failure = (fields: Partial<InstallationFailure>): InstallationFailure => ({
  installationId: InstallationId.make("ins-1"),
  installation: "Linear",
  reason: "ValueNeeded",
  ...fields,
})

describe("an Installation that fails a Session (#216)", () => {
  test("says which, and why, without a value", () => {
    expect(
      installationFailureText(failure({ reason: "ValueNeeded", secrets: ["API key", "Team"] })),
    ).toBe("Linear needs a value for API key and Team.")
    expect(installationFailureText(failure({ reason: "Rejected", status: 401 }))).toBe(
      "Linear's MCP server refused its credential (401).",
    )
    expect(installationFailureText(failure({ reason: "Unreachable" }))).toBe(
      "Linear's MCP server could not be reached.",
    )
    expect(installationFailureText(failure({ reason: "Errored", status: 503 }))).toBe(
      "Linear's MCP server answered 503.",
    )
    expect(installationFailureText(failure({ reason: "Unreadable" }))).toBe(
      "The Hub could not read Linear's header secret values: check HUB_SECRETS_KEY.",
    )
  })

  test("blocks a start when it is sure the Installation can't work", () => {
    expect(failureBlocksStart(failure({ reason: "ValueNeeded" }))).toBe(true)
    expect(failureBlocksStart(failure({ reason: "Rejected", status: 403 }))).toBe(true)
    expect(failureBlocksStart(failure({ reason: "Unreadable" }))).toBe(true)
    // A flaky server doesn't block work.
    expect(failureBlocksStart(failure({ reason: "Unreachable" }))).toBe(false)
    expect(failureBlocksStart(failure({ reason: "Errored", status: 500 }))).toBe(false)
  })

  test("says how to get the Session started", () => {
    expect(installationsCantStartText("acme/app", [failure({ secrets: ["API key"] })])).toBe(
      "Linear needs a value for API key. Fix the Installation on the MCP page, or take acme/app off it, then wake the Session.",
    )
    const sentry = failure({ installation: "Sentry", reason: "Rejected", status: 403 })
    expect(installationsCantStartText("acme/app", [failure({ secrets: ["Team"] }), sentry])).toBe(
      "Linear needs a value for Team. Sentry's MCP server refused its credential (403). Fix the Installations on the MCP page, or take acme/app off them, then wake the Session.",
    )
  })

  test("says to turn a global Installation off rather than leave it (#219)", () => {
    const global = failure({ secrets: ["API key"], global: true })
    expect(installationsCantStartText("acme/app", [global])).toBe(
      "Linear needs a value for API key. Fix the Installation on the MCP page, or turn it off for acme/app, then wake the Session.",
    )
    const sentry = failure({ installation: "Sentry", reason: "Rejected", status: 403 })
    expect(installationsCantStartText("acme/app", [global, sentry])).toEndWith(
      "Fix the Installations on the MCP page, or take acme/app off them or turn them off for it, then wake the Session.",
    )
  })

  test("rides on events a web UI of the version before reads all the same", () => {
    const changed = {
      _tag: "SessionStateChanged",
      state: "Asleep",
      message: "Claude Code could not start: Linear needs a value for API key.",
      installationsFailed: [failure({ secrets: ["API key"] })],
    }
    expect(Schema.decodeUnknownSync(SessionStateChanged)(changed)).toEqual(
      changed as SessionStateChanged,
    )
    const noted = {
      _tag: "SandboxNoted",
      message: "Linear's MCP server could not be reached.",
      installationFailed: failure({ reason: "Unreachable" }),
    }
    expect(Schema.decodeUnknownSync(SandboxNoted)(noted)).toEqual(noted as SandboxNoted)
    // The version before has neither field: it ignores them, and shows the message.
    const before = Schema.Struct({ _tag: Schema.Literal("SandboxNoted"), message: Schema.String })
    expect(Schema.decodeUnknownSync(before)(noted)).toEqual({
      _tag: "SandboxNoted",
      message: noted.message,
    })
  })
})

/** An Installation as {@link installationsFor} resolves it. */
const install = (
  id: string,
  mcpServerId: string,
  repos: ReadonlyArray<string>,
  more: { readonly global?: boolean; readonly off?: ReadonlyArray<string> } = {},
) => ({ id, mcpServerId, repos, ...more })

describe("the Installations on for a Repo (#219)", () => {
  const docs = install("docs", "hub:docs", [], { global: true, off: ["acme/Quiet"] })
  const linear = install("linear", "hub:linear", [], { global: true })
  const linearWork = install("linear-work", "hub:linear", ["Acme/App"])
  const sentry = install("sentry", "hub:sentry", ["acme/other"])
  const all = [docs, linear, linearWork, sentry]
  const resolved = (repo: string) =>
    installationsFor(all, repo).map(({ installation, source }) => [installation.id, source])

  test("a global one is on in every Repo, even one never seen", () => {
    expect(resolved("someone/new")).toEqual([
      ["docs", "Global"],
      ["linear", "Global"],
    ])
  })

  test("a Repo-scoped one of the same MCP server takes a global's place, by any spelling", () => {
    expect(resolved("acme/app")).toEqual([
      ["docs", "Global"],
      ["linear", "Overridden"],
      ["linear-work", "Repo"],
    ])
  })

  test("a Repo that turned a global one off has it off, by any spelling", () => {
    expect(resolved("ACME/quiet")).toEqual([
      ["docs", "Off"],
      ["linear", "Global"],
    ])
  })

  test("only the global ones and the Repo-scoped ones that list it are on", () => {
    expect(
      installationsFor(all, "acme/app")
        .filter(({ source }) => isOn(source))
        .map(({ installation }) => installation.id),
    ).toEqual(["docs", "linear-work"])
  })
})
