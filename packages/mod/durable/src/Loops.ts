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
// run the agent reported is kept in `kndl.turns`, so a run that started but never reached the Hub
// is reported as itself. A stream that falls far behind gets a snapshot instead of its events,
// which the reporter reconciles with what it reported.

import type { Context } from "@earendil-works/chord"
import { InboxDoc, watchEvents } from "@earendil-works/pi-durable"
import type {
  AgentEvent,
  AgentEventStream,
  ConversationId,
  EntryId,
  EntryRecord,
  Harness,
  MessageChange,
  SnapshotEvent,
  SubmissionId,
  SubmissionRecord,
  TaskId,
  UsageState,
} from "@earendil-works/pi-durable"
import { clip, isRecord } from "../../src/HubMessages.ts"
import { AgentsDoc, TurnsDoc } from "./Docs.ts"
import { contentText, inputOrigin, inputText } from "./Inputs.ts"
import type { InputOrigin } from "./Inputs.ts"
import type { AssistantEnd } from "./Turns.ts"
import {
  conversationUsage,
  toolResultSummary,
  turnEndReason,
  turnErrorMessage,
  turnUsage,
} from "./Turns.ts"

/** Whose a conversation is, as the Hub tells them apart. */
export type Loop =
  | { readonly kind: "main" }
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "agent"; readonly agentId: string; readonly reported: boolean }

/** What every event of a loop carries of whose it is. */
export const loopFields = (loop: Loop): { threadId?: string; agentId?: string } =>
  loop.kind === "thread"
    ? { threadId: loop.threadId }
    : loop.kind === "agent"
      ? { agentId: loop.agentId }
      : {}

export interface LoopsOptions {
  /** The open Harness. */
  readonly harness: () => Harness
  readonly report: (event: Record<string, unknown>) => void
  readonly newId: () => string
  /** Milliseconds, for a Turn's duration. */
  readonly now: () => number
  /** What must never reach the Hub in an error's message. */
  readonly secrets: ReadonlyArray<string>
  readonly log: (text: string) => void
  /** The agent's lifetime: cancelled as it shuts down. */
  readonly context: Context
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
  /** Queued steers the Hub was told of, until a boundary places them. */
  private readonly steers = new Map<SubmissionId, string>()
  private usage: UsageState | undefined
  private usageSent = ""
  private stopped = false

  constructor(
    readonly conversationId: ConversationId,
    readonly loop: Loop,
    private readonly options: LoopsOptions,
  ) {}

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

  /** A steer the Hub was told of: its placement is reported as read. */
  steered(submissionId: SubmissionId, promptId: string) {
    this.steers.set(submissionId, promptId)
  }

  private report(event: Record<string, unknown>) {
    if (!this.stopped) this.options.report(event)
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
          if (event.message.role === "assistant") this.emitted = new Map()
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

  private async continues(inputs: ReadonlyArray<SubmissionId>, facts: BatchFacts) {
    if (this.turn === undefined) return false
    return inputOrigin(await this.inputEntry(inputs[0], facts))._tag === "Continue"
  }

  /** The next run carries on the Turn: the same Turn, a new first input. */
  private carryOn(inputs: ReadonlyArray<SubmissionId>) {
    const turn = this.turn
    if (turn === undefined || inputs[0] === undefined) return
    turn.firstInput = inputs[0]
    for (const input of inputs) turn.inputs.add(input)
    void this.recordCurrent(turn.firstInput, [turn.turnId], false)
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
    const entry = resumed ? undefined : await this.inputEntry(first, facts, known)
    await this.recordCurrent(first, [turnId], resumed, entry?.id)
    if (this.loop.kind === "agent") return this.agentStatus("Running")
    const origin: InputOrigin = resumed ? { _tag: "Other" } : inputOrigin(entry)
    this.report({
      _tag: "TurnStarted",
      turnId,
      ...this.fields,
      text: resumed ? "" : inputText(entry),
      sender: resumed
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

  /** Keeps which run the agent reported, so a restart knows it (`kndl.turns`). */
  private async recordCurrent(
    input: SubmissionId,
    turnIds: ReadonlyArray<string>,
    resumed: boolean,
    entry?: EntryId,
  ) {
    if (this.loop.kind === "agent") return
    const { context } = this.options
    const harness = this.options.harness()
    try {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(TurnsDoc, this.conversationId)
        const earlier = resumed && doc.current?.input === input ? doc.current.turnIds : []
        doc.current = { input, turnIds: [...earlier, ...turnIds] }
        for (const turnId of turnIds) {
          const record = (doc.turns[turnId] ??= {})
          if (entry !== undefined) record.entry = entry
        }
        // A resumed Turn anchors where the Turn it goes on from does.
        const from = earlier[0] === undefined ? undefined : doc.turns[earlier[0]]?.entry
        if (from !== undefined) for (const turnId of turnIds) doc.turns[turnId] = { entry: from }
      }, context)
    } catch (error) {
      this.options.log(`kndl: couldn't record a Turn of ${this.conversationId}: ${error}`)
    }
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
    // Left unread, a steer stays in the conversation, and the model reads it in the next run.
    for (const id of this.steers.keys()) if (turn.inputs.has(id)) this.steers.delete(id)
    void this.recordEnd(answer, turn.lastEntry)
    if (this.loop.kind === "agent") void this.agentStatus(aborted ? "Stopped" : "Done")
  }

  /** The Turn's answer, or its last entry, for a thread forked at it. */
  private async recordEnd(answer: EntryId | undefined, last: EntryId | undefined) {
    if (this.loop.kind === "agent") return
    const { context } = this.options
    const harness = this.options.harness()
    try {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(TurnsDoc, this.conversationId)
        for (const turnId of doc.current?.turnIds ?? []) {
          const record = (doc.turns[turnId] ??= {})
          if (answer !== undefined) record.answer = answer
          if (last !== undefined) record.last = last
        }
        delete doc.current
      }, context)
    } catch (error) {
      this.options.log(`kndl: couldn't record a Turn's end in ${this.conversationId}: ${error}`)
    }
  }

