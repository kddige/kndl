// The commit the Hub runs (ADR 0011), and how a Runner's compares with it, for the Runners page.
// Read once from the checkout the Hub runs from; nothing acts on it yet (#87 will).

import {
  type BuildVersion,
  type RunnerVersionStatus,
  runnerVersionStatus,
} from "@claude-hub/protocol"
import { checkoutHolds, readBuildVersion } from "@claude-hub/protocol/checkout"
import { Context, Effect, Layer } from "effect"

export class HubVersion extends Context.Service<
  HubVersion,
  {
    /** The Hub's commit and branch; `undefined` when it doesn't run from a git checkout. */
    readonly version: BuildVersion | undefined
    /** A Runner's version against the Hub's. */
    readonly statusOf: (runner: BuildVersion | null) => RunnerVersionStatus
  }
>()("@claude-hub/hub/HubVersion") {
  /** The Hub's own checkout's. */
  static readonly layer = Layer.sync(HubVersion, () => {
    const version = readBuildVersion()
    // git answers in a few milliseconds, but the Runner list is sent often: each commit is asked
    // about once. The Hub's own commit doesn't change while it runs.
    const held = new Map<string, boolean | undefined>()
    const holds = (commit: string) => {
      if (!held.has(commit)) held.set(commit, checkoutHolds(commit))
      return held.get(commit)
    }
    return HubVersion.of({
      version,
      statusOf: (runner) => runnerVersionStatus(runner ?? undefined, version, holds),
    })
  })

  /** A Hub at `version` whose history holds the commits `holds` says, for tests. */
  static readonly fixed = (
    version: BuildVersion | undefined,
    holds: (commit: string) => boolean | undefined = () => undefined,
  ) =>
    Layer.succeed(
      HubVersion,
      HubVersion.of({
        version,
        statusOf: (runner) => runnerVersionStatus(runner ?? undefined, version, holds),
      }),
    )
}

/** Logs the Hub's commit as it starts. */
export const announceHubVersion = Layer.effectDiscard(
  Effect.gen(function* () {
    const { version } = yield* HubVersion
    if (version === undefined) {
      yield* Effect.logWarning(
        "The Hub doesn't run from a git checkout, so it can't tell which Runners are behind it.",
      )
    }
  }),
)
