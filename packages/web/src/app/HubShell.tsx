import { ProtocolVersion } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { Outlet, useRouter, useRouterState } from "@tanstack/react-router"
import { type MouseEvent, useEffect, useRef, useState } from "react"
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
  UpdateIcon,
  useDocumentTitle,
  WarningIcon,
} from "../ui/index.ts"
import { focus, srOnly } from "../ui/shared.ts"
import { chrome, color, layer, radius, space } from "../ui/tokens.stylex.ts"
import { useMediaQuery, WIDE } from "../ui/useMediaQuery.ts"
import { AppPermissionsBanner } from "./AppPermissionsBanner.tsx"
import { AppSidebar } from "./AppSidebar.tsx"
import { Brand } from "./Brand.tsx"
import { CommandsProvider } from "./commands.tsx"
import { commandText } from "./copy.ts"
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
    borderInlineEndWidth: "1px",
    borderInlineEndStyle: "solid",
    borderInlineEndColor: color.border,
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
  // The notices across the app, in one region that can never take the page: it scrolls past 40%.
  banners: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    flexShrink: 0,
    maxHeight: "40dvh",
    overflowY: "auto",
    overscrollBehavior: "contain",
    paddingBlock: { default: space.s2, ":empty": 0 },
    paddingInline: space.s4,
  },
  body: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minHeight: 0,
    // The skip link's target: focus lands here, with no ring, to start reading from.
    outline: "none",
  },
  // Off-screen until a keyboard reaches it, first thing on every page.
  skip: {
    position: "absolute",
    zIndex: layer.toast,
    top: space.s2,
    insetInlineStart: { default: "-999px", ":focus": space.s2 },
    padding: space.s2,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    color: color.text,
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
  // An update of the Hub was running as the connection went: the Hub is restarting under it.
  const updating = useHubState((state) => state.hubUpdateRun?.status.state === "Running")
  const wide = useMediaQuery(WIDE)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  // The page the drawer was opened on: going anywhere else closes it.
  const [drawerOn, setDrawerOn] = useState<string | null>(null)
  // The drawer closed because a link in it was followed: focus goes to the new page, not back to
  // the menu button.
  const followedLink = useRef(false)

  // A new page takes focus at its h1 once it has rendered, so a screen reader hears where it is;
  // not on first load, where focus starts at the top anyway, and not for a search change such as
  // ?tab=terminal.
  const router = useRouter()
  useEffect(
    () =>
      router.subscribe("onRendered", (event) => {
        if (event.fromLocation !== undefined && event.pathChanged) focusPageHeading()
      }),
    [router],
  )

  useEffect(() => hub.start(), [hub])
  // Refusals with no request to answer, such as putting a busy Session to sleep.
  useEffect(
    () =>
      hub.onCommandFailed((failure) =>
        // An answer to a question already closed (#193) says who closed it, and how.
        failure.command === "AnswerQuestion"
          ? toast.show({
              title: "That question was already answered",
              description: failure.message,
              intent: "warning",
            })
          : // The Hub's own text says how to fix it, such as "The Session is Asleep: wake it first."
            toast.show({
              title: `Couldn't ${commandText[failure.command] ?? "do that"}`,
              description: failure.message,
              intent: "danger",
            }),
      ),
    [hub],
  )

  if (connection.status === "signedOut") return <SignIn options={connection.options} />
  if (connection.status === "rejected") return <Rejected hubProtocol={connection.hubProtocol} />
  if (you === null) return <Connecting connection={connection} />

  // Following a link in the drawer closes it, even one to the page already shown.
  const closeOnLink = (event: MouseEvent) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null
    if (link && link.getAttribute("target") !== "_blank") {
      followedLink.current = true
      setDrawerOn(null)
    }
  }

  return (
    <CommandsProvider>
      <div {...stylex.props(styles.shell)}>
        <a href="#content" {...stylex.props(styles.skip, focus.ring)}>
          Skip to content
        </a>
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
          {/* Always mounted, empty while connected, so a screen reader hears the connection change. */}
          <p role="status" {...stylex.props(srOnly.root)}>
            {connection.status === "reconnecting"
              ? updating
                ? "Updating the Hub"
                : "Reconnecting to the Hub"
              : ""}
          </p>
          <div {...stylex.props(styles.banners)}>
            {connection.status === "reconnecting" &&
              (updating ? (
                // The Hub restarts under its own update (#362), and is back on the new version.
                <Banner slim intent="neutral" icon={<UpdateIcon />} title="Updating the Hub…">
                  This page reconnects on its own once the Hub is back.
                </Banner>
              ) : (
                <Banner
                  slim
                  intent="warning"
                  icon={<WarningIcon />}
                  title="Reconnecting to the Hub"
                >
                  Changes made elsewhere show up once it's back. Until then, what you do here isn't
                  sent.
                </Banner>
              ))}
            <AppPermissionsBanner />
            <HubUpdateBanner />
          </div>
          <div id="content" tabIndex={-1} {...stylex.props(styles.body)}>
            <Outlet />
          </div>
        </div>
        {!wide && (
          <Drawer
            label="Navigation"
            open={drawerOn === pathname}
            onOpenChange={(open) => {
              if (open) followedLink.current = false
              setDrawerOn(open ? pathname : null)
            }}
            finalFocus={() => (followedLink.current && pageHeading()) || true}
          >
            {/* Only hears the clicks of the links inside, which handle the keyboard themselves. */}
            <div onClick={closeOnLink} {...stylex.props(styles.drawer)}>
              <AppSidebar onClose={() => setDrawerOn(null)} />
            </div>
          </Drawer>
        )}
        {/* Opened from ⌘K, on any page: settings pages have no New Session button. */}
        <CreateSessionDialog listen />
      </div>
    </CommandsProvider>
  )
}

