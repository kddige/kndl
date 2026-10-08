// An OAuth Installation's account (#217), as the Plugins page and a Session's banner show it. The
// Hub connects it: Connect sends the browser to the server's authorization server to sign in and
// consent, which sends it back through the Hub to the Plugins page. The tokens stay on the Hub, so
// the page shows only whose account it is, who connected it and when, or that it needs connecting.
// The account is shared: every Session in the Installation's Repos acts as it.

import { clearsConnections, type Installation, type Plugin, type PluginAuth } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { useRouter } from "@tanstack/react-router"
import { andList, timeAgo } from "../app/format.ts"
import { useHub } from "../app/hub.tsx"
import { Badge, Banner, WarningIcon } from "../ui/index.ts"
import { color, space, text } from "../ui/tokens.stylex.ts"

const styles = stylex.create({
  line: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s1_5,
    color: color.textMuted,
    fontSize: text.sm,
  },
})

/**
 * Begins connecting an Installation: sends the browser to its authorization server. The fake Hub
 * has none, and sends it straight back within the web UI.
 */
export function useConnect(): (installation: Installation) => Promise<void> {
  const hub = useHub()
  const router = useRouter()
  return async (installation) => {
    const url = await hub.connectInstallation(installation.id)
    if (url.startsWith("/")) router.history.push(url)
    else window.location.assign(url)
  }
}

/** An OAuth Installation's account: whose, who connected it and when, or why it needs connecting. */
export function ConnectionLine({
  plugin,
  installation,
}: {
  plugin: Plugin
  installation: Installation
}) {
  if (plugin.auth._tag !== "OAuth") return null
  const { connection } = installation
  return (
    <div aria-label={`Account of ${installation.name}`} {...stylex.props(styles.line)}>
      {connection === undefined ? (
        <>
          <Badge intent="danger">not connected</Badge>
          <span>Its Repos' Sessions don't start until someone connects it to an account.</span>
        </>
      ) : connection.lostAt !== undefined ? (
        <>
          <Badge intent="danger">connection lost</Badge>
          <span title={new Date(connection.lostAt).toLocaleString()}>
            The authorization server stopped taking it {timeAgo(connection.lostAt)}: reconnect it.
          </span>
        </>
      ) : (
        <>
          <Badge intent="success">connected</Badge>
          <span title={new Date(connection.connectedAt).toLocaleString()}>
            as {connection.account ?? "an account the server didn't name"}, by{" "}
            {connection.connectedBy.name} {timeAgo(connection.connectedAt)}. Every Session in its
            Repos acts as this account.
          </span>
        </>
      )}
    </div>
  )
}

/** The connected Installations of `plugin` that saving it as `after` disconnects, by name. */
export function disconnected(
  plugin: Plugin,
  installations: ReadonlyArray<Installation>,
  after: { readonly url: string; readonly auth: PluginAuth },
): ReadonlyArray<string> {
  if (!clearsConnections(plugin, after)) return []
  return installations
    .filter((one) => one.pluginId === plugin.id && one.connection !== undefined)
    .map((one) => one.name)
}

/** Says which Installations a change to their Plugin disconnects, before it does. */
export function DisconnectsBanner({
  names,
  verb,
}: {
  names: ReadonlyArray<string>
  verb: "Saving" | "Upgrading"
}) {
  if (names.length === 0) return null
  return (
    <Banner intent="warning" icon={<WarningIcon />} title={`${verb} disconnects ${andList(names)}`}>
      The Hub drops the tokens and the client it registered: they were granted for the server as it
      is, and must not reach another. Each needs connecting again, and until it is, its Repos'
      Sessions don't start.
    </Banner>
  )
}
