# Pi Durable as kndl's only Harness: the spike's design

> **A spike.** This replaces ADR 0029's pi coding agent and ADR 0030's Claude Code Harness with one agent built on `@earendil-works/pi-durable`, on a draft PR, for testing on a dev machine. It is not a decision yet. If it holds, an ADR supersedes 0029 and 0030.

Everything a Session's agent does now runs in one headless Node process in the Sandbox, **the durable agent** (`packages/mod/durable/`), built on Pi Durable 1.3.0 over the same pi-ai 1.3.0 the Hub already pins. It speaks the mod protocol to the Hub, as the pi extension did, so the Hub and web keep their event log, Prompt queue and transcript. What Pi Durable adds is used, not hidden:

| Pi Durable | What kndl gets |
| --- | --- |
| Tasks with checkpoints, `resume()`, SQLite storage on the Session's volume | A run that was going when its Sandbox slept, the agent crashed or the Runner restarted continues where it stopped, reported as a `Resumed` Turn. The conversation is durable; the web's events are not (see the [recovery contract](../../packages/mod/durable/README.md#recovery-contract)). |
| `requestId` on submissions | Exactly-once prompt admission: a prompt's id is its request id, so a prompt delivered twice is admitted once. Effects of tools, and events not yet sent to the Hub, are not promised exactly once. |
| `fork(entryId)`, many conversations at once | **Threads**: anyone replies in a thread off any answer. A thread is a fork of the main conversation at that answer, runs beside it and beside other threads, and can be on another Model. |
| The inbox: steer, follow-up | Anyone can post into a busy thread; it steers. The main loop keeps the Hub's Prompt queue. |
| Task-owned conversations, background tasks | Subagents that survive a restart, whose results come back as a Turn. A background agent deliberately survives its parent's stop; only a foreground `wait: true` call stops with it. |
| Documents, forked `asOf` | **The Plan**: the agent keeps a checklist (`update_plan`), shown live to everyone, per conversation; a thread starts with the Plan as it was at its fork. |
| Background compaction, `compact()`, `reset(note)` | Sessions that never run out of context, a **Compact** action anyone can use, with instructions, and a `handoff` tool the agent can use on itself. |
| Codemode, deferred tools, `tool_search` | MCP servers' tools are deferred and found by search, so a Session with many servers keeps a short tool list; `codemode` scripts call any tool, and survive a restart. |
| `pi.usage` per conversation | Cost per Turn as before, and per thread. |
| Sections rebuilt every request | AGENTS.md, CLAUDE.md and skills are read live: an edit reaches the next request. |

Claude's Models run through **the Claude bridge**, ported from the pi extension to a pi-ai provider (`anthropic`). Claude Code is no longer a Harness, but its pinned binary is still mounted, as the bridge runs it as a model. The bridge's notices, such as rate-limit warnings, go only to the agent's log (`onNotice` in `packages/mod/durable/src/ClaudeModels.ts`, to `durable/agent.log`), not to the web.

**Everyone drives.** For the spike, every Participant who sees a Session can prompt it, steer, cancel queued prompts, stop, answer, switch its Model, message and stop its agents, start and post in threads, compact, and use its terminal. They can also sleep it, wake it, set Keep awake, restart it, archive it, restore it and rename it, and their `kndl forward` wakes an Asleep one. The list is `drivingCommands` in `packages/hub/src/SessionRelay.ts`, and `driveRefusal` in `packages/protocol/src/SessionRules.ts` never refuses: it stays as the one place to put the rule back. The Session still spends its Creator's accounts (ADR 0026's billing half stands; its driving half is lifted for testing).

## Departures from ADRs

The spike contradicts these accepted ADRs. They are not edited: the rules below are what this branch does instead, and an ADR that supersedes them follows only if the spike holds.

- **0026, a Session runs on and is driven by its Creator.** The driving half is lifted: `drivingCommands` (above) lets every Participant with Repo access send each driving command. The billing half stands: the Session runs on its Creator's Connected providers and Claude credential, and the model picker lists the Creator's Models.
- **0029, pi is the Harness and the Hub is the Gateway.** The pi coding agent's TUI, run in tmux with kndl's pi extension, is replaced by the headless durable agent, which has no TUI; the terminal is a separate plain shell. The Gateway half stands: the Hub holds every Connected provider and the agent reaches Providers through it (`packages/mod/durable/src/Providers.ts`).
- **0030, a Session switches Harness with a context handoff.** There is one Harness, so a Session never switches. `packages/hub/src/AgentModels.ts` checks only the Creator's Models, and a model named as Claude Code names it is refused. The Handoff survives solely to move a Session from before the spike onto the durable agent.
- **0027, anyone who sees an Archived Session can purge it.** Its sentence "Restoring stays the Creator's alone" no longer holds: `RestoreSession` is in `drivingCommands`, and `ArchivedSessions.tsx` offers **Restore** to anyone who sees the Session. A restored Session runs on the Creator's accounts.
- **0018, steering a prompt into the running Turn.** Its Creator-only Steer amendment (from ADR 0026) is lifted: `SteerPrompt` is a driving command. A prompt posted into a busy thread steers that thread's Turn without the Prompt queue (`DeliverThreadPrompt`), which ADR 0018 has no case for. "Only the main loop" is no longer true: threads steer too, though subagents still don't.
- **0024, attachments reach Claude through a mod tool.** The tool is `attachment`, registered by the durable agent, not `mcp__hub-link-commands__attachment`. A tool result carries text and images only, so a PDF is saved to a path outside the Workspace and the tool names it for the model to read; it isn't a native document (`Attachments.ts`).
- **0014, subagents replace Child Sessions.** The agents are the durable agent's `agent`, `message_agent` and `stop_agent` tools, not Claude Code's Agent tool. There are no Claude Code plugins to hold hub-link, and no `isolation: "worktree"`: the `agent` tool takes `description`, `prompt`, `model` and `wait` only. A background agent survives its parent's stop.
- **0031, the agent can ask a question and go on.** There is no Claude Code tool or terminal dialog; `ask_user_question` is the agent's own, and anyone in the Session answers (ADR 0031 says the Creator). Questions are main-loop only: threads and subagents have no question tool.
- **0020, plugins are remote MCP servers behind the Hub.** Claude Code no longer gets one MCP server per Installation, named to avoid its `.mcp.json`. The agent connects to each at the Gateway, and its tools are `mcp__<server>__<tool>`, deferred and found with `tool_search` (`Mcp.ts`). The Gateway and Installations stand.
- **0011, amended in #159.** "A new model's restart" no longer reloads the agent: a Model change reaches the running agent as `SwitchModel` and restarts nothing. The copy of the mod is still made each time the agent starts, at a Session's start, wake or relaunch.
- **0016, with 0026: forwarding a Session's ports.** `kndl forward` of an Asleep Session wakes it for anyone with access, not only its Creator (`connectForward` in the Session relay).

## The process

- **Where:** in the Sandbox, as the pi TUI was, so its tools run in `/workspace` with nothing routed. The Runner starts it with the pinned Node.js: `node /opt/kndl/mod/<copy>/durable/agent.js`, in its own tmux session, `<name>-agent`. A separate tmux session, `<name>`, runs a plain `bash -l` in `/workspace`, restarting the shell when it exits. Only that session is mirrored to the web terminal: agent output and terminal output never share a control-mode stream. No TUI: the web is the interface.
- **Storage:** `openNodeSqliteStorage("$KNDL_STATE_DIR/durable/session.sqlite")`, on the Session's persistent volume, so sleep and wake keep everything. One process owns it at a time; the Runner starts at most one.
- **Restart:** the agent opens the storage, installs its extensions, says hello, and calls `harness.resume()`. A run that was going continues. Its Turn was reported ended (`aborted`) by the Hub when the process stopped, so the agent reports a new `TurnStarted` with `sender: Resumed`, and the run's events follow under it.
- **Its environment:** as pi's was (`KNDL_URL`, `KNDL_MOD_TOKEN`, `KNDL_SESSION_ID`, `KNDL_MODEL`, `KNDL_THINKING`, `KNDL_MCP_SERVERS`, and the Claude bridge's `CLAUDE_CODE_OAUTH_TOKEN`, `KNDL_CLAUDE_CODE`, `CLAUDE_CONFIG_DIR`), with `KNDL_HARNESS=Pi`.
- **Exit:** a fatal error (`harness.closed` with `failed`) exits non-zero; the Runner watches the agent session's pane and reports the Harness stopped. Exit detection, adoption, signals and crash output target the agent session; terminal input, resizing and snapshots target the shell session.
- **Modules:** the copied `durable/agent.js` has a sibling `node_modules` symlink into the pinned install under `/opt/kndl/pi`. Node resolves its external `@earendil-works/*` imports there; it does not rely on `NODE_PATH` for ESM.
- **Secrets:** the Runner supplies the mod token and Claude credential only to the agent session, not the shell. The agent removes them from the environment inherited by coding tools. This is inheritance hygiene, not a security boundary against someone with shell access to the same Sandbox.

