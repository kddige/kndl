// Settings takes the sidebar over on a settings page (#398), as Linear's settings do: a way back
// to the Sessions, then the settings that are yours and the ones that are the Hub's. A count after
// a row says only what needs attention.

import { diskIsLow } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link, useRouterState } from "@tanstack/react-router"
import { needsValue } from "../environment/draft.ts"
import { bannerTarget, useDismissedUpdate } from "../hubpage/hubUpdate.ts"
import {
  ArrowLeftIcon,
  Badge,
  CloseIcon,
  IconButton,
  NavItem,
  NavSection,
  Sidebar,
} from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, control, radius, space, text, weight } from "../ui/tokens.stylex.ts"
import { useHubState } from "./hub.tsx"
import { lastSessionPath } from "./lastPlaces.ts"

type Section =
  | "providers"
  | "tokens"
  | "runners"
  | "environments"
  | "variables"
  | "mcp"
  | "people"
  | "updates"

function sectionOf(pathname: string, hash: string): Section | null {
  if (pathname === "/account") return hash === "cli-tokens" ? "tokens" : "providers"
  if (pathname === "/runners") return "runners"
  if (pathname === "/environments" || /^\/repos\/[^/]+\/[^/]+\/environment$/.test(pathname))
    return "environments"
  if (pathname === "/variables") return "variables"
  if (pathname === "/mcp") return "mcp"
  if (pathname === "/people") return "people"
  if (pathname === "/hub") return "updates"
  return null
}

const styles = stylex.create({
  back: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    flex: 1,
    minWidth: 0,
    height: control.md,
    paddingInline: space.s2,
    borderRadius: radius.md,
    color: color.text,
    fontSize: text.base,
    fontWeight: weight.medium,
    textDecoration: "none",
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, "@media (hover: hover)": color.surfaceHover },
    },
  },
})

/** The Settings nav, in the sidebar's place. `onClose` adds a close button, for a drawer. */
export function SettingsSidebar({ onClose }: { onClose?: () => void }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const hash = useRouterState({ select: (state) => state.location.hash })
  const owner = useHubState((state) => state.owner)
  const hubPage = useHubState((state) => state.owner && state.hubUpdate !== null)
  const update = useHubState((state) => state.hubUpdate)
  const dismissed = useDismissedUpdate()
  // What needs attention: Runners that can't take Sessions or are short of disk, values a
  // secrets-reset cleared, an update not yet looked at.
  const runnersToSee = useHubState(
    (state) =>
      state.runners?.filter(
        (runner) =>
          runner.versionStatus === "Behind" ||
          (runner.sysinfo !== undefined && diskIsLow(runner.sysinfo)),
      ).length ?? 0,
  )
  const valuesToEnter = useHubState(
    (state) => state.sharedVariables?.filter(needsValue).length ?? 0,
  )
  const updateOut = update !== null && bannerTarget(update, dismissed) !== null
  const current = sectionOf(pathname, hash)

  const row = (
    section: Section,
    to: string,
    label: string,
    attention?: string,
    linkHash?: string,
  ) => (
    <NavItem
      key={section}
      // Providers and CLI tokens are one page: the hash tells them apart.
      render={
        <Link
          to={to}
          {...(linkHash !== undefined && { hash: linkHash })}
          activeOptions={{ includeHash: to === "/account" }}
        />
      }
      current={current === section}
      {...(attention !== undefined && { trailing: <Badge intent="warning">{attention}</Badge> })}
    >
      {label}
    </NavItem>
  )

  return (
    <Sidebar
      label="Settings"
      header={
        <>
          <Link to={lastSessionPath()} {...stylex.props(styles.back, focus.ringInset)}>
            <ArrowLeftIcon />
            Back to Sessions
          </Link>
          {onClose && (
            <IconButton label="Close navigation" size="sm" noTooltip onClick={onClose}>
              <CloseIcon />
            </IconButton>
          )}
        </>
      }
    >
      <NavSection label="You">
        {row("providers", "/account", "Providers")}
        {row("tokens", "/account", "CLI tokens", undefined, "cli-tokens")}
      </NavSection>
      <NavSection label="Hub">
        {row("runners", "/runners", "Runners", runnersToSee > 0 ? String(runnersToSee) : undefined)}
        {row("environments", "/environments", "Environments")}
        {row(
          "variables",
          "/variables",
          "Shared variables",
          valuesToEnter > 0 ? String(valuesToEnter) : undefined,
        )}
        {row("mcp", "/mcp", "MCP servers")}
        {owner && row("people", "/people", "People")}
        {hubPage && row("updates", "/hub", "Updates", updateOut ? "New" : undefined)}
      </NavSection>
    </Sidebar>
  )
}
