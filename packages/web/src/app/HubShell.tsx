import * as stylex from "@stylexjs/stylex"
import { Link, Outlet } from "@tanstack/react-router"
import { useEffect } from "react"
import type { Connection } from "../hub/store.ts"
import {
  Avatar,
  Banner,
  Button,
  EmptyState,
  Menu,
  MenuGroup,
  MenuItem,
  Spinner,
  toast,
  WarningIcon,
} from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, control, radius, space, text, tracking, weight } from "../ui/tokens.stylex.ts"
import { useHub, useHubState } from "./hub.tsx"
import { SignIn } from "./SignIn.tsx"

const styles = stylex.create({
  shell: {
    display: "flex",
    flexDirection: "column",
    height: "100dvh",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    flexShrink: 0,
    height: "2.75rem",
    paddingInline: space.s4,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: color.border,
    backgroundColor: color.surface,
  },
  brand: {
    fontSize: text.md,
    fontWeight: weight.semibold,
    letterSpacing: tracking.tight,
    color: color.text,
    textDecoration: "none",
    borderRadius: radius.sm,
  },
  grow: { flex: 1 },
  you: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: control.md,
    height: control.md,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: "transparent",
    cursor: "pointer",
  },
  banner: { margin: space.s3, marginBottom: 0 },
  body: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minHeight: 0,
  },
  center: {
    display: "grid",
    placeItems: "center",
    minHeight: "100dvh",
    padding: space.s4,
  },
})

/** The signed-in app: the header, and the page under it once the Hub has welcomed us. */
export function HubShell() {
  const hub = useHub()
  const connection = useHubState((state) => state.connection)
  const you = useHubState((state) => state.you)

  useEffect(() => hub.start(), [hub])
  // Refusals with no request to answer, such as a prompt to a Frozen Session.
  useEffect(
    () =>
      hub.onCommandFailed((failure) =>
        toast.show({
          title: "The Hub refused that",
          description: failure.message,
          intent: "danger",
        }),
      ),
    [hub],
  )

  if (connection.status === "signedOut") return <SignIn options={connection.options} />
  if (connection.status === "rejected") {
    return (
      <main {...stylex.props(styles.center)}>
        <EmptyState
          size="page"
          icon={<WarningIcon />}
          title="This Hub can't talk to this page"
          description={connection.message}
          action={<Button onClick={() => window.location.reload()}>Reload</Button>}
        />
      </main>
    )
  }
  if (you === null) return <Connecting connection={connection} />

  return (
    <div {...stylex.props(styles.shell)}>
      <header {...stylex.props(styles.header)}>
        <Link to="/" {...stylex.props(styles.brand, focus.ring)}>
          Claude Hub
        </Link>
        <span {...stylex.props(styles.grow)} />
        <Menu
          align="end"
          trigger={
            <button
              type="button"
              aria-label={`Signed in as ${you.name}`}
              {...stylex.props(styles.you, focus.ring)}
            >
              <Avatar name={you.name} size="md" />
            </button>
          }
        >
          <MenuGroup label={`${you.name} (@${you.login})`}>
            <MenuItem
              onClick={() => {
                void hub.transport.signOut().finally(() => hub.retry())
              }}
            >
              Sign out
            </MenuItem>
          </MenuGroup>
        </Menu>
      </header>
      {connection.status === "reconnecting" && (
        <Banner
          intent="warning"
          icon={<WarningIcon />}
          title="Reconnecting to the Hub"
          sx={styles.banner}
        >
          What happens meanwhile shows up once it's back.
        </Banner>
      )}
      <div {...stylex.props(styles.body)}>
        <Outlet />
      </div>
    </div>
  )
}

function Connecting({ connection }: { connection: Connection }) {
  const struggling = connection.status === "reconnecting" && connection.attempt >= 3
  return (
    <main {...stylex.props(styles.center)}>
      <EmptyState
        size="page"
        icon={struggling ? <WarningIcon /> : <Spinner />}
        title={struggling ? "Can't reach the Hub" : "Connecting to the Hub"}
        {...(struggling && { description: "Still trying. Check that the Hub is running." })}
      />
    </main>
  )
}