  /** A subagent's status, as the Hub and `kndl.agents` keep it. */
  private async agentStatus(status: "Running" | "Done" | "Stopped") {
    if (this.loop.kind !== "agent") return
    const { agentId, reported } = this.loop
    if (reported) this.report({ _tag: "AgentStatusChanged", agentId, status })
    const { context } = this.options
    const harness = this.options.harness()
    try {
      await harness.commit(async (tx) => {
        const agent = (await tx.doc(AgentsDoc)).agents[agentId]
        if (agent !== undefined) agent.status = status
      }, context)
    } catch (error) {
      this.options.log(`kndl: couldn't record agent ${agentId}'s status: ${error}`)
    }
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
    if (turn !== undefined && (run === undefined || run.inputs[0] !== turn.firstInput)) {
      // Its end was in the batches the snapshot replaced: say how it ended, as far as it shows.
      for (const entry of snapshot.entries) {
        if (entry.id <= (turn.lastEntry ?? 0)) continue
        const end = assistantEnd(entry)
        if (end !== undefined) {
          turn.requests.push(end)
          turn.lastEntry = entry.id
        }
      }
      this.endTurn([], facts)
      this.sendUsage()
    }
    if (run !== undefined && this.turn === undefined) {
      // A subagent running again after a restart is Running again: the Hub marked it Interrupted.
      const resumed = initial && (await this.reportedBefore(run.inputs[0]))
      await this.startTurn(run.inputs, facts, resumed, snapshot.entries)
    }
    if (startup && run === undefined && this.loop.kind === "agent") await this.settleAgent()
    // What the in-flight message says already, which this reporter may not have reported.
    const partial = snapshot.generation?.message
    if (partial !== undefined && this.turn !== undefined) this.emitText(partial.content)
    for (const slot of snapshot.tools)
      if (
        slot.status === "running" &&
        this.turn !== undefined &&
        !this.turn.started.has(slot.callId)
      )
        this.toolStarted(slot.callId, slot.name, {})
  }

  /** Whether the agent reported the run starting with `input` before it restarted. */
  private async reportedBefore(input: SubmissionId | undefined) {
    if (input === undefined || this.loop.kind === "agent") return true
    const { context } = this.options
    const harness = this.options.harness()
    const doc = await harness.snapshot(TurnsDoc, this.conversationId, context)
    return doc?.current?.input === input
  }

  /** A subagent found idle at a restart whose last run ended unreported is Done. */
  private async settleAgent() {
    if (this.loop.kind !== "agent") return
    const { context } = this.options
    const harness = this.options.harness()
    const record = (await harness.snapshot(AgentsDoc, context))?.agents[this.loop.agentId]
    if (record?.status === "Running") await this.agentStatus("Done")
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
    const summary = await this.summaryOf(taskId).catch(() => undefined)
    this.report({
      _tag: "CompactionEnded",
      ...this.fields,
      outcome: summary === undefined ? "skipped" : "compacted",
      ...(summary === undefined || summary === "" ? {} : { summary: clip(summary) }),
    })
  }

  /** The summary a compaction made, wherever it is now; undefined when it made none. */
  private async summaryOf(taskId: TaskId): Promise<string | undefined> {
    const { context } = this.options
    const harness = this.options.harness()
    const task = await harness.getTask(taskId, context)
    const outcome = task?.state.status === "terminal" ? task.state.outcome : undefined
    const result =
      outcome?.status === "completed" && isRecord(outcome.result) ? outcome.result : undefined
    if (result === undefined) return undefined
    const conversation = await harness.conversation(this.conversationId, context)
    const entryText = async (id: unknown) => {
      if (typeof id !== "number" || conversation === undefined) return undefined
      const page = await conversation.entries(
        { minEntryId: id as EntryId, maxEntryId: id as EntryId },
        1,
        undefined,
        context,
      )
      return contentText(page.items[0]?.model?.[0]?.content)
    }
    if (result.entryId !== undefined) return (await entryText(result.entryId)) ?? ""
    if (typeof result.submissionId !== "number") return undefined
    const placed = await (
      await harness.submission(result.submissionId as SubmissionId, context)
    )?.status(context)
    if (placed?.entry !== undefined) return (await entryText(placed.entry)) ?? ""
    // Still queued, for the next boundary: its entry waits in the inbox.
    const inbox = await harness.snapshot(InboxDoc, this.conversationId, context)
    const item = inbox?.items.find((each) => each.id === result.submissionId)
    const draft = item?.mode === "write" ? item.entry : undefined
    const model = isRecord(draft) && Array.isArray(draft.model) ? draft.model[0] : undefined
    return isRecord(model) ? contentText(model.content) : ""
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

  /** The main loop's reporter, once attached. */
  get main(): LoopReporter | undefined {
    for (const reporter of this.reporters.values())
      if (reporter.loop.kind === "main") return reporter
    return undefined
  }

  /** The thread's conversation, if the agent follows it. */
  thread(threadId: string): LoopReporter | undefined {
    for (const reporter of this.reporters.values())
      if (reporter.loop.kind === "thread" && reporter.loop.threadId === threadId) return reporter
    return undefined
  }

  async stop() {
    await Promise.all([...this.reporters.values()].map((reporter) => reporter.stop()))
  }
}
