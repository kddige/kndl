import {
  type RunnerSummary,
  sameRepo,
  type SessionId,
  type SessionSummary,
  sessionTitle,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"
import { notSent } from "../app/copy.ts"
import { counted, day, purgedIn, repoParams, timeAgo } from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import type { HubClient } from "../hub/client.ts"
import { messageOf, useLastOpened } from "../mcp/shared.ts"
import { useDrives } from "../session/drive.ts"
import {
  BranchIcon,
  Button,
  Checkbox,
  Dialog,
  DialogClose,
  MenuItem,
  SettingsEmpty,
  SettingsList,
  SettingsLoading,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  toast,
} from "../ui/index.ts"
import { focus, srOnly } from "../ui/shared.ts"
import { color, font, radius, space, text, weight } from "../ui/tokens.stylex.ts"
import { type DiskSizes, freedBy, freedText, sizeText } from "./diskSizes.ts"
import { groupByRepo } from "./groups.ts"

const styles = stylex.create({
  // Its Select all lines up with the rows' ticks under it, and Purge selected ends with the list.
  toolbar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: space.s3,
    rowGap: space.s2,
    paddingInlineStart: space.s3,
  },
  // The toolbar, close over the list it ticks.
  listed: { display: "flex", flexDirection: "column", gap: space.s3 },
  repoLink: {
    color: color.text,
    textDecoration: { default: "none", ":hover": "underline" },
    borderRadius: radius.sm,
  },
  branch: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    maxWidth: "100%",
    fontFamily: font.mono,
    fontSize: text.sm,
    color: color.text,
    textDecoration: { default: "none", ":hover": "underline" },
    borderRadius: radius.sm,
  },
  branchText: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  size: { fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
  toolbarEnd: { display: "flex", alignItems: "center", gap: space.s3 },
  freed: { color: color.textSecondary, fontSize: text.sm },
  freedTotal: {
    margin: 0,
    marginBlockStart: space.s3,
    fontSize: text.sm,
    fontWeight: weight.semibold,
  },
  purging: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    margin: 0,
    paddingInlineStart: space.s5,
    fontSize: text.sm,
  },
  purgingTitle: { fontFamily: font.mono },
  purgingRepo: { color: color.textSecondary },
})

/**
 * A Repo's Archived Sessions: who deleted each and when, and until when it can be restored.
 * Restoring brings a Session back Asleep. Purging one or several, once confirmed, deletes them now,
 * to free their Runners' disk (#351).
 */
export function ArchivedSessions({ repo }: { repo: string }) {
  const sessions = useHubState((state) => state.sessions)
  const archived = useMemo(
    () =>
      sessions === null
        ? null
        : newestArchived(sessions.filter((session) => sameRepo(session.repo, repo))),
    [sessions, repo],
  )
  const purging = usePurging(archived ?? noSessions)

  return (
    <SettingsPage
      title="Archived Sessions"
      pageTitle={`Archived Sessions · ${repo}`}
      description={`${repo}: deleted Sessions can be restored until they're purged.`}
    >
      {archived === null ? (
        <SettingsLoading label="Loading Sessions" />
      ) : archived.length === 0 ? (
        <SettingsEmpty
          title="Nothing archived"
          description={`Sessions deleted from ${repo} show here until they're purged.`}
        />
      ) : (
        <div {...stylex.props(styles.listed)}>
          <PurgeToolbar purging={purging} />
          <ArchivedList label="Archived Sessions" sessions={archived} purging={purging} />
        </div>
      )}
      <PurgeDialog purging={purging} />
    </SettingsPage>
  )
}

