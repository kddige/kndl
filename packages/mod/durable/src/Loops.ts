// What the Hub hears of each conversation the durable agent runs: the main loop, each thread and
// each subagent, followed through Pi Durable's agent events (`watchEvents`), one reporter each.
//
// A kndl Turn is one Pi Durable run, from the input that starts it to its answer: its retries,
// compactions and tool rounds stay in it. Each run gets a fresh TurnId. The main loop's and each
// thread's Turns start with a TurnStarted whose sender the run's first input says (Inputs.ts); a
// subagent's runs have none, and say its status instead. A run the agent's handoff to itself
// carried on (`kndl.continue`) stays in the Turn it continues.
//
// Events derive from commits, so they hold after a restart: a reporter attached to a conversation
// whose run is still going (it was going when the process stopped, and Pi Durable continues it)
// reports a new Turn, `Resumed`, since the Hub ended the old one when the process stopped. Which
// run the agent reported is kept in `kndl.turns` (TurnLedger.ts), so a run that started but never
// reached the Hub is reported as itself. A stream that falls far behind gets a snapshot instead of its events,
// which the reporter reconciles with what it reported.

import { InboxDoc, LiveDoc, ProviderDoc, watchEvents } from "@earendil-works/pi-durable"
import type {
  AgentEvent,
  AgentEventStream,
  ConversationId,
  EntryId,
  EntryRecord,
  MessageChange,
  SnapshotEvent,
  SubmissionId,
  SubmissionRecord,
  TaskId,
  UsageState,
} from "@earendil-works/pi-durable"
import { compactionSummary } from "./Compaction.ts"
import { clip, isRecord } from "./hub/HubMessages.ts"
import type { Sender } from "./hub/HubMessages.ts"
import { inputOrigin, inputText, NudgeEntry } from "./Inputs.ts"
import type { InputOrigin } from "./Inputs.ts"
import { loopFields } from "./Runtime.ts"
import type { Loop, Runtime } from "./Runtime.ts"
import { isRecordedRunning, recordAgentStatus } from "./Subagents.ts"
import { TurnLedger } from "./TurnLedger.ts"
import type { AssistantEnd } from "./Turns.ts"
import {
  conversationUsage,
  toolResultSummary,
  turnEndReason,
  turnErrorMessage,
  turnUsage,
} from "./Turns.ts"

/** What a reporter needs of the Runtime, and what only it needs besides. */
export interface LoopsOptions extends Pick<
  Runtime,
  "harness" | "report" | "newId" | "secrets" | "log" | "context"
> {
  /** Milliseconds, for a Turn's duration. */
  readonly now: () => number
  /** A conversation's run settled, with its provider session id: the Models let go of its query. */
  readonly runSettled: (sessionId: string) => void
}

/** A run reported as a Turn, until it ends. */
interface RunningTurn {
  readonly turnId: string
  readonly startedAt: number
  /** The run's first input, which tells it apart from its successor. */
  firstInput: SubmissionId
  readonly inputs: Set<SubmissionId>
  readonly requests: Array<AssistantEnd>
  /** The tool calls the model made, by id, with their arguments. */
  readonly calls: Map<string, unknown>
  readonly started: Set<string>
  lastEntry?: EntryId
}

/** A steer a Participant sent, which the Hub is told of when the conversation takes it in. */
export interface Steer {
  readonly promptId: string
  readonly text: string
  readonly sender: Sender
  readonly attachments?: ReadonlyArray<unknown> | undefined
}

/** What a batch says of the submissions and entries it touched. */
interface BatchFacts {
  readonly submissions: Map<SubmissionId, SubmissionRecord>
  readonly entries: Map<EntryId, EntryRecord>
}

type UsageLike = AssistantEnd["usage"]

const assistantEnd = (entry: EntryRecord): AssistantEnd | undefined => {
  const message = entry.model?.[0]
  if (message?.role !== "assistant") return undefined
  return {
    provider: message.provider,
    model: message.model,
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
    usage: message.usage as UsageLike,
  }
}

