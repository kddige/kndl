import { Schema } from "effect"
import { EpochMillis, Participant } from "./Session.ts"

// Who gets in (issue #209, ADR 0019): a Hub is invite-only. Its Owner, the one Participant who
// administers it, signs in first with a Setup link made on the Hub's machine; everyone else needs
// an Invite the Owner made. Those admitted are Members.
//
// A Setup link and an Invite are each a secret in the fragment of a link to the web UI, such as
// `https://hub.example.com/invite#chi_<id>.<secret>`: the fragment never reaches a server, so a
// proxy in front of the Hub doesn't log it. The page hands the secret to the Hub just before
// sending the browser to GitHub, and the Hub reads it back once GitHub sends the browser back.

/** An Invite, as the Hub's records name it: not its link, which only the Owner sees, once. */
export const InviteId = Schema.NonEmptyString.pipe(Schema.brand("InviteId"))
export type InviteId = typeof InviteId.Type

/** How long an Invite can be used for. */
export const InviteLifetimeMs = 7 * 24 * 60 * 60 * 1000

/** A GitHub login: letters, digits and single hyphens, at most 39 characters. */
export const GitHubLogin = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/),
)
export type GitHubLogin = typeof GitHubLogin.Type

/** Whether two GitHub logins are the same account's: GitHub ignores their case. */
export const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The web UI's page an Invite's link opens. */
export const InvitePath = "/invite"

/** The web UI's page a Setup link opens. */
export const SetupPath = "/setup"

/** The web UI's page that tells someone the Hub didn't let them in (InviteOnlyMessage). */
export const InviteOnlyPath = "/invite-only"

/** The link to `path` on the Hub at `hubUrl`, with `secret` as its fragment. */
export function admissionLink(hubUrl: string, path: string, secret: string): string {
  return `${new URL(hubUrl).origin}${path}#${secret}`
}

/**
 * What everyone the Hub won't let in is told, alike whether they brought an Invite that was used,
 * expired, revoked, for someone else or never made, or none at all.
 */
export const InviteOnlyMessage = "This Hub is invite-only. Ask its owner for an invite."

/**
 * `POST /auth/github/admission`'s body: the Setup link's or Invite's secret, which the Hub keeps in
 * a cookie for the GitHub sign-in that follows.
 */
export const AdmissionTicket = Schema.Struct({
  ticket: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
})
export type AdmissionTicket = typeof AdmissionTicket.Type

/** An Invite not yet used, revoked or expired, as the Owner's People page lists it. */
export const PendingInvite = Schema.Struct({
  id: InviteId,
  /** The one GitHub login it is for, when it is for one; anyone with the link otherwise. */
  login: Schema.optionalKey(GitHubLogin),
  createdBy: Participant,
  createdAt: EpochMillis,
  expiresAt: EpochMillis,
})
export type PendingInvite = typeof PendingInvite.Type

/** A Member, as the Owner's People page lists them. */
export const Member = Schema.Struct({
  participant: Participant,
  /** Whether they are the Hub's Owner, who can't be removed. */
  owner: Schema.Boolean,
  /** When they were admitted: for a Member from before invites (#209), when they first signed in. */
  admittedAt: EpochMillis,
})
export type Member = typeof Member.Type

/** Why anyone but the Owner is refused a People page command, as the Hub says it. */
export const ownerOnlyMessage = "Only the Hub's Owner can do that."

/** Why removing someone is refused, as the Hub says it. */
export const memberRemovalRefusal = (
  member: { readonly owner: boolean } | undefined,
): string | undefined =>
  member === undefined
    ? "There is no such Member."
    : member.owner
      ? "The Hub's Owner can't be removed."
      : undefined
