// The Hub page (ADR 0028): the kndl this Hub runs, its Channel, and whether a newer kndl is out,
// with what changed: each newer Release's notes on stable, the titles of main's new commits on dev.
// Only the Owner has it, and only on a Hub the kndl service runs from its install, which is the
// one that checks GitHub: as it starts, every 6 hours, and when the Owner presses Check now.
//
// From here the Owner updates the Hub, and picks its Channel (#362): the Hub runs `kndl update` on
// its machine, outside its own service. The page follows it step by step, says "Updating… Hub
// restarting" while the Hub restarts under it, and shows how it ended once the Hub is back, with
// the end of its log. An update run with `kndl update` on the Hub's machine shows the same way.
// Update waits for running Turns, as a Runner's does; while the Runners wait, Update now stops them.

import type {
  BuildVersion,
  Channel,
  CommitTitle,
  HubFollows,
  HubUpdateFound,
  HubUpdateRun,
  HubUpdateState,
  ReleaseNotes,
  RunnerSummary,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { type ReactNode, useEffect, useState } from "react"
import { counted, day, timeAgo } from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  EmptyState,
  ExternalLinkIcon,
  LogView,
  Markdown,
  PageHeader,
  RestartIcon,
  Spinner,
  toast,
  UpdateIcon,
  textRole,
} from "../ui/index.ts"
import { focus, textLink } from "../ui/shared.ts"
import { color, font, leading, radius, space, text, weight } from "../ui/tokens.stylex.ts"
import {
  channelChangeText,
  drainingRunners,
  followsText,
  onStableNote,
  runSourceText,
  runTitle,
  versionText,
} from "./hubUpdate.ts"

/** How long the page waits for an update it started to say it started, before it gives up. */
const startingMillis = 60_000

const styles = stylex.create({
  view: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
  scroll: { flex: 1, overflowY: "auto" },
  page: {
    display: "flex",
    flexDirection: "column",
    gap: space.s6,
    maxWidth: "56rem",
    marginInline: "auto",
    paddingBlock: space.s6,
    paddingInline: space.s4,
  },
  section: { display: "flex", flexDirection: "column", gap: space.s2 },
  sectionTitle: { margin: 0 },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
    paddingBlock: space.s4,
    paddingInline: space.s4,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
  },
  facts: {
    display: "grid",
    gridTemplateColumns: "max-content 1fr",
    columnGap: space.s6,
    rowGap: space.s2,
    margin: 0,
    fontSize: text.sm,
  },
  term: { color: color.textMuted },
  value: { margin: 0, minWidth: 0, overflowWrap: "anywhere" },
  channel: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s2 },
  mono: { fontFamily: font.mono },
  error: { margin: 0, color: color.dangerSubtleText, fontSize: text.sm, lineHeight: leading.snug },
  failedTitle: { color: color.dangerSubtleText },
  headline: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s3,
  },
  headlineText: { display: "flex", flexDirection: "column", gap: space.s1, minWidth: 0 },
  headlineTitle: { margin: 0 },
  note: { margin: 0, color: color.textMuted, fontSize: text.sm, lineHeight: leading.snug },
  /** Update, beside the link to GitHub. */
  actions: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s2 },
  link: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    color: color.text,
    fontSize: text.sm,
    fontWeight: weight.medium,
    whiteSpace: "nowrap",
  },
  release: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
    paddingTop: space.s4,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  releaseTitle: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: space.s2,
    margin: 0,
  },
  releaseDate: { color: color.textMuted, fontSize: text.sm, fontWeight: weight.normal },
  commits: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
    margin: 0,
    padding: 0,
    listStyle: "none",
    fontSize: text.sm,
  },
  commit: { display: "flex", gap: space.s3, minWidth: 0 },
  sha: { flexShrink: 0, color: color.textMuted, fontFamily: font.mono },
  title: { minWidth: 0, overflowWrap: "anywhere" },
  loading: { display: "flex", alignItems: "center", gap: space.s2 },
})

