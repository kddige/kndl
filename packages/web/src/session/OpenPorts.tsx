import { isDockerPort, type OpenPort, type SessionSummary } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { copyCommand } from "../app/copy.ts"
import {
  Badge,
  Button,
  CopyIcon,
  IconButton,
  PlugIcon,
  Popover,
  useMediaQuery,
  WIDE,
} from "../ui/index.ts"
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
  port: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    paddingBlock: space.s2,
    borderTopWidth: { default: "1px", ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  line: { display: "flex", alignItems: "center", gap: space.s2, minWidth: 0 },
  number: {
    fontFamily: font.mono,
    fontSize: text.base,
    fontWeight: weight.semibold,
    fontVariantNumeric: "tabular-nums",
  },
  process: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: color.textMuted,
    fontSize: text.sm,
  },
  addresses: {
    color: color.textMuted,
    fontFamily: font.mono,
    fontSize: text.xs,
    overflowWrap: "anywhere",
  },
  forward: { display: "flex", flexDirection: "column", gap: space.s1_5 },
  note: { margin: 0, color: color.textMuted, fontSize: text.sm, lineHeight: leading.snug },
  command: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    paddingBlock: space.s1,
    paddingInlineStart: space.s2_5,
    paddingInlineEnd: space.s1,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.md,
    backgroundColor: color.surfaceMuted,
  },
  commandText: {
    flex: 1,
    minWidth: 0,
    fontFamily: font.mono,
    fontSize: text.sm,
    lineHeight: leading.snug,
    overflowWrap: "anywhere",
    userSelect: "all",
  },
})

/** A Session's short id, as `kndl forward` takes it: its first 6 characters (ADR 0016). */
export const shortSessionId = (summary: SessionSummary) => summary.id.slice(0, 6)

/** The command that forwards a Session's Open ports to the machine it runs on (#180). */
export const forwardCommand = (summary: SessionSummary) => `kndl forward ${shortSessionId(summary)}`

const portsText = (count: number) => (count === 1 ? "1 port" : `${count} ports`)

/**
 * What listens in the Session's Sandbox (#175): a button in its header while anything does, which
 * opens the list, each port with its addresses and process, and the command that forwards them.
 */
export function OpenPorts({ summary }: { summary: SessionSummary }) {
  const wide = useMediaQuery(WIDE)
  const ports = summary.openPorts ?? []
  if (summary.state !== "Active" || ports.length === 0) return null
  const command = forwardCommand(summary)
  return (
    <Popover
      trigger={
        <Button
          size="sm"
          intent="secondary"
          icon={<PlugIcon />}
          aria-label={`Open ports: ${portsText(ports.length)}`}
        >
          {/* A phone's header has room for the count only. */}
          {wide ? portsText(ports.length) : ports.length}
        </Button>
      }
      title="Open ports"
      description="Listening in the Session's Sandbox."
      align="end"
      sx={styles.panel}
    >
      <ul aria-label="Open ports" {...stylex.props(styles.list)}>
        {ports.map((port) => (
          <PortRow key={port.port} port={port} />
        ))}
      </ul>
      <div {...stylex.props(styles.forward)}>
        <p {...stylex.props(styles.note)}>
          Forward them to <code>localhost</code> on your machine:
        </p>
        <div {...stylex.props(styles.command)}>
          <code aria-label="Forward command" {...stylex.props(styles.commandText)}>
            {command}
          </code>
          <IconButton label="Copy command" size="sm" onClick={() => void copyCommand(command)}>
            <CopyIcon />
          </IconButton>
        </div>
      </div>
    </Popover>
  )
}

function PortRow({ port }: { port: OpenPort }) {
  return (
    <li {...stylex.props(styles.port)}>
      <span {...stylex.props(styles.line)}>
        <span {...stylex.props(styles.number)}>{port.port}</span>
        {port.process !== undefined && (
          <span title={port.process} {...stylex.props(styles.process)}>
            {port.process}
          </span>
        )}
        {/* Docker's proxy names no container: the label says the port is a container's. */}
        {isDockerPort(port) && <Badge intent="accent">Docker</Badge>}
      </span>
      <span {...stylex.props(styles.addresses)}>{port.addresses.join(", ")}</span>
    </li>
  )
}
