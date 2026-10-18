// The Runners page (issue #85): every Runner paired with the Hub, whether it's online, its version
// against the Hub's own, when it was last seen and how many Sessions it has. A Runner has no
// Claude credential of its own: each Session runs on its Creator's (ADR 0026).
// Anyone signed in adds a Runner here with a Pairing code, Re-pairs one (a new token, same RunnerId
// and Sessions) or removes one, once its Sessions are all Archived. Codes still waiting are listed
// so they can be revoked. A Runner behind the Hub that updates itself has Update (#87), for the
// Hub's Owner alone (ADR 0028): it moves to the Hub's commit once its Sessions sleep, and its row
// follows the update, or says why it refused or failed. Every Member sees whether one is behind. A row warns when the Runner's disk is low (#350), and its Monitor (#356) opens
// under it: the host as it last sampled it, and charts of its last week. Every confirmation is a
// Dialog on the page.

import {
  type BuildVersion,
  describeBuild,
  diskIsLow,
  type PairingCodeCreated,
  pairingCommand,
  type PendingPairingCode,
  type RunnerSummary,
  runnerRemovalRefusal,
  type SessionSummary,
  sessionTitle,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { lazy, type ReactNode, Suspense, useEffect, useState } from "react"
import { copyCommand } from "../app/copy.ts"
import { counted, timeAgo } from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import { keptAwakeText } from "../session/keepAwake.ts"
import {
  Badge,
  Banner,
  Button,
  CheckIcon,
  CopyIcon,
  Dialog,
  DialogClose,
  IconButton,
  MenuItem,
  MenuSeparator,
  PlusIcon,
  Popover,
  SettingsEmpty,
  SettingsList,
  SettingsLoading,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  Spinner,
  SunIcon,
  toast,
  WarningIcon,
} from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, font, leading, radius, space, text } from "../ui/tokens.stylex.ts"
import {
  codeOutcome,
  hasMonitor,
  shortCommit,
  sortRunners,
  timeLeft,
  updateAction,
  manualUpdateText,
  updateNote,
  versionNote,
  waitingCodes,
} from "./runners.ts"

// The charts are most of the Monitor's weight: it loads when a Monitor is first opened.
const RunnerMonitor = lazy(async () => ({
  default: (await import("./RunnerMonitor.tsx")).RunnerMonitor,
}))

const styles = stylex.create({
  // A badge that opens what it means: no button look of its own.
  badgeButton: {
    display: "inline-flex",
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: "transparent",
    cursor: "pointer",
  },
  monitorLoading: { display: "grid", placeItems: "center", paddingBlock: space.s8 },
  mono: { fontFamily: font.mono },
  keptAwakeList: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  dot: { width: "0.5rem", height: "0.5rem", borderRadius: "50%", flexShrink: 0 },
  online: { backgroundColor: color.success },
  offline: { backgroundColor: color.neutral },
  dialogBody: { display: "flex", flexDirection: "column", gap: space.s3 },
  command: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s2,
    paddingBlock: space.s2,
    paddingInlineStart: space.s3,
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
    paddingBlock: space.s1,
    fontFamily: font.mono,
    fontSize: text.sm,
    lineHeight: leading.snug,
    overflowWrap: "anywhere",
    userSelect: "all",
  },
  note: { margin: 0, color: color.textSecondary, fontSize: text.sm, lineHeight: leading.snug },
  status: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    margin: 0,
    color: color.textSecondary,
    fontSize: text.sm,
  },
  error: { margin: 0, color: color.dangerText, fontSize: text.sm, lineHeight: leading.snug },
  updateLine: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s2,
    margin: 0,
    color: color.textSecondary,
    fontSize: text.sm,
    lineHeight: leading.snug,
  },
  updateText: { minWidth: 0, overflowWrap: "anywhere", whiteSpace: "pre-line" },
  updateWarning: { color: color.warningText },
  updateDanger: { color: color.dangerText },
})

/** What a pairing dialog is for: a new Runner, or a Re-pair of one. */
type PairTarget =
  | { readonly _tag: "New" }
  | { readonly _tag: "Repair"; readonly runner: RunnerSummary }

/** The pairing dialog's state: what it's for, and the code made for it, once there is one. */
interface Pairing {
  readonly target: PairTarget
  readonly minted: PairingCodeCreated | null
  readonly busy: boolean
  readonly error: string | null
}

/**
 * Opens the pairing dialog and makes its code: a new Runner's as it opens, a Re-pair's once it's
 * confirmed. Codes are made from clicks, not effects, so each opening makes one.
 */
