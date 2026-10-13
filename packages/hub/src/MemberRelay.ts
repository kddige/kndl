// What the Session relay does for the People page (#209, ADR 0019): Invites made, listed and
// revoked, and Members listed and removed. Only the Owner may do any of it; the Hub refuses
// everyone else, whatever their web UI shows. It runs off the relay's lock, which only a removal
// takes, to close the removed Member's connections.
//
// - The Owner's web clients are sent the pending Invites and the Members whenever they change: an
//   Invite made, revoked or used, someone admitted, or a Member removed. No one else is sent them.
// - Removing a Member signs them out everywhere and revokes their CLI tokens (Members.ts), then
//   closes their web clients and forwards. A tunnel already open stays open until it closes, as
//   with a CLI token revoked. Their awake Sessions are put to sleep, each saying why: they run on
//   the removed Member's Claude credential (ADR 0026).

import {
  admissionLink,
  CommandFailed,
  type HubToWeb,
  InviteCreated,
  InviteList,
  InvitePath,
  MemberList,
  ownerOnlyMessage,
  type Participant,
  type ParticipantId,
  type RequestId,
  type WebToHub,
} from "@kndl/protocol"
import { Effect, Option } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { HubConfig } from "./HubConfig.ts"
import { Members } from "./Members.ts"

const webTags = [
  "CreateInvite",
  "ListInvites",
  "RevokeInvite",
  "ListMembers",
  "RemoveMember",
] as const

/** A web command from the People page. */
export type MemberCommand = Extract<WebToHub, { readonly _tag: (typeof webTags)[number] }>

export const isMemberCommand = (message: WebToHub): message is MemberCommand =>
  (webTags as ReadonlyArray<string>).includes(message._tag)

/** How a removed Member's web clients are closed: as signed out, which a sign-in can't undo. */
export const RemovedCloseCode = 4401

/** A web connection, as the relay knows it. */
export interface MemberWebClient {
  readonly you: Participant
  readonly peer: { readonly send: (message: HubToWeb) => void }
}

export const makeMemberRelay = Effect.fn("makeMemberRelay")(function* (deps: {
  /** Sends a message to every web client `to` picks. */
  readonly toWeb: (message: HubToWeb, to: (client: MemberWebClient) => boolean) => void
  /** Closes a removed Member's web clients and forwards, and puts their awake Sessions to sleep. */
  readonly removed: (participantId: ParticipantId, by: Participant) => Effect.Effect<void, SqlError>
}) {
  const members = yield* Members
  const { publicUrl } = yield* HubConfig

  const inviteList = (requestId?: RequestId) =>
    Effect.map(members.pendingInvites, (invites) =>
      InviteList.make({ invites, ...(requestId !== undefined && { requestId }) }),
    )
  const memberList = (requestId?: RequestId) =>
    Effect.map(members.list, (list) =>
      MemberList.make({ members: list, ...(requestId !== undefined && { requestId }) }),
    )

  /** Sends the Owner's web clients `message`; the one that asked, if one did, with `requestId`. */
  const toOwner = Effect.fn("MemberRelay.toOwner")(function* (
    message: InviteList | MemberList,
    asked?: { readonly client: MemberWebClient; readonly requestId: RequestId },
  ) {
    const owner = yield* members.owner
    if (Option.isNone(owner)) return
    deps.toWeb(
      message,
      (client) => client.you.id === owner.value && client.peer !== asked?.client.peer,
    )
    asked?.client.peer.send({ ...message, requestId: asked.requestId })
  })

  /** The Members, or the pending Invites, changed: the Owner's web clients are sent them. */
  const membersChanged = Effect.gen(function* () {
    yield* toOwner(yield* memberList())
    yield* toOwner(yield* inviteList())
  }).pipe(
    Effect.catchTag("SqlError", (error) =>
      Effect.logError("Could not send the Owner the Members", error),
    ),
  )

  const handle = Effect.fn("MemberRelay.handle")(function* (
    client: MemberWebClient,
    message: MemberCommand,
    refuse: (why: string) => void,
  ): Effect.fn.Return<void, SqlError> {
    const asked = { client, requestId: message.requestId }
    switch (message._tag) {
      case "CreateInvite": {
        const invite = yield* members.invite(client.you, message.login)
        yield* Effect.logInfo(
          `${client.you.login} made an Invite (${invite.id})${invite.login === undefined ? "" : ` for ${invite.login}`}`,
        )
        client.peer.send(
          InviteCreated.make({
            requestId: message.requestId,
            id: invite.id,
            link: admissionLink(publicUrl.origin, InvitePath, invite.secret),
            ...(invite.login !== undefined && { login: invite.login }),
            expiresAt: invite.expiresAt,
          }),
        )
        return yield* toOwner(yield* inviteList())
      }
      case "ListInvites":
        return client.peer.send(yield* inviteList(message.requestId))
      case "RevokeInvite": {
        yield* members.revokeInvite(message.inviteId)
        yield* Effect.logInfo(`${client.you.login} revoked an Invite (${message.inviteId})`)
        return yield* toOwner(yield* inviteList(), asked)
      }
      case "ListMembers":
        return client.peer.send(yield* memberList(message.requestId))
      case "RemoveMember": {
        const refusal = yield* members.remove(message.participantId).pipe(
          Effect.as(undefined),
          Effect.catchTag("RemovalRefused", (error) => Effect.succeed(error.message)),
        )
        if (refusal !== undefined) return refuse(refusal)
        yield* Effect.logInfo(`${client.you.login} removed a Member (${message.participantId})`)
        yield* deps.removed(message.participantId, client.you)
        return yield* toOwner(yield* memberList(), asked)
      }
    }
  })

  const receiveWeb = (client: MemberWebClient, message: MemberCommand) => {
    const refuse = (why: string) =>
      client.peer.send(
        CommandFailed.make({ command: message._tag, message: why, requestId: message.requestId }),
      )
    return Effect.gen(function* () {
      const owner = yield* members.owner
      if (!Option.contains(owner, client.you.id)) return refuse(ownerOnlyMessage)
      return yield* handle(client, message, refuse)
    }).pipe(
      Effect.catchTag("SqlError", (error) =>
        Effect.logError("A People page command failed", error).pipe(
          Effect.andThen(Effect.sync(() => refuse("The Hub could not do that; try again."))),
        ),
      ),
    )
  }

  return { receiveWeb, membersChanged }
})
