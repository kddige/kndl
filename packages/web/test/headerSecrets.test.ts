// An MCP server's header secrets (#215) as the MCP page sees them: the key a title gives, which
// values an Installation needs, and whose values an edit to the MCP server clears.

import { describe, expect, test } from "bun:test"
import type { Installation, McpServer, McpServerAuth } from "@kndl/protocol"
import { clearedValues, keyFromTitle, neededText, valuesNeeded } from "../src/mcp/headerSecrets.ts"

const auth: McpServerAuth = {
  _tag: "Headers",
  headers: [
    { key: "api_key", title: "API key", header: "Authorization", template: "Bearer {value}" },
    { key: "team", title: "Team", header: "X-Team", template: "{value}" },
  ],
}
const by = { login: "alice", name: "Alice", avatarUrl: "" }
const mcpServer = {
  name: "Acme",
  url: "https://mcp.acme.example/mcp",
  auth,
} as unknown as McpServer
const installation = (name: string, keys: ReadonlyArray<string>) =>
  ({ name, values: keys.map((key) => ({ key, setBy: by, setAt: 0 })) }) as unknown as Installation

describe("keyFromTitle", () => {
  test("joins a title's letters and digits with underscores", () => {
    expect(keyFromTitle("API key")).toBe("api_key")
    expect(keyFromTitle("  Sentry auth-token!")).toBe("sentry_auth_token")
    expect(keyFromTitle("Clé d'accès")).toBe("cle_d_acces")
  })

  test("starts with a letter, as a key must", () => {
    expect(keyFromTitle("2nd key")).toBe("secret_2nd_key")
    expect(keyFromTitle("")).toBe("secret")
    expect(keyFromTitle("🔑")).toBe("secret")
  })
})

test("says which header secrets an Installation needs a value for", () => {
  const needed = valuesNeeded(mcpServer, installation("Acme", ["api_key"]))
  expect(needed.map((secret) => secret.title)).toEqual(["Team"])
  expect(neededText(needed)).toBe("Team needs a value")
  expect(neededText(valuesNeeded(mcpServer, installation("Acme", [])))).toBe(
    "API key and Team need values",
  )
})

describe("clearedValues", () => {
  const installations = [installation("Acme", ["api_key", "team"]), installation("Empty", [])]

  test("a URL on another server clears every value; another path keeps them", () => {
    expect(
      clearedValues(mcpServer, installations, { url: "https://mcp.acme.example/v2", auth }),
    ).toEqual([])
    expect(
      clearedValues(mcpServer, installations, { url: "https://acme.example/mcp", auth }),
    ).toEqual([{ installation: "Acme", secrets: ["API key", "Team"] }])
    expect(
      clearedValues(mcpServer, installations, { url: "https://mcp.acme.example:8443/mcp", auth }),
    ).toEqual([{ installation: "Acme", secrets: ["API key", "Team"] }])
  })

  test("a header secret removed, or sent in another header, clears its values", () => {
    const [apiKey, team] = auth._tag === "Headers" ? auth.headers : []
    if (apiKey === undefined || team === undefined) throw new Error("No header secrets")
    const after = (headers: McpServerAuth) => ({ url: mcpServer.url, auth: headers })
    expect(
      clearedValues(mcpServer, installations, after({ _tag: "Headers", headers: [apiKey] })),
    ).toEqual([{ installation: "Acme", secrets: ["Team"] }])
    expect(
      clearedValues(
        mcpServer,
        installations,
        after({ _tag: "Headers", headers: [{ ...apiKey, header: "X-Api-Key" }, team] }),
      ),
    ).toEqual([{ installation: "Acme", secrets: ["API key"] }])
    // A new title or template keeps the value.
    expect(
      clearedValues(
        mcpServer,
        installations,
        after({
          _tag: "Headers",
          headers: [{ ...apiKey, title: "Key", template: "Token {value}" }, team],
        }),
      ),
    ).toEqual([])
  })
})