function usePairing() {
  const hub = useHub()
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const mint = async (target: PairTarget) => {
    setPairing({ target, minted: null, busy: true, error: null })
    const runnerId = target._tag === "Repair" ? target.runner.id : undefined
    const settle = (next: Partial<Pairing>) =>
      setPairing((current) =>
        current?.target === target ? { ...current, busy: false, ...next } : current,
      )
    try {
      settle({ minted: await hub.createPairingCode(runnerId) })
    } catch (error) {
      settle({ error: messageOf(error) })
    }
  }
  return {
    pairing,
    open: (target: PairTarget) =>
      target._tag === "New"
        ? void mint(target)
        : setPairing({ target, minted: null, busy: false, error: null }),
    confirm: () => {
      if (pairing) void mint(pairing.target)
    },
    close: () => setPairing(null),
  }
}

export function RunnersView() {
  const runners = useHubState((state) => state.runners)
  const codes = useHubState((state) => state.pairingCodes)
  const hubVersion = useHubState((state) => state.hubVersion)
  const sessions = useHubState((state) => state.sessions)
  const now = useNow(15_000)
  const pairing = usePairing()
  const [removing, setRemoving] = useState<RunnerSummary | null>(null)
  const [updating, setUpdating] = useState<RunnerSummary | null>(null)

  const sorted = runners === null ? null : sortRunners(runners)
  const waiting = waitingCodes(codes, now)
  const addRunner = () => pairing.open({ _tag: "New" })
  return (
    <SettingsPage
      title="Runners"
      description={
        <>
          The machines Sessions run on
          {hubVersion && (
            <>
              ; the Hub runs <span {...stylex.props(styles.mono)}>{describeBuild(hubVersion)}</span>
            </>
          )}
          .
        </>
      }
      action={
        <Button intent="primary" size="sm" icon={<PlusIcon />} onClick={addRunner}>
          Add a Runner
        </Button>
      }
    >
      {sorted === null ? (
        <SettingsLoading label="Loading Runners" />
      ) : sorted.length === 0 ? (
        <SettingsEmpty
          title="No Runners yet"
          description="A Runner is a machine that runs Sessions. One command pairs it and starts it."
          action={
            <Button size="sm" icon={<PlusIcon />} onClick={addRunner}>
              Add a Runner
            </Button>
          }
        />
      ) : (
        <SettingsList label="Runners">
          {sorted.map((runner) => (
            <RunnerRow
              key={runner.id}
              runner={runner}
              keptAwake={(sessions ?? []).filter(
                (session) => session.runnerId === runner.id && session.keepAwake !== undefined,
              )}
              now={now}
              onUpdate={() => setUpdating(runner)}
              onRepair={() => pairing.open({ _tag: "Repair", runner })}
              onRemove={() => setRemoving(runner)}
            />
          ))}
        </SettingsList>
      )}
      {waiting.length > 0 && (
        <SettingsSection title="Pairing codes not used yet">
          <SettingsList label="Pairing codes not used yet">
            {waiting.map((code) => (
              <CodeRow key={code.id} code={code} runners={runners ?? []} now={now} />
            ))}
          </SettingsList>
        </SettingsSection>
      )}
      <PairDialog pairing={pairing.pairing} onConfirm={pairing.confirm} onClose={pairing.close} />
      <RemoveDialog runner={removing} onClose={() => setRemoving(null)} />
      <UpdateDialog runner={updating} hub={hubVersion} onClose={() => setUpdating(null)} />
    </SettingsPage>
  )
}