/** The text blocks of an assistant message's content, by their index. */
const textBlocks = (content: unknown): Array<readonly [number, string]> =>
  Array.isArray(content)
    ? content.flatMap((block, index): Array<readonly [number, string]> =>
        isRecord(block) && block.type === "text" && typeof block.text === "string"
          ? [[index, block.text]]
          : [],
      )
    : []

/** One conversation's reporter. */
export class LoopReporter {
  private stream: AgentEventStream | undefined
  private turn: RunningTurn | undefined
  /** The text of the in-flight assistant message the Hub has, by content index. */
  private emitted = new Map<number, string>()
  /** Steers about to be submitted, by request id, until their submission is seen. */
  private readonly submitting = new Map<string, Steer>()
  /** Queued steers the Hub was told of, until a boundary places them. */
  private readonly steers = new Map<SubmissionId, string>()
  private usage: UsageState | undefined
  private usageSent = ""
  private stopped = false
  /** The Turns reported; a subagent's runs are not Turns, so it keeps none. */
  private readonly ledger: TurnLedger | undefined

  constructor(
    readonly conversationId: ConversationId,
    readonly loop: Loop,
    private readonly options: LoopsOptions,
  ) {
    this.ledger = loop.kind === "agent" ? undefined : new TurnLedger(options, conversationId)
  }

  /** The Turn running, if one is. */
  get turnId(): string | undefined {
    return this.turn?.turnId
  }

  /**
   * Follows the conversation from now on; at the agent's start, a subagent found idle whose run
   * the Hub didn't hear end is said Done.
   */
  async attach(startup = false) {
    const stream = await watchEvents(
      this.options.harness(),
      this.conversationId,
      this.options.context,
    )
    if (this.stopped) {
      await stream.stop()
      return
    }
    this.stream = stream
    await this.reconcile(stream.snapshot, true, startup)
    stream.start(async (events) => {
      try {
        await this.batch(events)
      } catch (error) {
        this.options.log(`kndl: reporting conversation ${this.conversationId} failed: ${error}`)
      }
    })
  }

  async stop() {
    this.stopped = true
    await this.stream?.stop()
  }

  /**
   * A steer about to be submitted under `requestId`. The Hub hears of it from this conversation's
   * events, once the conversation has taken it in, after the Turn it joins has started and before
   * any boundary placed it: registered before it is submitted, so no placement can come first.
   */
  steering(requestId: string, steer: Steer) {
    this.submitting.set(requestId, steer)
  }

  /** The steer registered under `requestId` was not submitted after all. */
  unsteer(requestId: string) {
    this.submitting.delete(requestId)
  }

  private report(event: Record<string, unknown>) {
    if (this.stopped) return
    // The Hub was never told of this agent (AgentStarted), so it has no agent for any event of it.
    if (this.loop.kind === "agent" && !this.loop.reported) return
    this.options.report(event)
  }

  private get fields() {
    return loopFields(this.loop)
  }

  // ── Batches ─────────────────────────────────────────────────────────────