/** Every Repo's Archived Sessions, grouped by Repo: where the sidebar's "Archived Sessions" goes. */
export function AllArchivedSessions() {
  const sessions = useHubState((state) => state.sessions)
  const groups = useMemo(
    () =>
      sessions === null
        ? null
        : groupByRepo(
            sessions.filter((session) => session.archived !== undefined),
            lastDeletedFirst,
          ),
    [sessions],
  )
  const listed = useMemo(() => groups?.flatMap((group) => group.sessions) ?? noSessions, [groups])
  const purging = usePurging(listed)

  return (
    <SettingsPage
      title="Archived Sessions"
      description="Deleted Sessions by Repo, which you can restore until they're purged."
    >
      {groups === null ? (
        <SettingsLoading label="Loading Sessions" />
      ) : groups.length === 0 ? (
        <SettingsEmpty
          title="Nothing archived"
          description="Deleted Sessions show here until they're purged."
        />
      ) : (
        <>
          <PurgeToolbar purging={purging} />
          {groups.map(({ repo, sessions: archived }) => (
            <SettingsSection
              key={repo}
              title={
                <Link
                  to="/repos/$owner/$repo/archived"
                  params={repoParams(repo)}
                  {...stylex.props(styles.repoLink, focus.ring)}
                >
                  {repo}
                </Link>
              }
            >
              <ArchivedList
                label={`Archived Sessions of ${repo}`}
                sessions={archived}
                purging={purging}
              />
            </SettingsSection>
          ))}
        </>
      )}
      <PurgeDialog purging={purging} />
    </SettingsPage>
  )
}

const noSessions: ReadonlyArray<SessionSummary> = []

const lastDeletedFirst = (a: SessionSummary, b: SessionSummary) =>
  (b.archived?.at ?? 0) - (a.archived?.at ?? 0)

/** The Archived ones, the most recently deleted first. */
function newestArchived(sessions: ReadonlyArray<SessionSummary>): Array<SessionSummary> {
  return sessions.filter((session) => session.archived !== undefined).toSorted(lastDeletedFirst)
}

/** What is ticked to purge on an Archived screen, and what its confirmation asks about. */
interface Purging {
  /** The Archived Sessions listed, which the ticks pick from. */
  readonly listed: ReadonlyArray<SessionSummary>
  /** The ticked ones still listed, in the list's order. */
  readonly selected: ReadonlyArray<SessionSummary>
  readonly isSelected: (sessionId: SessionId) => boolean
  readonly select: (sessionIds: ReadonlyArray<SessionId>, on: boolean) => void
  /** The disk each listed Session takes on its Runner (#352), as far as the Hub has said. */
  readonly sizes: DiskSizes
  /** The Sessions the confirmation asks to purge, or null while it is closed. */
  readonly asking: ReadonlyArray<SessionSummary> | null
  readonly ask: (sessions: ReadonlyArray<SessionSummary> | null) => void
}

function usePurging(listed: ReadonlyArray<SessionSummary>): Purging {
  const [ticked, setTicked] = useState<ReadonlySet<SessionId>>(() => new Set())
  const [asking, setAsking] = useState<ReadonlyArray<SessionSummary> | null>(null)
  // One restored or purged meanwhile drops out of the selection with the list.
  const selected = useMemo(
    () => listed.filter((session) => ticked.has(session.id)),
    [listed, ticked],
  )
  const sizes = useDiskSizes(listed)
  return {
    listed,
    selected,
    sizes,
    isSelected: (sessionId) => ticked.has(sessionId),
    select: (sessionIds, on) =>
      setTicked((before) => {
        const after = new Set(before)
        for (const sessionId of sessionIds) {
          if (on) after.add(sessionId)
          else after.delete(sessionId)
        }
        return after
      }),
    asking,
    ask: setAsking,
  }
}

/**
 * The disk the Archived Sessions take on their Runners (#352), asked of the Hub when the list opens
 * and again when it changes, or when a Runner of theirs goes offline or comes back, since an
 * offline Runner can't say. The Hub keeps its Runners' answers for a minute. Sizes already known
 * stay while it asks again; a Session the Hub can't say is `null`, and one not answered is absent.
 */
