// The Runners page (issue #85): every Runner paired with the Hub, whether it's online, its Runner
// login and version against the Hub's own, when it was last seen and how many Sessions it has.
// Anyone signed in adds a Runner here with a Pairing code, Re-pairs one (a new token, same RunnerId
// and Sessions) or removes one, once its Sessions are all Archived. Codes still waiting are listed
// so they can be revoked. A Runner behind the Hub that updates itself has Update (#87): it moves
// to the Hub's commit once its Sessions sleep, and its row follows the update, or says why it
// refused or failed. Every confirmation is a Dialog on the page.

import {
  type BuildVersion,
  describeBuild,
  type PairingCodeCreated,
  pairingCommand,
  type PendingPairingCode,
  type RunnerSummary,
  runnerRemovalRefusal,
} from "@claude-hub/protocol";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import { timeAgo } from "../app/format.ts";
import { useHub, useHubState } from "../app/hub.tsx";
import {
  Badge,
  Banner,
  Button,
  CheckIcon,
  CopyIcon,
  Dialog,
  DialogClose,
  EmptyState,
  IconButton,
  PageHeader,
  PlusIcon,
  ServerIcon,
  Spinner,
  toast,
  Tooltip,
  WarningIcon,
} from "../ui/index.ts";
import {
  color,
  font,
  leading,
  radius,
  space,
  text,
  weight,
} from "../ui/tokens.stylex.ts";
import {
  codeOutcome,
  shortCommit,
  sortRunners,
  timeLeft,
  updateAction,
  manualUpdateText,
  updateNote,
  versionNote,
  waitingCodes,
} from "./runners.ts";

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
  sectionTitle: {
    margin: 0,
    color: color.textMuted,
    fontSize: text.sm,
    fontWeight: weight.semibold,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    listStyle: "none",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    overflow: "hidden",
  },
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s3,
    paddingBlock: space.s3,
    paddingInline: space.s4,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  firstRow: { borderTopWidth: 0 },
  main: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    flex: 1,
    minWidth: "14rem",
  },
  nameLine: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    flexWrap: "wrap",
  },
  name: { fontSize: text.md, fontWeight: weight.semibold },
  facts: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space.s3,
    rowGap: space.s1,
    margin: 0,
    color: color.textMuted,
    fontSize: text.sm,
  },
  fact: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    minWidth: 0,
  },
  mono: { fontFamily: font.mono },
  actions: { display: "flex", gap: space.s2 },
  dot: {
    width: "0.5rem",
    height: "0.5rem",
    borderRadius: "50%",
    flexShrink: 0,
  },
  online: { backgroundColor: color.success },
  offline: { backgroundColor: color.borderStrong },
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
  note: {
    margin: 0,
    color: color.textMuted,
    fontSize: text.sm,
    lineHeight: leading.snug,
  },
  status: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    margin: 0,
    color: color.textMuted,
    fontSize: text.sm,
  },
  error: {
    margin: 0,
    color: color.dangerSubtleText,
    fontSize: text.sm,
    lineHeight: leading.snug,
  },
  updateLine: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s2,
    margin: 0,
    color: color.textMuted,
    fontSize: text.sm,
    lineHeight: leading.snug,
  },
  updateText: { minWidth: 0, overflowWrap: "anywhere", whiteSpace: "pre-line" },
  updateWarning: { color: color.warningSubtleText },
  updateDanger: { color: color.dangerSubtleText },
  loading: { display: "grid", placeItems: "center", paddingBlock: space.s16 },
});

/** What a pairing dialog is for: a new Runner, or a Re-pair of one. */
type PairTarget =
  | { readonly _tag: "New" }
  | { readonly _tag: "Repair"; readonly runner: RunnerSummary };

/** The pairing dialog's state: what it's for, and the code made for it, once there is one. */
interface Pairing {
  readonly target: PairTarget;
  readonly minted: PairingCodeCreated | null;
  readonly busy: boolean;
  readonly error: string | null;
}

/**
 * Opens the pairing dialog and makes its code: a new Runner's as it opens, a Re-pair's once it's
 * confirmed. Codes are made from clicks, not effects, so each opening makes one.
 */