  private async batch(events: ReadonlyArray<AgentEvent>) {
    const facts: BatchFacts = { submissions: new Map(), entries: new Map() }
    for (const event of events) {
      if (event.type === "submission") facts.submissions.set(event.record.id, event.record)
      if (event.type === "message_end" || event.type === "entry_appended")
        facts.entries.set(event.entry.id, event.entry)
    }
    let ranEnded = false
    for (const [index, event] of events.entries()) {
      switch (event.type) {
        case "snapshot":
          await this.reconcile(event, false)
          break
        case "message_start":
          // Its first partial already holds the text streamed before Pi Durable committed it.
          if (event.message.role === "assistant") {
            this.emitted = new Map()
            this.emitText(event.message.content)
          }
          break
        case "message_update":
          for (const change of event.changes) this.messageChange(change)
          break
        case "message_end":
          this.entry(event.entry)
          break
        case "entry_appended":
          this.entry(event.entry)
          break
        case "tool_execution_start":
          if (event.parentToolCallId === undefined)
            this.toolStarted(event.toolCallId, event.toolName, event.args)
          break
        case "tool_execution_end":
          if (event.parentToolCallId === undefined)
            this.toolEnded(event.toolCallId, event.toolName, event.entry)
          break
        case "submission":
          this.submission(event.record)
          break
        case "usage_changed":
          this.usage = event.usage
          break
        case "compaction_start":
          // A manual one is reported by the Compact command that asked for it, with who did.
          if (event.reason !== "manual")
            this.report({ _tag: "CompactionStarted", ...this.fields, reason: event.reason })
          break
        case "compaction_end":
          await this.compactionEnded(event.taskId, event.error)
          if (this.turn === undefined) this.sendUsage()
          break
        case "run_end": {
          // A run the agent's handoff to itself carries on is the same Turn.
          const next = events.slice(index + 1).find((later) => later.type === "run_start")
          if (next?.type === "run_start" && (await this.continues(next.inputs, facts))) {
            this.carryOn(next.inputs)
            break
          }
          this.endTurn(event.inputs, facts)
          ranEnded = true
          break
        }
        case "run_start":
          if (this.turn?.firstInput === event.inputs[0]) break
          if (this.turn !== undefined) this.endTurn(this.turn.inputs, facts)
          await this.startTurn(event.inputs, facts, false)
          break
        case "task_failed":
          this.options.log(
            `kndl: conversation ${this.conversationId}'s ${event.kind} task failed: ${event.message}`,
          )
          break
        default:
          break
      }
    }
    if (ranEnded) this.sendUsage()
  }

  // ── Turns ───────────────────────────────────────────────────────────────

  /** The entry the input `id` was placed as: from this batch, or from storage. */
  private async inputEntry(
    id: SubmissionId | undefined,
    facts: BatchFacts,
    known: ReadonlyArray<EntryRecord> = [],
  ): Promise<EntryRecord | undefined> {
    if (id === undefined) return undefined
    const { context } = this.options
    const harness = this.options.harness()
    const record =
      facts.submissions.get(id) ?? (await (await harness.submission(id, context))?.status(context))
    const entryId = record?.entry
    if (entryId === undefined) return undefined
    const found = facts.entries.get(entryId) ?? known.find((entry) => entry.id === entryId)
    if (found !== undefined) return found
    const conversation = await harness.conversation(this.conversationId, context)
    const page = await conversation?.entries(
      { minEntryId: entryId, maxEntryId: entryId },
      1,
      undefined,
      context,
    )
    return page?.items[0]
  }

  /**
   * Whether the next run carries the Turn on: the handoff's follow-up is among its inputs, though
   * not first when a steer or an earlier follow-up was queued ahead of it.
   */
  private async continues(inputs: ReadonlyArray<SubmissionId>, facts: BatchFacts) {
    if (this.turn === undefined) return false
    for (const id of inputs)
      if (inputOrigin(await this.inputEntry(id, facts))._tag === "Continue") return true
    return false
  }

  /** The next run carries on the Turn: the same Turn, a new first input. */
  private carryOn(inputs: ReadonlyArray<SubmissionId>) {
    const turn = this.turn
    if (turn === undefined || inputs[0] === undefined) return
    turn.firstInput = inputs[0]
    for (const input of inputs) {
      turn.inputs.add(input)
      // A steer placed with the handoff is read now: no later event of it can say so.
      const promptId = this.steers.get(input)
      if (promptId === undefined) continue
      this.steers.delete(input)
      this.report({ _tag: "SteeredPromptRead", turnId: turn.turnId, ...this.fields, promptId })
    }
    void this.ledger?.recordCurrent(turn.firstInput, [turn.turnId], false, undefined, true)
  }

