// What the Runners page works out from the Hub's state: the order Runners are listed in, how a
// Pairing code it showed is getting on, and how its expiry and a Runner's version read.

import type {
  PairingCodeId,
  PendingPairingCode,
  RunnerId,
  RunnerSummary,
  RunnerVersionStatus,
} from "@claude-hub/protocol"

/** Online Runners first, then by name. */
export function sortRunners(runners: ReadonlyArray<RunnerSummary>): Array<RunnerSummary> {
  return runners.toSorted(
    (a, b) => Number(b.isOnline) - Number(a.isOnline) || a.name.localeCompare(b.name),
  )
}

/** The Pairing codes still waiting at `now`: the Hub's list leaves out none that expired since. */
export function waitingCodes(
  codes: ReadonlyArray<PendingPairingCode> | null,
  now: number,
): Array<PendingPairingCode> {
  return (codes ?? []).filter((code) => code.expiresAt > now)
}

/** "14 min", "1 min", "under a minute": how long a code has left. */
export function timeLeft(expiresAt: number, now: number): string {
  const left = expiresAt - now
  // To the nearest minute, so a code just made says 15, not 14.
  return left < 60_000 ? "under a minute" : `${Math.round(left / 60_000)} min`
}

/** What a Runner's version against the Hub's says, when it says anything worth a badge. */
export function versionNote(
  status: RunnerVersionStatus,
): { readonly label: string; readonly title: string } | undefined {
  switch (status) {
    case "Behind":
      return {
        label: "behind the Hub",
        title: "It runs an older commit than the Hub: update its checkout and restart it.",
      }
    case "Differs":
      return {
        label: "not the Hub's commit",
        title: "It runs a commit the Hub's history doesn't have: a newer one, or another branch's.",
      }
    case "Current":
    case "Unknown":
      return undefined
  }
}

/** A code the Runners page showed, as it was minted. */
export interface ShownCode {
  readonly id: PairingCodeId
  readonly expiresAt: number
}

/** How a shown code is getting on. */
export type CodeOutcome =
  | { readonly _tag: "Waiting" }
  | { readonly _tag: "Expired" }
  /** It was used: by `runner`, once the Hub lists it. */
  | { readonly _tag: "Used"; readonly runner: RunnerSummary | undefined }
  /** Someone revoked it, here or elsewhere. */
  | { readonly _tag: "Revoked" }

/**
 * How `shown` is getting on: used once the Hub says it was redeemed (PairingCodeRedeemed), waiting
 * while it lists it and its time isn't up, and otherwise expired or revoked.
 */
export function codeOutcome(
  shown: ShownCode,
  state: {
    readonly pairingCodes: ReadonlyArray<PendingPairingCode> | null
    readonly redeemedCodes: Readonly<Record<PairingCodeId, RunnerId>>
    readonly runners: ReadonlyArray<RunnerSummary> | null
  },
  now: number,
): CodeOutcome {
  const runnerId = state.redeemedCodes[shown.id]
  if (runnerId !== undefined) {
    return { _tag: "Used", runner: state.runners?.find((runner) => runner.id === runnerId) }
  }
  if (now >= shown.expiresAt) return { _tag: "Expired" }
  const listed = state.pairingCodes?.some((code) => code.id === shown.id) ?? true
  return listed ? { _tag: "Waiting" } : { _tag: "Revoked" }
}
