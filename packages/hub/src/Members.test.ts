// Who gets in (#209, ADR 0019), end to end: a real Hub with a stand-in GitHub, sign-ins with the
// Setup link and with Invites, and the Owner's People page over the web channel.

import { afterEach, describe, expect, test } from "bun:test"
import { InviteOnlyPath, ownerOnlyMessage, Participant, ParticipantId } from "@kndl/protocol"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { signInCookie } from "./Auth.ts"
import { CliTokens, pkceChallenge } from "./CliTokens.ts"
import { GitHub } from "./GitHub.ts"
import { RemovedCloseCode } from "./MemberRelay.ts"
import { Members } from "./Members.ts"
import { type Connection, openWeb, stopAll, type Web } from "./testChannels.ts"
import {
  cookieFrom,
  githubSignIn,
  ownerSignIn,
  setupSecret,
  startHub,
  type TestHub,
} from "./testSupport.ts"

afterEach(stopAll)

/** Three people GitHub knows, by the code it sends each back with. */
const github = GitHub.layerTest({
  users: {
    "owner-code": { id: 1, login: "octocat", name: "The Octocat" },
    "friend-code": { id: 2, login: "Friend-Login", name: null },
    "stranger-code": { id: 3, login: "stranger", name: null },
  },
})

const friend = Participant.make({
  id: ParticipantId.make("github:2"),
  login: "Friend-Login",
  name: "Friend-Login",
})

/** Everyone the Hub has on record. */
const participantIds = (hub: TestHub) =>
  hub.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ readonly id: string }>`SELECT id FROM participants ORDER BY id`
      return rows.map((row) => row.id)
    }),
  )

/** A sign-in let in: back to the web UI, signed in. */
async function expectSignedIn(response: Response) {
  expect(response.status).toBe(302)
  expect(response.headers.get("location")).toBe("/")
  return cookieFrom(response)
}

/** A sign-in turned away: to the invite-only page, with no sign-in. */
function expectTurnedAway(response: Response) {
  expect(response.status).toBe(302)
  expect(response.headers.get("location")).toBe(InviteOnlyPath)
  for (const cookie of response.headers.getSetCookie()) {
    expect(cookie.startsWith(`${signInCookie}=`)).toBe(false)
  }
}

/** A Hub whose Owner, octocat, has signed in with the Setup link and has the People page open. */
async function ownedHub() {
  const hub = await startHub({ github })
  const cookie = await expectSignedIn(await ownerSignIn(hub, { code: "owner-code" }))
  const owner = await openWeb(hub, "octocat", cookie)
  return { hub, owner }
}

/** The secret in the link of an Invite the Owner makes, for `login` only if given. */
async function invite(owner: Connection<Web>, login?: string) {
  owner.send({ _tag: "CreateInvite", requestId: "invite", ...(login && { login }) })
  const created = await owner.take("InviteCreated")
  await owner.take("InviteList", (m) => m.requestId === undefined)
  return new URL(created.link).hash.slice(1)
}

describe("the Setup link", () => {
  test("makes whoever signs in with it the Owner, and works once", async () => {
    const hub = await startHub({ github })
    const secret = await setupSecret(hub)
    const cookie = await expectSignedIn(
      await githubSignIn(hub, { ticket: secret, code: "owner-code" }),
    )
    const owner = await openWeb(hub, "octocat", cookie)

    expect(owner.welcome.owner).toBe(true)
    expect(await hub.run(Effect.flatMap(Members, (members) => members.owner))).toEqual(
      Option.some(ParticipantId.make("github:1")),
    )
    expectTurnedAway(await githubSignIn(hub, { ticket: secret, code: "friend-code" }))
    expect(await participantIds(hub)).toEqual(["github:1"])
  })

  test("is no longer made once the Hub has an Owner", async () => {
    const { hub } = await ownedHub()

    await expect(setupSecret(hub)).rejects.toThrow("has an Owner already")
  })

  test("is replaced by a new one", async () => {
    const hub = await startHub({ github })
    const first = await setupSecret(hub)
    const second = await setupSecret(hub)

    expectTurnedAway(await githubSignIn(hub, { ticket: first, code: "owner-code" }))
    await expectSignedIn(await githubSignIn(hub, { ticket: second, code: "owner-code" }))
  })

  test("is the only way in while the Hub has no Owner", async () => {
    const hub = await startHub({ github })
    await setupSecret(hub)

    expectTurnedAway(await githubSignIn(hub, { code: "owner-code" }))
    expect(await participantIds(hub)).toEqual([])
  })
})