export function HubPage() {
  const owner = useHubState((state) => state.owner)
  const update = useHubState((state) => state.hubUpdate)
  return (
    <main {...stylex.props(styles.view)}>
      {owner && update !== null ? (
        <Hub update={update} />
      ) : (
        <>
          <PageHeader title="Hub" />
          <EmptyState
            size="page"
            icon={<UpdateIcon />}
            {...(owner
              ? {
                  title: "This Hub doesn't check for updates",
                  description:
                    "Only a Hub that kndl's service runs from its install checks GitHub for a newer kndl. Update this one where it runs.",
                }
              : {
                  title: "Only the Hub's Owner sees this page",
                  description: "It says which kndl the Hub runs, and whether a newer one is out.",
                })}
          />
        </>
      )}
    </main>
  )
}

/** The confirmation open on the page, if one is. */
type Confirming =
  | { readonly _tag: "Update" }
  | { readonly _tag: "Channel"; readonly to: Channel }
  | { readonly _tag: "StopTurns" }

/** An update the page started, until its status says it started: the latest one before it. */
interface Awaiting {
  readonly before: string | undefined
}

function Hub({ update }: { update: HubUpdateState }) {
  const hub = useHub()
  const version = useHubState((state) => state.hubVersion)
  const run = useHubState((state) => state.hubUpdateRun)
  const runners = useHubState((state) => state.runners)
  const now = useNow(15_000)
  const [checking, setChecking] = useState(false)
  const [confirming, setConfirming] = useState<Confirming | null>(null)
  const [awaiting, setAwaiting] = useState<Awaiting | null>(null)
  const { follows, checked, failed } = update
  // A failure older than the last check that worked is over.
  const failure = failed !== undefined && failed.at >= (checked?.at ?? 0) ? failed : undefined
  // The update started is under way once its status is written: a new one.
  const started = awaiting !== null && run !== null && run.status.id !== awaiting.before
  useEffect(() => {
    if (started) setAwaiting(null)
  }, [started])
  useEffect(() => {
    if (awaiting === null) return
    const timer = setTimeout(() => {
      setAwaiting(null)
      toast.show({
        title: "The update didn't start",
        description:
          "The Hub launched it, but it never said it started. See logs/update.log in the Hub's home.",
        intent: "danger",
      })
    }, startingMillis)
    return () => clearTimeout(timer)
  }, [awaiting])
  const updating = (awaiting !== null && !started) || run?.status.state === "Running"
  const draining = drainingRunners(runners, version)

  /** Starts the update, as Update, Update now or a Channel asks; throws why it couldn't. */
  const start = async (request: { readonly now: boolean; readonly channel?: Channel }) => {
    const before = run?.status.id
    await hub.updateHub(request)
    setAwaiting({ before })
  }

  const checkNow = async () => {
    setChecking(true)
    try {
      const after = await hub.checkHubUpdate()
      if (after.failed !== undefined && after.failed.at >= (after.checked?.at ?? 0)) {
        toast.show({
          title: "Couldn't check for a newer kndl",
          description: after.failed.message,
          intent: "danger",
        })
      } else if (after.checked?.found._tag === "UpToDate") {
        toast.show({ title: "kndl is up to date", intent: "success" })
      }
    } catch (error) {
      toast.show({
        title: "Couldn't check for a newer kndl",
        description: messageOf(error),
        intent: "danger",
      })
    } finally {
      setChecking(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Hub"
        description="The kndl this Hub runs, and updates on its Channel."
        actions={
          follows._tag === "Channel" && (
            <Button
              size="sm"
              icon={<RestartIcon />}
              loading={checking}
              onClick={() => void checkNow()}
            >
              Check now
            </Button>
          )
        }
      />
      <div {...stylex.props(styles.scroll)}>
        <div {...stylex.props(styles.page)}>
          <section aria-labelledby="this-hub" {...stylex.props(styles.section)}>
            <h2 id="this-hub" {...stylex.props(textRole.overline, styles.sectionTitle)}>
              This Hub
            </h2>
            <div {...stylex.props(styles.card)}>
              <dl {...stylex.props(styles.facts)}>
                <dt {...stylex.props(styles.term)}>Version</dt>
                <dd {...stylex.props(styles.value, styles.mono)}>
                  {versionText(version, follows)}
                </dd>
                <dt {...stylex.props(styles.term)}>Channel</dt>
                <dd {...stylex.props(styles.value)}>
                  <ChannelPicker
                    follows={follows}
                    disabled={updating}
                    onPick={(to) => setConfirming({ _tag: "Channel", to })}
                  />
                </dd>
                {follows._tag === "Channel" && (
                  <>
                    <dt {...stylex.props(styles.term)}>Last checked</dt>
                    <dd {...stylex.props(styles.value)}>
                      {checked === undefined ? "Not yet" : timeAgo(checked.at, now)}
                    </dd>
                  </>
                )}
              </dl>
              {failure !== undefined && (
                <p role="alert" {...stylex.props(styles.error)}>
                  The check {timeAgo(failure.at, now)} failed: {failure.message}
                </p>
              )}
            </div>
          </section>
          {(run !== null || updating) && (
            <section aria-labelledby="latest-update" {...stylex.props(styles.section)}>
              <h2 id="latest-update" {...stylex.props(textRole.overline, styles.sectionTitle)}>
                Latest update
              </h2>
              <div {...stylex.props(styles.card)}>
                <LatestUpdate
                  run={started || awaiting === null ? run : null}
                  now={now}
                  draining={draining}
                  onStopTurns={() => setConfirming({ _tag: "StopTurns" })}
                />
              </div>
            </section>
          )}
          <section aria-labelledby="update" {...stylex.props(styles.section)}>
            <h2 id="update" {...stylex.props(textRole.overline, styles.sectionTitle)}>
              Update
            </h2>
            <div {...stylex.props(styles.card)}>
              {follows._tag === "Pinned" ? (
                <p {...stylex.props(styles.note)}>
                  This Hub is pinned to {follows.ref}, so no update is offered. Pick a Channel above
                  to follow one again.
                </p>
              ) : checked === undefined ? (
                failure === undefined ? (
                  <div {...stylex.props(styles.loading, styles.note)}>
                    <Spinner size="sm" /> Checking GitHub for a newer kndl…
                  </div>
                ) : (
                  <p {...stylex.props(styles.note)}>
                    The Hub couldn't tell whether a newer kndl is out. See the{" "}
                    <ExternalLink href="https://github.com/kddige/kndl/releases">
                      Releases on GitHub
                    </ExternalLink>
                    .
                  </p>
                )
              ) : (
                <Found
                  found={checked.found}
                  channel={follows.channel}
                  version={version}
                  action={
                    updating ? null : (
                      <Button
                        size="sm"
                        intent="primary"
                        icon={<UpdateIcon />}
                        onClick={() => setConfirming({ _tag: "Update" })}
                      >
                        Update
                      </Button>
                    )
                  }
                />
              )}
            </div>
          </section>
        </div>
      </div>
      <UpdateDialog
        open={confirming?._tag === "Update"}
        found={checked?.found}
        runners={runners ?? []}
        onStart={start}
        onClose={() => setConfirming(null)}
      />
      <ChannelDialog
        to={confirming?._tag === "Channel" ? confirming.to : null}
        follows={follows}
        onStart={start}
        onClose={() => setConfirming(null)}
      />
      <StopTurnsDialog
        open={confirming?._tag === "StopTurns"}
        runners={draining}
        onClose={() => setConfirming(null)}
      />
    </>
  )
}

/**
 * What the Hub follows, and the Channels it can follow instead: the other one, or either on a
 * pinned Hub, which picking one unpins.
 */
function ChannelPicker({
  follows,
  disabled,
  onPick,
}: {
  follows: HubFollows
  disabled: boolean
  onPick: (to: Channel) => void
}) {
  const others: ReadonlyArray<Channel> =
    follows._tag === "Pinned"
      ? ["stable", "dev"]
      : follows.channel === "stable"
        ? ["dev"]
        : ["stable"]
  return (
    <span {...stylex.props(styles.channel)}>
      {followsText(follows)}
      {others.map((to) => (
        <Button key={to} size="sm" intent="ghost" disabled={disabled} onClick={() => onPick(to)}>
          {follows._tag === "Pinned" ? `Follow ${to}` : `Switch to ${to}`}
        </Button>
      ))}
    </span>
  )
}

/**
 * The latest update: where it is while it runs, "Hub restarting" while the Hub is down under it,
 * and how it ended, with the error and the end of its log. `null` while one the page started
 * hasn't said it started. Once it moved the Hub, Update now stops the Turns its Runners wait for.
 */
function LatestUpdate({
  run,
  now,
  draining,
  onStopTurns,
}: {
  run: HubUpdateRun | null
  now: number
  draining: ReadonlyArray<RunnerSummary>
  onStopTurns: () => void
}) {
  const connection = useHubState((state) => state.connection)
  const online = connection.status === "online"
  if (run === null || run.status.state === "Running") {
    const title =
      run !== null && !online
        ? "Updating… Hub restarting"
        : run === null
          ? "Starting the update…"
          : runTitle(run)
    return (
      <div role="status" {...stylex.props(styles.headlineText)}>
        <p {...stylex.props(textRole.heading, styles.loading, styles.headlineTitle)}>
          <Spinner size="sm" /> {title}
        </p>
        <p {...stylex.props(styles.note)}>
          {run !== null && !online
            ? "This page reconnects on its own once the Hub is back, and says how the update ended."
            : run === null
              ? "The Hub is starting kndl update on its machine."
              : `Started ${timeAgo(run.status.startedAt, now)}, ${runSourceText(run)}. The Hub restarts on the new version, and this page reconnects on its own.`}
        </p>
      </div>
    )
  }
  const { status, logTail } = run
  const failed = status.state !== "Succeeded"
  const waiting = draining.length
  return (
    <>
      <div {...stylex.props(styles.headline)}>
        <div role="status" {...stylex.props(styles.headlineText)}>
          <p
            {...stylex.props(textRole.heading, styles.headlineTitle, failed && styles.failedTitle)}
          >
            {runTitle(run)}
          </p>
          <p {...stylex.props(styles.note)}>
            {status.finishedAt === undefined
              ? `Started ${timeAgo(status.startedAt, now)}`
              : `Finished ${timeAgo(status.finishedAt, now)}`}
            , {runSourceText(run)}.
            {status.state === "RolledBack" &&
              " The Hub went back to the commit it ran, rebuilt it and restarted there."}
          </p>
        </div>
        {!failed && waiting > 0 && (
          <div {...stylex.props(styles.actions)}>
            <Button size="sm" intent="primary" onClick={onStopTurns}>
              Update now
            </Button>
          </div>
        )}
      </div>
      {!failed && waiting > 0 && (
        <p {...stylex.props(styles.note)}>
          {waiting === 1
            ? `${draining[0]?.name ?? "A Runner"} waits for its running Turns to end, up to ten minutes, before it updates.`
            : `${waiting} Runners wait for their running Turns to end, up to ten minutes, before they update.`}
        </p>
      )}
      {status.error !== undefined && (
        <p role="alert" {...stylex.props(styles.error)}>
          {status.error}
        </p>
      )}
      {failed && logTail !== undefined && (
        <LogView label="The end of the update's log">{logTail}</LogView>
      )}
    </>
  )
}

/**
 * Updates the Hub once it's confirmed: Update lets its Runners' running Turns end (within ten
 * minutes) before they follow, and Update now stops them at once, as the Runner dialog does.
 */
function UpdateDialog({
  open,
  found,
  runners,
  onStart,
  onClose,
}: {
  open: boolean
  found: HubUpdateFound | undefined
  runners: ReadonlyArray<RunnerSummary>
  onStart: (request: { readonly now: boolean }) => Promise<void>
  onClose: () => void
}) {
  const [busy, setBusy] = useState<"wait" | "now" | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setBusy(null)
    setError(null)
  }, [open])
  const sessions = runners.reduce((sum, runner) => sum + runner.openSessions, 0)
  const update = async (now: boolean) => {
    setBusy(now ? "now" : "wait")
    setError(null)
    try {
      await onStart({ now })
      onClose()
    } catch (cause) {
      setError(messageOf(cause))
      setBusy(null)
    }
  }
  const target =
    found?._tag === "NewerRelease"
      ? `kndl ${found.releases[0].version}`
      : found?._tag === "NewerCommits"
        ? `main's head, ${found.head.slice(0, 12)}`
        : "the newest kndl on its Channel"
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title="Update the Hub?"
      description={`It moves to ${target}, builds it and restarts, which takes a few minutes: this page reconnects on its own. Its Runners follow${sessions === 0 ? "" : ", each once its running Turns finish (up to ten minutes)"}. If anything fails, the Hub goes back to the commit it runs now.`}
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          {sessions > 0 && (
            <Button
              loading={busy === "now"}
              disabled={busy === "wait"}
              onClick={() => void update(true)}
            >
              Update now
            </Button>
          )}
          <Button
            intent="primary"
            loading={busy === "wait"}
            disabled={busy === "now"}
            onClick={() => void update(false)}
          >
            Update
          </Button>
        </>
      }
    >
      {/* One expression, null when there's nothing to add, so the dialog leaves out its body. */}
      {sessions === 0 && error === null ? null : (
        <>
          {sessions > 0 && (
            <p {...stylex.props(styles.note)}>
              Update now stops running Turns at once instead of letting them finish.
            </p>
          )}
          {error && (
            <p role="alert" {...stylex.props(styles.error)}>
              {error}
            </p>
          )}
        </>
      )}
    </Dialog>
  )
}