function RunnerRow({
  runner,
  keptAwake,
  now,
  onUpdate,
  onRepair,
  onRemove,
}: {
  runner: RunnerSummary
  /** Its Sessions the viewer can see that have Keep awake on (ADR 0016). */
  keptAwake: ReadonlyArray<SessionSummary>
  now: number
  onUpdate: () => void
  onRepair: () => void
  onRemove: () => void
}) {
  const update = updateNote(runner.update, now)
  const underWay = update?.busy === true
  // While it updates, the update says it all: being behind is why.
  const note = underWay ? undefined : versionNote(runner.versionStatus, runner.updater)
  const you = useHubState((state) => state.you)
  // Moving the code its Sessions run on is the Owner's (ADR 0028).
  const owner = useHubState((state) => state.owner)
  const action = owner ? updateAction(runner) : undefined
  const manual = manualUpdateText(runner)
  // Paired, but it hasn't connected since.
  const neverSeen = !runner.isOnline && runner.lastSeenAt === null
  const [monitoring, setMonitoring] = useState(false)
  const lowDisk = runner.sysinfo !== undefined && diskIsLow(runner.sysinfo)
  const monitor = hasMonitor(runner)
  const toggleMonitor = () => setMonitoring((open) => !open)
  return (
    <SettingsRow
      label={runner.name}
      icon={
        <span
          role="img"
          aria-label={runner.isOnline ? "online" : "offline"}
          {...stylex.props(styles.dot, runner.isOnline ? styles.online : styles.offline)}
        />
      }
      name={runner.name}
      meta={[
        runner.version === null ? (
          neverSeen ? (
            "Not connected yet"
          ) : (
            "Version unknown"
          )
        ) : (
          <span key="version" title={runner.version.commit} {...stylex.props(styles.mono)}>
            {describeBuild(runner.version)}
          </span>
        ),
        !runner.isOnline &&
          !neverSeen &&
          runner.lastSeenAt !== null &&
          `Last seen ${timeAgo(runner.lastSeenAt, now)}`,
        runner.openSessions === 0
          ? "No Sessions"
          : counted(runner.openSessions, { one: "Session", other: "Sessions" }),
      ]}
      notes={
        <>
          {update && (
            <p
              aria-live="polite"
              {...stylex.props(
                styles.updateLine,
                update.intent === "warning" && styles.updateWarning,
                update.intent === "danger" && styles.updateDanger,
              )}
            >
              {update.busy && <Spinner size="sm" />}
              <span {...stylex.props(styles.updateText)}>{update.detail}</span>
            </p>
          )}
          {manual && (
            <p {...stylex.props(styles.updateLine)}>
              <span {...stylex.props(styles.updateText)}>{manual}</span>
            </p>
          )}
        </>
      }
      badges={
        (!runner.isOnline || note || update || lowDisk || keptAwake.length > 0) && (
          <>
            {!runner.isOnline && <Badge>offline</Badge>}
            {note && (
              // What the badge means has to be readable on touch and to a screen reader: a Popover,
              // not a Tooltip.
              <BadgePopover title={note.label} badge={<Badge intent="warning">{note.label}</Badge>}>
                {note.title}
              </BadgePopover>
            )}
            {update && <Badge intent={update.intent}>{update.label}</Badge>}
            {lowDisk && (
              <BadgePopover title="Low disk" badge={<Badge intent="warning">low disk</Badge>}>
                Under 10 GiB, or a tenth of the disk, is free. Sessions can still start, until it
                runs out.
              </BadgePopover>
            )}
            {keptAwake.length > 0 && (
              // Which ones, and who keeps them awake (ADR 0016).
              <BadgePopover
                title="Kept awake"
                badge={
                  <Badge icon={<SunIcon width={12} height={12} />}>
                    {keptAwake.length} kept awake
                  </Badge>
                }
              >
                <ul {...stylex.props(styles.keptAwakeList)}>
                  {keptAwake.map((session) => (
                    <li key={session.id}>
                      {sessionTitle(session)}
                      {session.keepAwake && `: ${keptAwakeText(session.keepAwake, you?.id)}`}
                    </li>
                  ))}
                </ul>
              </BadgePopover>
            )}
          </>
        )
      }
      action={
        action && (
          <Button
            size="sm"
            intent="primary"
            aria-label={`${action === "Update" ? "Update" : "Update now"} ${runner.name}`}
            onClick={onUpdate}
          >
            {action === "Update" ? "Update" : "Update now"}
          </Button>
        )
      }
      menu={
        <>
          {monitor && (
            <MenuItem onClick={toggleMonitor}>
              {monitoring ? `Close ${runner.name}'s Monitor` : `Monitor ${runner.name}`}
            </MenuItem>
          )}
          <MenuItem onClick={onRepair}>Re-pair {runner.name}</MenuItem>
          <MenuSeparator />
          <MenuItem intent="danger" onClick={onRemove}>
            Remove {runner.name}
          </MenuItem>
        </>
      }
      {...(monitor && { onToggle: toggleMonitor })}
      detail={
        monitor &&
        monitoring && (
          <Suspense
            fallback={
              <div {...stylex.props(styles.monitorLoading)}>
                <Spinner label={`Loading ${runner.name}'s monitor`} />
              </div>
            }
          >
            <RunnerMonitor runner={runner} now={now} />
          </Suspense>
        )
      }
    />
  )
}

/** A badge that opens what it means, readable on touch and to a screen reader. */
function BadgePopover({
  title,
  badge,
  children,
}: {
  title: string
  badge: ReactNode
  children: ReactNode
}) {
  return (
    <Popover
      title={title}
      trigger={
        <button type="button" {...stylex.props(styles.badgeButton, focus.ring)}>
          {badge}
        </button>
      }
    >
      {children}
    </Popover>
  )
}

