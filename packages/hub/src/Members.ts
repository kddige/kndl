// Who gets in (GLOSSARY.md, issue #209, ADR 0019): a Hub is invite-only.
//
// - A Member is a Participant the Hub admitted. Only a Member's sign-ins and CLI tokens work
//   (SignIns.ts, CliTokens.ts).
// - The Owner is the one Member who administers the Hub: they make Invites, and list and remove
//   Members. A Hub without one lets nobody in with GitHub but whoever brings its Setup link,
//   which `kndl hub setup-link` makes on the Hub's machine, and which makes them the Owner.
// - An Invite admits one person, once, within 7 days: anyone with its link, or only the GitHub
//   login it names, ignoring case. Using it, revoking it or its expiring ends it.
// - A Setup link and an Invite are kept as their secret's hash, as a Pairing code is, and every
//   one refused is refused alike: whether it never existed, was used, revoked or expired, or was
//   for someone else, the person is told only that the Hub is invite-only. Nothing is recorded
//   of someone refused.
// - Removing a Member signs them out everywhere and revokes their CLI tokens at once; they need a
//   new Invite to come back. Their Sessions and their Claude credential stay, but their awake
//   Sessions are put to sleep, and none wakes on their credential until they are back (ADR 0026,
//   SessionRelay.ts). The Owner can't be removed.
// - Each Member chooses which Harness runs Claude's Models in their new Sessions (ADR 0030): Claude
//   Code unless they chose pi.

import {
  type Harness,
  InviteId,
  InviteLifetimeMs,
  LiveVoiceSetting,
  type Member,
  memberRemovalRefusal,
  type Participant,
  ParticipantId,
  type PendingInvite,
  sameLogin,
} from "@kndl/protocol"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { CliTokens } from "./CliTokens.ts"
import { SignIns } from "./SignIns.ts"
import { mintToken, parseToken, secretMatches } from "./Tokens.ts"

/**
 * How someone signing in with GitHub got in: as a Member already, as the Owner with the Setup
 * link, or with an Invite.
 */
export type Admission = "Member" | "Owner" | "Invited"

/** An Invite made: its secret, shown to the Owner once, in its link, never kept. */
export interface MintedInvite {
  readonly id: InviteId
  /** What its link carries: `chi_<id>.<secret>`. */
  readonly secret: string
  readonly login?: string
  readonly expiresAt: number
}

/** A Member's removal refused: they aren't one, or they are the Owner. */
// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class RemovalRefused extends Schema.TaggedError<RemovalRefused>()("RemovalRefused", {
  message: Schema.String,
}) {}

/** A Setup link refused, since the Hub has an Owner already. */
// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class SetupLinkRefused extends Schema.TaggedError<SetupLinkRefused>()("SetupLinkRefused", {
  message: Schema.String,
}) {}

export const hasOwnerMessage =
  "This Hub has an Owner already, so it takes no Setup link: its Owner invites everyone else from the People page."

interface ParticipantRow {
  readonly id: string
  readonly login: string
  readonly name: string
  readonly avatarUrl: string | null
}

const participantOf = (row: ParticipantRow): Participant => ({
  id: ParticipantId.make(row.id),
  login: row.login,
  name: row.name,
  ...(row.avatarUrl !== null && { avatarUrl: row.avatarUrl }),
})

