// What `kndl update` moves the installed checkout to. A branch is followed: the checkout
// stays on it, and a later plain `update` pulls it. A tag or a commit pins: the checkout is
// detached there, and a later plain `update` stays put and says how to follow main again.
//
// An install may follow a Channel instead (ADR 0025), recorded as `kndl.channel` in the
// checkout's git config: `stable` moves to the latest Release, never back to a commit older than
// the one checked out, and `dev` follows main. install.sh records `stable` on a fresh install. An
// install with no Channel recorded, as every one from before Channels is, does what it did.
//
// The installed checkout (`<home>/app`) is the CLI's to manage: an update discards changes made
// to its files, and following a branch resets it to origin's, so commits made in it by hand are
// left behind (git's reflog still has them).
import { Data } from "effect"
import type { Role } from "./Layout.ts"
import { type Step, step } from "./Shell.ts"

/** What an install follows (ADR 0025): the latest Release, or main. */
export type Channel = "stable" | "dev"
export const Channels: ReadonlyArray<Channel> = ["stable", "dev"]

/** The git config key, in the installed checkout, that records its Channel. install.sh writes it too. */
export const ChannelKey = "kndl.channel"

/**
 * Where the checkout is now: on a branch, or detached at a commit (with the tag there, if any);
 * and the Channel it follows, if one is recorded.
 */
export interface Checkout {
  readonly branch: string | undefined
  readonly commit: string
  readonly tag: string | undefined
  readonly channel?: Channel | undefined
}

/** The branches and tags on origin, from `git ls-remote --heads --tags origin`. */
export interface Remote {
  readonly branches: ReadonlyArray<string>
  readonly tags: ReadonlyArray<string>
}

/** What to move to. A Release is a tag the stable Channel moves to, unless it is older. */
export type Target =
  | { readonly _tag: "Branch"; readonly name: string }
  | { readonly _tag: "Tag"; readonly name: string }
  | { readonly _tag: "Commit"; readonly sha: string }
  | { readonly _tag: "Release"; readonly name: string }

/** What plain `update` does on a pinned checkout: nothing, with how to follow a branch again. */
export interface Pinned {
  readonly _tag: "Pinned"
  readonly at: string
}

/** What `update` on the stable Channel does when origin has no Release yet: stays. */
export interface NoRelease {
  readonly _tag: "NoRelease"
}

export class RefNotFound extends Data.TaggedError("RefNotFound")<{ readonly message: string }> {}

/** What `update` is asked: `--ref`, `--channel`, or neither. */
export interface UpdateRequest {
  readonly ref: string | undefined
  readonly channel: Channel | undefined
}

/** The branch a fresh install follows, and plain `update --ref` names to follow again. */
export const DefaultBranch = "main"

/** Reads `git ls-remote --heads --tags origin`. */
export function parseLsRemote(output: string): Remote {
  const branches: Array<string> = []
  const tags: Array<string> = []
  for (const line of output.split("\n")) {
    const ref = line.split("\t")[1]?.trim()
    if (ref === undefined) continue
    if (ref.startsWith("refs/heads/")) branches.push(ref.slice("refs/heads/".length))
    else if (ref.startsWith("refs/tags/") && !ref.endsWith("^{}")) {
      tags.push(ref.slice("refs/tags/".length))
    }
  }
  return { branches, tags }
}

/**
 * A Release's version from its tag: `v2026.10.1` is `[2026, 10, 1]`. Any other tag, a
 * `-beta.1` or a `v0.1.0`, isn't a Release.
 */
export function releaseVersion(tag: string): readonly [number, number, number] | undefined {
  const match = /^v(\d{4})\.([1-9]\d?)\.([1-9]\d*)$/.exec(tag)
  if (match === null) return undefined
  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as const
  return version[1] <= 12 ? version : undefined
}

/** The latest Release among `tags`, compared by number, not as text: 2026.10.10 is after 2026.10.9. */
export function latestRelease(tags: ReadonlyArray<string>): string | undefined {
  let latest: { tag: string; version: readonly [number, number, number] } | undefined
  for (const tag of tags) {
    const version = releaseVersion(tag)
    if (version === undefined) continue
    if (latest === undefined || compareVersions(version, latest.version) > 0) {
      latest = { tag, version }
    }
  }
  return latest?.tag
}