function CodeRow({
  code,
  runners,
  now,
}: {
  code: PendingPairingCode
  runners: ReadonlyArray<RunnerSummary>
  now: number
}) {
  const hub = useHub()
  const runner = runners.find((candidate) => candidate.id === code.runnerId)
  const what =
    code.runnerId === undefined ? "A new Runner" : `Re-pair ${runner?.name ?? "a removed Runner"}`
  const revoke = async () => {
    try {
      await hub.revokePairingCode(code.id)
      toast.show({ title: "Pairing code revoked" })
    } catch (error) {
      toast.show({
        title: "Couldn't revoke the code",
        description: messageOf(error),
        intent: "danger",
      })
    }
  }
  return (
    <SettingsRow
      label={what}
      name={what}
      meta={[
        `Made by ${code.createdBy.name} ${timeAgo(code.createdAt, now)}`,
        `Expires in ${timeLeft(code.expiresAt, now)}`,
      ]}
      menu={
        <MenuItem intent="danger" onClick={() => void revoke()}>
          Revoke the code
        </MenuItem>
      }
    />
  )
}

/**
 * Adds a Runner, or Re-pairs one: a Re-pair asks first, since its code replaces the Runner's token.
 * Then it mints a code and shows the command to paste on the machine, and follows the code until
 * it's used, expires or is revoked. Closing it leaves the code waiting, listed on the page.
 */