/** Has the Hub follow another Channel once it's confirmed: an update with `--channel`. */
function ChannelDialog({
  to,
  follows,
  onStart,
  onClose,
}: {
  to: Channel | null
  follows: HubFollows
  onStart: (request: { readonly now: boolean; readonly channel: Channel }) => Promise<void>
  onClose: () => void
}) {
  const shown = useLastOpened(to)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setBusy(false)
    setError(null)
  }, [to])
  const change = shown === null ? null : channelChangeText(follows, shown)
  const pick = async () => {
    if (shown === null) return
    setBusy(true)
    setError(null)
    try {
      await onStart({ now: false, channel: shown })
      onClose()
    } catch (cause) {
      setError(messageOf(cause))
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={to !== null}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={change?.title ?? ""}
      description={change?.description}
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button intent="primary" loading={busy} onClick={() => void pick()}>
            {change?.action ?? ""}
          </Button>
        </>
      }
    >
      {error === null ? null : (
        <p role="alert" {...stylex.props(styles.error)}>
          {error}
        </p>
      )}
    </Dialog>
  )
}

/**
 * Stops the running Turns the Runners wait for after the Hub's update, so they update now rather
 * than in up to ten minutes: Update now on each, as on the Runners page.
 */
function StopTurnsDialog({
  open,
  runners,
  onClose,
}: {
  open: boolean
  runners: ReadonlyArray<RunnerSummary>
  onClose: () => void
}) {
  const client = useHub()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setBusy(false)
    setError(null)
  }, [open])
  const stop = async () => {
    setBusy(true)
    setError(null)
    const failures = (
      await Promise.allSettled(runners.map((runner) => client.updateRunner(runner.id, true)))
    ).flatMap((result) => (result.status === "rejected" ? [messageOf(result.reason)] : []))
    if (failures.length === 0) {
      onClose()
      return
    }
    setError(failures.join(" "))
    setBusy(false)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title="Stop the Runners' running Turns?"
      description="Their Sessions' Turns stop where they are, as Stop would, so the Runners update now rather than in up to ten minutes. Each Session sleeps and keeps its conversation."
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button intent="danger" loading={busy} onClick={() => void stop()}>
            Stop Turns and update
          </Button>
        </>
      }
    >
      {error === null ? null : (
        <p role="alert" {...stylex.props(styles.error)}>
          {error}
        </p>
      )}
    </Dialog>
  )
}