/** The page's h1, where focus lands when a page opens. */
function pageHeading(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#content h1, main h1")
}

/**
 * Moves focus to the new page's h1. A page still loading has none yet, so it waits for one for up
 * to a second, unless focus has moved on meanwhile.
 */
function focusPageHeading(): void {
  const from = document.activeElement
  const until = performance.now() + 1000
  const attempt = () => {
    if (document.activeElement !== from) return
    const heading = pageHeading()
    if (heading) heading.focus({ preventScroll: true })
    else if (performance.now() < until) requestAnimationFrame(attempt)
  }
  attempt()
}

/**
 * The Hub turned this page away: said in people's words, not the protocol's ("the peer", "this
 * side"). A Hub newer than the page is fixed by reloading; an older one by its Owner updating it.
 */
function Rejected({ hubProtocol }: { hubProtocol: number | undefined }) {
  const ask = "Reload the page. If this keeps happening, ask the Hub's Owner to update the Hub."
  const { title, description } =
    hubProtocol === undefined || hubProtocol === ProtocolVersion
      ? { title: "This Hub can't talk to this page", description: ask }
      : hubProtocol > ProtocolVersion
        ? {
            title: "This page is out of date",
            description: "The Hub runs a newer version of kndl than this page. Reload to get it.",
          }
        : { title: "This page is newer than the Hub", description: ask }
  useDocumentTitle(`${title} · kndl`)
  return (
    <main {...stylex.props(styles.center)}>
      <EmptyState
        size="page"
        icon={<WarningIcon />}
        title={title}
        description={description}
        action={<Button onClick={() => window.location.reload()}>Reload page</Button>}
      />
    </main>
  )
}

function Connecting({ connection }: { connection: Connection }) {
  const struggling = connection.status === "reconnecting" && connection.attempt >= 3
  useDocumentTitle(`${struggling ? "Can't reach the Hub" : "Connecting to the Hub"} · kndl`)
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