  private async startTurn(
    inputs: ReadonlyArray<SubmissionId>,
    facts: BatchFacts,
    resumed: boolean,
    known: ReadonlyArray<EntryRecord> = [],
  ) {
    const first = inputs[0]
    if (first === undefined) return
    const turnId = this.options.newId()
    this.turn = {
      turnId,
      startedAt: this.options.now(),
      firstInput: first,
      inputs: new Set(inputs),
      requests: [],
      calls: new Map(),
      started: new Set(),
    }
    this.emitted = new Map()
    const entry = await this.inputEntry(first, facts, known)
    // A startup snapshot's committed entries belong to the old process's Turn, not this one.
    const last = known.at(-1)?.id ?? entry?.id
    if (last !== undefined) this.turn.lastEntry = last
    await this.ledger?.recordCurrent(first, [turnId], resumed, entry?.id)
    if (this.loop.kind === "agent") return this.agentStatus("Running")
    const origin: InputOrigin = resumed ? { _tag: "Other" } : inputOrigin(entry)
    // The handoff's follow-up is the agent's own, with no sender and nothing to say: when it
    // starts a Turn (the run before it failed), that Turn takes the work up where it was left.
    const continued = resumed || origin._tag === "Continue"
    this.report({
      _tag: "TurnStarted",
      turnId,
      ...this.fields,
      text: continued ? "" : inputText(entry),
      sender: continued
        ? { _tag: "Resumed" }
        : origin._tag === "Prompt"
          ? { _tag: "FromParticipant", participant: origin.sender }
          : origin._tag === "AgentResult"
            ? { _tag: "FromAgent", agentId: origin.agentId }
            : origin._tag === "Answer" && origin.sender !== undefined
              ? { _tag: "FromParticipant", participant: origin.sender }
              : { _tag: "FromTerminal" },
      ...(origin._tag === "Prompt" && { promptId: origin.promptId }),
      ...(origin._tag === "Prompt" &&
        origin.attachments !== undefined && { attachments: origin.attachments }),
    })
  }

  private endTurn(inputs: Iterable<SubmissionId>, facts: BatchFacts) {
    const turn = this.turn
    if (turn === undefined) return
    this.turn = undefined
    this.emitted = new Map()
    const settled = [...inputs, ...turn.inputs]
      .map((id) => facts.submissions.get(id))
      .filter((record) => record !== undefined)
    const aborted = settled.some(
      (record) => record.status === "unanswered" && record.reason === "aborted",
    )
    const failure = settled.find(
      (record) =>
        record.status === "unanswered" && record.reason !== "aborted" && record.reason !== "reset",
    )
    const answer = settled.find((record) => record.status === "done")?.answer
    const last = turn.requests.at(-1)
    const reason =
      failure !== undefined && !aborted ? "error" : turnEndReason(aborted, last?.stopReason)
    const detail = failure?.status === "unanswered" ? failure.detail : undefined
    const errorMessage =
      reason === "error"
        ? turnErrorMessage(
            last?.errorMessage ??
              (typeof detail === "string"
                ? detail
                : failure?.status === "unanswered"
                  ? failure.reason
                  : undefined),
            this.options.secrets,
          )
        : undefined
    const usage = turnUsage(turn.requests)
    this.report({
      _tag: "TurnEnded",
      turnId: turn.turnId,
      ...this.fields,
      reason,
      durationMs: Math.max(0, Math.round(this.options.now() - turn.startedAt)),
      ...(usage === undefined ? {} : { usage }),
      ...(errorMessage === undefined ? {} : { errorMessage }),
    })
    // The steers this Turn read are done with. One it didn't read stays tracked: the next run
    // places it, or, if a stop withdrew it, Stopping.ts kept it in the conversation, unread, for
    // the model to read with the next prompt.
    for (const id of this.steers.keys()) if (turn.inputs.has(id)) this.steers.delete(id)
    void this.ledger?.recordEnd(answer, turn.lastEntry)
    if (reason === "error") void this.placeQueued(turn.turnId)
    void this.settled()
    if (this.loop.kind === "agent") void this.agentStatus(aborted ? "Stopped" : "Done")
  }

  /**
   * Tells the Models the conversation's run settled, whatever ended it, so a Claude Code query
   * they hold for it is stopped. Not while a run is going: one that took over at the end of the
   * last (a queued follow-up) says so itself when it ends, and its query is its own.
   */
  private async settled() {
    const { context } = this.options
    const harness = this.options.harness()
    try {
      if ((await harness.snapshot(LiveDoc, this.conversationId, context))?.run !== undefined) return
      const provider = await harness.snapshot(ProviderDoc, this.conversationId, context)
      if (provider !== undefined) this.options.runSettled(provider.sessionId)
    } catch (error) {
      this.options.log(
        `kndl: couldn't tell the Models a run of ${this.conversationId} ended: ${error}`,
      )
    }
  }

