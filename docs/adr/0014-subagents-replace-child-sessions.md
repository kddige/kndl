---
status: accepted
supersedes: 0012
---

# Claude Code's subagents replace Child Sessions

A Session delegates with Claude Code's own subagents, in its own Sandbox: foreground and background agents, and `isolation: "worktree"`. hub-link reports every agent to the Hub, and the web UI shows each one under its Session, live. Any Participant can watch an agent, message it or stop it. Child Sessions, their tools and Reports (ADR 0012) are removed.

ADR 0012 kept the Agent tool off because an agent ran on the host, invisible to the UI and out of people's reach. With Claude Code in the Sandbox (ADR 0013) and the mod's agent API, neither holds any more. Delegation becomes what people already use in a terminal and what the model is trained on, at no extra VM per worker. Spike #148 measured it on Claude Code 2.1.289.

## How it works

- **Agents.** With ADR 0001's tool allowlists retired (#147), nothing refuses Agent, SendMessage or TaskStop. They work as in a terminal. Claude Code decides foreground or background: 2.1.289 runs an Agent call in the background unless the call says `run_in_background: false`. hub-link doesn't change that.
- **What hub-link reports.** An agent is keyed by Claude Code's `agentId`, unique in its Session. hub-link learns each one at `agent.spawn`, and reports only those: agents Claude Code starts for itself, such as progress summaries, never pass `agent.spawn`.
  - `AgentStarted`: `agentId`, the parent loop's `turnId` and Agent `toolCallId`, `agentType`, `description`, `model` and `background`.
  - `AgentStatusChanged`: `agentId` and `status`: Running at SubagentStart, Done at SubagentStop, Stopped once a `TaskStop` call stops it, by the model or by hub-link-commands, or at an aborted `turn.complete` (TaskStop fires no SubagentStop, and a stopped background agent's run no `turn.complete` either). Once the agent has a worktree, its path and branch.
  - An agent's text, tool calls and run ends stay `TextDelta`, `ToolCallStarted`, `ToolCallEnded` and `TurnEnded`, tagged with its `agentId`. Their `turnId` is the agent's own run, new for each run, so the web groups them by `agentId`. That also fixes the phantom Turn the web builds today from an agent's unknown `turnId`.
- **Turns from agents.** When a background agent finishes or is stopped, Claude Code starts a main-loop Turn with a `<task-notification>` prompt. hub-link reports its sender as `FromAgent { agentId }`, read from the notification's task id. A background command's end is notified the same way, so the web UI shows a Turn from an id the Session never started as from a background task.
- **Messaging and stopping.** The web sends `MessageAgent { sessionId, agentId, text }` and `StopAgent { sessionId, agentId }`, and the Hub relays them as mod commands.
  - A message goes through `$.session.send`, prefixed with the Participant's name as a prompt is. A running agent reads it at its next tool round. A Done, Stopped or Interrupted one resumes from its transcript, with the same `agentId`.
  - Stop runs `TaskStop` with the `agentId`.
  - The Hub records each message as an `AgentMessaged` event, since Claude Code doesn't keep it in the agent's messages.
  - The Prompt queue feeds the main loop only.
- **Two plugins.** A plugin's hooks don't see the work it causes: when a plugin resumes an agent with `session.send`, that run's steps skip the plugin's own hooks (#148). So the mod package holds two plugins, both loaded with `--plugin-dir`:
  - **hub-link** reports: Turn and agent events.
  - **hub-link-commands** runs every command from the Hub: `DeliverPrompt`, `StopTurn`, `MessageAgent` and `StopAgent`. It also draws the band, since `PresenceChanged`, the band's Participants, is a command too.
  - Both say hello with the Session's mod token; only hub-link-commands polls. Before it submits a prompt from the Hub, hub-link-commands records its `promptId`, sender and text in its `$.state`; hub-link reads that at `turn.start` to report the Turn as from that Participant, with that `promptId`.
- **Web UI.**
  - **Sidebar.** A Session's agents are listed under it with a status dot. Finished ones fold away.
  - **Transcript.** An agent is a card at the Agent call that started it, streaming its text and tool calls, folded once it is Done. A background agent keeps streaming into its card after its Turn ends.
  - **Agent view.** Selecting an agent in the sidebar opens its card full height, with a message box (Resume once it has stopped) and, while it runs, Stop.
  - A `FromAgent` Turn shows the agent's description as its sender.
  - People don't start agents from the UI; they ask the Session.
- **Session state.** A Session with a Running agent is working: idle sleep waits for its agents, and the sidebar shows it busy. The Prompt queue still delivers whenever the main loop is idle, as a terminal does with background agents running.
- **Sleep, wake and restart.**
  - Sleep, a model or effort restart (ADR 0013), and a lost Runner stop every agent with the Claude Code process. Sleep and restart ask for confirmation when agents are running. The Hub marks Running agents Interrupted when Claude Code stops.
  - The transcripts survive on the state volume. After `--resume`, Claude Code queues the main loop a task notification for each agent that was running, saying it can be resumed with a message. The Hub doesn't resume agents on its own: the main loop reads that note on its next Turn, and people can resume one from the UI. A resumed agent repeats the tool call it was cut off in.
- **Worktrees.** `isolation: "worktree"` makes `/workspace/.claude/worktrees/agent-<agentId>` on branch `worktree-agent-<agentId>`. It lives in the Workspace, so it survives sleep, and Claude Code keeps it after the agent ends if it has changes. Its `.git` file and `.git/worktrees/` entry hold guest paths, which host git can't resolve. So:
  - **Excluded.** The Runner adds `.claude/worktrees/` to the Workspace's `.git/info/exclude` when it clones it. Without that, a `git add -A` in the Sandbox commits a worktree as an embedded repo. (It also kept worktrees out of the WIP snapshot, until #194 removed the WIP ref.)
  - **No host prune or gc.** The Runner never runs `git worktree prune` or `git gc` on the host, where these worktrees look prunable. Since #194 host git only clones, so it never meets them.
  - **Merging.** An agent's card shows its branch. Merging it into the Work branch is the main loop's job, with git in the Sandbox. Until then the branch is a local branch like any other the Session makes: on the state volume, and on GitHub only if the Session pushes it.

## What goes away

All of ADR 0012's Child Sessions:

- the Child tools (`create_child`, `message_child`, `list_children`, `read_child`, `archive_child`, `message_parent`), and the child system prompt
- the `/mod/children` route, the Hub's `ChildSessions`, and `CLAUDE_HUB_PARENT_SESSION_ID`
- Reports, the archive cascade and its confirmation
- `SessionSummary.parentId`, `DeliverPrompt.fromSession` and `QueuedPrompt.fromSession`
- the `FromParentSession`, `FromChildSession` and `FromChildSessionMessage` senders
- the sidebar's nesting of Sessions under Sessions

## Migrating

- **Child Sessions become ordinary Sessions.** A migration drops `parent_id`, `last_report` and `parent_exchanges`, so former children show at the top level of their Repo, with their Creator, Sandbox, Work branch and history.
- **History.** Stored events and queued prompts from another Session decode as one legacy sender, `FromSession { session }`, which nothing produces any more. They show as "from" that Session's name. A former parent's queued Reports are delivered as ordinary prompts.
- **Rollout.** Runners follow the Hub's commit (ADR 0011), so the mod loses the Child tools in the release in which the Hub drops the route.

## Considered options

- **Keep Child Sessions and the Agent tool off.** Each worker gets its own VM, terminal and Session UI. But it rebuilds what Claude Code already does as Hub tools the model isn't trained on, and costs a VM, a clone and a Claude Code process per worker.
- **Both.** Two delegation mechanisms to explain to the model and to people, and to secure. Revisit if one Sandbox proves too small.
- **Agent teams** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, in-process teammates). #148 showed they work, but they are experimental and bring an Idle state, addressing by name, peer-message Turns and a team that a restart loses. Background subagents already run in parallel and can be messaged. Revisit when teams leave experimental.
- **Each agent's worktree its own WIP ref.** It would back up an agent's uncommitted work, at the cost of a second snapshot per worktree and a per-worktree index. The worktree is on the state volume like the rest of the Session's local state, and work that matters reaches the Work branch when the main loop merges it. (#194 removed the WIP ref itself.)
- **Show each subagent as a Session row.** An agent has no Sandbox, terminal, Prompt queue or Work branch, so a row would promise what it can't do.
- **Force foreground agents** (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`). Every agent would sit inside a Turn, but it also turns off background Bash.
- **Build the tree from Claude Code's transcripts** (sidechains and `meta.json`). It works, but it isn't live and reads a private format. It stays a recovery path.
- **One hub-link plugin.** It can't report an agent it resumed itself.

## Consequences

- **Workers share one Sandbox.** CPU, memory, ports and the Workspace are shared, and only worktrees separate files and branches. A Repo that needs more raises its Environment's CPU and memory.
- **Agents live in the Session's Claude Code process.** Sleep, a restart or a lost Runner interrupts them, and they resume only when messaged.
- **Authority holds by construction.** Agents run in the Session's Sandbox, on its Creator's credential (ADR 0015), so delegation can't do what the Creator couldn't.
- **People message agents; they don't prompt them.** There is no terminal or Prompt queue per agent, and a message reaches a running agent only at its next tool call.
- **Claude Code's undocumented behaviour.** Task notifications, sidechain paths and the background default can change. The pinned version's smoke test (ADR 0013) gains an agent check: spawn, stream, completion notification, message and stop.
- **The model learns nothing new.** Claude Code's own Agent, SendMessage and TaskStop apply.
- **Other ADRs.** This supersedes ADR 0012, and amends ADR 0013 (the mod keeps no Child tools and is two plugins) and ADR 0015 (no Child Sessions run on a parent's Creator's credential).
