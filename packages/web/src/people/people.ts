// What the People page and the Setup and Invite pages work out (issue #209, ADR 0019), apart from
// how they show it.

import { GitHubLogin, type PendingInvite } from "@kndl/protocol"
import { Schema } from "effect"

/** The Invites that can still be used: the Hub lists them, but one may have expired since. */
export function usableInvites(
  invites: ReadonlyArray<PendingInvite> | null,
  now: number,
): ReadonlyArray<PendingInvite> {
  return (invites ?? []).filter((invite) => invite.expiresAt > now)
}

/** How long an Invite has left: "6 days", "5 hours", "under an hour". */
export function inviteTimeLeft(expiresAt: number, now: number): string {
  const left = expiresAt - now
  if (left < 3_600_000) return "under an hour"
  // Rounded, so an Invite just made says 7 days, not 6.
  const hours = Math.round(left / 3_600_000)
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`
  return `${Math.round(left / 86_400_000)} days`
}

/** Who an Invite is for, as its row names it. */
export function inviteFor(invite: Pick<PendingInvite, "login">): string {
  return invite.login === undefined ? "Anyone with the link" : `@${invite.login}`
}

const isLogin = Schema.is(GitHubLogin)

/**
 * The GitHub login typed for an Invite: none when it's empty, the login without a leading `@`, or
 * why it can't be one.
 */
export function readLogin(
  typed: string,
): { readonly login: GitHubLogin | undefined } | { readonly error: string } {
  const login = typed.trim().replace(/^@/, "")
  if (login === "") return { login: undefined }
  return isLogin(login)
    ? { login }
    : { error: "A GitHub login is letters, digits and single hyphens, up to 39 characters." }
}

/**
 * The secret a Setup link or an Invite carries, from the page's address: its fragment, which the
 * browser never sends a server. Undefined when there is none.
 */
export function ticketFrom(hash: string): string | undefined {
  const ticket = hash.replace(/^#/, "").trim()
  return ticket === "" ? undefined : ticket
}