  /**
   * Pi Durable leaves what was queued behind a failed run in the inbox until the next input
   * places it, which may never come: an agent's result or a prompt would wait unread. A write
   * that changes nothing the model sees asks for the boundary now, and the oldest follow-up
   * starts the next run.
   */
  private async placeQueued(turnId: string) {
    const { context } = this.options
    const harness = this.options.harness()
    try {
      if ((await harness.snapshot(LiveDoc, this.conversationId, context))?.run !== undefined) return
      const inbox = await harness.snapshot(InboxDoc, this.conversationId, context)
      if (inbox === undefined || inbox.items.length === 0) return
      const conversation = await harness.conversation(this.conversationId, context)
      await conversation?.submit(
        {
          type: "write",
          entry: { kind: NudgeEntry, data: {}, model: [] },
          requestId: `${NudgeEntry}:${turnId}`,
        },
        context,
      )
    } catch (error) {
      this.options.log(`kndl: couldn't place what is queued in ${this.conversationId}: ${error}`)
    }
  }

  /** A subagent's status, as the Hub and `kndl.agents` keep it. */
  private async agentStatus(status: "Running" | "Done" | "Stopped") {
    if (this.loop.kind !== "agent") return
    const { agentId } = this.loop
    this.report({ _tag: "AgentStatusChanged", agentId, status })
    await recordAgentStatus(this.options, agentId, status)
  }

  /**
   * Squares what was reported with a snapshot: at attachment, where a run still going is a
   * Turn resumed (or one never reported, reported now), and after the stream fell behind.
   */
  private async reconcile(snapshot: SnapshotEvent, initial: boolean, startup = false) {
    this.usage = snapshot.usage
    if (initial) this.usageSent = JSON.stringify(conversationUsage(snapshot.usage))
    const facts: BatchFacts = { submissions: new Map(), entries: new Map() }
    const run = snapshot.run
    const turn = this.turn
    const changed = turn !== undefined && (run === undefined || run.inputs[0] !== turn.firstInput)
    let answer: EntryId | undefined
    let next: EntryId | undefined
    if (changed) {
      // The snapshot has no settlements: read them or an abort/failure looks like an answer.
      const harness = this.options.harness()
      for (const id of turn.inputs) {
        const record = await (
          await harness.submission(id, this.options.context)
        )?.status(this.options.context)
        if (record !== undefined) facts.submissions.set(id, record)
        if (record?.status === "done" && record.answer !== undefined) answer = record.answer
      }
      next = (await this.inputEntry(run?.inputs[0], facts, snapshot.entries))?.id
    }
    // Never attribute a successor's committed answers/tools to the Turn the snapshot ended.
    this.recoverEntries(
      snapshot.entries.filter(
        (entry) =>
          (answer === undefined || entry.id <= answer) && (next === undefined || entry.id < next),
      ),
    )
    if (changed) {
      this.endTurn(turn.inputs, facts)
      this.sendUsage()
    }
    if (run !== undefined && this.turn === undefined) {
      // A subagent running again after a restart is Running again: the Hub marked it Interrupted.
      const resumed = initial && ((await this.ledger?.reportedBefore(run.inputs[0])) ?? true)
      await this.startTurn(run.inputs, facts, resumed, initial ? snapshot.entries : [])
      if (!initial) this.recoverEntries(snapshot.entries)
    }
    if (initial && run === undefined) await this.ledger?.settleCurrent()
    if (startup && run === undefined && this.loop.kind === "agent")
      await this.settleAgent(this.loop.agentId)
    // What the in-flight message says already, which this reporter may not have reported.
    const partial = snapshot.generation?.message
    if (partial !== undefined && this.turn !== undefined) this.emitText(partial.content)
    for (const slot of snapshot.tools)
      if (
        slot.status === "running" &&
        this.turn !== undefined &&
        !this.turn.started.has(slot.callId)
      ) {
        // A model-issued slot doesn't carry arguments; they live in its assistant entry.
        const call = snapshot.entries
          .flatMap((entry) => {
            const message = entry.model?.[0]
            return message?.role === "assistant" ? message.content : []
          })
          .find((block) => block.type === "toolCall" && block.id === slot.callId)
        this.toolStarted(slot.callId, slot.name, call?.type === "toolCall" ? call.arguments : {})
      }
  }

