// Claude Code reports the plan's usage as `rate_limit_event` messages, not HTTP headers. The
// unified headers it can supply are rebuilt from them, so pi's `after_provider_response` readers
// read the bridge as they do the built-in Anthropic provider.
//
// Ported from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

import type { ProviderResponse } from "@earendil-works/pi-ai"

const HeaderPrefix = "anthropic-ratelimit-unified"

/** Claude Code's own window name → header abbreviation table. */
const WindowAbbreviations: Readonly<Record<string, string>> = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_overage_included: "7d_oi",
}

interface UsageWindow {
  readonly utilization?: number
  readonly resetsAt?: number
}

export interface RateLimitInfo {
  readonly status?: string
  readonly resetsAt?: number
  readonly rateLimitType?: string
  readonly overageStatus?: string
  readonly overageResetsAt?: number
  readonly utilization?: number
  readonly surpassedThreshold?: number
  readonly unifiedWindows?: Readonly<Record<string, UsageWindow | undefined>>
}

/** Always 200: a "rejected" status can still be served from overage, which only the status says. */
export function rateLimitResponse(info: RateLimitInfo): ProviderResponse {
  const headers: Record<string, string> = {}
  const set = (name: string, value: string | number | undefined) => {
    if (value !== undefined) headers[`${HeaderPrefix}-${name}`] = String(value)
  }

  set("status", info.status)
  set("reset", info.resetsAt)
  set("representative-claim", info.rateLimitType)
  set("overage-status", info.overageStatus)
  set("overage-reset", info.overageResetsAt)

  for (const [name, window] of Object.entries(info.unifiedWindows ?? {})) {
    const abbreviation = WindowAbbreviations[name] ?? name
    set(`${abbreviation}-utilization`, window?.utilization)
    set(`${abbreviation}-reset`, window?.resetsAt)
  }

  return { status: 200, headers }
}
