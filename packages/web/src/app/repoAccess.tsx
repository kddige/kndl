// Checking a Repo as it is entered (#104): whether the signed-in person has access to it, and if
// not, why, before they set up a Session or an Environment for it. The Hub answers from its cache
// of what GitHub said; "Check again" asks GitHub afresh, as after installing the GitHub App.

import type { RepoStatus } from "@claude-hub/protocol"
import * as stylex from "@stylexjs/stylex"
import { useCallback, useEffect, useState } from "react"
import { ExternalLinkIcon } from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, space, weight } from "../ui/tokens.stylex.ts"
import { useHub } from "./hub.tsx"

/** `owner/name`, as the protocol's RepoName takes it. */
export const repoPattern = /^[^/\s]+\/[^/\s]+$/

/** How long typing pauses before the Repo is checked. */
const debounceMs = 400

/** What the Hub said about a Repo, or that it couldn't say. */
export type RepoCheck =
  | { readonly status: "Checking" }
  | { readonly status: RepoStatus; readonly installUrl: string | null }
  /** The Hub couldn't ask GitHub: it decides again when the Repo is used. */
  | { readonly status: "Unknown"; readonly message: string }

interface Checked {
  readonly repo: string
  readonly check: RepoCheck
}

/**
 * Checks `repo` once typing pauses, while it looks like `owner/name`; null for anything else.
 * `recheck` asks GitHub again rather than the Hub's cache.
 */
export function useRepoCheck(repo: string): {
  readonly check: RepoCheck | null
  readonly recheck: () => void
} {
  const hub = useHub()
  const [checked, setChecked] = useState<Checked | null>(null)
  const [asked, setAsked] = useState<{ readonly repo: string; readonly fresh: boolean } | null>(
    null,
  )
  const valid = repoPattern.test(repo)

  useEffect(() => {
    if (!valid) return
    const timer = setTimeout(() => setAsked({ repo, fresh: false }), debounceMs)
    return () => clearTimeout(timer)
  }, [repo, valid])

  useEffect(() => {
    if (asked === null) return
    let current = true
    setChecked({ repo: asked.repo, check: { status: "Checking" } })
    hub.checkRepo(asked.repo, asked.fresh).then(
      (answer) => {
        if (current) {
          setChecked({
            repo: asked.repo,
            check: { status: answer.status, installUrl: answer.installUrl ?? null },
          })
        }
      },
      (error: unknown) => {
        if (current) {
          setChecked({
            repo: asked.repo,
            check: {
              status: "Unknown",
              message: error instanceof Error ? error.message : String(error),
            },
          })
        }
      },
    )
    return () => {
      current = false
    }
  }, [hub, asked])

  const recheck = useCallback(() => setAsked({ repo, fresh: true }), [repo])
  if (!valid) return { check: null, recheck }
  return {
    check: checked?.repo === repo ? checked.check : { status: "Checking" },
    recheck,
  }
}

/** Whether a check says the person can't use the Repo. */
export const isRefused = (check: RepoCheck | null): boolean =>
  check?.status === "NotInstalled" || check?.status === "NoAccess"

const styles = stylex.create({
  link: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    color: "inherit",
    fontWeight: weight.medium,
    textDecorationLine: "underline",
    textUnderlineOffset: "2px",
    whiteSpace: "nowrap",
  },
  again: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
    fontWeight: weight.medium,
    textDecorationLine: "underline",
    textUnderlineOffset: "2px",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  muted: { color: color.textMuted },
})

/**
 * Why the person can't use `repo`, for a Field's error or a page: the GitHub App isn't installed
 * on it, with where to install it and a way to check again once it is; or they have no access.
 */
export function RepoRefusal({
  repo,
  check,
  onRecheck,
}: {
  repo: string
  check: RepoCheck
  onRecheck: () => void
}) {
  if (check.status === "NotInstalled") {
    return (
      <>
        The GitHub App isn't installed on {repo}, or there's no such Repo.{" "}
        {check.installUrl !== null && (
          <>
            <a
              href={check.installUrl}
              target="_blank"
              rel="noreferrer"
              {...stylex.props(styles.link, focus.ring)}
            >
              Install the App
              <ExternalLinkIcon aria-hidden="true" />
            </a>
            , then{" "}
          </>
        )}
        <button type="button" onClick={onRecheck} {...stylex.props(styles.again, focus.ring)}>
          {check.installUrl === null ? "Check again" : "check again"}
        </button>
        .
      </>
    )
  }
  if (check.status === "NoAccess") {
    return (
      <>
        You don't have access to {repo} on GitHub.{" "}
        <button type="button" onClick={onRecheck} {...stylex.props(styles.again, focus.ring)}>
          Check again
        </button>
      </>
    )
  }
  return null
}