  /** Replay the committed requests/tool rounds an overflow hid, once in entry order. */
  private recoverEntries(entries: ReadonlyArray<EntryRecord>) {
    const turn = this.turn
    if (turn === undefined) return
    for (const entry of entries) {
      if (entry.id <= (turn.lastEntry ?? 0)) continue
      const message = entry.model?.[0]
      if (message?.role === "toolResult")
        this.toolEnded(message.toolCallId, message.toolName, entry)
      this.entry(entry)
    }
  }

  /** A subagent found idle at a restart whose last run ended unreported is Done. */
  private async settleAgent(agentId: string) {
    if (await isRecordedRunning(this.options, agentId)) await this.agentStatus("Done")
  }

  // ── Within a Turn ───────────────────────────────────────────────────────

  private messageChange(change: MessageChange) {
    if (this.turn === undefined) return
    switch (change.type) {
      case "text_start":
        this.emitted.set(change.contentIndex, "")
        if (change.block.type === "text") this.emitBlock(change.contentIndex, change.block.text)
        return
      case "text_delta":
        this.emitted.set(
          change.contentIndex,
          (this.emitted.get(change.contentIndex) ?? "") + change.delta,
        )
        this.textDelta(change.delta)
        return
      case "block":
        if (change.block.type === "text") this.emitBlock(change.contentIndex, change.block.text)
        return
      case "message":
        this.emitText(change.message.content)
        return
      default:
        return
    }
  }

  /** Reports what of a text block the Hub doesn't have yet. */
  private emitBlock(index: number, text: string) {
    const sent = this.emitted.get(index) ?? ""
    if (text.length <= sent.length || !text.startsWith(sent)) return
    this.emitted.set(index, text)
    this.textDelta(text.slice(sent.length))
  }

  private emitText(content: unknown) {
    for (const [index, text] of textBlocks(content)) this.emitBlock(index, text)
  }

  private textDelta(text: string) {
    const turn = this.turn
    if (turn === undefined || text === "") return
    this.report({ _tag: "TextDelta", turnId: turn.turnId, ...this.fields, text })
  }

  private entry(entry: EntryRecord) {
    const turn = this.turn
    if (turn === undefined) return
    const message = entry.model?.[0]
    if (message?.role === "assistant") {
      this.emitText(message.content)
      this.emitted = new Map()
      const end = assistantEnd(entry)
      if (end !== undefined) turn.requests.push(end)
      for (const block of message.content)
        if (block.type === "toolCall") turn.calls.set(block.id, block.arguments)
    }
    if (entry.model !== undefined && entry.model.length > 0) turn.lastEntry = entry.id
  }

  private toolStarted(toolCallId: string, tool: string, args: unknown) {
    const turn = this.turn
    if (turn === undefined || turn.started.has(toolCallId)) return
    turn.started.add(toolCallId)
    this.report({
      _tag: "ToolCallStarted",
      turnId: turn.turnId,
      ...this.fields,
      toolCallId,
      tool,
      input: clip(JSON.stringify(args ?? {}) ?? ""),
    })
  }

  private toolEnded(toolCallId: string, tool: string, entry: EntryRecord | undefined) {
    const turn = this.turn
    if (turn === undefined) return
    // One that never ran (not offered, invalid, blocked) ends without a start: it starts here.
    if (!turn.started.has(toolCallId))
      this.toolStarted(toolCallId, tool, turn.calls.get(toolCallId))
    const message = entry?.model?.[0]
    const result = message?.role === "toolResult" ? message : undefined
    this.report({
      _tag: "ToolCallEnded",
      turnId: turn.turnId,
      ...this.fields,
      toolCallId,
      tool,
      outcome: result === undefined || result.isError ? "Failed" : "Succeeded",
      output: result === undefined ? "" : toolResultSummary(result.content),
    })
  }

