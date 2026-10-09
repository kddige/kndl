import { expect, test } from "bun:test"
import type { BranchChoice } from "@kndl/protocol"
import { branchFromSearch, branchSearch, branchText } from "../src/sessions/branches.ts"

const choices: ReadonlyArray<BranchChoice> = [
  { _tag: "Existing", name: "main", newWorkBranch: true },
  { _tag: "Existing", name: "release/1.0", newWorkBranch: false },
  { _tag: "Create", name: "feature/health", from: "main" },
]

test("a branch choice survives the Environment setup redirect's search", () => {
  for (const choice of choices) expect(branchFromSearch(branchSearch(choice))).toEqual(choice)
})

test("only what differs from the usual is put in the search", () => {
  expect(branchSearch(choices[0] as BranchChoice)).toEqual({ branch: "main" })
  expect(branchSearch(choices[1] as BranchChoice)).toEqual({ branch: "release/1.0", direct: true })
  expect(branchSearch(choices[2] as BranchChoice)).toEqual({
    branch: "feature/health",
    from: "main",
  })
})

test("a new branch is said to be new, and from what", () => {
  expect(branchText(choices[0] as BranchChoice)).toBe("main")
  expect(branchText(choices[2] as BranchChoice)).toBe("feature/health (new, from main)")
})
