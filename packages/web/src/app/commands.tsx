// ⌘K (#399): the palette's commands, from anywhere in the app. The Hub-wide ones are here; a page
// adds its own while it's mounted, as the Session view adds "This Session".

import { sessionTitle } from "@kndl/protocol"
import { useNavigate } from "@tanstack/react-router"
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"
import { isListed } from "../hub/store.ts"
import { openNewSession } from "../sessions/newSession.ts"
import {
  type Command,
  type CommandGroup,
  CommandPalette,
  IconButton,
  SearchIcon,
} from "../ui/index.ts"
import { useHubState } from "./hub.tsx"
import { recentSessions } from "./lastPlaces.ts"

interface Commands {
  open: () => void
  register: (group: CommandGroup) => () => void
}

const CommandsContext = createContext<Commands | null>(null)

/** Mounts the palette, opened by ⌘K or Ctrl+K, and lets pages add to it. */
export function CommandsProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const sessions = useHubState((state) => state.sessions)
  const owner = useHubState((state) => state.owner)
  const hubPage = useHubState((state) => state.owner && state.hubUpdate !== null)
  const [open, setOpen] = useState(false)
  const [pageGroups, setPageGroups] = useState<ReadonlyArray<CommandGroup>>([])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setOpen((was) => !was)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const register = useCallback((group: CommandGroup) => {
    setPageGroups((groups) => [group, ...groups.filter((other) => other.label !== group.label)])
    return () => setPageGroups((groups) => groups.filter((other) => other !== group))
  }, [])

  const groups = useMemo((): ReadonlyArray<CommandGroup> => {
    const go = (to: string) => () => void navigate({ to })
    // The Sessions this tab opened lately first, then the rest, newest first.
    const order = recentSessions()
    const listed = (sessions ?? []).filter(isListed).toSorted((a, b) => {
      const ra = order.indexOf(a.id)
      const rb = order.indexOf(b.id)
      if (ra !== -1 || rb !== -1) return (ra === -1 ? Infinity : ra) - (rb === -1 ? Infinity : rb)
      return b.createdAt - a.createdAt
    })
    const setting = (id: string, label: string, to: string): Command => ({ id, label, run: go(to) })
    return [
      ...pageGroups,
      {
        label: "Actions",
        commands: [{ id: "new-session", label: "New Session", run: openNewSession }],
      },
      {
        label: "Sessions",
        commands: [
          ...listed.map((session): Command => ({
            id: `session-${session.id}`,
            label: sessionTitle(session),
            meta: session.repo,
            run: go(`/sessions/${session.id}`),
          })),
          setting("archive", "Archived Sessions", "/archive"),
        ],
      },
      {
        label: "Settings",
        commands: [
          setting("providers", "Providers", "/account"),
          {
            id: "tokens",
            label: "CLI tokens",
            run: () => void navigate({ to: "/account", hash: "cli-tokens" }),
          },
          setting("runners", "Runners", "/runners"),
          setting("environments", "Environments", "/environments"),
          setting("variables", "Shared variables", "/variables"),
          setting("mcp", "MCP servers", "/mcp"),
          ...(owner ? [setting("people", "People", "/people")] : []),
          ...(hubPage ? [setting("updates", "Updates", "/hub")] : []),
        ],
      },
    ]
  }, [navigate, sessions, owner, hubPage, pageGroups])

  // With nothing typed: what the page offers, the actions, and the latest Sessions.
  const initial = useMemo(
    () =>
      groups
        .filter((group) => group.label !== "Settings")
        .map((group) =>
          group.label === "Sessions" ? { ...group, commands: group.commands.slice(0, 8) } : group,
        ),
    [groups],
  )

  const value = useMemo(() => ({ open: () => setOpen(true), register }), [register])
  return (
    <CommandsContext.Provider value={value}>
      {children}
      <CommandPalette open={open} onOpenChange={setOpen} groups={groups} initial={initial} />
    </CommandsContext.Provider>
  )
}

/** Adds `group` to the palette while the calling page is mounted. Keep `group` stable (useMemo). */
export function useCommands(group: CommandGroup | undefined): void {
  const commands = useContext(CommandsContext)
  useEffect(() => (group && commands ? commands.register(group) : undefined), [commands, group])
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)

/** The sidebar header's way to the palette, for a pointer. */
export function SearchButton() {
  const commands = useContext(CommandsContext)
  return (
    <IconButton
      label={`Search (${isMac ? "⌘K" : "Ctrl K"})`}
      size="sm"
      aria-keyshortcuts="Meta+K Control+K"
      onClick={() => commands?.open()}
    >
      <SearchIcon />
    </IconButton>
  )
}