export class Members extends Context.Service<
  Members,
  {
    /**
     * Whether `participant`, signing in with GitHub with `ticket` (a Setup link's or an
     * Invite's secret) if they brought one, gets in, in this order: a Member gets in as they
     * are; anyone, with the Setup link while there is no Owner, as the Owner; anyone, with a
     * usable Invite for them, as a Member, which uses it up. None for anyone else, recording
     * nothing of them.
     */
    readonly admit: (
      participant: Participant,
      ticket: string | undefined,
    ) => Effect.Effect<Option.Option<Admission>, SqlError>
    /** Admits someone signing in with dev login, which needs no Invite. */
    readonly admitLocal: (participant: Participant) => Effect.Effect<void, SqlError>
    /** The Owner, if the Hub has one. */
    readonly owner: Effect.Effect<Option.Option<ParticipantId>, SqlError>
    /** The Members, the Owner first, then the earliest admitted. */
    readonly list: Effect.Effect<ReadonlyArray<Member>, SqlError>
    /** Whether someone is a Member now: admitted, and not removed since. */
    readonly isMember: (id: ParticipantId) => Effect.Effect<boolean, SqlError>
    /**
     * Removes a Member: signs them out everywhere and revokes their CLI tokens. Refused for the
     * Owner, or anyone who isn't a Member.
     */
    readonly remove: (id: ParticipantId) => Effect.Effect<void, SqlError | RemovalRefused>
    /** A new Invite, by the Owner `by`: for `login` only, if given. */
    readonly invite: (by: Participant, login?: string) => Effect.Effect<MintedInvite, SqlError>
    /** The Invites not yet used, revoked or expired, oldest first. */
    readonly pendingInvites: Effect.Effect<ReadonlyArray<PendingInvite>, SqlError>
    /** Revokes an Invite not yet used; one used, expired or unknown is left as it is. */
    readonly revokeInvite: (id: InviteId) => Effect.Effect<void, SqlError>
    /**
     * A new Setup link's secret, which replaces any made before. Refused once the Hub has an
     * Owner.
     */
    readonly newSetupLink: Effect.Effect<string, SqlError | SetupLinkRefused>
    /**
     * Which Harness runs Claude's Models in the Member's new Sessions (ADR 0030): Claude Code, on
     * their setup token, unless they chose pi.
     */
    readonly claudeHarness: (id: ParticipantId) => Effect.Effect<Harness, SqlError>
    /** The live voice the Member chose to talk to Sessions with (ADR 0033); none until they do. */
    readonly liveVoice: (id: ParticipantId) => Effect.Effect<LiveVoiceSetting | undefined, SqlError>
    readonly setLiveVoice: (
      id: ParticipantId,
      setting: LiveVoiceSetting,
    ) => Effect.Effect<void, SqlError>
    /** Sets which Harness runs Claude's Models in the Member's new Sessions. */
    readonly setClaudeHarness: (
      id: ParticipantId,
      harness: Harness,
    ) => Effect.Effect<void, SqlError>
  }
