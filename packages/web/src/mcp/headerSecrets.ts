// An MCP server's header secrets (#215) as the MCP page shows and edits them: which of an
// Installation's need a value, the key a new one gets from its title, and whose values an edit to
// the MCP server would clear, as the Hub clears them.

import {
  clearedHeaderSecrets,
  type HeaderSecret,
  headerSecretsOf,
  type Installation,
  type McpServer,
  type McpServerAuth,
} from "@kndl/protocol"
import { andList } from "../app/format.ts"

/** The header secrets of `mcpServer` that `installation` has no value for. */
export const valuesNeeded = (
  mcpServer: McpServer,
  installation: Installation,
): ReadonlyArray<HeaderSecret> =>
  headerSecretsOf(mcpServer.auth).filter(
    (secret) => !installation.values.some((value) => value.key === secret.key),
  )

/** "API key needs a value", "API key and Team need values". */
export const neededText = (needed: ReadonlyArray<HeaderSecret>) =>
  `${andList(needed.map((secret) => secret.title))} ${needed.length === 1 ? "needs a value" : "need values"}`

/** The key a header secret titled `title` gets: its letters and digits, joined by underscores. */
export function keyFromTitle(title: string): string {
  const words = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "")
  const key = words.join("_").slice(0, 40)
  return /^[a-z]/.test(key) ? key : `secret${key === "" ? "" : `_${key}`}`
}

/** An Installation whose values an edit clears, and the titles of those. */
export interface ClearedValues {
  readonly installation: string
  readonly secrets: ReadonlyArray<string>
}

/**
 * The values that saving `mcpServer` as `after` clears on each of its Installations: all of them
 * for a URL on another origin, else those of each header secret whose key is gone or whose header
 * is another.
 */
export function clearedValues(
  mcpServer: McpServer,
  installations: ReadonlyArray<Installation>,
  after: { readonly url: string; readonly auth: McpServerAuth },
): ReadonlyArray<ClearedValues> {
  const cleared = clearedHeaderSecrets(mcpServer, after)
  return installations.flatMap((installation) => {
    const secrets = cleared
      .filter((secret) => installation.values.some((value) => value.key === secret.key))
      .map((secret) => secret.title)
    return secrets.length > 0 ? [{ installation: installation.name, secrets }] : []
  })
}
