// The commit a Hub or Runner runs, read from the git checkout it runs from (ADR 0011).
//
// Imported as `@kndl/protocol/checkout`, not from the package's index: it runs git, which
// the web UI and the mod's bundle have no use for.
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import { type BuildVersion, Channel, CommitIdPattern, releaseOf } from "./Build.ts"

/** The checkout this file is in: the one the Hub, Runner or CLI importing it runs from. */
export const thisCheckout = fileURLToPath(new URL("../../..", import.meta.url))

function git(dir: string, args: ReadonlyArray<string>): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim()
  } catch {
    return undefined
  }
}

/**
 * The checkout's HEAD, its branch, the Release tagged on HEAD and the Channel recorded in its git
 * config (ADR 0025), or `undefined` when `dir` isn't a git checkout.
 */
export function readBuildVersion(dir: string = thisCheckout): BuildVersion | undefined {
  const commit = git(dir, ["rev-parse", "HEAD"])
  if (commit === undefined || !CommitIdPattern.test(commit)) return undefined
  const branch = git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  const tags = git(dir, ["tag", "--points-at", "HEAD", "--list", "v*"])
  const release = releaseOf(tags === undefined ? [] : tags.split("\n"))
  const recorded = git(dir, ["config", "--get", "kndl.channel"])
  const channel = Schema.is(Channel)(recorded) ? recorded : undefined
  return {
    commit,
    ...(branch && { branch }),
    ...(release !== undefined && { release }),
    ...(channel !== undefined && { channel }),
  }
}

/**
 * Whether `commit` is in the history of `of` (HEAD by default) in the checkout. A commit the
 * checkout has never fetched isn't in it. `undefined` when git can't say, such as outside a
 * checkout.
 */
export function checkoutHolds(
  commit: string,
  dir: string = thisCheckout,
  of = "HEAD",
): boolean | undefined {
  if (!/^[0-9a-f]{7,64}$/.test(commit)) return undefined
  try {
    execFileSync(
      "git",
      ["-C", dir, "merge-base", "--is-ancestor", "--end-of-options", commit, of],
      {
        stdio: "ignore",
        timeout: 5_000,
      },
    )
    return true
  } catch (error) {
    // 1: not an ancestor; 128: no such commit, or no checkout, which readBuildVersion tells apart.
    const status = (error as { status?: number }).status
    if (status === 1) return false
    if (status === 128) return readBuildVersion(dir) === undefined ? undefined : false
    return undefined
  }
}
