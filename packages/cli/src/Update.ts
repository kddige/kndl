// What `claude-hub update` moves the installed checkout to. A branch is followed: the checkout
// stays on it, and a later plain `update` pulls it. A tag or a commit pins: the checkout is
// detached there, and a later plain `update` stays put and says how to follow main again. A fresh
// install follows main.
//
// The installed checkout (`<home>/app`) is the CLI's to manage: an update discards changes made
// to its files, and following a branch resets it to origin's, so commits made in it by hand are
// left behind (git's reflog still has them).
import { Data } from "effect"
import type { Role } from "./Layout.ts"
import { type Step, step } from "./Shell.ts"

/** Where the checkout is now: on a branch, or detached at a commit (with the tag there, if any). */
export interface Checkout {
  readonly branch: string | undefined
  readonly commit: string
  readonly tag: string | undefined
}

/** The branches and tags on origin, from `git ls-remote --heads --tags origin`. */
export interface Remote {
  readonly branches: ReadonlyArray<string>
  readonly tags: ReadonlyArray<string>
}

/** What to move to. */
export type Target =
  | { readonly _tag: "Branch"; readonly name: string }
  | { readonly _tag: "Tag"; readonly name: string }
  | { readonly _tag: "Commit"; readonly sha: string }

/** What plain `update` does on a pinned checkout: nothing, with how to follow a branch again. */
export interface Pinned {
  readonly _tag: "Pinned"
  readonly at: string
}

export class RefNotFound extends Data.TaggedError("RefNotFound")<{ readonly message: string }> {}

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
 * Where `update` goes: `--ref` (or `--branch`) names a branch, tag or commit, in that order;
 * without it, the branch the checkout follows, or nowhere when it is pinned.
 */
export function updateTarget(
  checkout: Checkout,
  ref: string | undefined,
  remote: Remote,
): Target | Pinned | RefNotFound {
  if (ref === undefined) {
    if (checkout.branch !== undefined) return { _tag: "Branch", name: checkout.branch }
    return { _tag: "Pinned", at: checkout.tag ?? checkout.commit.slice(0, 12) }
  }
  if (remote.branches.includes(ref)) return { _tag: "Branch", name: ref }
  if (remote.tags.includes(ref)) return { _tag: "Tag", name: ref }
  if (/^[0-9a-f]{7,40}$/i.test(ref)) return { _tag: "Commit", sha: ref.toLowerCase() }
  return new RefNotFound({
    message: `origin has no branch or tag named ${ref}, and it isn't a commit id.`,
  })
}

/** The git Steps, in the checkout, that move it to `target`. */
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
          ["checkout", "--force", "-B", target.name, "--track", `origin/${target.name}`],
          {
            cwd: app,
            why: `follow ${target.name}`,
          },
        ),
      ]
    case "Tag":
      return [
        fetch,
        step("git", ["checkout", "--force", "--detach", `refs/tags/${target.name}`], {
          cwd: app,
          why: `pin to ${target.name}`,
        }),
      ]
    case "Commit":
      return [
        fetch,
        step("git", ["checkout", "--force", "--detach", target.sha], {
          cwd: app,
          why: `pin to ${target.sha}`,
        }),
      ]
  }
}

/** What the checkout follows, as `status` and `update` say it. */
export function describeCheckout(checkout: Checkout): string {
  const commit = checkout.commit.slice(0, 12)
  if (checkout.branch !== undefined) return `${commit}, following ${checkout.branch}`
  return `${commit}, pinned${checkout.tag === undefined ? "" : ` at ${checkout.tag}`}`
}

/** What plain `update` says on a pinned checkout. */
export function pinnedNotice(pinned: Pinned): string {
  return `The install is pinned at ${pinned.at}, so update stays there. To follow ${DefaultBranch} again: claude-hub update --ref ${DefaultBranch}`
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
