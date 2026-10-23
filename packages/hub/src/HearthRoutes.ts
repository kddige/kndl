// The kndl MCP server (spike, ADR 0032): the Hub's own MCP server, which a Member's Hearth reaches
// its other Sessions with.
//
// - `/gateway/kndl`, by the Hearth's mod token alone as `Authorization: Bearer`, as the Gateway's
//   other servers are: the Runner's relay passes it on with it. Every Hearth gets it in its
//   StartSession (SessionRelay.ts), beside its Installations. Any other Session is answered `403`.
// - It speaks MCP's Streamable HTTP without sessions or streams: each POST is a JSON-RPC request,
//   or a batch, answered with JSON. GET and DELETE are answered `405`.
// - Each tool runs as the Hearth's Creator, through a web connection of theirs made for the call
//   alone (`asCreator`): the Session relay checks what it asks as it checks the web UI's commands,
//   so the Hearth sees the Sessions its Creator may see, and drives the ones they may drive, and
//   no others. What it sends shows as sent by its Creator.
// - The Hearth can read itself, but neither prompts nor stops itself.

import {
  EventSeq,
  type HubToWeb,
  isHearthRepo,
  type Participant,
  type RepoName,
  RequestId,
  type SessionId,
  type SessionSummary,
  sessionTitle,
  type WebToHub,
} from "@kndl/protocol"
import { Duration, Effect, Option, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { authenticateMod } from "./Auth.ts"
import { DefaultHistoryLimit, historyPage, MaxHistoryLimit } from "./Handoff.ts"
import { PromptQueue } from "./PromptQueue.ts"
import { SessionLog } from "./SessionLog.ts"
import { SessionRelay } from "./SessionRelay.ts"
import { Sessions } from "./Sessions.ts"
import { randomId } from "./Tokens.ts"

/** The longest `wait_for_session` waits, under the Hub server's idle timeout (Hub.ts). */
const MaxWaitSeconds = 25

/** How often `wait_for_session` looks again. */
const waitPoll = Duration.seconds(1)

/** What the Hearth's agent is told of the server as it connects. */
const instructions = `You are a Hearth: the persistent kndl Session of the person who started you. Your Workspace is yours alone and lives on across sleeps: keep notes and memory in it. These tools reach the person's other kndl Sessions, as them: list and read them, create them on a Repo, prompt them, stop them, answer their questions, and wait for them to finish. Prefer creating a Session for real work on a Repo over doing it in your own Workspace.`

interface Tool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

const sessionIdProperty = { session_id: { type: "string", description: "The Session's id." } }

const tools: ReadonlyArray<Tool> = [
  {
    name: "list_sessions",
    description:
      "Lists the kndl Sessions you can see, with their state and whether they are working or waiting on a question. Archived ones only if asked.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Only this Repo's, owner/name." },
        include_archived: { type: "boolean" },
      },
    },
  },
  {
    name: "get_session",
    description:
      "One Session's status in full: state, Turn, subagents, Open question, queued prompts, model and branch.",
    inputSchema: { type: "object", properties: sessionIdProperty, required: ["session_id"] },
  },
  {
    name: "read_session",
    description:
      "A Session's Turns, oldest first: who prompted what, the tools its agent called and what it answered, shortened. Pass `before` from the answer's `earlierBefore` to read further back.",
    inputSchema: {
      type: "object",
      properties: {
        ...sessionIdProperty,
        before: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: MaxHistoryLimit },
      },
      required: ["session_id"],
    },
  },
  {
    name: "list_repos",
    description: "The GitHub Repos you can start Sessions on.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_session",
    description:
      "Starts a new Session on a Repo, on a new claude/<id> branch made from `base_branch`, or on a new branch named `new_branch`. Give `prompt` to send it its first prompt. The Repo needs an Environment.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name" },
        base_branch: { type: "string", description: "Defaults to main." },
        new_branch: { type: "string", description: "A branch to create from base_branch." },
        model: {
          type: "string",
          description: "A Model, as the web UI names it; else your default.",
        },
        prompt: { type: "string" },
      },
      required: ["repo"],
    },
  },
  {
    name: "send_prompt",
    description:
      "Sends a prompt to a Session, as you: it waits in its Prompt queue if a Turn runs, and wakes it if it is asleep.",
    inputSchema: {
      type: "object",
      properties: { ...sessionIdProperty, text: { type: "string" } },
      required: ["session_id", "text"],
    },
  },
  {
    name: "stop_turn",
    description: "Stops the Session's running Turn.",
    inputSchema: { type: "object", properties: sessionIdProperty, required: ["session_id"] },
  },
  {
    name: "answer_question",
    description: "Answers the Session's Open question in your own words.",
    inputSchema: {
      type: "object",
      properties: { ...sessionIdProperty, answer: { type: "string" } },
      required: ["session_id", "answer"],
    },
  },
  {
    name: "wait_for_session",
    description: `Waits until the Session is idle (no Turn, subagent or queued prompt) or asks a question, for at most \`seconds\` (up to ${MaxWaitSeconds}); then says its status. Call it again to wait longer.`,
    inputSchema: {
      type: "object",
      properties: { ...sessionIdProperty, seconds: { type: "integer", minimum: 1 } },
      required: ["session_id"],
    },
  },
]

