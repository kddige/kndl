// What can be done to a Session from its sidebar row (#400): the same items for the row's ⋯ and
// its right-click, Shift+F10 and Menu key. Its Creator renames, keeps awake, sleeps and deletes;
// anyone copies its link.

import { type SessionSummary, sessionTitle } from "@kndl/protocol"
import { useNavigate, useParams } from "@tanstack/react-router"
import { requestRename } from "../sessions/renameRequests.ts"
import {
  CopyIcon,
  MenuItem,
  MenuSeparator,
  PencilIcon,
  SunIcon,
  toast,
  TrashIcon,
} from "../ui/index.ts"
import { notSent } from "./copy.ts"
import { useHub } from "./hub.tsx"

export function SessionRowMenuItems({ session }: { session: SessionSummary }) {
  const hub = useHub()
  const navigate = useNavigate()
  const { sessionId } = useParams({ strict: false })
  const title = sessionTitle(session)
  const active = session.state === "Active"
  const kept = session.keepAwake !== undefined
  // Sleeping stops its running agents: from here it doesn't ask first, so it waits until none run.
  const agentsRunning = (session.agents ?? []).some((agent) => agent.status === "Running")
  const busy =
    session.starting !== undefined ||
    session.restarting !== undefined ||
    session.currentTurn !== null

  const copyLink = () => {
    void navigator.clipboard
      .writeText(`${window.location.origin}/sessions/${session.id}`)
      .then(() => toast.show({ title: "Link copied" }))
  }
  const remove = () => {
    if (!hub.archiveSession(session.id)) return notSent("Delete")
    toast.show({
      title: "Session deleted",
      description: `${title} is archived. Restore it from ${session.repo}'s Archived Sessions.`,
      action: {
        label: "Undo",
        onAction: () => {
          if (!hub.restoreSession(session.id)) notSent("Restore")
        },
      },
    })
    if (sessionId === session.id) void navigate({ to: "/" })
  }

  return (
    <>
      <MenuItem icon={<PencilIcon />} end="F2" onClick={() => requestRename(session.id)}>
        Rename
      </MenuItem>
      <MenuItem icon={<CopyIcon />} onClick={copyLink}>
        Copy link
      </MenuItem>
      {session.state !== "Archived" && (
        <MenuItem
          icon={<SunIcon />}
          onClick={() => {
            if (!hub.setKeepAwake(session.id, !kept)) notSent("Keep awake")
          }}
        >
          {kept ? "Stop keeping awake" : "Keep awake"}
        </MenuItem>
      )}
      {active && (
        <MenuItem
          disabled={busy || agentsRunning}
          onClick={() => {
            if (!hub.sleepSession(session.id)) notSent("Sleep")
          }}
        >
          Sleep now
        </MenuItem>
      )}
      {session.state !== "Archived" && (
        <>
          <MenuSeparator />
          <MenuItem icon={<TrashIcon />} intent="danger" onClick={remove}>
            Delete Session
          </MenuItem>
        </>
      )}
    </>
  )
}
