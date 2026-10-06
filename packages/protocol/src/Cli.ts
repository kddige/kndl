import { Schema } from "effect"
import { CommitId } from "./Build.ts"

// The `claude-hub` CLI the Hub serves (issue #178): `GET /cli` is the install script,
// `GET /cli/version` the commit the Hub serves it at, and `GET /cli/<target>` the binary, built
// with `bun build --compile` from the Hub's own commit. The CLI follows that commit, as Runners
// follow the Hub's (ADR 0011).

/** The platforms the Hub builds the CLI for, as `<os>-<arch>`. Windows is not one. */
export const CliTargets = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const
export type CliTarget = (typeof CliTargets)[number]

export const isCliTarget = (name: string): name is CliTarget =>
  (CliTargets as ReadonlyArray<string>).includes(name)

/** What `GET /cli/version` answers: the commit the Hub builds the CLI at, which is its own. */
export const CliVersion = Schema.Struct({ commit: CommitId })
export type CliVersion = typeof CliVersion.Type

/** The response header on `GET /cli/<target>` naming the commit the binary was built at. */
export const CliCommitHeader = "x-claude-hub-commit"