/** A tool's answer: its text, and whether it failed. */
interface ToolResult {
  readonly text: string
  readonly isError?: boolean
}

const ok = (value: unknown): ToolResult => ({
  text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
})
const failed = (text: string): ToolResult => ({ text, isError: true })

/** What a JSON-RPC request is, as far as this server reads it. */
const RpcRequest = Schema.Struct({
  jsonrpc: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})
type RpcRequest = typeof RpcRequest.Type

const decodeRequest = Schema.decodeUnknownOption(RpcRequest)

const errorResponse = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status })

const stringArg = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key]
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

const numberArg = (args: Record<string, unknown>, key: string): number | undefined => {
  const value = args[key]
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined
}

/** Whether the Session works: a Turn, a running subagent or a start under way. */
const isWorking = (session: SessionSummary) =>
  session.currentTurn !== null ||
  session.starting !== undefined ||
  session.agents?.some((agent) => agent.status === "Running") === true

/** A Session as `list_sessions` lists it. */
const listed = (session: SessionSummary) => ({
  id: session.id,
  title: sessionTitle(session),
  repo: session.repo,
  state: session.state,
  working: isWorking(session),
  ...(session.openQuestion !== undefined && {
    question: session.openQuestion.questions.map((question) => question.question).join(" / "),
  }),
  creator: session.creator.login,
})

/** The Sessions the Creator can see, as the relay lists them to a new web connection. */
const visibleSessions = (received: ReadonlyArray<HubToWeb>) => {
  for (const message of received) {
    if (message._tag === "SessionList") return message.sessions
  }
  return []
}

/** The command's refusal, if the relay sent one. */
const refusalOf = (
  received: ReadonlyArray<HubToWeb>,
  command: string,
  about: { readonly requestId?: string; readonly sessionId?: string },
) => {
  for (const message of received) {
    if (message._tag !== "CommandFailed" || message.command !== command) continue
    if (about.requestId !== undefined && message.requestId !== about.requestId) continue
    if (about.sessionId !== undefined && message.sessionId !== about.sessionId) continue
    return message.message
  }
  return undefined
}

