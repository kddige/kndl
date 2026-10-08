// A Repo's Plugins, on its Repo page (ADR 0020): the Installations on for it, whose MCP servers
// Claude Code in its Sessions gets, each saying which of its header secrets need a value; and its
// Plugin change log: who created, edited, added or removed an Installation here, or set or cleared
// its header secret values (by title, never the values), and when.

import { type PluginLogEntry, repoKey, sameRepo } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link } from "@tanstack/react-router"
import { useEffect } from "react"
import { andList, timeAgo } from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import { Avatar, Badge, Spinner } from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, radius, space, text, weight } from "../ui/tokens.stylex.ts"
import { neededText, valuesNeeded } from "./headerSecrets.ts"

const styles = stylex.create({
  part: { display: "flex", flexDirection: "column", gap: space.s2 },
  heading: { margin: 0, fontSize: text.sm, fontWeight: weight.semibold },
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
  muted: { color: color.textMuted, fontSize: text.sm },
  grow: { flex: 1, minWidth: 0 },
  link: {
    color: color.accentSubtleText,
    textDecoration: { default: "none", ":hover": "underline" },
    borderRadius: radius.sm,
  },
})

/** What a change log entry says happened, after who did it. */
export function pluginChangeText(entry: PluginLogEntry): string {
  const { installationName: installation, pluginName: plugin } = entry
  switch (entry.change) {
    case "Created":
      return `created ${installation}, an Installation of ${plugin}`
    case "Added":
      return `put ${installation}, an Installation of ${plugin}, on in this Repo`
    case "Renamed":
      return `renamed an Installation of ${plugin} to ${installation}`
    case "Removed":
      return `took ${installation}, an Installation of ${plugin}, off this Repo`
    case "Deleted":
      return `deleted ${installation}, an Installation of ${plugin}`
    case "PluginEdited":
      return `edited ${plugin}, the Plugin of ${installation}`
    case "ValuesSet":
      return `set ${installation}'s ${valuesText(entry.secrets)}`
    case "ValuesCleared":
      return `cleared ${installation}'s ${valuesText(entry.secrets)}, as ${plugin} changed`
    case "PluginUpgraded":
      return `upgraded ${plugin}, the Plugin of ${installation}, to ${entry.pluginVersion ?? "a new version"}`
  }
}

/** The header secrets whose values a change set or cleared, by title: never their values. */
const valuesText = (secrets: ReadonlyArray<string> | undefined) =>
  secrets === undefined || secrets.length === 0
    ? "header secret values"
    : `${secrets.length === 1 ? "value" : "values"} of ${andList(secrets)}`

/** The Installations on for `repo`, and its Plugin change log, both kept fresh by the Hub. */
export function RepoPlugins({ repo }: { repo: string }) {
  const hub = useHub()
  const online = useHubState((state) => state.connection.status === "online")
  const plugins = useHubState((state) => state.plugins)
  const log = useHubState((state) => state.pluginLogs[repoKey(repo)])

  useEffect(() => {
    if (!online) return
    // Shown as empty for now: the Hub refuses only a Repo the person lost access to.
    hub.getPlugins().catch(() => undefined)
    hub.getPluginLog(repo).catch(() => undefined)
  }, [hub, repo, online])

  const on =
    plugins?.installations.filter((installation) =>
      installation.repos.some((listed) => sameRepo(listed, repo)),
    ) ?? null
  const pluginOf = (id: string) => plugins?.plugins.find((plugin) => plugin.id === id)
  return (
    <>
      <div {...stylex.props(styles.part)}>
        {on === null ? (
          <Spinner label="Loading the Installations" />
        ) : on.length === 0 ? (
          <p {...stylex.props(styles.muted)}>
            No Installation is on for this Repo.{" "}
            <Link to="/plugins" {...stylex.props(styles.link, focus.ring)}>
              Install a Plugin
            </Link>
          </p>
        ) : (
          <ul aria-label="Installations on for this Repo" {...stylex.props(styles.list)}>
            {on.map((installation, index) => {
              const plugin = pluginOf(installation.pluginId)
              const needed = plugin === undefined ? [] : valuesNeeded(plugin, installation)
              return (
                <li
                  key={installation.id}
                  {...stylex.props(styles.row, index === 0 && styles.first)}
                >
                  <span {...stylex.props(styles.name)}>{installation.name}</span>
                  <span {...stylex.props(styles.muted)}>
                    {plugin?.name ?? installation.pluginId}
                  </span>
                  {needed.length > 0 && <Badge intent="danger">{neededText(needed)}</Badge>}
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <div {...stylex.props(styles.part)}>
        <h3 {...stylex.props(styles.heading)}>Change log</h3>
        {log === undefined ? (
          <Spinner label="Loading the Plugin change log" />
        ) : log.length === 0 ? (
          <p {...stylex.props(styles.muted)}>No Installation was ever on for this Repo.</p>
        ) : (
          <ol aria-label="Plugin change log" {...stylex.props(styles.list)}>
            {log.map((entry, index) => (
              <li
                key={`${log.length - index}:${entry.installationId}:${entry.change}`}
                {...stylex.props(styles.row, index === 0 && styles.first)}
              >
                <Avatar name={entry.by.name} src={entry.by.avatarUrl} size="sm" />
                <span {...stylex.props(styles.grow)}>
                  <span {...stylex.props(styles.name)}>{entry.by.name}</span>{" "}
                  {pluginChangeText(entry)}
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