/** What the last check that worked found, with what changed, and Update when it is newer. */
function Found({
  found,
  channel,
  version,
  action,
}: {
  found: HubUpdateFound
  channel: "stable" | "dev"
  version: BuildVersion | null
  action: ReactNode
}) {
  switch (found._tag) {
    case "UpToDate":
      return (
        <div {...stylex.props(styles.headlineText)}>
          <p {...stylex.props(textRole.heading, styles.headlineTitle)}>kndl is up to date</p>
          <p {...stylex.props(styles.note)}>
            {channel === "dev"
              ? "This Hub runs the head of main."
              : version !== null && version.release === undefined
                ? onStableNote
                : "This Hub runs the newest Release."}
          </p>
        </div>
      )
    case "NewerRelease": {
      const [newest] = found.releases
      const count = found.releases.length
      return (
        <>
          <Headline
            title={`kndl ${newest.version} is out`}
            note={
              count === 1
                ? "One Release is newer than this Hub's."
                : `${count} Releases are newer than this Hub's, newest first.`
            }
            href={found.compareUrl}
            link="Compare on GitHub"
            action={action}
          />
          {found.releases.map((release) => (
            <Release key={release.version} release={release} />
          ))}
        </>
      )
    }
    case "NewerCommits":
      return (
        <>
          <Headline
            title={`main is ${counted(found.behindBy, { one: "commit", other: "commits" })} ahead`}
            note={
              found.behindBy > found.commits.length
                ? `The newest ${found.commits.length}, newest first.`
                : "Newest first."
            }
            href={found.compareUrl}
            link="Compare on GitHub"
            action={action}
          />
          <ul aria-label="Commits since this Hub's" {...stylex.props(styles.commits)}>
            {found.commits.map((commit) => (
              <Commit key={commit.commit} commit={commit} />
            ))}
          </ul>
          {found.behindBy > found.commits.length && (
            <p {...stylex.props(styles.note)}>
              And {found.behindBy - found.commits.length} more on GitHub.
            </p>
          )}
        </>
      )
  }
}

