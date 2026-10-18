// A Repo's MCP servers, on its Repo page (ADR 0020): the Installations for it, whose MCP servers
// Claude Code in its Sessions gets, each saying which of its header secrets need a value, and
// where it comes from (#219): listed for this Repo, or global, on in every Repo but where a
// Repo-scoped one of its MCP server takes its place or the Repo turned it off. Anyone with access
// to the Repo turns a global one off for it, or back on. And its MCP server change log: who
// created, edited, added or removed an Installation here, or set or cleared its header secret
// values (by title, never the values), and when; a global one's changes show in every Repo's.

import {
  type Installation,
  type InstallationSource,
  installationsFor,
  type McpServerLogEntry,
  repoKey,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { andList, timeAgo } from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import { Avatar, Badge, type BadgeIntent, Button, Spinner, toast, textRole } from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, radius, space, text, weight } from "../ui/tokens.stylex.ts"
import { neededText, valuesNeeded } from "./headerSecrets.ts"

const styles = stylex.create({
  part: { display: "flex", flexDirection: "column", gap: space.s2 },
  heading: { margin: 0 },
  list: { display: "flex", flexDirection: "column", margin: 0, padding: 0, listStyle: "none" },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    flexWrap: "wrap",
    paddingBlock: space.s2,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: color.border,
    fontSize: text.sm,
  },
  first: { borderTopWidth: 0 },
  name: { fontWeight: weight.semibold },
  notOn: { opacity: 0.7 },
  muted: { color: color.textSecondary, fontSize: text.sm },
  grow: { flex: 1, minWidth: 0 },
  link: {
    color: color.accentText,
    textDecoration: { default: "none", ":hover": "underline" },
    borderRadius: radius.sm,
  },
})

/** What a change log entry says happened, after who did it. */
export function mcpServerChangeText(entry: McpServerLogEntry): string {
  const { installationName: installation, mcpServerName: mcpServer } = entry
  const an = entry.global === true ? "a global Installation" : "an Installation"
  switch (entry.change) {
    case "Created":
      return `created ${installation}, ${an} of ${mcpServer}`
    case "Added":
      return `put ${installation}, an Installation of ${mcpServer}, on in this Repo`
    case "Renamed":
      return `renamed ${an} of ${mcpServer} to ${installation}`
    case "Removed":
      return `took ${installation}, an Installation of ${mcpServer}, off this Repo`
    case "Deleted":
      return `deleted ${installation}, ${an} of ${mcpServer}`
    case "MadeGlobal":
      return `made ${installation}, an Installation of ${mcpServer}, global: on in every Repo`
    case "MadeRepoScoped":
      return `made ${installation}, an Installation of ${mcpServer}, on only in the Repos it lists`
    case "TurnedOff":
      return `turned ${installation}, a global Installation of ${mcpServer}, off for this Repo`
    case "TurnedOn":
      return `turned ${installation}, a global Installation of ${mcpServer}, back on for this Repo`
    case "McpServerEdited":
      return `edited ${mcpServer}, the MCP server of ${installation}`
    case "ValuesSet":
      return `set ${installation}'s ${valuesText(entry.secrets)}`
    case "ValuesCleared":
      return `cleared ${installation}'s ${valuesText(entry.secrets)}, as ${mcpServer} changed`
    case "McpServerUpgraded":
      return `upgraded ${mcpServer}, the MCP server of ${installation}, to ${entry.mcpServerVersion ?? "a new version"}`
    case "Connected":
      return `connected ${installation} to its account at ${mcpServer}`
    case "ClientSet":
      return `entered the OAuth client ${installation} connects to ${mcpServer} with`
    case "Reconnected":
      return `reconnected ${installation} to its account at ${mcpServer}`
    case "Disconnected":
      return `disconnected ${installation} from its account at ${mcpServer}`
  }
}

/** The header secrets whose values a change set or cleared, by title: never their values. */
const valuesText = (secrets: ReadonlyArray<string> | undefined) =>
  secrets === undefined || secrets.length === 0
    ? "header secret values"
    : `${secrets.length === 1 ? "value" : "values"} of ${andList(secrets)}`

/** How the badge of an Installation from that source reads, if it has one. */
const sourceBadges: Record<InstallationSource, { label: string; intent: BadgeIntent } | null> = {
  Repo: null,
  Global: { label: "Global", intent: "neutral" },
  Overridden: { label: "Overridden", intent: "neutral" },
  Off: { label: "Off", intent: "neutral" },
}

