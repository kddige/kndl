# Pi Durable as kndl's only Harness: the spike's design

> **A spike.** This replaces ADR 0029's pi coding agent and ADR 0030's Claude Code Harness with one agent built on `@earendil-works/pi-durable`, on a draft PR, for testing on a dev machine. It is not a decision yet. If it holds, an ADR supersedes 0029 and 0030.

Everything a Session's agent does now runs in one headless Node process in the Sandbox, **the durable agent** (`packages/mod/durable/`), built on Pi Durable 1.3.0 over the same pi-ai 1.3.0 the Hub already pins. It speaks the mod protocol to the Hub, as the pi extension did, so the Hub and web keep their event log, Prompt queue and transcript. What Pi Durable adds is used, not hidden:

| Pi Durable | What kndl gets |
| --- | --- |
| Tasks with checkpoints, `resume()`, SQLite storage on the Session's volume | A Turn survives its Sandbox sleeping, the agent crashing, or the Runner restarting: it continues where it stopped, reported as resumed. |
| `requestId` on submissions | Exactly-once prompts: a prompt's id is its request id, so a prompt delivered twice is answered once. |
| `fork(entryId)`, many conversations at once | **Threads**: anyone replies in a thread off any answer. A thread is a fork of the main conversation at that answer, runs beside it and beside other threads, and can be on another Model. |
| The inbox: steer, follow-up | Anyone can post into a busy thread; it steers. The main loop keeps the Hub's Prompt queue. |
| Task-owned conversations, background tasks | Subagents that survive a restart, whose results come back as a Turn, and whose stop cascades. |
| Documents, forked `asOf` | **The Plan**: the agent keeps a checklist (`update_plan`), shown live to everyone, per conversation; a thread starts with the Plan as it was at its fork. |
| Background compaction, `compact()`, `reset(note)` | Sessions that never run out of context, a **Compact** button anyone can press, with instructions, and a `handoff` tool the agent can use on itself. |
| Codemode, deferred tools, `tool_search` | MCP servers' tools are deferred and found by search, so a Session with many servers keeps a short tool list; `codemode` scripts call any tool, and survive a restart. |
| `pi.usage` per conversation | Cost per Turn as before, and per thread. |
| Sections rebuilt every request | AGENTS.md, CLAUDE.md and skills are read live: an edit reaches the next request. |

Claude's Models run through **the Claude bridge**, ported from the pi extension to a pi-ai provider (`anthropic`). Claude Code is no longer a Harness, but its pinned binary is still mounted, as the bridge runs it as a model.

**Everyone drives.** For the spike, every Participant who sees a Session can prompt it, steer, stop, answer, switch its Model, message and stop its agents, start and post in threads, compact, and use its terminal. It still spends its Creator's accounts (ADR 0026's billing half stands; its driving half is lifted for testing).

## The process

- **Where:** in the Sandbox, as the pi TUI was, so its tools run in `/workspace` with nothing routed. The Runner starts it with the pinned Node.js: `node /opt/kndl/mod/<copy>/durable/agent.js`, in a second tmux window, `agent`, that the web terminal doesn't show. The first window, the one the terminal mirrors, is a plain `bash -l` in `/workspace`. No TUI: the web is the interface.
- **Storage:** `openNodeSqliteStorage("$KNDL_STATE_DIR/durable/session.sqlite")`, on the Session's persistent volume, so sleep and wake keep everything. One process owns it at a time; the Runner starts at most one.
- **Restart:** the agent opens the storage, installs its extensions, says hello, and calls `harness.resume()`. A run that was going continues. Its Turn was reported ended (`Interrupted`) by the Hub when the process stopped, so the agent reports a new `TurnStarted` with `sender: Resumed`, and the run's events follow under it.
- **Its environment:** as pi's was (`KNDL_URL`, `KNDL_MOD_TOKEN`, `KNDL_SESSION_ID`, `KNDL_MODEL`, `KNDL_THINKING`, `KNDL_MCP_SERVERS`, and the Claude bridge's `CLAUDE_CODE_OAUTH_TOKEN`, `KNDL_CLAUDE_CODE`, `CLAUDE_CONFIG_DIR`), with `KNDL_HARNESS=Pi`.
- **Exit:** a fatal error (`harness.closed` with `failed`) exits non-zero; the Runner sees the window die and reports the Harness stopped, as it does today.

## Conversations