function usePairing() {
  const hub = useHub();
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const mint = async (target: PairTarget) => {
    setPairing({ target, minted: null, busy: true, error: null });
    const runnerId = target._tag === "Repair" ? target.runner.id : undefined;
    const settle = (next: Partial<Pairing>) =>
      setPairing((current) =>
        current?.target === target
          ? { ...current, busy: false, ...next }
          : current,
      );
    try {
      settle({ minted: await hub.createPairingCode(runnerId) });
    } catch (error) {
      settle({ error: messageOf(error) });
    }
  };
  return {
    pairing,
    open: (target: PairTarget) =>
      target._tag === "New"
        ? void mint(target)
        : setPairing({ target, minted: null, busy: false, error: null }),
    confirm: () => {
      if (pairing) void mint(pairing.target);
    },
    close: () => setPairing(null),
  };
}

export function RunnersView() {
  const runners = useHubState((state) => state.runners);
  const codes = useHubState((state) => state.pairingCodes);
  const hubVersion = useHubState((state) => state.hubVersion);
  const now = useNow(15_000);
  const pairing = usePairing();
  const [removing, setRemoving] = useState<RunnerSummary | null>(null);
  const [updating, setUpdating] = useState<RunnerSummary | null>(null);

  const sorted = runners === null ? null : sortRunners(runners);
  const waiting = waitingCodes(codes, now);
  const addRunner = () => pairing.open({ _tag: "New" });
  return (
    <main {...stylex.props(styles.view)}>
      <PageHeader
        title="Runners"
        description={
          <>
            The machines Sessions run on, each with its own Claude login.
            {hubVersion && (
              <>
                {" "}
                The Hub runs{" "}
                <span {...stylex.props(styles.mono)}>
                  {describeBuild(hubVersion)}
                </span>
                .
              </>
            )}
          </>
        }
        actions={
          <Button
            intent="primary"
            size="sm"
            icon={<PlusIcon />}
            onClick={addRunner}
          >
            Add a Runner
          </Button>
        }
      />
      <div {...stylex.props(styles.scroll)}>
        <div {...stylex.props(styles.page)}>
          {sorted === null ? (
            <div {...stylex.props(styles.loading)}>
              <Spinner size="lg" label="Loading Runners" />
            </div>
          ) : sorted.length === 0 ? (
            <EmptyState
              size="page"
              icon={<ServerIcon />}
              title="No Runners yet"
              description="A Runner is a machine that runs Sessions. Add one with a pairing code: one command on the machine pairs it and starts it."
              action={
                <Button
                  intent="primary"
                  icon={<PlusIcon />}
                  onClick={addRunner}
                >
                  Add a Runner
                </Button>
              }
            />
          ) : (
            <ul aria-label="Runners" {...stylex.props(styles.list)}>
              {sorted.map((runner, index) => (
                <RunnerRow
                  key={runner.id}
                  runner={runner}
                  first={index === 0}
                  now={now}
                  onUpdate={() => setUpdating(runner)}
                  onRepair={() => pairing.open({ _tag: "Repair", runner })}
                  onRemove={() => setRemoving(runner)}
                />
              ))}
            </ul>
          )}
          {waiting.length > 0 && (
            <section
              aria-labelledby="waiting-codes"
              {...stylex.props(styles.section)}
            >
              <h2 id="waiting-codes" {...stylex.props(styles.sectionTitle)}>
                Pairing codes not used yet
              </h2>
              <ul
                aria-label="Pairing codes not used yet"
                {...stylex.props(styles.list)}
              >
                {waiting.map((code, index) => (
                  <CodeRow
                    key={code.id}
                    code={code}
                    runners={runners ?? []}
                    first={index === 0}
                    now={now}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
      <PairDialog
        pairing={pairing.pairing}
        onConfirm={pairing.confirm}
        onClose={pairing.close}
      />
      <RemoveDialog runner={removing} onClose={() => setRemoving(null)} />
      <UpdateDialog
        runner={updating}
        hub={hubVersion}
        onClose={() => setUpdating(null)}
      />
    </main>
  );
}

function RunnerRow({
  runner,
  first,
  now,
  onUpdate,
  onRepair,
  onRemove,
}: {
  runner: RunnerSummary;
  first: boolean;
  now: number;
  onUpdate: () => void;
  onRepair: () => void;
  onRemove: () => void;
}) {
  const update = updateNote(runner.update, now);
  const underWay = update?.busy === true;
  // While it updates, the update says it all: being behind is why.
  const note = underWay
    ? undefined
    : versionNote(runner.versionStatus, runner.updater);
  const action = updateAction(runner);
  const manual = manualUpdateText(runner);
  return (
    <li
      aria-label={runner.name}
      {...stylex.props(styles.row, first && styles.firstRow)}
    >
      <div {...stylex.props(styles.main)}>
        <div {...stylex.props(styles.nameLine)}>
          <span
            aria-hidden="true"
            {...stylex.props(
              styles.dot,
              runner.isOnline ? styles.online : styles.offline,
            )}
          />
          <span {...stylex.props(styles.name)}>{runner.name}</span>
          {runner.isOnline ? (
            <Badge intent="success">online</Badge>
          ) : (
            <Badge>offline</Badge>
          )}
          {note && (
            <Tooltip content={note.title}>
              <span tabIndex={0}>
                <Badge intent="warning">{note.label}</Badge>
              </span>
            </Tooltip>
          )}
          {update && <Badge intent={update.intent}>{update.label}</Badge>}
        </div>
        <p {...stylex.props(styles.facts)}>
          <span {...stylex.props(styles.fact)}>
            {runner.login === null ? "Not connected yet" : runner.login.account}
          </span>
          <span {...stylex.props(styles.fact)}>
            {runner.version === null ? (
              runner.login === null ? null : (
                "Version unknown"
              )
            ) : (
              <span
                title={runner.version.commit}
                {...stylex.props(styles.mono)}
              >
                {describeBuild(runner.version)}
              </span>
            )}
          </span>
          {!runner.isOnline && (
            <span {...stylex.props(styles.fact)}>
              {runner.lastSeenAt === null
                ? "Never seen"
                : `Last seen ${timeAgo(runner.lastSeenAt, now)}`}
            </span>
          )}
          <span {...stylex.props(styles.fact)}>
            {runner.openSessions === 0
              ? "No Sessions"
              : `${runner.openSessions} ${runner.openSessions === 1 ? "Session" : "Sessions"}`}
          </span>
        </p>
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
      </div>
      <div {...stylex.props(styles.actions)}>
        {action && (
          <Button
            size="sm"
            intent="primary"
            aria-label={`${action === "Update" ? "Update" : "Update now"} ${runner.name}`}
            onClick={onUpdate}
          >
            {action === "Update" ? "Update" : "Update now"}
          </Button>
        )}
        <Button
          size="sm"
          aria-label={`Re-pair ${runner.name}`}
          onClick={onRepair}
        >
          Re-pair
        </Button>
        <Button
          size="sm"
          intent="ghost"
          aria-label={`Remove ${runner.name}`}
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
    </li>
  );
}

function CodeRow({
  code,
  runners,
  first,
  now,
}: {
  code: PendingPairingCode;
  runners: ReadonlyArray<RunnerSummary>;
  first: boolean;
  now: number;
}) {
  const hub = useHub();
  const [busy, setBusy] = useState(false);
  const runner = runners.find((candidate) => candidate.id === code.runnerId);
  const what =
    code.runnerId === undefined
      ? "A new Runner"
      : `Re-pair ${runner?.name ?? "a removed Runner"}`;
  const revoke = async () => {
    setBusy(true);
    try {
      await hub.revokePairingCode(code.id);
      toast.show({ title: "Pairing code revoked" });
    } catch (error) {
      toast.show({
        title: "Couldn't revoke the code",
        description: messageOf(error),
        intent: "danger",
      });
      setBusy(false);
    }
  };
  return (
    <li
      aria-label={what}
      {...stylex.props(styles.row, first && styles.firstRow)}
    >
      <div {...stylex.props(styles.main)}>
        <span {...stylex.props(styles.name)}>{what}</span>
        <p {...stylex.props(styles.facts)}>
          <span>
            Made by {code.createdBy.name} {timeAgo(code.createdAt, now)}
          </span>
          <span>Expires in {timeLeft(code.expiresAt, now)}</span>
        </p>
      </div>
      <Button
        size="sm"
        intent="ghost"
        loading={busy}
        aria-label={`Revoke the code for ${what.toLowerCase()}`}
        onClick={() => void revoke()}
      >
        Revoke
      </Button>
    </li>
  );
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
  pairing: Pairing | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  // While the dialog closes, it keeps showing what it was opened for.
  const shown = useLastOpened(pairing);
  const repair = shown?.target._tag === "Repair" ? shown.target.runner : null;
  const minted = shown?.minted ?? null;
  const busy = shown?.busy ?? false;
  const error = shown?.error ?? null;
  // A Re-pair asks first, and stays asking while its code is made or if making it failed.
  const confirming = repair !== null && minted === null;
  return (
    <Dialog
      open={pairing !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
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
  );
}

/** The command a minted code is pasted in, and how the code is getting on. */
function MintedCode({ minted }: { minted: PairingCodeCreated }) {
  const state = useHubState((hub) => hub);
  const now = useNow(1_000);
  const outcome = codeOutcome(minted, state, now);
  const command = pairingCommand(minted.link);
  if (outcome._tag === "Used") {
    const runner = outcome.runner;
    return (
      <Banner
        intent="accent"
        icon={<CheckIcon />}
        title={`Paired ${runner?.name ?? "the Runner"}`}
      >
        {runner?.isOnline
          ? `${runner.name} is online.`
          : "Waiting for it to connect: the join command starts its service."}
      </Banner>
    );
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
    );
  }
  return (
    <>
      <div {...stylex.props(styles.command)}>
        <code
          aria-label="Pairing command"
          {...stylex.props(styles.commandText)}
        >
          {command}
        </code>
        <IconButton
          label="Copy command"
          size="sm"
          onClick={() => void copy(command)}
        >
          <CopyIcon />
        </IconButton>
      </div>
      <p {...stylex.props(styles.note)}>
        Works once, for the next {timeLeft(minted.expiresAt, now)}. The code is
        shown only here: anyone with it can pair a machine, so share it only
        with whoever is setting up the Runner.
      </p>
      <p {...stylex.props(styles.status)} aria-live="polite">
        <Spinner size="sm" /> Waiting for the machine to pair…
      </p>
    </>
  );
}

/**
 * Removes a Runner once it's confirmed; a Runner with Sessions that aren't Archived is refused, as
 * the Hub would, and the dialog says to archive them first.
 */
function RemoveDialog({
  runner,
  onClose,
}: {
  runner: RunnerSummary | null;
  onClose: () => void;
}) {
  const hub = useHub();
  const shown = useLastOpened(runner);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setBusy(false);
    setError(null);
  }, [runner]);

  // The live count: a Session archived meanwhile makes it removable.
  const live = useHubState((state) =>
    state.runners?.find((other) => other.id === shown?.id),
  );
  const refusal = shown
    ? runnerRemovalRefusal(shown.name, (live ?? shown).openSessions)
    : undefined;

  const remove = async () => {
    if (!shown) return;
    setBusy(true);
    setError(null);
    try {
      await hub.removeRunner(shown.id);
      toast.show({ title: `Removed ${shown.name}` });
      onClose();
    } catch (cause) {
      setError(messageOf(cause));
      setBusy(false);
    }
  };

  return (
    <Dialog
      size="sm"
      open={runner !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        refusal
          ? `${shown?.name ?? ""} can't be removed yet`
          : `Remove ${shown?.name ?? ""}?`
      }
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
            <Button
              intent="danger"
              loading={busy}
              onClick={() => void remove()}
            >
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
  );
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
  runner: RunnerSummary | null;
  hub: BuildVersion | null;
  onClose: () => void;
}) {
  const client = useHub();
  const shown = useLastOpened(runner);
  const [busy, setBusy] = useState<"wait" | "now" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setBusy(null);
    setError(null);
  }, [runner]);

  const waiting = shown?.update?._tag === "Draining";
  const sessions = shown?.openSessions ?? 0;
  const update = async (now: boolean) => {
    if (!shown) return;
    setBusy(now ? "now" : "wait");
    setError(null);
    try {
      await client.updateRunner(shown.id, now);
      onClose();
    } catch (cause) {
      setError(messageOf(cause));
      setBusy(null);
    }
  };
  const target = hub === null ? "the Hub's commit" : shortCommit(hub);
  return (
    <Dialog
      open={runner !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        waiting
          ? `Stop ${shown?.name ?? ""}'s running Turns?`
          : `Update ${shown?.name ?? ""}?`
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
            <Button
              intent="danger"
              loading={busy === "now"}
              onClick={() => void update(true)}
            >
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
              Update now stops running Turns at once instead of letting them
              finish.
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
  );
}

async function copy(command: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(command);
    toast.show({ title: "Copied the command" });
  } catch {
    toast.show({
      title: "Couldn't copy",
      description: "Select the command and copy it yourself.",
      intent: "warning",
    });
  }
}

/** The time, updated every `ms`. */
function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** `value`, or while it is null (a dialog closing), the last value it wasn't. */
function useLastOpened<T>(value: T | null): T | null {
  const [last, setLast] = useState(value);
  if (value !== null && value !== last) setLast(value);
  return value ?? last;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