/** The Installations for `repo`, and its MCP server change log, both kept fresh by the Hub. */
export function RepoMcpServers({ repo }: { repo: string }) {
  const hub = useHub()
  const online = useHubState((state) => state.connection.status === "online")
  const mcpServers = useHubState((state) => state.mcpServers)
  const log = useHubState((state) => state.mcpServerLogs[repoKey(repo)])
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (!online) return
    // Shown as empty for now: the Hub refuses only a Repo the person lost access to.
    hub.getMcpServers().catch(() => undefined)
    hub.getMcpServerLog(repo).catch(() => undefined)
  }, [hub, repo, online])

  /** Turns a global Installation off for this Repo, or back on (#219). */
  const turn = async (installation: Installation, on: boolean) => {
    setBusy(installation.id)
    try {
      await hub.turnGlobalInstallation(installation.id, repo, on)
      toast.show({
        title: `Turned ${installation.name} ${on ? "back on" : "off"} for ${repo}`,
        description: "Its Sessions pick it up on their next wake or restart.",
      })
    } catch (error) {
      toast.show({
        title: `Couldn't turn ${installation.name} ${on ? "on" : "off"}`,
        description: error instanceof Error ? error.message : String(error),
        intent: "danger",
      })
    } finally {
      setBusy(null)
    }
  }

  const on = mcpServers === null ? null : installationsFor(mcpServers.installations, repo)
  const mcpServerOf = (id: string) =>
    mcpServers?.mcpServers.find((mcpServer) => mcpServer.id === id)
  /** The Repo-scoped Installation of the MCP server that takes a global one's place here. */
  const overriddenBy = (installation: Installation) =>
    on?.find(
      (other) =>
        other.source === "Repo" && other.installation.mcpServerId === installation.mcpServerId,
    )?.installation.name
  return (
    <>
      <div {...stylex.props(styles.part)}>
        {on === null ? (
          <Spinner label="Loading the Installations" />
        ) : on.length === 0 ? (
          <p {...stylex.props(styles.muted)}>
            No Installation is on for this Repo.{" "}
            <Link to="/mcp" {...stylex.props(styles.link, focus.ring)}>
              Install a McpServer
            </Link>
          </p>
        ) : (
          <ul aria-label="Installations for this Repo" {...stylex.props(styles.list)}>
            {on.map(({ installation, source }, index) => {
              const mcpServer = mcpServerOf(installation.mcpServerId)
              const needed = mcpServer === undefined ? [] : valuesNeeded(mcpServer, installation)
              const badge = sourceBadges[source]
              const isOn = source === "Repo" || source === "Global"
              return (
                <li
                  key={installation.id}
                  aria-label={installation.name}
                  {...stylex.props(styles.row, index === 0 && styles.first)}
                >
                  <span {...stylex.props(styles.name, !isOn && styles.notOn)}>
                    {installation.name}
                  </span>
                  <span {...stylex.props(styles.muted, styles.grow)}>
                    {mcpServer?.name ?? installation.mcpServerId}
                    {source === "Overridden" &&
                      `: ${overriddenBy(installation) ?? "a Repo-scoped Installation"} takes its place here`}
                    {source === "Off" && ", turned off for this Repo"}
                  </span>
                  {badge !== null && <Badge intent={badge.intent}>{badge.label}</Badge>}
                  {isOn && needed.length > 0 && <Badge intent="danger">{neededText(needed)}</Badge>}
                  {(source === "Global" || source === "Off") && (
                    <Button
                      size="sm"
                      intent="ghost"
                      loading={busy === installation.id}
                      onClick={() => void turn(installation, source === "Off")}
                    >
                      {source === "Off" ? "Turn back on" : "Turn off for this Repo"}
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <div {...stylex.props(styles.part)}>
        <h3 {...stylex.props(textRole.subheading, styles.heading)}>Change log</h3>
        {log === undefined ? (
          <Spinner label="Loading the MCP server change log" />
        ) : log.length === 0 ? (
          <p {...stylex.props(styles.muted)}>No Installation was ever on for this Repo.</p>
        ) : (
          <ol aria-label="MCP server change log" {...stylex.props(styles.list)}>
            {log.map((entry, index) => (
              <li
                key={`${log.length - index}:${entry.installationId}:${entry.change}`}
                {...stylex.props(styles.row, index === 0 && styles.first)}
              >
                <Avatar name={entry.by.name} src={entry.by.avatarUrl} size="sm" />
                <span {...stylex.props(styles.grow)}>
                  <span {...stylex.props(styles.name)}>{entry.by.name}</span>{" "}
                  {mcpServerChangeText(entry)}
                </span>
                <span {...stylex.props(styles.muted)} title={new Date(entry.at).toLocaleString()}>
                  {timeAgo(entry.at)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </>
  )
}