- **Main loop:** `harness.root()`. Its Turns have no `threadId` or `agentId`, as today.
- **Threads:** ownerless forks of the root, `root.fork(entryId)`. Each has a `ThreadId` the Hub mints. The agent keeps `kndl.threads` (a Session-scope document): `threadId → { conversationId, anchorTurnId, title }`.
- **Subagents:** conversations owned by a background anchor task of the conversation that started them (Pi Durable's example 23), with a reporter task per message. `kndl.agents` (conversation-scope) keeps `agentId → { conversationId, description, model, reported }`.
- **Turns ↔ entries:** `kndl.turns` (conversation-scope) maps each Turn the agent reported to its user entry and final answer entry, so a thread can fork at a Turn's answer, and a resumed run finds its Turn.

## The protocol, version 5

The contract is code: `packages/protocol/src/Thread.ts`, and the `threadId`s, `Resumed` and new members in `Turn.ts`, `Mod.ts` and `Web.ts`. The version bump makes a peer of version 4 say it must update.

**Ids:** `ThreadId`, minted by the Hub.

**Turn events, mod to Hub (logged):**

- `TurnStarted`, `TextDelta`, `ToolCallStarted`, `ToolCallEnded`, `TurnEnded`, `PromptSteered`, `SteeredPromptRead` and `AgentStarted` have an optional `threadId`. Without one, the event is the main loop's, or its subagents' (by `agentId`, as today). A `TurnStarted`/`TurnEnded` with a `threadId` starts or ends that thread's Turn and leaves the Session's `currentTurn` alone.
- `PromptSender` has `Resumed {}`: a run the agent continued after it restarted.
- `CompactionStarted { threadId?, agentId?, reason, by? }`, `CompactionEnded { threadId?, agentId?, outcome, summary?, error? }`.
- `PlanChanged { threadId?, agentId?, plan }`.
- `UsageChanged { threadId?, agentId?, usage }`: a conversation's running total, sent once a Turn ends.
- `ModelSwitchFailed` has an optional `threadId`.
- `ModHello` has `durable: true`.

**Session events the Hub logs itself:** `ThreadStarted { threadId, anchorTurnId, title, startedBy, model?, thinkingLevel? }`, `ThreadPromptSent { threadId, promptId, sender, text, attachments? }` (shown as sent until the agent's `TurnStarted` or `PromptSteered` with that `promptId`), `ThreadModelChanged { threadId, by, model, thinkingLevel? }`, and `TurnStopRequested` with an optional `threadId`.

**Commands, Hub to mod:** `StartThread { threadId, anchorTurnId, promptId, text, sender, attachments?, model?, thinkingLevel? }`, `DeliverThreadPrompt { threadId, promptId, text, sender, attachments? }` (steers a busy thread, else starts a Turn; `requestId: promptId`), `StopThread`, `SwitchThreadModel`, `Compact { threadId?, instructions?, sender }`.

**Web to Hub** (`ThreadCommand`): `CreateThread { sessionId, anchorTurnId, text, attachments?, model?, thinkingLevel? }`, `PromptThread`, `StopThread`, `SetThreadModel`, `CompactConversation`. Any Participant with access. The Hub mints the ids, logs what it logs, wakes an Asleep Session, and queues the mod command; thread commands not yet delivered when the Harness restarts are delivered again after its hello, which `requestId` makes safe.

**Hub to web** (`ThreadMessage`): `ThreadCreated { sessionId, threadId }` to the creator of a thread, and `SessionModels { sessionId, models }` to everyone who joins a Session: its Creator's Models, so anyone can switch it.

**`SessionSummary.threads`:** `ThreadSummary { id, title, anchorTurnId, startedBy, running, model?, thinkingLevel? }`, oldest first. A running thread keeps the Session from going to sleep for being idle, as a Turn does. When the Harness stops, the Hub ends each running thread's Turn as `aborted`, as it does the main loop's; the agent's restart reports `Resumed` Turns for those it continues.

## The agent's tools

- **Coding:** `read`, `write`, `edit`, `bash` (`createCodingTools({ images })`), on a `NodeExecutionEnv` in `/workspace`.
- **Codemode:** `codemode`, with a QuickJS sandbox, namespaces for each MCP server.
- **MCP:** each of the Session's servers through `@earendil-works/pi-mcp`, at the Gateway as today, its tools `mcp__<server>__<tool>`, deferred; `tool_search` loads them.
- **kndl:** `attachment(id)`, `ask_user_question` (sync and `async: true`, as ADR 0031; main loop only), `update_plan`, `agent` / `message_agent` / `stop_agent`, `handoff(note)` with `search_history(text)`.
- **Sections:** a preamble (who kndl is, that several people may be talking, each prompt carries its sender), `<cwd>`, AGENTS.md and CLAUDE.md from `/workspace` (nested ones listed), the skills in `.agents/skills`, `.claude/skills`, `.pi/skills` (name and description; the agent reads the file), and the Plan.

## Not in the spike

- Handoffs between Harnesses (ADR 0030): one Harness, so none. The Hub's handoff code is unreachable.
- Claude Code Sessions already on a dev Hub: they relaunch on the durable agent with a fresh conversation, as a switch to a new Harness would, and get a handoff.
- A TUI. The terminal is a shell.
- Questions in threads and subagents.
