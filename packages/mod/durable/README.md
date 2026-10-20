# The durable agent (experimental)

The headless Node runtime for the spike in [`docs/design/durable-harness.md`](../../../docs/design/durable-harness.md), pinned to Pi Durable / pi-ai **1.3.0**. `src/agent.ts` opens `$KNDL_STATE_DIR/durable/session.sqlite`; one process must own that database. The Runner starts it in its own tmux session beside the Session's shell; [`docs/design/durable-testing.md`](../../../docs/design/durable-testing.md) covers trying the whole spike locally.

## Checking it

From the repository root:

```sh
bun run --filter @kndl/mod typecheck:durable
bun run --filter @kndl/mod test:durable
bun run mod:build
bunx oxlint --deny-warnings packages/mod/durable
```

The standalone durable typecheck isolates this runtime from unrelated workspace tests/imports. Run the full mod/workspace checks separately when integrating the Runner and Hub changes.

The suite uses scripted models, not paid requests:

- `src/*.spec.ts`, `src/hub/*.spec.ts`: the runtime over temporary SQLite databases and an HTTP fake Hub; tools really run. Includes main/thread concurrency, Plan forks, steering, subagents, questions, Gateway requests, deferred MCP discovery, compaction and handoff.
- `test/agent.e2e.spec.ts`: builds and starts the real bundle under Node, then sends SIGTERM and SIGKILL. Covers interrupted unsafe commands; simultaneous main/thread recovery while another thread finishes; and a background subagent interrupted inside code mode. The journal test checks that a finished nested shell command is not repeated after SIGKILL. This is not a real-Hub or real-provider test. It skips when Node's SQLite support is unavailable (Node 22.19+ required); CI installs Node 24.22.0, the version a Runner pins for Sessions, so it runs there.
- `src/claude/*.spec.ts`: the Claude bridge with scripted Claude Code queries. Its real subscription test is **opt-in**, `KNDL_CLAUDE_IT=1`, and needs the credentials and pinned binary described in `src/claude/Live.spec.ts`. A default green suite does not establish real-Claude end-to-end compatibility.

## Recovery contract

**Durable admission is not durable delivery of web events.** These are different boundaries:

| Boundary | Current behavior |
| --- | --- |
| Input admitted to SQLite | A repeated prompt `requestId` finds the same submission. Main prompts, steers and thread prompts return `PromptAlreadySubmitted` on redelivery. The Hub must consume that receipt by prompt id, including for pending thread prompts. |
| Process dies during a run | The run resumes under a new `TurnStarted` with sender `Resumed`; threads retain their routing, and agent events retain only their `agentId`, never their parent's `threadId`. An agent's result goes to the conversation that started it, including a thread. |
| Process dies during a tool | Replay-safe tools reattach/replay according to Pi Durable's policy. Unsafe tools such as shell/MCP calls return an interrupted result; external side effects may already have happened. Exactly-once external effects are **not** promised. Code mode journals completed nested calls instead of repeating them. |
| Question answered, sync result not yet committed | The accepted answer receipt remains in SQLite, so replay returns that answer instead of asking again. |
| Question answered async, input not yet admitted | Startup drains the accepted-answer receipt using `answer:<toolCallId>`. A crash after admission but before acknowledgement finds the same input, not a second answer. Closed receipts are retained, so their storage grows with the Session. |
| Run settled, Turn's end bookkeeping interrupted | Startup reconciles a lingering `kndl.turns.current` from its submission's durable settlement, repairing the answer's fork anchor. A running Turn forks at its newest **committed** entry, not at its in-flight partial. |
| Consumer falls behind | Pi Durable replaces buffered events with a snapshot. The reporter recovers available committed text/tool entries and consults durable submission outcomes instead of treating an abort as an answer. It does not reconstruct every intermediate run or history removed from the active snapshot by compaction/reset. |
| Plan committed but its report lost | Startup republishes the absolute Plan, including an empty/cleared Plan, for each known conversation. |
| Events queued/sent to the Hub | **Volatile.** HubLink has an in-memory outbox and no persisted acknowledgement cursor or event id shared with the Hub. SIGTERM drains best-effort; SIGKILL may lose queued transcript events. A lost HTTP response may also cause a repeated batch. |

In particular, `recordCurrent` can commit before `TurnStarted` reaches the Hub, and `recordEnd` can clear `current` before the Hub acknowledges `TurnEnded`. If an entire run settled in SQLite but its events were lost, startup does **not** replay its web transcript. Redelivery clears its queued prompt using the admission receipt, but its answer can remain visible only in SQLite/history rather than the web transcript. `Loops.spec.ts` explicitly characterizes this limitation by refusing event posts, discarding the volatile outbox, reopening SQLite, and checking both the receipt and the absent replay. Fixing this fully needs a persisted event outbox plus Hub-side event/batch idempotency (or an authoritative snapshot/reconciliation protocol), not simply replaying text deltas and duplicating answers already displayed.

## Other draft limitations

- Questions are main-loop only. Threads/subagents have no question tool; subagents cannot spawn agents. Background agents deliberately survive their parent's stop; a foreground `wait: true` call cascades a stop to its child. Shutdown preserves work rather than treating it as a user stop.
- MCP discovery is now bounded and awaited **before** hello/command polling or recovery can enable scheduling. This avoids a first `tool_search` seeing an empty catalogue, or a recovered script journaling `tool_unavailable` merely because its server's tools weren't installed yet. Unreachable servers are logged and omitted for that process; automatic discovery retry, dynamic server-list changes, and collision-resistant names for long/sanitized MCP tool names are not implemented.
- Code mode and Photon image processing have explicit logged fallbacks if their optional modules cannot load. Missing code mode means the tool is absent, not an emulated script executor. Runtime installation must include the pinned packages.
- The Plan is returned in `update_plan` results and carried in handoff notes, not continuously rewritten into the system prompt: a Claude bridge query held across tool rounds would not see such a prompt rewrite. Root thinking-level changes from the Runner are reapplied on reopen even when the model is unchanged.
- Prompt admissions have request ids. Administrative commands and participant messages to agents do not all have durable command ids; replaying those commands is not an exactly-once protocol. A failed prompt admission is reported as `PromptFailed` because HubLink advances its command sequence even if a handler throws; one cut off by the agent's own shutdown is thrown instead, which HubLink (no longer polling) leaves unacknowledged for the next start, where its request id makes it run once.
- Agent creation/status, question/compaction notifications and usage also use the volatile event link. Durable tasks/state survive, but the corresponding historical web notifications are not all reconstructible. Usage totals are absolute and reported on subsequent run/compaction completion; startup alone does not replay every ledger update. Storage-failure exit behavior follows Pi Durable's fatal `closed` contract, but this suite does not fault-inject every SQLite failure or host/power failure. SQLite WAL `synchronous=NORMAL` is process-crash durability, not a guarantee against loss of the newest writes on power failure.
