// What a `kndl` binary the Hub built knows about itself (issue #178): the commit and the
// platform it was built for. The Hub's `bun build --compile` defines both (compileCli in the
// Hub's CliBuilds.ts). Run from a checkout, as an install's command runs it, neither is defined,
// and the CLI is the checkout's.

declare const KNDL_BUILD_COMMIT: string | undefined
declare const KNDL_BUILD_TARGET: string | undefined

/** What a binary the Hub built knows: its commit, and its platform as `<os>-<arch>`. */
export interface Build {
  readonly commit: string
  readonly target: string
}

/** This binary's build, if the Hub built it; `undefined` run from a checkout. */
export const build: Build | undefined =
  typeof KNDL_BUILD_COMMIT === "string" && typeof KNDL_BUILD_TARGET === "string"
    ? { commit: KNDL_BUILD_COMMIT, target: KNDL_BUILD_TARGET }
    : undefined