function useDiskSizes(listed: ReadonlyArray<SessionSummary>): DiskSizes {
  const hub = useHub()
  const runners = useHubState((state) => state.runners)
  const [sizes, setSizes] = useState<DiskSizes>(() => new Map())
  const ids = listed.map((session) => session.id)
  const online = new Set(
    runners?.filter((runner) => runner.isOnline).map((runner) => runner.id) ?? [],
  )
  // What the answer depends on: which Sessions, and which of their Runners are online.
  const key = JSON.stringify([
    ids,
    [...new Set(listed.map((session) => session.runnerId))]
      .filter((id) => online.has(id))
      .toSorted(),
  ])
  useEffect(() => {
    if (ids.length === 0) return
    let current = true
    hub.sessionDiskUsage(ids).then(
      (answer) => {
        if (!current) return
        setSizes(
          (before) =>
            new Map([
              ...before,
              ...answer.map(({ sessionId, bytes }) => [sessionId, bytes ?? null] as const),
            ]),
        )
      },
      () => {
        // Not connected, or the Hub refused: every size is unknown, and asked again on reconnecting.
        if (current)
          setSizes((before) => new Map([...before, ...ids.map((id) => [id, null] as const)]))
      },
    )
    return () => {
      current = false
    }
    // `key` stands for `ids` and the Runners online.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [hub, key])
  return sizes
}

/** Ticks every Archived Session listed, and asks to purge the ticked ones. */
function PurgeToolbar({ purging }: { purging: Purging }) {
  const { listed, selected } = purging
  return (
    <div {...stylex.props(styles.toolbar)}>
      <Checkbox
        label="Select all"
        checked={selected.length === listed.length}
        onCheckedChange={(on) =>
          purging.select(
            listed.map((session) => session.id),
            on,
          )
        }
      />
      <div {...stylex.props(styles.toolbarEnd)}>
        {selected.length > 0 && (
          <span aria-live="polite" {...stylex.props(styles.freed)}>
            {freedText(
              freedBy(
                selected.map((session) => session.id),
                purging.sizes,
              ),
            )}
          </span>
        )}
        <Button
          size="sm"
          intent="danger"
          disabled={selected.length === 0}
          onClick={() => purging.ask(selected)}
        >
          {selected.length === 0 ? "Purge selected" : `Purge selected (${selected.length})`}
        </Button>
      </div>
    </div>
  )
}

function ArchivedList({
  label,
  sessions,
  purging,
}: {
  label: string
  sessions: ReadonlyArray<SessionSummary>
  purging: Purging
}) {
  const hub = useHub()
  return (
    <SettingsList label={label}>
      {sessions.map((session) => (
        <ArchivedRow key={session.id} session={session} hub={hub} purging={purging} />
      ))}
    </SettingsList>
  )
}

function ArchivedRow({
  session,
  hub,
  purging,
}: {
  session: SessionSummary
  hub: HubClient
  purging: Purging
}) {
  const archived = session.archived
  // Restoring it is its Creator's alone (ADR 0026); purging it, anyone's who sees it (ADR 0027).
  const drives = useDrives(session)
  if (archived === undefined) return null
  const title = sessionTitle(session)
  return (
    <SettingsRow
      label={title}
      icon={
        <Checkbox
          label={<span {...stylex.props(srOnly.root)}>Select {title}</span>}
          checked={purging.isSelected(session.id)}
          onCheckedChange={(on) => purging.select([session.id], on)}
        />
      }
      name={
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: session.id }}
          title={title}
          {...stylex.props(styles.branch, focus.ring)}
        >
          <BranchIcon />
          <span {...stylex.props(styles.branchText)}>{title}</span>
        </Link>
      }
      meta={[
        `Deleted by ${archived.by.name} ${timeAgo(archived.at)}`,
        <span key="purge" title={day(archived.purgeAt)}>
          Purged {purgedIn(archived.purgeAt)}
        </span>,
        <span key="size" {...stylex.props(styles.size)}>
          {/* A label on a plain span isn't read out, so the words are there, hidden from sight. */}
          <span {...stylex.props(srOnly.root)}>Disk used by {title}: </span>
          {sizeText(purging.sizes.get(session.id))}
        </span>,
      ]}
      action={
        drives && (
          <Button
            size="sm"
            aria-label={`Restore ${title}`}
            onClick={() => restoreSession(hub, session.id)}
          >
            Restore
          </Button>
        )
      }
      menu={
        <MenuItem intent="danger" onClick={() => purging.ask([session])}>
          Purge {title}
        </MenuItem>
      }
    />
  )
}

