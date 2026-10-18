import type { SessionInstallation, SessionSummary } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link } from "@tanstack/react-router"
import { counted, mcpServersChanged } from "../app/format.ts"
import { Button, McpIcon, Popover, useMediaQuery, WIDE } from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, font, leading, radius, space, text, weight } from "../ui/tokens.stylex.ts"

const styles = stylex.create({
  panel: { width: "20rem" },
  list: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  row: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    paddingBlock: space.s2,
    borderTopWidth: { default: "1px", ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  line: { display: "flex", alignItems: "baseline", gap: space.s2, minWidth: 0 },
  name: { fontWeight: weight.semibold },
  mcpServer: { minWidth: 0, color: color.textSecondary, fontSize: text.sm },
  server: { color: color.textSecondary, fontFamily: font.mono, fontSize: text.xs },
  note: { margin: 0, color: color.textSecondary, fontSize: text.sm, lineHeight: leading.snug },
  link: {
    color: color.accentText,
    textDecoration: { default: "none", ":hover": "underline" },
    borderRadius: radius.sm,
  },
})

/** The name Claude Code shows an Installation's MCP server by, in the plugin kndl generates. */
export const serverName = (installation: SessionInstallation) =>
  `plugin:kndl:${installation.server}`

const installationsText = (count: number) =>
  counted(count, { one: "Installation", other: "Installations" })

/**
 * The Installations a Session runs with (ADR 0020): a button in its header while it runs with any,
 * or its Repo's changed, which opens the list, each with its MCP server and the name Claude Code
 * reaches it by. Participants can't change them per Session: they are its Repo's.
 */
export function SessionMcpServers({ summary }: { summary: SessionSummary }) {
  const wide = useMediaQuery(WIDE)
  const installations = summary.mcpServers ?? []
  const changed = mcpServersChanged(summary)
  if (summary.state === "Archived" || (installations.length === 0 && !changed)) return null
  const count = installationsText(installations.length)
  return (
    <Popover
      trigger={
        <Button
          size="sm"
          intent="secondary"
          icon={<McpIcon />}
          aria-label={`MCP servers: ${count}${changed ? ", changed" : ""}`}
        >
          {/* A phone's header has room for the count only. */}
          {wide ? count : installations.length}
        </Button>
      }
      title="MCP servers"
      description={`The Installations on for ${summary.repo} as this Session last started.`}
      align="end"
      sx={styles.panel}
    >
      {installations.length > 0 && (
        <ul aria-label="Installations this Session runs with" {...stylex.props(styles.list)}>
          {installations.map((installation) => (
            <li key={installation.id} {...stylex.props(styles.row)}>
              <span {...stylex.props(styles.line)}>
                <span {...stylex.props(styles.name)}>{installation.name}</span>
                <span {...stylex.props(styles.mcpServer)}>{installation.mcpServerName}</span>
              </span>
              <code {...stylex.props(styles.server)}>{serverName(installation)}</code>
            </li>
          ))}
        </ul>
      )}
      <p {...stylex.props(styles.note)}>
        {changed
          ? `${summary.repo}'s Installations changed since it started: a restart applies the change. `
          : ""}
        <Link to="/mcp" {...stylex.props(styles.link, focus.ring)}>
          Manage MCP servers
        </Link>
      </p>
    </Popover>
  )
}