export const HearthRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    const relay = yield* SessionRelay
    const sessions = yield* Sessions
    const prompts = yield* PromptQueue
    const log = yield* SessionLog

    /**
     * Runs `use` on a web connection of the Creator's own, made for it alone and closed after:
     * whatever the relay sends it is in `received`, the Session list first.
     */
    const asCreator = <A, E, R>(
      creator: Participant,
      use: (client: {
        readonly send: (message: WebToHub) => Effect.Effect<void>
        readonly received: ReadonlyArray<HubToWeb>
      }) => Effect.Effect<A, E, R>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const received: Array<HubToWeb> = []
          const send = yield* relay.connectWeb(creator, {
            send: (message) => void received.push(message),
            close: () => {},
          })
          return yield* use({ send, received })
        }),
      )

    const status = Effect.fn("Hearth.status")(function* (session: SessionSummary) {
      const queued = yield* prompts.list(session.id)
      return {
        ...listed(session),
        workBranch: session.workBranch,
        baseBranch: session.baseBranch,
        ...(session.model !== undefined && { model: session.model }),
        ...(session.harness !== undefined && { harness: session.harness }),
        currentTurn: session.currentTurn,
        ...(session.agents !== undefined && { agents: session.agents }),
        ...(session.openQuestion !== undefined && { openQuestion: session.openQuestion }),
        queuedPrompts: queued.length,
        ...(session.lastOutput !== undefined && { lastOutput: session.lastOutput }),
        createdAt: new Date(session.createdAt).toISOString(),
      }
    })

    /** Runs one tool for the Hearth, as its Creator. */
    const callTool = Effect.fn("Hearth.callTool")(function* (
      hearth: SessionSummary,
      name: string,
      args: Record<string, unknown>,
    ) {
      const creator = hearth.creator
      return yield* asCreator(creator, ({ send, received }) =>
        Effect.gen(function* () {
          const visible = visibleSessions(received)
          /** A Session the Creator can see, by the `session_id` argument. */
          const target = (options: { readonly drive: boolean }) => {
            const id = stringArg(args, "session_id")
            if (id === undefined) return failed("Give a session_id.")
            const found = visible.find((session) => session.id === id)
            if (found === undefined) return failed(`There is no Session ${id} you can see.`)
            if (options.drive && found.id === hearth.id) {
              return failed("That is you: a Hearth doesn't prompt or stop itself.")
            }
            return found
          }
          /** Sends a command and says how it went: its refusal, or `done`. */
          const command = (
            message: WebToHub & { readonly sessionId: SessionId },
            done: string,
          ): Effect.Effect<ToolResult> =>
            Effect.gen(function* () {
              yield* send(message)
              const refused = refusalOf(received, message._tag, { sessionId: message.sessionId })
              return refused === undefined ? ok(done) : failed(refused)
            })

          switch (name) {
            case "list_sessions": {
              const repo = stringArg(args, "repo")
              const archived = args["include_archived"] === true
              return ok(
                visible
                  .filter((session) => session.id !== hearth.id)
                  .filter((session) => archived || session.state !== "Archived")
                  .filter(
                    (session) =>
                      repo === undefined || session.repo.toLowerCase() === repo.toLowerCase(),
                  )
                  .map(listed),
              )
            }

            case "get_session": {
              const found = target({ drive: false })
              if (!("id" in found)) return found
              return ok(yield* status(found))
            }

            case "read_session": {
              const found = target({ drive: false })
              if (!("id" in found)) return found
              const limit = Math.min(
                numberArg(args, "limit") ?? DefaultHistoryLimit,
                MaxHistoryLimit,
              )
              const asked = numberArg(args, "before")
              const before = asked === undefined ? undefined : EventSeq.make(asked)
              const { entries, earlier } = yield* log.lastTurns(found.id, {
                count: limit,
                ...(before !== undefined && { before }),
              })
              return ok(historyPage(entries, { before, limit, earlier }))
            }

            case "list_repos": {
              const requestId = RequestId.make(randomId())
              yield* send({ _tag: "ListRepos", requestId })
              // Answered off the lock: wait for it a little.
              for (let tries = 0; tries < 100; tries++) {
                for (const message of received) {
                  if (message._tag === "ReposListed" && message.requestId === requestId) {
                    return ok(message.repos)
                  }
                  if (message._tag === "ListingUnavailable" && message.requestId === requestId) {
                    return failed(message.hint ?? "The Hub can't list Repos: it has no GitHub App.")
                  }
                }
                const refused = refusalOf(received, "ListRepos", { requestId })
                if (refused !== undefined) return failed(refused)
                yield* Effect.sleep(Duration.millis(100))
              }
              return failed("The Hub didn't list the Repos in time; try again.")
            }

            case "create_session": {
              const repo = stringArg(args, "repo")
              if (repo === undefined || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
                return failed("Give the Repo as owner/name.")
              }
              if (isHearthRepo(repo)) return failed("You are the Hearth: there is only one.")
              const base = stringArg(args, "base_branch") ?? "main"
              const newBranch = stringArg(args, "new_branch")
              const model = stringArg(args, "model")
              const requestId = RequestId.make(randomId())
              yield* send({
                _tag: "CreateSession",
                requestId,
                repo: repo as RepoName,
                branch:
                  newBranch === undefined
                    ? { _tag: "Existing", name: base, newWorkBranch: true }
                    : { _tag: "Create", name: newBranch, from: base },
                ...(model !== undefined && { model: model as never }),
              } as WebToHub)
              const refused = refusalOf(received, "CreateSession", { requestId })
              if (refused !== undefined) return failed(refused)
              const created = received.find(
                (message) => message._tag === "SessionCreated" && message.requestId === requestId,
              )
              if (created === undefined || created._tag !== "SessionCreated") {
                return failed("The Hub didn't say the Session was created.")
              }
              const session = created.session
              const prompt = stringArg(args, "prompt")
              if (prompt !== undefined) {
                yield* send({ _tag: "SendPrompt", sessionId: session.id, text: prompt })
                const notSent = refusalOf(received, "SendPrompt", { sessionId: session.id })
                if (notSent !== undefined) {
                  return failed(`Created ${session.id}, but its prompt wasn't sent: ${notSent}`)
                }
              }
              return ok({
                created: listed(session),
                ...(prompt !== undefined && { prompted: true }),
              })
            }

            case "send_prompt": {
              const found = target({ drive: true })
              if (!("id" in found)) return found
              const text = stringArg(args, "text")
              if (text === undefined) return failed("Give the prompt's text.")
              return yield* command(
                { _tag: "SendPrompt", sessionId: found.id, text },
                `Sent to ${sessionTitle(found)}.`,
              )
            }

            case "stop_turn": {
              const found = target({ drive: true })
              if (!("id" in found)) return found
              return yield* command({ _tag: "StopTurn", sessionId: found.id }, "Stopping its Turn.")
            }

            case "answer_question": {
              const found = target({ drive: true })
              if (!("id" in found)) return found
              const answer = stringArg(args, "answer")
              if (answer === undefined) return failed("Give the answer.")
              const question = found.openQuestion
              if (question === undefined) return failed("The Session asks no question now.")
              return yield* command(
                {
                  _tag: "AnswerQuestion",
                  sessionId: found.id,
                  toolCallId: question.toolCallId,
                  answer: { _tag: "Replied", text: answer },
                },
                "Answered.",
              )
            }

            case "wait_for_session": {
              const found = target({ drive: false })
              if (!("id" in found)) return found
              const seconds = Math.min(
                Math.max(numberArg(args, "seconds") ?? MaxWaitSeconds, 1),
                MaxWaitSeconds,
              )
              const until = Date.now() + seconds * 1000
              for (;;) {
                const now = yield* sessions.get(found.id)
                if (Option.isNone(now)) return failed("The Session is gone.")
                const session = now.value
                const queued = (yield* prompts.list(session.id)).length
                const settled =
                  session.openQuestion !== undefined ||
                  session.state !== "Active" ||
                  (!isWorking(session) && queued === 0)
                if (settled || Date.now() >= until) {
                  return ok({ settled, ...(yield* status(session)) })
                }
                yield* Effect.sleep(waitPoll)
              }
            }

            default:
              return failed(`There is no tool called ${name}.`)
          }
        }),
      )
    })

    /** One JSON-RPC request's answer; undefined for a notification. */
    const answer = Effect.fn("Hearth.answer")(function* (
      hearth: SessionSummary,
      request: RpcRequest,
    ) {
      const id = request.id ?? null
      const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value })
      if (request.id === undefined || request.method.startsWith("notifications/")) return undefined
      switch (request.method) {
        case "initialize": {
          const asked = request.params?.["protocolVersion"]
          return result({
            protocolVersion: typeof asked === "string" ? asked : "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "kndl", version: "0.0.0-spike" },
            instructions,
          })
        }
        case "ping":
          return result({})
        case "tools/list":
          return result({ tools })
        case "tools/call": {
          const name = request.params?.["name"]
          const args = request.params?.["arguments"]
          const called = yield* callTool(
            hearth,
            typeof name === "string" ? name : "",
            typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {},
          ).pipe(
            Effect.catch((error) =>
              Effect.as(
                Effect.logError("A Hearth tool failed", error),
                failed("The Hub could not do that; try again."),
              ),
            ),
          )
          return result({
            content: [{ type: "text", text: called.text }],
            ...(called.isError === true && { isError: true }),
          })
        }
        default:
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `No method ${request.method}` },
          }
      }
    })

    yield* router.add(
      "*",
      "/gateway/kndl",
      Effect.gen(function* () {
        const grant = yield* authenticateMod
        const request = yield* HttpServerRequest.HttpServerRequest
        const session = yield* sessions.get(grant.sessionId).pipe(Effect.orDie)
        if (Option.isNone(session) || !isHearthRepo(session.value.repo)) {
          return errorResponse(403, "Only a Hearth reaches the kndl MCP server.")
        }
        if (request.method !== "POST") {
          return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
        }
        const body = yield* request.json.pipe(Effect.option)
        if (Option.isNone(body)) {
          return HttpServerResponse.jsonUnsafe(
            { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
            { status: 400 },
          )
        }
        const batch = Array.isArray(body.value)
        const asked = (batch ? (body.value as Array<unknown>) : [body.value]).map((one) =>
          decodeRequest(one),
        )
        const answers: Array<unknown> = []
        for (const one of asked) {
          if (Option.isNone(one)) {
            answers.push({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32600, message: "Invalid Request" },
            })
            continue
          }
          const answered = yield* answer(session.value, one.value).pipe(Effect.orDie)
          if (answered !== undefined) answers.push(answered)
        }
        yield* Effect.logInfo(`kndl MCP ${asked.length} request(s)`).pipe(
          Effect.annotateLogs({ sessionId: grant.sessionId }),
        )
        if (answers.length === 0) return HttpServerResponse.empty({ status: 202 })
        return HttpServerResponse.jsonUnsafe(batch ? answers : answers[0])
      }).pipe(Effect.annotateLogs({ component: "Hearth" }), Effect.withSpan("Hearth.request")),
    )
  }),
)
