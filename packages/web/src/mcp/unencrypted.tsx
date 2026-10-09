// Warnings for an MCP server at a plain http URL to a host other than loopback (#255). Such a
// URL is allowed, as for an MCP server on a LAN that only speaks http, but what the Hub sends it,
// credentials included, crosses the network unencrypted. So the page says so where the URL is
// entered, and most clearly where an Installation's credentials are set.

import { headerSecretsOf, type McpServer, mcpServerUrlUnencrypted } from "@kndl/protocol"
import { Banner, WarningIcon } from "../ui/index.ts"

/** Says, where an MCP server's URL is entered or read, that it is unencrypted, if it is. */
export function UnencryptedUrlBanner({ url }: { url: string }) {
  if (!mcpServerUrlUnencrypted(url)) return null
  return (
    <Banner intent="warning" icon={<WarningIcon />} title="Sent unencrypted">
      It's plain http, so the Hub's requests to this server, with any header secret or OAuth token,
      and its answers cross the network unencrypted: anyone on the network path between the Hub and
      the server can read them. That can be fine on a network you trust, such as a LAN; use https
      where the server offers it.
    </Banner>
  )
}

/** Says, where an Installation's credentials are set, that the Hub sends them unencrypted. */
export function UnencryptedCredentialsBanner({ mcpServer }: { mcpServer: McpServer }) {
  if (!mcpServerUrlUnencrypted(mcpServer.url)) return null
  if (mcpServer.auth._tag === "OAuth") {
    return (
      <Banner
        intent="warning"
        icon={<WarningIcon />}
        title="The account's token is sent unencrypted"
      >
        {mcpServer.name} is at an http URL, so the Hub sends the access token of the account it
        connects to with every request, unencrypted. Anyone on the network path between the Hub and
        the server can read it, and act as that account. Connect it only on a network you trust; use
        https where the server offers it.
      </Banner>
    )
  }
  if (headerSecretsOf(mcpServer.auth).length === 0) return null
  return (
    <Banner
      intent="warning"
      icon={<WarningIcon />}
      title="Header secret values are sent unencrypted"
    >
      {mcpServer.name} is at an http URL, so the Hub sends these values to it with every request,
      unencrypted. Anyone on the network path between the Hub and the server can read them, and use
      them. Enter them only on a network you trust; use https where the server offers it.
    </Banner>
  )
}