function PairDialog({
  pairing,
  onConfirm,
  onClose,
}: {
  pairing: Pairing | null
  onConfirm: () => void
  onClose: () => void
}) {
  // While the dialog closes, it keeps showing what it was opened for.
  const shown = useLastOpened(pairing)
  const repair = shown?.target._tag === "Repair" ? shown.target.runner : null
  const minted = shown?.minted ?? null
  const busy = shown?.busy ?? false
  const error = shown?.error ?? null
  // A Re-pair asks first, and stays asking while its code is made or if making it failed.
  const confirming = repair !== null && minted === null
  return (
    <Dialog
      open={pairing !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={repair ? `Re-pair ${repair.name}` : "Add a Runner"}
      description={
        confirming
          ? `For a machine whose token was lost, or one taking ${repair.name}'s place. It keeps its name and Sessions. Once the new code is used, its current token stops working and, if it's connected, it's disconnected.`
          : repair
            ? `Run this on the machine that will be ${repair.name}. It checks the machine has what a Runner needs, pairs it with the Hub in ${repair.name}'s place, and installs and starts the Runner service.`
            : "Run this on the machine that will run Sessions. It checks the machine has what a Runner needs, pairs it with the Hub, and installs and starts the Runner service."
      }
      footer={
        confirming ? (
          <>
            <DialogClose>Cancel</DialogClose>
            <Button intent="primary" loading={busy} onClick={onConfirm}>
              Make a pairing code
            </Button>
          </>
        ) : (
          <DialogClose>Done</DialogClose>
        )
      }
    >
      {/* One expression, null while only asking, so the dialog leaves out its body. */}
      {confirming && error === null ? null : (
        <>
          {!confirming && (
            <div {...stylex.props(styles.dialogBody)}>
              {minted ? (
                <MintedCode minted={minted} />
              ) : error === null ? (
                <p {...stylex.props(styles.status)}>
                  <Spinner size="sm" /> Making a pairing code…
                </p>
              ) : null}
            </div>
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

/** The command a minted code is pasted in, and how the code is getting on. */
function MintedCode({ minted }: { minted: PairingCodeCreated }) {
  const state = useHubState((hub) => hub)
  const now = useNow(1_000)
  const outcome = codeOutcome(minted, state, now)
  const command = pairingCommand(minted.link)
  if (outcome._tag === "Used") {
    const runner = outcome.runner
    return (
      <Banner
        intent="neutral"
        icon={<CheckIcon />}
        title={`Paired ${runner?.name ?? "the Runner"}`}
      >
        {runner?.isOnline
          ? `${runner.name} is online.`
          : "Waiting for it to connect: the join command starts its service."}
      </Banner>
    )
  }
  if (outcome._tag !== "Waiting") {
    return (
      <Banner
        intent="warning"
        icon={<WarningIcon />}
        title={`The code ${outcome._tag === "Expired" ? "expired" : "was revoked"}`}
      >
        It can't be used any more. Close this and make another.
      </Banner>
    )
  }
  return (
    <>
      <div {...stylex.props(styles.command)}>
        <code aria-label="Pairing command" {...stylex.props(styles.commandText)}>
          {command}
        </code>
        <IconButton label="Copy command" size="sm" onClick={() => void copyCommand(command)}>
          <CopyIcon />
        </IconButton>
      </div>
      <p {...stylex.props(styles.note)}>
        Works once, for the next {timeLeft(minted.expiresAt, now)}. The code is shown only here:
        anyone with it can pair a machine, so share it only with whoever is setting up the Runner.
      </p>
      <p {...stylex.props(styles.status)} aria-live="polite">
        <Spinner size="sm" /> Waiting for the machine to pair…
      </p>
    </>
  )
}

/**
 * Removes a Runner once it's confirmed; a Runner with Sessions that aren't Archived is refused, as
 * the Hub would, and the dialog says to archive them first.
 */
function RemoveDialog({ runner, onClose }: { runner: RunnerSummary | null; onClose: () => void }) {
  const hub = useHub()
  const shown = useLastOpened(runner)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setBusy(false)
    setError(null)
  }, [runner])

  // The live count: a Session archived meanwhile makes it removable.
  const live = useHubState((state) => state.runners?.find((other) => other.id === shown?.id))
  const refusal = shown ? runnerRemovalRefusal(shown.name, (live ?? shown).openSessions) : undefined

  const remove = async () => {
    if (!shown) return
    setBusy(true)
    setError(null)
    try {
      await hub.removeRunner(shown.id)
      toast.show({ title: `Removed ${shown.name}` })
      onClose()
    } catch (cause) {
      setError(messageOf(cause))
      setBusy(false)
    }
  }

  return (
    <Dialog
      size="sm"
      open={runner !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={refusal ? `${shown?.name ?? ""} can't be removed yet` : `Remove ${shown?.name ?? ""}?`}
      description={
        refusal ??
        "Its token stops working at once and, if it's connected, it's disconnected. Its Archived Sessions can't be restored unless a Runner by the same name is added again: a Runner's name is its identity, so use a new name to start clean."
      }
      footer={
        refusal ? (
          <DialogClose>OK</DialogClose>
        ) : (
          <>
            <DialogClose>Cancel</DialogClose>
            <Button intent="danger" loading={busy} onClick={() => void remove()}>
              Remove
            </Button>
          </>
        )
      }
    >
      {error && (
        <p role="alert" {...stylex.props(styles.error)}>
          {error}
        </p>
      )}
    </Dialog>
  )
}

/**
 * Updates a Runner to the Hub's commit once it's confirmed: either letting running Turns end
 * (within ten minutes), or stopping them at once. Opened on a Runner already waiting for its
 * Turns, it only offers to stop them now.
 */
function UpdateDialog({
  runner,
  hub,
  onClose,
}: {
  runner: RunnerSummary | null
  hub: BuildVersion | null
  onClose: () => void
}) {
  const client = useHub()
  const shown = useLastOpened(runner)
  const [busy, setBusy] = useState<"wait" | "now" | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setBusy(null)
    setError(null)
  }, [runner])

  const waiting = shown?.update?._tag === "Draining"
  const sessions = shown?.openSessions ?? 0
  const update = async (now: boolean) => {
    if (!shown) return
    setBusy(now ? "now" : "wait")
    setError(null)
    try {
      await client.updateRunner(shown.id, now)
      onClose()
    } catch (cause) {
      setError(messageOf(cause))
      setBusy(null)
    }
  }
  const target = hub === null ? "the Hub's commit" : shortCommit(hub)
  return (
    <Dialog
      open={runner !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={
        waiting ? `Stop ${shown?.name ?? ""}'s running Turns?` : `Update ${shown?.name ?? ""}?`
      }
      description={
        waiting
          ? "Its Sessions' Turns stop where they are, as Stop would, so it can update now rather than in up to ten minutes. Each Session sleeps and keeps its conversation."
          : `It moves to ${target}, the Hub's commit, and restarts. Meanwhile no Session starts or wakes there${sessions === 0 ? "" : ", running Turns finish (up to ten minutes) and its Active Sessions are put to sleep: the next prompt wakes each, with its conversation, on the new version"}.`
      }
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          {waiting ? (
            <Button intent="danger" loading={busy === "now"} onClick={() => void update(true)}>
              Stop Turns and update
            </Button>
          ) : (
            <>
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
          )}
        </>
      }
    >
      {/* One expression, null when there's nothing to add, so the dialog leaves out its body. */}
      {(waiting || sessions === 0) && error === null ? null : (
        <>
          {!waiting && sessions > 0 && (
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
