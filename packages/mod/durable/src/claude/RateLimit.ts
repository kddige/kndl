// Claude Code reports the plan's usage as `rate_limit_event` messages: this is what the bridge
// reads of one (Stream.ts), to notice a limit reached or near and to name the failure it causes.
//
// Ported from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

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