/**
 * Asks to purge the Sessions, naming each, and purges them once it's confirmed: they can't be
 * restored, and their Workspaces go with any work not pushed.
 */
function PurgeDialog({ purging }: { purging: Purging }) {
  const hub = useHub()
  const runners = useHubState((state) => state.runners)
  const shown = useLastOpened(purging.asking) ?? noSessions
  const [busy, setBusy] = useState(false)
  const count = shown.length
  const only = count === 1 ? shown[0] : undefined
  const named = only === undefined ? `${count} Sessions` : sessionTitle(only)
  const close = () => {
    setBusy(false)
    purging.ask(null)
  }
  const purge = async () => {
    setBusy(true)
    await purgeSessions(hub, shown, runners ?? [])
    purging.select(
      shown.map((session) => session.id),
      false,
    )
    close()
  }

  return (
    <Dialog
      size="sm"
      open={purging.asking !== null}
      onOpenChange={(open) => {
        if (!open && !busy) close()
      }}
      title={`Purge ${named}?`}
      description={
        count === 1
          ? "Deletes 1 Session now: its history, and its Workspace on its Runner with any work not pushed. This can't be undone."
          : `Deletes ${count} Sessions now: their history, and their Workspaces on their Runners with any work not pushed. This can't be undone.`
      }
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button intent="danger" loading={busy} onClick={() => void purge()}>
            {only === undefined ? `Purge ${named}` : "Purge"}
          </Button>
        </>
      }
    >
      <ul aria-label="Sessions to purge" {...stylex.props(styles.purging)}>
        {shown.map((session) => (
          <li key={session.id}>
            <span {...stylex.props(styles.purgingTitle)}>{sessionTitle(session)}</span>{" "}
            <span {...stylex.props(styles.purgingRepo)}>
              {session.repo} · {sizeText(purging.sizes.get(session.id))}
            </span>
          </li>
        ))}
      </ul>
      <p {...stylex.props(styles.freedTotal)}>
        {freedText(
          freedBy(
            shown.map((session) => session.id),
            purging.sizes,
          ),
        )}
      </p>
    </Dialog>
  )
}

/**
 * Purges the Archived Sessions, and says which were, and that a Runner that is offline frees their
 * disk when it reconnects; and which couldn't be, and why.
 */
async function purgeSessions(
  hub: HubClient,
  sessions: ReadonlyArray<SessionSummary>,
  runners: ReadonlyArray<RunnerSummary>,
): Promise<void> {
  const results = await Promise.allSettled(sessions.map((session) => hub.purgeSession(session.id)))
  const purged: Array<SessionSummary> = []
  const offline = new Set<string>()
  results.forEach((result, index) => {
    const session = sessions[index]
    if (session === undefined) return
    if (result.status === "rejected") {
      toast.show({
        title: `Couldn't purge ${sessionTitle(session)}`,
        description: messageOf(result.reason),
        intent: "warning",
      })
      return
    }
    purged.push(session)
    if (!result.value.runnerOnline) {
      offline.add(runners.find((runner) => runner.id === session.runnerId)?.name ?? "Its Runner")
    }
  })
  const [first] = purged
  if (first === undefined) return
  toast.show({
    title: `Purged ${purged.length === 1 ? sessionTitle(first) : counted(purged.length, { one: "Session", other: "Sessions" })}`,
    ...(offline.size > 0 && {
      description: [...offline]
        .map((name) => `${name} is offline: its disk frees when it reconnects.`)
        .join(" "),
    }),
  })
}

/** Restores an Archived Session, saying so, or that the Hub isn't connected. */
export function restoreSession(hub: HubClient, sessionId: SessionId): void {
  if (!hub.restoreSession(sessionId)) {
    notSent("Restore")
    return
  }
  toast.show({ title: "Session restored", description: "It's Asleep: the next prompt wakes it." })
}