function compareVersions(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/** Whether `update` needs origin's refs: to look `--ref` up, or to find the latest Release. */
export function needsRemote(checkout: Checkout, request: UpdateRequest): boolean {
  return request.ref !== undefined || (request.channel ?? checkout.channel) === "stable"
}

/**
 * The Channel recorded after `update`: `--channel` sets it, and `--ref` clears it, as the install
 * then follows or pins what it names; otherwise it stays.
 */
export function channelAfter(checkout: Checkout, request: UpdateRequest): Channel | undefined {
  if (request.channel !== undefined) return request.channel
  if (request.ref !== undefined) return undefined
  return checkout.channel
}

/**
 * Where `update` goes: `--ref` (or `--branch`) names a branch, tag or commit, in that order;
 * `--channel`, or the Channel recorded, names the latest Release or main; without either, the
 * branch the checkout follows, or nowhere when it is pinned.
 */
export function updateTarget(
  checkout: Checkout,
  request: UpdateRequest,
  remote: Remote,
): Target | Pinned | NoRelease | RefNotFound {
  const ref = request.ref
  if (ref !== undefined && request.channel !== undefined) {
    return new RefNotFound({ message: "Pass --ref or --channel, not both." })
  }
  if (ref === undefined) {
    const channel = request.channel ?? checkout.channel
    if (channel === "dev") return { _tag: "Branch", name: DefaultBranch }
    if (channel === "stable") {
      const release = latestRelease(remote.tags)
      return release === undefined ? { _tag: "NoRelease" } : { _tag: "Release", name: release }
    }
    if (checkout.branch !== undefined) return { _tag: "Branch", name: checkout.branch }
    return { _tag: "Pinned", at: checkout.tag ?? checkout.commit.slice(0, 12) }
  }
  // No branch, tag or commit id starts with "-": git would read such a ref as an option.
  if (ref.startsWith("-")) {
    return new RefNotFound({ message: `${ref} isn't a branch, tag or commit id.` })
  }
  if (remote.branches.includes(ref)) return { _tag: "Branch", name: ref }
  if (remote.tags.includes(ref)) return { _tag: "Tag", name: ref }
  if (/^[0-9a-f]{7,40}$/i.test(ref)) return { _tag: "Commit", sha: ref.toLowerCase() }
  return new RefNotFound({
    message: `origin has no branch or tag named ${ref}, and it isn't a commit id.`,
  })
}

/**
 * The git Steps, in the checkout, that move it to `target`. `--end-of-options` comes before the
 * ref, which the person typed, so git never reads it as an option. `switch`, not `checkout`: git
 * before 2.43 (Debian 12 has 2.39) reads checkout's `--end-of-options` as `--`, and the ref after
 * it as a path to check out.
 */
export function gitSteps(app: string, target: Target): ReadonlyArray<Step> {
  const fetch = step("git", ["fetch", "--prune", "--tags", "--force", "origin"], {
    cwd: app,
    why: "fetch origin",
  })
  switch (target._tag) {
    case "Branch":
      return [
        fetch,
        step(
          "git",
          [
            "switch",
            "--discard-changes",
            "-C",
            target.name,
            "--track",
            "--end-of-options",
            `origin/${target.name}`,
          ],
          {
            cwd: app,
            why: `follow ${target.name}`,
          },
        ),
      ]
    case "Tag":
    case "Release":
      return [
        fetch,
        step(
          "git",
          [
            "switch",
            "--discard-changes",
            "--detach",
            "--end-of-options",
            `refs/tags/${target.name}`,
          ],
          {
            cwd: app,
            why: `pin to ${target.name}`,
          },
        ),
      ]
    case "Commit":
      return [
        fetch,
        step("git", ["switch", "--discard-changes", "--detach", "--end-of-options", target.sha], {
          cwd: app,
          why: `pin to ${target.sha}`,
        }),
      ]
  }
}

/**
 * The Step that records the Channel in the checkout, or clears it. Clearing one that isn't there
 * makes `git config --unset` exit 5, which is fine.
 */
export function channelStep(app: string, channel: Channel | undefined): Step {
  return channel === undefined
    ? step("git", ["config", "--unset", ChannelKey], { cwd: app, mayFail: true })
    : step("git", ["config", ChannelKey, channel], { cwd: app, why: `follow ${channel}` })
}

/**
 * The Step that exits 0 when a Release is the commit checked out, or after it, after the fetch.
 * The stable Channel never moves an install back: its Hub may have migrated its database for the
 * newer code.
 */
export function containsCheckoutStep(app: string, release: string): Step {
  return step(
    "git",
    ["merge-base", "--is-ancestor", "--end-of-options", "HEAD", `refs/tags/${release}`],
    { cwd: app, mayFail: true },
  )
}

/** What the checkout follows, as `status` and `update` say it. */
export function describeCheckout(checkout: Checkout): string {
  const commit = checkout.commit.slice(0, 12)
  if (checkout.channel === "stable") {
    return `${commit}, on stable${checkout.tag === undefined ? "" : ` at ${checkout.tag}`}`
  }
  if (checkout.branch !== undefined) return `${commit}, following ${checkout.branch}`
  return `${commit}, pinned${checkout.tag === undefined ? "" : ` at ${checkout.tag}`}`
}

/** What plain `update` says on a pinned checkout. */
export function pinnedNotice(pinned: Pinned): string {
  return `The install is pinned at ${pinned.at}, so update stays there. To follow the latest Release: kndl update --channel stable. To follow ${DefaultBranch}: kndl update --channel dev`
}

/** Why `update` on the stable Channel stays where it is. */
export type StableStay = NoRelease | { readonly _tag: "Older"; readonly release: string }

/** What `update` on the stable Channel says when it stays where it is. */
export function stableNotice(stay: StableStay): string {
  return stay._tag === "NoRelease"
    ? "On the stable Channel, but origin has no Release yet: update stays here, and moves to the first Release."
    : `On the stable Channel: the latest Release, ${stay.release}, doesn't include this checkout's commit, so update stays here until a Release does.`
}

/**
 * The Steps, in the checkout, after it moved: install its dependencies, then build what the
 * configured roles run, the mod for a Runner and the web UI for a Hub (both when none is set up).
 */
export function buildSteps(
  app: string,
  bun: string,
  roles: ReadonlyArray<Role>,
): ReadonlyArray<Step> {
  const all = roles.length === 0
  return [
    step(bun, ["install"], { cwd: app, why: "install dependencies" }),
    ...(all || roles.includes("runner")
      ? [step(bun, ["run", "mod:build"], { cwd: app, why: "build the hub-link mod" })]
      : []),
    ...(all || roles.includes("hub")
      ? [step(bun, ["run", "web:build"], { cwd: app, why: "build the web UI" })]
      : []),
  ]
}

/**
 * How `update` restarts the Runner on this machine (issue #87, ADR 0011):
 * - `Hub`: the Hub it shares the checkout with drains it, putting its Sessions to sleep, and it
 *   restarts itself on the commit `update` moved the checkout to;
 * - `Service`: `update` restarts its service at once, under its running Sessions, as before
 *   Runners followed the Hub: a Runner on a machine with no Hub, or one that doesn't update itself
 *   (too old to, or whose service file changed, which only reinstalling the service loads);
 * - `None`: no Runner service is installed here.
 */
export type LocalRunnerRestart = "Hub" | "Service" | "None"

export function localRunnerRestart(facts: {
  /** The Runner's service is installed. */
  readonly installed: boolean
  /** The Hub's service is installed here, and `update` restarts it. */
  readonly hubRestarts: boolean
  /** The service file `update` would write differs from the installed one. */
  readonly serviceFileChanged: boolean
  /** The Hub knows the Runner here, and it said it updates itself. */
  readonly updatesItself: boolean
}): LocalRunnerRestart {
  if (!facts.installed) return "None"
  if (!facts.hubRestarts || facts.serviceFileChanged || !facts.updatesItself) return "Service"
  return "Hub"
}

/** What `update` on the Hub's machine says about the Runners it asks to follow. */
export function runnersNotice(options: {
  readonly commit: string
  readonly updateRunners: boolean
  readonly now: boolean
  readonly local: LocalRunnerRestart
  readonly localName: string | undefined
}): ReadonlyArray<string> {
  const commit = options.commit.slice(0, 12)
  const turns = options.now
    ? "stopping their running Turns at once (--now)"
    : "letting running Turns end first (up to 10 minutes)"
  const lines = options.updateRunners
    ? [
        `The Hub asks its Runners to follow ${commit} as they reconnect, ${turns}. Runners from before this feature, and ones run from a developer's checkout, need updating by hand; the Runners page shows which.`,
      ]
    : [
        `--no-update-runners: the Hub leaves Runners on other machines on their commit. The Runners page updates each one when you choose.`,
      ]
  const name = options.localName ?? "The Runner here"
  if (options.local === "Hub") {
    lines.push(
      `${name}, on this machine, follows: the Hub puts its Sessions to sleep (${turns}), then it restarts on ${commit}.`,
    )
  } else if (options.local === "Service") {
    lines.push(`${name}, on this machine, restarts now, under any Sessions it runs.`)
  }
  return lines
}
