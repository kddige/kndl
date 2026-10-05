---
status: proposed
supersedes: 0012
---

# Claude Code's subagents replace Child Sessions

A Session delegates with Claude Code's own agents, in its own Sandbox: foreground and background subagents, teammates, and `isolation: "worktree"`. hub-link reports every agent to the Hub, and the web UI shows each one nested under its Session, live. Any Participant can watch an agent, message it or stop it. Child Sessions, their tools and Reports (ADR 0012) are removed.

ADR 0012 kept the Agent tool off because an agent ran on the host, invisible to the UI and out of people's reach. With Claude Code in the Sandbox (ADR 0013), and the mod's agent API, neither holds any more. Delegation becomes what people already use in a terminal and what the model is trained on, at no extra VM per worker. Spike #148 measured it on Claude Code 2.1.289.

## How it works

- **Agents.** With ADR 0001's tool allowlists retired (#147), nothing refuses Agent, SendMessage or TaskStop. They work as in a terminal.
  - Agent teams are on, with `teammateMode: "in-process"`, since a Session's terminal is one tmux window.
  - Claude Code decides foreground or background. 2.1.289 runs an Agent call in the background unless the call says `run_in_background: false`. hub-link doesn't force foreground: only `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` does, and that also turns off background Bash.
- **The agent tree.** An agent is keyed by Claude Code's `agentId`, which is unique in its Session. hub-link learns each one at `agent.spawn`:
  - its parent: the main loop, or `parentAgentId`
  - the parent's Turn and the Agent tool call that started it (`tool_use_id`)
  - its type, description, model and name (for a teammate), and whether it runs in the background
  
  Agents that Claude Code starts for itself never pass `agent.spawn` (a progress summary fires only a SubagentStop, with an empty type), so they are not reported. The Hub keeps the tree as a projection of the events, a table keyed by Session and `agentId`, so the sidebar doesn't replay event logs. The event log stays the record.