>()("@kndl/hub/Members") {
  static readonly layer = Layer.effect(
    Members,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const signIns = yield* SignIns
      const cliTokens = yield* CliTokens

      const owner = Effect.gen(function* () {
        const rows = yield* sql<{ readonly id: string }>`
          SELECT id FROM participants WHERE owner = 1
        `
        return Option.map(Option.fromNullishOr(rows[0]), (row) => ParticipantId.make(row.id))
      }).pipe(Effect.withSpan("Members.owner"))

      /** Records `participant` as admitted now, unless they are already. */
      const admitted = Effect.fn("Members.admitted")(function* (
        participant: Participant,
        now: number,
        asOwner = false,
      ) {
        yield* sql`
          INSERT INTO participants (
            id, login, name, avatar_url, created_at, updated_at, admitted_at, owner
          )
          VALUES (
            ${participant.id}, ${participant.login}, ${participant.name},
            ${participant.avatarUrl ?? null}, ${now}, ${now}, ${now}, ${asOwner ? 1 : 0}
          )
          ON CONFLICT (id) DO UPDATE SET
            admitted_at = coalesce(admitted_at, excluded.admitted_at),
            owner = max(owner, excluded.owner)
        `
      })

      /** Admits with the Setup link: the Owner, if `secret` is it and the Hub has none. */
      const withSetupLink = Effect.fn("Members.withSetupLink")(function* (
        participant: Participant,
        ticket: { readonly id: string; readonly secret: string },
        now: number,
      ) {
        if (Option.isSome(yield* owner)) return false
        const rows = yield* sql<{ readonly secretHash: string }>`
          SELECT secret_hash AS secretHash FROM setup_links WHERE id = ${ticket.id}
        `
        const row = rows[0]
        if (row === undefined || !secretMatches(ticket.secret, row.secretHash)) return false
        yield* admitted(participant, now, true)
        yield* sql`DELETE FROM setup_links`
        return true
      })

      /** Admits with an Invite: a Member, if `secret` is a usable one for them. */
      const withInvite = Effect.fn("Members.withInvite")(function* (
        participant: Participant,
        ticket: { readonly id: string; readonly secret: string },
        now: number,
      ) {
        const rows = yield* sql<{
          readonly secretHash: string
          readonly login: string | null
        }>`
          SELECT secret_hash AS secretHash, login FROM invites
          WHERE id = ${ticket.id} AND used_at IS NULL AND revoked_at IS NULL
            AND expires_at > ${now}
        `
        const row = rows[0]
        if (
          row === undefined ||
          !secretMatches(ticket.secret, row.secretHash) ||
          (row.login !== null && !sameLogin(row.login, participant.login))
        ) {
          return false
        }
        yield* admitted(participant, now)
        yield* sql`
          UPDATE invites SET used_at = ${now}, used_by = ${participant.id} WHERE id = ${ticket.id}
        `
        return true
      })

      const admit = Effect.fn("Members.admit")(function* (
        participant: Participant,
        ticket: string | undefined,
      ) {
        const now = yield* Clock.currentTimeMillis
        const rows = yield* sql<{ readonly admittedAt: number | null }>`
            SELECT admitted_at AS admittedAt FROM participants WHERE id = ${participant.id}
          `
        if (rows[0] !== undefined && rows[0].admittedAt !== null) {
          return Option.some<Admission>("Member")
        }
        const setup = ticket === undefined ? undefined : parseToken("setup", ticket)
        if (setup !== undefined && (yield* withSetupLink(participant, setup, now))) {
          return Option.some<Admission>("Owner")
        }
        const invite = ticket === undefined ? undefined : parseToken("invite", ticket)
        if (invite !== undefined && (yield* withInvite(participant, invite, now))) {
          return Option.some<Admission>("Invited")
        }
        return Option.none<Admission>()
      }, sql.withTransaction)

      const admitLocal = Effect.fn("Members.admitLocal")(function* (participant: Participant) {
        yield* admitted(participant, yield* Clock.currentTimeMillis)
      })

      const list = Effect.gen(function* () {
        const rows = yield* sql<
          ParticipantRow & { readonly owner: number; readonly admittedAt: number }
        >`
          SELECT id, login, name, avatar_url AS avatarUrl, owner, admitted_at AS admittedAt
          FROM participants WHERE admitted_at IS NOT NULL
          ORDER BY owner DESC, admitted_at, id
        `
        return rows.map((row): Member => ({
          participant: participantOf(row),
          owner: row.owner === 1,
          admittedAt: row.admittedAt,
        }))
      }).pipe(Effect.withSpan("Members.list"))

      const remove = Effect.fn("Members.remove")(function* (id: ParticipantId) {
        const rows = yield* sql<{ readonly owner: number }>`
            SELECT owner FROM participants WHERE id = ${id} AND admitted_at IS NOT NULL
          `
        const refusal = memberRemovalRefusal(
          rows[0] === undefined ? undefined : { owner: rows[0].owner === 1 },
        )
        if (refusal !== undefined) return yield* new RemovalRefused({ message: refusal })
        yield* sql`UPDATE participants SET admitted_at = NULL WHERE id = ${id}`
        yield* signIns.signOutAll(id)
        yield* cliTokens.revokeAll(id)
      }, sql.withTransaction)

      const invite = Effect.fn("Members.invite")(function* (by: Participant, login?: string) {
        const now = yield* Clock.currentTimeMillis
        const minted = mintToken("invite")
        const expiresAt = now + InviteLifetimeMs
        yield* sql`
          INSERT INTO invites (id, secret_hash, login, created_by, created_at, expires_at)
          VALUES (
            ${minted.id}, ${minted.secretHash}, ${login ?? null}, ${by.id}, ${now}, ${expiresAt}
          )
        `
        return {
          id: InviteId.make(minted.id),
          secret: minted.token,
          ...(login !== undefined && { login }),
          expiresAt,
        }
      })

      const pendingInvites = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const rows = yield* sql<{
          readonly id: string
          readonly login: string | null
          readonly createdAt: number
          readonly expiresAt: number
          readonly byId: string
          readonly byLogin: string
          readonly byName: string
          readonly byAvatarUrl: string | null
        }>`
          SELECT i.id, i.login, i.created_at AS createdAt, i.expires_at AS expiresAt,
                 p.id AS byId, p.login AS byLogin, p.name AS byName, p.avatar_url AS byAvatarUrl
          FROM invites i JOIN participants p ON p.id = i.created_by
          WHERE i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ${now}
          ORDER BY i.created_at, i.id
        `
        return rows.map((row): PendingInvite => ({
          id: InviteId.make(row.id),
          ...(row.login !== null && { login: row.login }),
          createdBy: participantOf({
            id: row.byId,
            login: row.byLogin,
            name: row.byName,
            avatarUrl: row.byAvatarUrl,
          }),
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
        }))
      }).pipe(Effect.withSpan("Members.pendingInvites"))

      const revokeInvite = Effect.fn("Members.revokeInvite")(function* (id: InviteId) {
        const now = yield* Clock.currentTimeMillis
        yield* sql`
          UPDATE invites SET revoked_at = ${now}
          WHERE id = ${id} AND used_at IS NULL AND revoked_at IS NULL
        `
      })

      const newSetupLink = Effect.gen(function* () {
        if (Option.isSome(yield* owner)) {
          return yield* new SetupLinkRefused({ message: hasOwnerMessage })
        }
        const now = yield* Clock.currentTimeMillis
        const minted = mintToken("setup")
        yield* sql`DELETE FROM setup_links`
        yield* sql`
          INSERT INTO setup_links (id, secret_hash, created_at)
          VALUES (${minted.id}, ${minted.secretHash}, ${now})
        `
        return minted.token
      }).pipe(sql.withTransaction, Effect.withSpan("Members.newSetupLink"))

      const isMember = Effect.fn("Members.isMember")(function* (id: ParticipantId) {
        const rows = yield* sql<{ readonly id: string }>`
            SELECT id FROM participants WHERE id = ${id} AND admitted_at IS NOT NULL
          `
        return rows.length > 0
      })

      const claudeHarness = Effect.fn("Members.claudeHarness")(function* (id: ParticipantId) {
        const chosen = yield* sql<{ readonly harness: string | null }>`
          SELECT claude_harness AS harness FROM participants WHERE id = ${id}
        `
        return chosen[0]?.harness === "Pi" ? ("Pi" as const) : ("ClaudeCode" as const)
      })

      const setClaudeHarness = Effect.fn("Members.setClaudeHarness")(function* (
        id: ParticipantId,
        harness: Harness,
      ) {
        // Claude Code, the default, is kept as none.
        yield* sql`
          UPDATE participants SET claude_harness = ${harness === "Pi" ? harness : null}
          WHERE id = ${id}
        `
      })

      const decodeLiveVoice = Schema.decodeUnknownOption(Schema.fromJsonString(LiveVoiceSetting))

      const liveVoice = Effect.fn("Members.liveVoice")(function* (id: ParticipantId) {
        const chosen = yield* sql<{ readonly voice: string | null }>`
          SELECT live_voice AS voice FROM participants WHERE id = ${id}
        `
        const stored = chosen[0]?.voice
        // One kndl can't talk to any more is as none.
        return stored == null ? undefined : Option.getOrUndefined(decodeLiveVoice(stored))
      })

      const setLiveVoice = Effect.fn("Members.setLiveVoice")(function* (
        id: ParticipantId,
        setting: LiveVoiceSetting,
      ) {
        yield* sql`
          UPDATE participants SET live_voice = ${JSON.stringify(setting)} WHERE id = ${id}
        `
      })

      return Members.of({
        liveVoice,
        setLiveVoice,
        admit,
        admitLocal,
        owner,
        list,
        isMember,
        remove,
        invite,
        pendingInvites,
        revokeInvite,
        newSetupLink,
        claudeHarness,
        setClaudeHarness,
      })
    }),
  )
}