function Headline({
  title,
  note,
  href,
  link,
  action,
}: {
  title: string
  note: string
  href: string
  link: string
  action: ReactNode
}) {
  return (
    <div {...stylex.props(styles.headline)}>
      <div {...stylex.props(styles.headlineText)}>
        <p {...stylex.props(textRole.heading, styles.headlineTitle)}>{title}</p>
        <p {...stylex.props(styles.note)}>{note}</p>
      </div>
      <div {...stylex.props(styles.actions)}>
        <ExternalLink href={href}>{link}</ExternalLink>
        {action}
      </div>
    </div>
  )
}

function Release({ release }: { release: ReleaseNotes }) {
  return (
    <article aria-label={release.version} {...stylex.props(styles.release)}>
      <h3 {...stylex.props(textRole.heading, styles.releaseTitle)}>
        {release.version}
        {release.publishedAt !== undefined && (
          <span {...stylex.props(styles.releaseDate)}>{day(release.publishedAt)}</span>
        )}
        <Badge>Release</Badge>
        <ExternalLink href={release.url}>On GitHub</ExternalLink>
      </h3>
      {release.notes.trim() === "" ? (
        <p {...stylex.props(styles.note)}>It has no notes.</p>
      ) : (
        <Markdown text={release.notes} />
      )}
    </article>
  )
}

function Commit({ commit }: { commit: CommitTitle }) {
  return (
    <li {...stylex.props(styles.commit)}>
      <span {...stylex.props(styles.sha)}>{commit.commit.slice(0, 9)}</span>
      <span {...stylex.props(styles.title)}>{commit.title}</span>
    </li>
  )
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      {...stylex.props(textLink.underline, styles.link, focus.ring)}
    >
      {children}
      <ExternalLinkIcon aria-hidden="true" />
    </a>
  )
}

/** The time, updated every `ms`. */
function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

/** `value`, or while it is null (a dialog closing), the last value it wasn't. */
function useLastOpened<T>(value: T | null): T | null {
  const [last, setLast] = useState(value)
  if (value !== null && value !== last) setLast(value)
  return value ?? last
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
