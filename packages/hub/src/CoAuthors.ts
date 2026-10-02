import type { GitIdentity, Participant, SessionId } from "@claude-hub/protocol"
import { Clock, Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"

/** Who prompted a Session since its last commit, as Co-authored-by trailers. */
export interface CoAuthorList {
  readonly coAuthors: ReadonlyArray<GitIdentity>
  /** The last prompt counted: `committed` with it forgets that one and those before. */
  readonly through: number
}

/** The GitHub user id in a Participant id from GitHub sign-in (`github:<id>`), if it is one. */
export const githubUserId = (participantId: string): number | undefined => {
  const match = /^github:(\d+)$/.exec(participantId)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

/**
 * The trailer identity of a Participant, with GitHub's noreply address
 * (`<id>+<login>@users.noreply.github.com`), which GitHub links to the account. A dev-login
 * Participant has no GitHub account, and so no trailer.
 */
export const coAuthorOf = (participant: {
  readonly id: string
  readonly login: string
  readonly name: string
}): GitIdentity | undefined => {
  const id = githubUserId(participant.id)
  if (id === undefined) return undefined
  return {
    name: participant.name === "" ? participant.login : participant.name,
    email: `${id}+${participant.login}@users.noreply.github.com`,
  }
}

/**
 * Each Session's prompters since its last commit (issue #13), in SQLite so that a Hub restart
 * keeps them. The Hub records the sender of every prompt that starts a Turn, hands the list to
 * the Runner when the model commits, and forgets it once the Runner reports the commit made.
 */
export class CoAuthors extends Context.Service<
  CoAuthors,
  {
    /** The prompt `sender` sent started a Turn in the Session. */
    readonly record: (sessionId: SessionId, sender: Participant) => Effect.Effect<void, SqlError>
    /**
     * The Session's co-authors since its last commit, each once, in the order they first
     * prompted. Dev-login Participants are left out: they have no GitHub account.
     */
    readonly list: (sessionId: SessionId) => Effect.Effect<CoAuthorList, SqlError>
    /** A commit was made with the list up to `through`: those prompts are forgotten. */
    readonly committed: (sessionId: SessionId, through: number) => Effect.Effect<void, SqlError>
  }
>()("@claude-hub/hub/CoAuthors") {
  static readonly layer = Layer.effect(
    CoAuthors,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const record = Effect.fn("CoAuthors.record")(function* (
        sessionId: SessionId,
        sender: Participant,
      ) {
        const at = yield* Clock.currentTimeMillis
        yield* sql`
          INSERT INTO session_prompters (session_id, participant_id, at)
          VALUES (${sessionId}, ${sender.id}, ${at})
        `
      })

      const list = Effect.fn("CoAuthors.list")(function* (sessionId: SessionId) {
        const rows = yield* sql<{
          readonly seq: number
          readonly id: string
          readonly login: string
          readonly name: string
        }>`
          SELECT s.seq, p.id, p.login, p.name
          FROM session_prompters s JOIN participants p ON p.id = s.participant_id
          WHERE s.session_id = ${sessionId}
          ORDER BY s.seq
        `
        const seen = new Set<string>()
        const coAuthors: Array<GitIdentity> = []
        let through = 0
        for (const row of rows) {
          through = Math.max(through, row.seq)
          if (seen.has(row.id)) continue
          seen.add(row.id)
          const coAuthor = coAuthorOf(row)
          if (coAuthor !== undefined) coAuthors.push(coAuthor)
        }
        return { coAuthors, through }
      })

      const committed = Effect.fn("CoAuthors.committed")(function* (
        sessionId: SessionId,
        through: number,
      ) {
        yield* sql`DELETE FROM session_prompters WHERE session_id = ${sessionId} AND seq <= ${through}`
      })

      return CoAuthors.of({ record, list, committed })
    }),
  )
}
