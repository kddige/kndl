import * as stylex from "@stylexjs/stylex"
import { Outlet, useRouterState } from "@tanstack/react-router"
import { type MouseEvent, useEffect, useState } from "react"
import type { Connection } from "../hub/store.ts"
import { HubUpdateBanner } from "../hubpage/HubUpdateBanner.tsx"
import { CreateSessionDialog } from "../sessions/CreateSessionDialog.tsx"
import {
  Banner,
  Button,
  Drawer,
  EmptyState,
  IconButton,
  MenuIcon,
  PlusIcon,
  Spinner,
  toast,
  WarningIcon,
} from "../ui/index.ts"
import { chrome, color, space } from "../ui/tokens.stylex.ts"
import { useMediaQuery, WIDE } from "../ui/useMediaQuery.ts"
import { AppPermissionsBanner } from "./AppPermissionsBanner.tsx"
import { AppSidebar } from "./AppSidebar.tsx"
import { Brand } from "./Brand.tsx"
import { useHub, useHubState } from "./hub.tsx"
import { SignIn } from "./SignIn.tsx"

const styles = stylex.create({
  shell: {
    display: "flex",
    height: "100dvh",
  },
  sidebar: {
    flexShrink: 0,
    width: "16rem",
    borderRightWidth: "1px",
    borderRightStyle: "solid",
    borderRightColor: color.border,
  },
  main: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minWidth: 0,
  },
  topBar: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    flexShrink: 0,
    height: chrome.barHeight,
    paddingInline: space.s2,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: color.border,
    backgroundColor: color.surface,
  },
  drawer: { display: "flex", flexDirection: "column", height: "100%" },
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

/**
 * The signed-in app: the sidebar, and the page beside it once the Hub has welcomed us. On a narrow
 * screen the sidebar is a drawer, opened from a slim top bar.
 */
export function HubShell() {
  const hub = useHub()
  const connection = useHubState((state) => state.connection)
  const you = useHubState((state) => state.you)
  const wide = useMediaQuery(WIDE)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  // The page the drawer was opened on: going anywhere else closes it.
  const [drawerOn, setDrawerOn] = useState<string | null>(null)

  useEffect(() => hub.start(), [hub])
  // Refusals with no request to answer, such as putting a busy Session to sleep.
  useEffect(
    () =>
      hub.onCommandFailed((failure) =>
        // An answer to a question already closed (#193) says who closed it, and how.
        failure.command === "AnswerQuestion"
          ? toast.show({
              title: "The question had closed",
              description: failure.message,
              intent: "warning",
            })
          : toast.show({
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

  // Following a link in the drawer closes it, even one to the page already shown.
  const closeOnLink = (event: MouseEvent) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null
    if (link && link.getAttribute("target") !== "_blank") setDrawerOn(null)
  }

  return (
    <div {...stylex.props(styles.shell)}>
      {wide && (
        <div {...stylex.props(styles.sidebar)}>
          <AppSidebar />
        </div>
      )}
      <div {...stylex.props(styles.main)}>
        {!wide && (
          <header {...stylex.props(styles.topBar)}>
            <IconButton label="Open navigation" noTooltip onClick={() => setDrawerOn(pathname)}>
              <MenuIcon />
            </IconButton>
            <Brand />
            <CreateSessionDialog
              trigger={
                <IconButton label="New Session" noTooltip>
                  <PlusIcon />
                </IconButton>
              }
            />
          </header>
        )}
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
        <AppPermissionsBanner sx={styles.banner} />
        <HubUpdateBanner sx={styles.banner} />
        <div {...stylex.props(styles.body)}>
          <Outlet />
        </div>
      </div>
      {!wide && (
        <Drawer
          label="Navigation"
          open={drawerOn === pathname}
          onOpenChange={(open) => setDrawerOn(open ? pathname : null)}
        >
          {/* Only hears the clicks of the links inside, which handle the keyboard themselves. */}
          <div onClick={closeOnLink} {...stylex.props(styles.drawer)}>
            <AppSidebar onClose={() => setDrawerOn(null)} />
          </div>
        </Drawer>
      )}
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
