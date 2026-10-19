import {
  type Compact,
  type DeliverThreadPrompt,
  HubToMod,
  type PromptId,
  type SessionId,
  type StartThread,
  type StopThread,
  type SwitchThreadModel,
} from "@kndl/protocol"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"

/** A command the durable agent must not lose: one about a thread, or a Compact. */
export type ThreadCommand =
  | StartThread
  | DeliverThreadPrompt
  | StopThread
  | SwitchThreadModel
  | Compact

/** A thread command as it waits for the agent, numbered in the order it was sent. */
export interface PendingThreadCommand {
  readonly seq: number
  readonly command: ThreadCommand
}

const CommandJson = Schema.fromJsonString(HubToMod)
const encodeCommand = Schema.encodeSync(CommandJson)
const decodeCommand = Schema.decodeUnknownOption(CommandJson)

/** The prompt a thread command carries, if it carries one. */
const promptOf = (command: ThreadCommand): PromptId | undefined =>
  command._tag === "StartThread" || command._tag === "DeliverThreadPrompt"
    ? command.promptId
    : undefined

/**
 * The thread commands and Compacts each Session's agent hasn't taken yet
 * (docs/design/durable-harness.md), in SQLite: the mod outbox is in memory, and dropped when the
 * agent restarts, so a prompt to a thread sent then, or while the Session sleeps or starts, would
 * be lost. Each is sent again after every hello of its agent until it is done: a prompt once a
 * Turn starts from it or it steers one, the others once the agent has polled past them. Sent
 * twice, a prompt runs once (the agent submits it with its id as its request id), and a thread
 * starts once.
 */
export class ThreadCommands extends Context.Service<
  ThreadCommands,
  {
    /** Keeps the command for the Session's agent until it is done: its number. */
    readonly add: (sessionId: SessionId, command: ThreadCommand) => Effect.Effect<number, SqlError>
    /** The Session's commands not done yet, oldest first. */
    readonly pending: (
      sessionId: SessionId,
    ) => Effect.Effect<ReadonlyArray<PendingThreadCommand>, SqlError>
    /** The agent took the prompt: its command is done. The command, if one carried it. */
    readonly promptTaken: (
      sessionId: SessionId,
      promptId: PromptId,
    ) => Effect.Effect<Option.Option<ThreadCommand>, SqlError>
    /** The agent took the commands numbered `seqs`, none of them a prompt's: they are done. */
    readonly taken: (
      sessionId: SessionId,
      seqs: ReadonlyArray<number>,
    ) => Effect.Effect<void, SqlError>
    /** Forgets the Session's commands, as when it is archived. */
    readonly clear: (sessionId: SessionId) => Effect.Effect<void, SqlError>
  }
>()("@kndl/hub/ThreadCommands") {
  static readonly layer = Layer.effect(
    ThreadCommands,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const add = Effect.fn("ThreadCommands.add")(function* (
        sessionId: SessionId,
        command: ThreadCommand,
      ) {
        const rows = yield* sql<{ readonly seq: number }>`
          INSERT INTO thread_commands (session_id, command, prompt_id)
          VALUES (${sessionId}, ${encodeCommand(command)}, ${promptOf(command) ?? null})
          RETURNING seq
        `
        return rows[0]?.seq ?? 0
      })

      const pending = Effect.fn("ThreadCommands.pending")(function* (sessionId: SessionId) {
        const rows = yield* sql<{ readonly seq: number; readonly command: string }>`
          SELECT seq, command FROM thread_commands WHERE session_id = ${sessionId} ORDER BY seq
        `
        return rows.flatMap((row): Array<PendingThreadCommand> => {
          // One the Hub can no longer read is dropped from what is sent.
          const command = Option.getOrUndefined(decodeCommand(row.command))
          return command === undefined ? [] : [{ seq: row.seq, command: command as ThreadCommand }]
        })
      })

      const promptTaken = Effect.fn("ThreadCommands.promptTaken")(function* (
        sessionId: SessionId,
        promptId: PromptId,
      ) {
        const rows = yield* sql<{ readonly command: string }>`
          DELETE FROM thread_commands WHERE session_id = ${sessionId} AND prompt_id = ${promptId}
          RETURNING command
        `
        return Option.flatMap(Option.fromNullishOr(rows[0]), (row) =>
          Option.map(decodeCommand(row.command), (command) => command as ThreadCommand),
        )
      })

      const taken = Effect.fn("ThreadCommands.taken")(function* (
        sessionId: SessionId,
        seqs: ReadonlyArray<number>,
      ) {
        if (seqs.length === 0) return
        yield* sql`
          DELETE FROM thread_commands
          WHERE session_id = ${sessionId} AND seq IN ${sql.in(seqs)} AND prompt_id IS NULL
        `
      })

      const clear = Effect.fn("ThreadCommands.clear")(function* (sessionId: SessionId) {
        yield* sql`DELETE FROM thread_commands WHERE session_id = ${sessionId}`
      })

      return ThreadCommands.of({ add, pending, promptTaken, taken, clear })
    }),
  )
}
