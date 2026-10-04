// Whether a home holds claude-hub data that no install there made, decided before onboard writes
// anything.
//
// Before checkouts got a dev home of their own (`~/.claude-hub-dev`), a checkout's Runner kept its
// Session Workspaces in `~/.claude-hub/sessions`, on tmux socket `claude-hub`: exactly where an
// installed Runner keeps them now. A Runner installed over that data would carry the old Runner's
// mark (a digest of its tmux socket and sessions root, see the Runner's Naming.ts), so it would
// re-adopt the old tmux sessions and reconcile the old Sandboxes, against a new Hub database that
// has never heard of them. A role's data is the install's own once onboard has written that role's
// env file; before that, it is old. Onboard stops on old data and offers to move it aside (never to
// delete it); doctor reports it.
import type { Role } from "./Layout.ts"

/** The data a Hub or Runner keeps in its home, and whose it is. */
export const DataEntries: Readonly<Record<string, Role>> = {
  sessions: "runner",
  "claude-code": "runner",
  "hub.db": "hub",
  "hub.db-wal": "hub",
  "hub.db-shm": "hub",
}

export interface HomeDataFacts {
  /** The data entries present, from {@link DataEntries}: a directory only when it holds anything. */
  readonly data: ReadonlyArray<string>
  /** The roles whose env file (`hub.env`, `runner.env`) exists. */
  readonly envFiles: ReadonlyArray<Role>
  /** How many sessions tmux server `claude-hub` has: 0 when it isn't running, or wasn't asked. */
  readonly tmuxSessions: number
}

/** The data in a home that isn't this install's. */
export interface OldData {
  /** Entries whose role has no env file here, in {@link DataEntries}' order. */
  readonly entries: ReadonlyArray<string>
  /** Sessions on tmux socket `claude-hub` that a Runner set up here would re-adopt. */
  readonly tmuxSessions: number
}

/**
 * The home's old data, for setting up `roles`; `undefined` when there's none. Data is old when its
 * role's env file doesn't exist. Live tmux sessions count only when a Runner is being set up for
 * the first time here: an installed Runner's are its own.
 */
export function findOldData(facts: HomeDataFacts, roles: ReadonlyArray<Role>): OldData | undefined {
  const entries = facts.data.filter((entry) => {
    const owner = DataEntries[entry]
    return owner !== undefined && !facts.envFiles.includes(owner)
  })
  const tmuxSessions =
    roles.includes("runner") && !facts.envFiles.includes("runner") ? facts.tmuxSessions : 0
  return entries.length === 0 && tmuxSessions === 0 ? undefined : { entries, tmuxSessions }
}

/** Whether moving the old data aside settles it: there is some, and no live tmux session. */
export function canMoveAside(old: OldData): boolean {
  return old.entries.length > 0 && old.tmuxSessions === 0
}

/** Why onboard stops on the home, and what the person can do: onboard and doctor say the same. */
export function explainOldData(old: OldData, home: string, renames: ReadonlyArray<Rename>): string {
  const lines: Array<string> = []
  if (old.entries.length > 0) {
    lines.push(
      `${home} holds claude-hub data that wasn't set up here by \`claude-hub onboard\`: ${old.entries.join(", ")}, with no ${[...new Set(old.entries.map((entry) => `${DataEntries[entry]}.env`))].join(" or ")}. It is likely a checkout's, from before checkouts kept theirs in ~/.claude-hub-dev. A Runner or Hub set up over it would take over its Sessions and Sandboxes, with a new Hub database that doesn't know them.`,
    )
  }
  if (old.tmuxSessions > 0) {
    lines.push(
      `tmux server \`claude-hub\` has ${old.tmuxSessions} session${old.tmuxSessions === 1 ? "" : "s"}, which a Runner set up here would re-adopt. Archive them on the Hub that started them, or stop that server yourself (\`tmux -L claude-hub kill-server\`), then onboard again.`,
    )
  }
  const choices: Array<string> = []
  if (canMoveAside(old)) {
    choices.push(
      `Move it aside, keeping it: ${renames.map((rename) => `${rename.from} → ${rename.to}`).join(", ")}. Nothing is deleted. (\`claude-hub onboard --move-old-data\`)`,
    )
  }
  choices.push("Install somewhere else: set CLAUDE_HUB_HOME to another directory.")
  lines.push(`You can:\n${choices.map((choice) => `  - ${choice}`).join("\n")}`)
  return lines.join("\n\n")
}

/** One entry moved aside, within the home. */
export interface Rename {
  readonly from: string
  readonly to: string
}

/** SQLite's side files, which must keep their database's name plus the suffix. */
const SideFile = /^(.+\.db)(-wal|-shm)$/

const pad = (n: number) => String(n).padStart(2, "0")

/** `20261004`: the day, in local time, that moved-aside names carry. */
export function dateStamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

/**
 * The renames moving `entries` aside: each to `<entry>.old-<YYYYMMDD>`, or with `-2`, `-3`, ...
 * when that name is among `existing`. A database's `-wal` and `-shm` files follow it, as
 * `<its new name>-wal`, so SQLite still finds them.
 */
export function asideRenames(
  entries: ReadonlyArray<string>,
  date: Date,
  existing: ReadonlyArray<string>,
): ReadonlyArray<Rename> {
  const stamp = dateStamp(date)
  const taken = new Set(existing)
  const chosen = new Map<string, string>()
  const free = (name: string) =>
    !taken.has(name) && !taken.has(`${name}-wal`) && !taken.has(`${name}-shm`)
  const asideOf = (root: string) => {
    const known = chosen.get(root)
    if (known !== undefined) return known
    const base = `${root}.old-${stamp}`
    let name = base
    for (let n = 2; !free(name); n++) name = `${base}-${n}`
    chosen.set(root, name)
    taken.add(name)
    return name
  }
  return entries.map((from) => {
    const side = SideFile.exec(from)
    const to = side?.[1] && side[2] ? `${asideOf(side[1])}${side[2]}` : asideOf(from)
    taken.add(to)
    return { from, to }
  })
}