- **Mod to Hub.** Two new Turn events:
  - `AgentStarted`: `agentId`, `parentAgentId?`, `turnId` and `toolCallId` (the parent loop's), `kind` (Subagent or Teammate), `agentType`, `description`, `name?`, `model`, `background`.
  - `AgentStatusChanged`: `agentId`, `status` (Running, Idle, Done, Stopped or Interrupted), and the agent's worktree path and branch once it has one. hub-link derives the status from SubagentStart, SubagentStop, TeammateIdle, a `turn.complete` that was aborted, and TaskStop.
  
  An agent's text, tool calls and run ends stay `TextDelta`, `ToolCallStarted`, `ToolCallEnded` and `TurnEnded` with its `agentId`. Their `turnId` is the agent's own run, a new one for each run including resumes, and never the parent's. The web groups them by `agentId`, which also fixes the phantom Turn it builds today from an agent's unknown `turnId`.
- **Turns Claude Code starts itself.** When a background agent finishes or is stopped, Claude Code starts a main-loop Turn with a `<task-notification>` prompt. When a teammate goes idle or messages the lead, it starts one from a peer message (`session.receive`). `PromptSender` gets `FromAgent { agentId }` for these. hub-link reads the agent from the notification's task id, or from the teammate's name.
- **Web to Hub to mod.**
  - `MessageAgent { sessionId, agentId, text }` and `StopAgent { sessionId, agentId }` from the web, which the Hub relays as mod commands.
  - hub-link sends a message with `$.session.send` (a teammate by name), prefixed with the Participant's name. A running agent reads it at its next tool round. A Done, Stopped or Interrupted one resumes from its transcript, with the same `agentId`.
  - Stop runs `TaskStop` with the `agentId`, or a teammate's name.
  - The Hub records each message as an `AgentMessaged` event (sender and text), since Claude Code's record of it isn't in the agent's messages.
  - Messages go straight to the agent. The Prompt queue feeds the main loop only.
- **Two plugins.** Claude Code hides from a plugin's hooks the work that plugin causes: when a plugin resumes an agent with `session.send`, that agent's steps skip the plugin's own hooks. So hub-link becomes two plugins in the mod package, both loaded with `--plugin-dir`:
  - **hub-link** reports.
  - **hub-link-commands** takes every command from the Hub: `DeliverPrompt`, `StopTurn`, `MessageAgent` and `StopAgent`.
  
  Reporting never depends on what the reporter itself caused.
- **Web UI.**
  - **Sidebar.** It nests a Session's agents under it, with their status.
  - **Transcript.** An agent is a card at the tool call that started it. The card streams its text and tool calls, and is folded once the agent is Done.
  - **Agent pane.** Selecting an agent in the sidebar opens it alone.
  - **Outliving a Turn.** A background agent keeps streaming into its card and pane after the Turn that started it has ended.
  - **Actions.** Every agent has a message box, which resumes it if needed, and a running one has Stop.
  - **Turns from agents.** A `FromAgent` Turn shows the agent's description as its sender.
  - **Starting agents.** People don't start agents from the UI; they ask the Session.
- **Session state.**
  - A Session with a Running agent is working: idle sleep waits for its agents, and the sidebar shows it busy. Idle teammates don't keep it awake.
  - The Prompt queue still delivers whenever the main loop is idle, as a terminal does with background agents running.
- **Sleep, wake and restart.**
  - **Interruption.** Sleep stops the VM and every agent in it, and so does a model or effort restart (ADR 0013). Both ask for confirmation when agents are running. A lost Runner has the same effect.
  - **On wake.** The transcripts survive on the state volume (`projects/-workspace/<session>/subagents/agent-<id>.jsonl` and its `meta.json`). After `--resume`, Claude Code lists no agents, and queues the main loop a task notification for each one that was running, saying it can be resumed with a message.
  - **The Hub's part.** It marks those agents Interrupted when the Session stops. It doesn't resume them on its own: the main loop reads Claude Code's note on its next Turn, and people can resume an agent from the UI. A resumed agent repeats the tool call it was cut off in.
  - **Teammates.** They don't survive, because the team belongs to the process, so the Hub marks them Done.
- **Worktrees.** `isolation: "worktree"` makes `/workspace/.claude/worktrees/agent-<agentId>` on branch `worktree-agent-<agentId>`. It lives inside the Workspace, so it survives sleep, and Claude Code keeps it after the agent ends when it has changes. Its `.git` file and its `.git/worktrees/` entry hold guest paths, which host git can't resolve. So:
  - **Excluded from the WIP snapshot.** The Runner adds `.claude/worktrees/` to the Workspace's `.git/info/exclude`, which its host git already copies. Without that, the WIP snapshot on the host takes a worktree's files, uncommitted ones included, as plain files. And a `git add -A` in the Sandbox commits the worktree as an embedded repo.
  - **Its own WIP ref.** The WIP push snapshots each agent worktree as it does the Workspace, to its own ref under the Session's WIP ref (`refs/claude-hub/wip/<session>/worktrees/<name>`). The snapshot's parent is the worktree's HEAD, so the agent's commits go with it.
  - **No host prune or gc.** The Runner never runs `git worktree prune` or `git gc` on the host, where these worktrees look prunable. The Workspace's own `.git` stays a plain directory, so `checkGitDir` holds.
  - **Merging.** An agent's card shows its worktree branch. Merging it is the main loop's work, with git in the Sandbox.

## What goes away

All of ADR 0012's Child Sessions:

- the Child tools (`create_child`, `message_child`, `list_children`, `read_child`, `archive_child`, `message_parent`)
- the `/mod/children` route and the Hub's `ChildSessions`
- Reports
- the archive cascade and its confirmation
- `CLAUDE_HUB_PARENT_SESSION_ID` and the child system prompt
- `SessionSummary.parentId`, `DeliverPrompt.fromSession` and `QueuedPrompt.fromSession`
- the `FromParentSession`, `FromChildSession` and `FromChildSessionMessage` senders
- the sidebar's nesting of Sessions under Sessions

Session names stay, but not "a parent names its children".

## Migrating

- **Child Sessions become ordinary Sessions.** A migration drops `parent_id`, `last_report` and `parent_exchanges`, so former children show at the top level of their Repo. They keep their Creator, Sandbox, Work branch and history.
- **History.** Stored events and queued prompts from another Session decode as one legacy sender, `FromSession { session }`, which nothing produces any more. They show as "from" that Session's name.
- **Queued Reports.** A former parent's queued Reports are delivered as ordinary prompts.
- **Rollout.** Runners follow the Hub's commit (ADR 0011), so the mod loses the Child tools in the same release in which the Hub drops the route.

## Considered options

- **Keep Child Sessions and the Agent tool off.** Each worker gets its own VM, terminal and full Session UI, on any Runner. But it rebuilds what Claude Code already does (delegating, reporting, messaging) as Hub tools the model isn't trained on, and it costs a VM, a clone and a Claude Code process per worker.
- **Both.** Subagents for work inside one Sandbox, Child Sessions for heavy or long work. That is two delegation mechanisms to explain to the model and to people, and to secure. Revisit if one Sandbox proves too small.
- **Show each subagent as a Session row.** An agent has no Sandbox, terminal, Prompt queue or Work branch of its own, so a row would promise what it can't do.
- **Force foreground agents** (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`). Every agent would sit inside a Turn, but it takes away background agents and background Bash, which is how long work runs in parallel.
- **Build the tree from Claude Code's transcripts** (sidechains and `meta.json`), not from mod events. #148 verified it can be done, but it isn't live and it reads a private file format. It stays a recovery path.
- **One hub-link plugin that reports what it caused.** It can't: an agent it resumes skips its hooks.

## Consequences

- **Workers share one Sandbox.** CPU, memory, ports and the Workspace are shared, and only worktree isolation separates files and branches. Parallel work is bounded by one VM; a Repo that needs more raises its Environment's CPU and memory.
- **Agents live in the Session's Claude Code process.** Sleep, a restart or a lost Runner interrupts them, and they resume only when messaged. Teammates are lost. Child Sessions ran on their own.
- **Authority holds by construction.** Agents run in the Session's Sandbox, on its Creator's Claude credential (ADR 0015) and its Sandbox token, so delegation can't do what the Creator couldn't.
- **People message agents; they don't prompt them.** There is no terminal or Prompt queue per agent, and a message reaches a running agent only at its next tool call.
- **Claude Code's undocumented behaviour.** Teammates need `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`. Task notifications, sidechain paths and the background default can change. The pinned version's smoke test (ADR 0013) gains an agent check: spawn, completion notification, message and stop.
- **The model learns nothing new.** Claude Code's own descriptions of Agent, SendMessage and TaskStop apply. The child system prompt and the Report notes go.
- **Other ADRs.** On acceptance, this supersedes ADR 0012. It amends ADR 0013, whose mod keeps no Child Session tools and becomes two plugins, and ADR 0015, which says a Child Session runs on its parent's Creator's credential.
- **The glossary.** It drops Parent Session, Child Session and Report, and the children in Session name and Creator. It adds:
  - **Subagent:** a Claude Code agent that a Session's Claude starts, running in the Session's Sandbox and shown under the Session. _Avoid_: Child Session, worker.
  - **Teammate:** a named Subagent that stays, idle, between tasks.