## Conversations

- **Main loop:** `harness.root()`. Its Turns have no `threadId` or `agentId`, as today.
- **Threads:** ownerless forks of the root, `root.fork(entryId)`. Each has a `ThreadId` the Hub mints. The agent keeps `kndl.threads` (a Session-scope document): `threadId → { conversationId, anchorTurnId, title }`.
- **Compactions:** `kndl.compactions` (Session-scope) keeps the last 200 `Compact` request ids the agent handled, so a `Compact` the Hub sends again after a restart is acknowledged, not run twice.
- **Subagents:** conversations owned by a background anchor task of the conversation that started them (Pi Durable's example 23), with a reporter task per message. `kndl.agents` (Session-scope) keeps each agent's conversation, parent conversation, owning task, status and delivered results.
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
- `ModHello` carries no capability flags: every mod of version 5 is the durable agent, and a thread command the Hub holds before its hello is sent after it.
- `RunnerHello.runsAgent` says whether the Runner prepared the agent's runtime; the Hub starts no Session on one that didn't, and says so.

**Session events the Hub logs itself:** `ThreadStarted { threadId, anchorTurnId, title, startedBy, model?, thinkingLevel? }`, `ThreadPromptSent { threadId, promptId, requestId?, sender, text, attachments? }` (shown as sent until the agent's `TurnStarted` or `PromptSteered` with that `promptId`), `ThreadModelChanged { threadId, by, model, thinkingLevel? }`, and `TurnStopRequested` with an optional `threadId`. New `ThreadStarted` events always carry `model`: the Session's own Model when the web asked for none, because a fork keeps the Model its parent had at the fork and doesn't follow the Session's later switches. Events logged before threads had their own Model can lack it; history replay accepts those unchanged rather than guessing their Model from the Session's current one. `StartThread.model` and `ThreadSummary.model` remain required.

**A failed thread prompt:** the agent reports `ThreadPromptFailed { threadId, promptId, message, threadDropped? }` when it couldn't take one, such as the first prompt of a thread it couldn't fork. The prompt is then not sent for everyone, and a thread whose first prompt failed is dropped (`threadDropped: true`): the agent never made it, and later replies are refused.

**Commands, Hub to mod:** `StartThread { threadId, anchorTurnId, promptId, text, sender, attachments?, model, thinkingLevel? }` (the Hub always resolves a `model`), `DeliverThreadPrompt { threadId, promptId, text, sender, attachments? }` (steers a busy thread, else starts a Turn; `requestId: promptId`), `StopThread { threadId, turnId? }`, `SwitchThreadModel`, `Compact { requestId, threadId?, instructions?, sender }`.

**Web to Hub** (`ThreadCommand`): `CreateThread { requestId, sessionId, anchorTurnId, text, attachments?, model?, thinkingLevel? }`, `PromptThread { requestId, sessionId, threadId, text, attachments? }`, `StopThread`, `SetThreadModel`, `CompactConversation` (while the Session is Active). Any Participant with access. A `requestId` lets the sender match the Hub's answer: `ThreadCreated` echoes `CreateThread`'s, the `ThreadPromptSent` the Hub logs carries the one from `CreateThread` or `PromptThread`, and a refusal is a `CommandFailed` with it. The Hub mints the ids, logs what it logs, wakes an Asleep Session, and queues the mod command (a `model` the web didn't ask for is the Session's current one); thread commands not yet delivered when the Harness restarts are delivered again after its hello. A prompt's `requestId` makes that safe; a `StopThread` carries the `turnId` it was asked for and is ignored if that Turn is no longer the thread's, and a `Compact` carries a `requestId` of its own, which the agent keeps in its storage (`kndl.compactions`), because Pi Durable's `compact()` takes none.

**Hub to web** (`ThreadMessage`): `ThreadCreated { requestId, sessionId, threadId }` to the creator of a thread, and `SessionModels { sessionId, models }` to everyone who joins a Session: its Creator's Models, so anyone can switch it.

**`SessionSummary.threads`:** `ThreadSummary { id, title, anchorTurnId, startedBy, running, model, thinkingLevel? }`, oldest first. A running thread keeps the Session from going to sleep for being idle, as a Turn does. When the Harness stops, the Hub ends each running thread's Turn as `aborted`, as it does the main loop's; the agent's restart reports `Resumed` Turns for those it continues.

## The agent's tools

- **Coding:** `read`, `write`, `edit`, `bash` (`createCodingTools({ images })`), on a `NodeExecutionEnv` in `/workspace`.
- **Codemode:** `codemode`, with a QuickJS sandbox, namespaces for each MCP server.
- **MCP:** each of the Session's servers through `@earendil-works/pi-mcp`, at the Gateway as today, its tools `mcp__<server>__<tool>`, deferred; `tool_search` loads them.
- **kndl:** `attachment(id)`, `ask_user_question` (sync and `async: true`, as ADR 0031; main loop only), `update_plan`, `agent` / `message_agent` / `stop_agent`, `handoff(note)` with `search_history(text)`.
- **Sections:** a preamble (who kndl is, that several people may be talking, each prompt carries its sender), `<cwd>`, AGENTS.md and CLAUDE.md from `/workspace` (nested ones listed), the skills in `.agents/skills`, `.claude/skills`, `.pi/skills` (name and description; the agent reads the file). The Plan is returned by `update_plan`, not inserted into the system prompt: a held Claude bridge query cannot see section changes midway through its tool rounds.

## Not in the spike

- Repeated switching between Harnesses (ADR 0030): there is only one Harness. The Hub keeps its handoff code solely for legacy Session migration.
- Claude Code Sessions already on a dev Hub: they relaunch on the durable agent with a fresh conversation, as a switch to a new Harness would, and get a handoff.
- A TUI. The terminal is a shell.
- Questions in threads and subagents.
