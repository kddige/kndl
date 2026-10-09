// A New Session's branch choice (ADR 0023) as the web keeps it, and as it travels the Environment
// setup redirect in the URL's search, which a Repo's first Session goes through.

import type { BranchChoice } from "@kndl/protocol"

/**
 * The branch choice as search params: `?branch=`, with `from` for a new branch, `direct` for no
 * Work branch.
 */
export interface BranchSearch {
  branch: string
  /** Set when `branch` is new, made from this one. */
  from?: string
  /** Set when the Session commits to `branch` itself, rather than a new Work branch off it. */
  direct?: true
}

export function branchSearch(choice: BranchChoice): BranchSearch {
  if (choice._tag === "Create") return { branch: choice.name, from: choice.from }
  return { branch: choice.name, ...(!choice.newWorkBranch && { direct: true as const }) }
}

/** The choice a search stands for. A `from` makes the branch a new one, so `direct` is moot. */
export function branchFromSearch(search: BranchSearch): BranchChoice {
  if (search.from !== undefined) return { _tag: "Create", name: search.branch, from: search.from }
  return { _tag: "Existing", name: search.branch, newWorkBranch: search.direct !== true }
}

/** Where the Session starts from, in a sentence: "main", "new-thing (from main)". */
export function branchText(choice: BranchChoice): string {
  return choice._tag === "Create" ? `${choice.name} (new, from ${choice.from})` : choice.name
}