describe("an Invite", () => {
  test("admits whoever opens it, once, and the Owner sees them a Member", async () => {
    const { hub, owner } = await ownedHub()
    const secret = await invite(owner)

    const cookie = await expectSignedIn(
      await githubSignIn(hub, { ticket: secret, code: "friend-code" }),
    )
    const me = await fetch(`${hub.url}/auth/me`, { headers: { cookie } })
    expect(await me.json()).toEqual({ id: "github:2", login: "Friend-Login", name: "Friend-Login" })
    const members = await owner.take("MemberList")
    expect(members.members.map((m) => [m.participant.id, m.owner])).toEqual([
      ["github:1", true],
      ["github:2", false],
    ])
    expect((await owner.take("InviteList")).invites).toEqual([])

    expectTurnedAway(await githubSignIn(hub, { ticket: secret, code: "stranger-code" }))
    expect(await participantIds(hub)).toEqual(["github:1", "github:2"])
  })

  test("for a login admits only that login, whatever its case", async () => {
    const { hub, owner } = await ownedHub()
    const secret = await invite(owner, "friend-login")

    expectTurnedAway(await githubSignIn(hub, { ticket: secret, code: "stranger-code" }))
    await expectSignedIn(await githubSignIn(hub, { ticket: secret, code: "friend-code" }))
    expect(await participantIds(hub)).toEqual(["github:1", "github:2"])
  })

  test("is turned away alike when revoked, expired or never made", async () => {
    const { hub, owner } = await ownedHub()
    const revoked = await invite(owner)
    owner.send({ _tag: "ListInvites", requestId: "list" })
    const listed = await owner.take("InviteList", (m) => m.requestId === "list")
    const revokedId = listed.invites[0]?.id ?? ""
    owner.send({ _tag: "RevokeInvite", requestId: "revoke", inviteId: revokedId })
    expect((await owner.take("InviteList", (m) => m.requestId === "revoke")).invites).toEqual([])

    const expired = await invite(owner)
    await hub.run(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE invites SET expires_at = 0`),
    )

    for (const ticket of [revoked, expired, "chi_nope.secret", "not-a-ticket"]) {
      expectTurnedAway(await githubSignIn(hub, { ticket, code: "friend-code" }))
    }
    expect(await participantIds(hub)).toEqual(["github:1"])
  })

  test("isn't needed by a Member signing in again", async () => {
    const { hub, owner } = await ownedHub()
    const secret = await invite(owner)
    await expectSignedIn(await githubSignIn(hub, { ticket: secret, code: "friend-code" }))

    await expectSignedIn(await githubSignIn(hub, { code: "friend-code" }))
    await expectSignedIn(await githubSignIn(hub, { code: "owner-code" }))
  })
})

describe("the People page", () => {
  test("is the Owner's alone", async () => {
    const { hub, owner } = await ownedHub()
    const secret = await invite(owner)
    const cookie = await expectSignedIn(
      await githubSignIn(hub, { ticket: secret, code: "friend-code" }),
    )
    const member = await openWeb(hub, "Friend-Login", cookie)

    expect(member.welcome.owner).toBeUndefined()
    for (const command of [
      { _tag: "CreateInvite" },
      { _tag: "ListInvites" },
      { _tag: "RevokeInvite", inviteId: "any" },
      { _tag: "ListMembers" },
      { _tag: "RemoveMember", participantId: "github:1" },
    ]) {
      member.send({ ...command, requestId: command._tag })
      expect(await member.take("CommandFailed", (m) => m.requestId === command._tag)).toEqual({
        _tag: "CommandFailed",
        command: command._tag,
        requestId: command._tag,
        message: ownerOnlyMessage,
      })
    }
    expect(await member.untaken("MemberList")).toEqual([])
    expect(await member.untaken("InviteList")).toEqual([])
    expect(await member.untaken("InviteCreated")).toEqual([])
  })

  test("removes a Member at once: their sign-ins, CLI tokens and connections", async () => {
    const { hub, owner } = await ownedHub()
    const cookie = await expectSignedIn(
      await githubSignIn(hub, { ticket: await invite(owner), code: "friend-code" }),
    )
    const member = await openWeb(hub, "Friend-Login", cookie)
    const verifier = "v".repeat(20) + "-verifier-of-the-cli-that-asked"
    const cli = await hub.run(
      Effect.gen(function* () {
        const cliTokens = yield* CliTokens
        const { code } = yield* cliTokens.approve(friend, "laptop", pkceChallenge(verifier))
        return yield* cliTokens.redeem(code, verifier)
      }),
    )
    await owner.take("MemberList")
    // A Connected provider of theirs (ADR 0029), as the Hub keeps one.
    const connectedProviders = () =>
      hub.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql`SELECT provider FROM connected_providers WHERE participant_id = 'github:2'`
        }),
      )
    await hub.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO connected_providers
          (participant_id, provider, kind, credential, label, connected_at)
          VALUES ('github:2', 'openai', 'ApiKey', 'sealed', 'abcd', 1)`
      }),
    )
    expect(await connectedProviders()).toHaveLength(1)

    owner.send({ _tag: "RemoveMember", requestId: "remove", participantId: "github:2" })

    const members = await owner.take("MemberList", (m) => m.requestId === "remove")
    expect(members.members.map((m) => m.participant.id)).toEqual(["github:1"])
    expect((await member.closed).code).toBe(RemovedCloseCode)
    expect((await fetch(`${hub.url}/auth/me`, { headers: { cookie } })).status).toBe(401)
    expect(
      await hub.run(Effect.flatMap(CliTokens, (cliTokens) => cliTokens.authenticate(cli.token))),
    ).toEqual(Option.none())
    // Their record stays, for the Sessions they were in; what they connected doesn't.
    expect(await participantIds(hub)).toEqual(["github:1", "github:2"])
    expect(await connectedProviders()).toEqual([])

    expectTurnedAway(await githubSignIn(hub, { code: "friend-code" }))
    await expectSignedIn(
      await githubSignIn(hub, { ticket: await invite(owner), code: "friend-code" }),
    )
  })

  test("won't remove the Owner, or someone who isn't a Member", async () => {
    const { owner } = await ownedHub()

    for (const [participantId, message] of [
      ["github:1", "The Hub's Owner can't be removed."],
      ["github:9", "There is no such Member."],
    ] as const) {
      owner.send({ _tag: "RemoveMember", requestId: participantId, participantId })
      expect(
        (await owner.take("CommandFailed", (m) => m.requestId === participantId)).message,
      ).toBe(message)
    }
  })
})