  private submission(record: SubmissionRecord) {
    const turn = this.turn
    const steer = record.requestId === undefined ? undefined : this.submitting.get(record.requestId)
    if (steer !== undefined && record.requestId !== undefined) {
      this.submitting.delete(record.requestId)
      this.steers.set(record.id, steer.promptId)
      // One that found no Turn running starts the next, which the Hub hears of instead.
      if (turn !== undefined && turn.firstInput !== record.id)
        this.report({
          _tag: "PromptSteered",
          turnId: turn.turnId,
          ...this.fields,
          promptId: steer.promptId,
          text: steer.text,
          sender: steer.sender,
          ...(steer.attachments === undefined || steer.attachments.length === 0
            ? {}
            : { attachments: steer.attachments }),
        })
    }
    const promptId = this.steers.get(record.id)
    if (promptId === undefined) return
    if (record.status === "queued") return
    this.steers.delete(record.id)
    if (record.status !== "placed" || turn === undefined || turn.firstInput === record.id) return
    turn.inputs.add(record.id)
    this.report({
      _tag: "SteeredPromptRead",
      turnId: turn.turnId,
      ...this.fields,
      promptId,
    })
  }

  // ── Compaction and usage ────────────────────────────────────────────────

  /** How a compaction ended: its summary, nothing to compact, or why it failed. */
  private async compactionEnded(taskId: TaskId, error: string | undefined) {
    if (error !== undefined) {
      this.report({
        _tag: "CompactionEnded",
        ...this.fields,
        outcome: "failed",
        error: clip(turnErrorMessage(error, this.options.secrets) ?? "It failed.", 2_000),
      })
      return
    }
    const summary = await compactionSummary(this.options, this.conversationId, taskId).catch(
      () => undefined,
    )
    this.report({
      _tag: "CompactionEnded",
      ...this.fields,
      outcome: summary === undefined ? "skipped" : "compacted",
      ...(summary === undefined || summary === "" ? {} : { summary: clip(summary) }),
    })
  }

  /** The conversation's running total, once it changed since it was last sent. */
  private sendUsage() {
    if (this.usage === undefined) return
    const usage = conversationUsage(this.usage)
    const said = JSON.stringify(usage)
    if (said === this.usageSent) return
    this.usageSent = said
    this.report({ _tag: "UsageChanged", ...this.fields, usage })
  }
}

/** Every conversation's reporter, by conversation. */
export class Loops {
  private readonly reporters = new Map<ConversationId, LoopReporter>()
  private readonly attaching = new Map<ConversationId, Promise<LoopReporter>>()

  constructor(private readonly options: LoopsOptions) {}

  /**
   * Follows a conversation, once: attached already, it is left as it is. `startup` says the agent
   * is starting, and finds the conversation as the last process left it.
   */
  attach(conversationId: ConversationId, loop: Loop, startup = false): Promise<LoopReporter> {
    const known = this.attaching.get(conversationId)
    if (known !== undefined) return known
    const reporter = new LoopReporter(conversationId, loop, this.options)
    const attached = reporter.attach(startup).then(() => {
      this.reporters.set(conversationId, reporter)
      return reporter
    })
    this.attaching.set(conversationId, attached)
    attached.catch((error: unknown) => {
      this.attaching.delete(conversationId)
      this.options.log(`kndl: couldn't follow conversation ${conversationId}: ${error}`)
    })
    return attached
  }

  get(conversationId: ConversationId): LoopReporter | undefined {
    return this.reporters.get(conversationId)
  }

  /** The loop a conversation is, if the agent follows it. */
  loopOf(conversationId: ConversationId): Loop | undefined {
    return this.reporters.get(conversationId)?.loop
  }

  async stop() {
    await Promise.all([...this.reporters.values()].map((reporter) => reporter.stop()))
  }
}
