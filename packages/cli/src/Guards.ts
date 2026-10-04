// What uninstall, `uninstall --purge` and `onboard --reset` may delete, decided before anything is
// deleted. A home is removed only when it is exactly the resolved home, is nowhere near the user's
// own home directory or `/`, and holds only what claude-hub puts there: a mistyped
// CLAUDE_HUB_HOME must never cost anyone their files.
import { isAbsolute, join, normalize, relative, sep } from "node:path"
import { HomeEntries } from "./Layout.ts"

/** Files a home may hold besides its own entries: the GitHub App's key, and Finder's litter. */
const ToleratedEntry = /^(?:[^/]+\.pem|\.DS_Store)$/

/** What the guards look at, with every path already resolved through symlinks (realpath). */
export interface HomeFacts {
  /** The resolved home. */
  readonly home: string
  /** The user's home directory. */
  readonly userHome: string
  /** The names in the home directory. */
  readonly entries: ReadonlyArray<string>
}

/** Why `target` can't be deleted as the home, or `undefined` when it can. */
export function refuseHomeRemoval(target: string, facts: HomeFacts): string | undefined {
  const home = normalize(facts.home)
  if (normalize(target) !== home) {
    return `${target} is not the claude-hub home (${home}); only the home itself is removed.`
  }
  const general = refuseHome(facts)
  if (general !== undefined) return general
  const unknown = facts.entries.filter(
    (name) => !(HomeEntries as ReadonlyArray<string>).includes(name) && !ToleratedEntry.test(name),
  )
  if (unknown.length > 0) {
    return `${home} holds files claude-hub didn't put there (${unknown.join(", ")}), so it isn't removed. Move them out, or delete the home yourself.`
  }
  return undefined
}

/**
 * Why `entry` in the home can't be deleted, or `undefined` when it can: it must be one of the
 * home's own entries, in a home that passes {@link refuseHome}.
 */
export function refuseEntryRemoval(entry: string, facts: HomeFacts): string | undefined {
  const general = refuseHome(facts)
  if (general !== undefined) return general
  if (!(HomeEntries as ReadonlyArray<string>).includes(entry)) {
    return `${entry} is not one of the claude-hub home's own entries.`
  }
  return undefined
}

/** What to delete, decided by the guards: exactly this path, or nothing, and why. */
export type Removal =
  | { readonly _tag: "Remove"; readonly path: string }
  | { readonly _tag: "Refused"; readonly reason: string }

/**
 * What `uninstall --purge` deletes: the home, when `requested` (the home as the CLI resolved it,
 * through symlinks) is the home and the guards allow it.
 */
export function homeRemoval(requested: string, facts: HomeFacts): Removal {
  const reason = refuseHomeRemoval(requested, facts)
  return reason === undefined
    ? { _tag: "Remove", path: normalize(facts.home) }
    : { _tag: "Refused", reason }
}

/** What `uninstall` deletes of the home: one of its own entries, such as `app`. */
export function entryRemoval(entry: (typeof HomeEntries)[number], facts: HomeFacts): Removal {
  const reason = refuseEntryRemoval(entry, facts)
  return reason === undefined
    ? { _tag: "Remove", path: join(normalize(facts.home), entry) }
    : { _tag: "Refused", reason }
}

/** Why this can't be a claude-hub home at all, or `undefined` when it can. */
export function refuseHome(facts: HomeFacts): string | undefined {
  const home = normalize(facts.home)
  const userHome = normalize(facts.userHome)
  if (!isAbsolute(home)) return `The home ${home} is not an absolute path.`
  if (home === sep) return "The home is /, which is never removed."
  if (home === userHome) {
    return `The home is your home directory (${home}), which is never removed. Set CLAUDE_HUB_HOME to the claude-hub home, such as ${userHome}/.claude-hub.`
  }
  if (isInside(userHome, home)) {
    return `The home ${home} holds your home directory (${userHome}), so it is never removed.`
  }
  if (home.split(sep).filter(Boolean).length < 2) {
    return `The home ${home} is a top-level directory, which is never removed.`
  }
  if (facts.entries.includes(".git")) {
    return `${home} is a git checkout, not a claude-hub home.`
  }
  if (!facts.entries.some((name) => (HomeEntries as ReadonlyArray<string>).includes(name))) {
    return `${home} doesn't look like a claude-hub home: it holds none of ${HomeEntries.join(", ")}.`
  }
  return undefined
}

/** True when `path` is strictly inside `dir`. */
function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}
