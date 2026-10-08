---
title: Work with subagents
description: Have a Session hand work to Claude Code's subagents, follow them live, message them, stop them, resume them, and merge their worktrees.
sidebar:
  order: 9
---

A Session can hand parts of its work to [subagents](/reference/glossary/): Claude Code's own agents, started by Claude's Agent tool. They run in the Session's Sandbox, and the web UI shows each one under its Session, live. At the end of this guide, a Session has agents working for it, and you've followed, messaged, stopped and resumed one. The design is [ADR 0014](/reference/decisions/0014-subagents-replace-child-sessions/).

## Before you start

- A Session: see [Work in a Session](/how-to/work-in-a-session/).

## Ask a Session to delegate

Claude starts subagents, not the web UI. Ask for them in a prompt:

```
Use a background agent to write the changelog, and another, in a worktree, to update the API docs.
```

Claude Code decides how each agent runs:

- **In the background**, the default, the agent runs on after the Turn ends, and Claude Code starts a Turn to read its result: see [Read what a background agent did](#read-what-a-background-agent-did).
- **In the foreground**, the Turn waits for the agent's result.
- **In a worktree**, the agent works in its own checkout, on its own branch: see [Merge a worktree agent's work](#merge-a-worktree-agents-work).

Every agent shares the Session's Sandbox: its CPU, memory, ports and Workspace. If agents need more, raise the [Environment's](/how-to/set-up-an-environment/#set-the-resources) CPUs and memory.

## Follow an agent

In the transcript, an agent is a card in place of the Agent call that started it, showing its status, description, branch and tool calls. The card streams the agent's work while it runs and folds when it finishes.

In the sidebar, a Session's agents are listed under its row, each with its status's dot:

| Status | It means |
|---|---|
| Running | The agent is working. |
| Done | The agent finished. |
| Stopped | Someone, or Claude, stopped it. |
| Interrupted | The Session's Claude Code stopped while the agent ran: see [After sleep or a restart](#after-sleep-or-a-restart). |

The sidebar lists all of the open Session's agents, and only the Running and Interrupted agents of other Sessions. The chevron on a Session's row hides and shows them.

To open an agent's view, click its row, or **Message or stop it** in its card. **Back to the chat** returns to the transcript.

## Message an agent

In the agent's view, type in the box and press **Send message**. Any Participant can. The agent reads it, with your name, at its next tool call. A message doesn't go through the Prompt queue or start a Turn.

If the message can't reach the agent, a toast says "Your message could not be delivered to the agent: …".

## Stop an agent

While an agent runs, press **Stop agent** in its view. Its status turns Stopped, and Claude Code starts a Turn to tell the Session's Claude.

**Stop** on a Turn doesn't stop a background agent: stop it from its view.

## Resume an agent

An agent that is Done, Stopped or Interrupted resumes when it's messaged. In its view, type what it should do and press **Resume**: the agent picks up where it left off.

A message to an agent of an Asleep Session wakes the Session first. An agent of a Frozen Session can't be messaged until its Runner is back, and one of an Archived Session until it's restored.

## Read what a background agent did

When a background agent is done or stopped, Claude Code starts a Turn to read its result, once no other Turn is running. That Turn shows the agent's description, linked to its view, with **Agent** beside it. A Turn started by a background command ending shows as from a **Background task**.

## After sleep or a restart

Agents run inside the Session's Claude Code, so they stop when it does: when the Session sleeps, when a change of model or effort or of Environment restarts it, and when its Runner is lost. While agents run, **Sleep now** and a restart ask first, and the Session doesn't fall asleep on its own.

The Hub marks the agents that were running Interrupted. Their work so far is kept, and you can resume one from its view; it repeats the tool call it was cut off in. A Frozen Session's agents stay Running, since its Claude Code may still run on the offline Runner.

## Merge a worktree agent's work

A worktree agent works in `/workspace/.claude/worktrees/agent-<agent id>`, on the branch `worktree-agent-<agent id>`, shown on its card. Claude Code keeps the worktree after the agent ends if it has changes.

To get its work onto the Session's Work branch, ask the Session to merge the branch. Until then it is a local branch, and reaches GitHub only if the Session pushes it. `.claude/worktrees/` is kept out of the Workspace's git status, so `git add -A` never takes a worktree in.

## Next

- [Protocol](/reference/protocol/#subagents): how the mod reports agents, and the Hub's agent commands.
- [Session lifecycle](/explanation/session-lifecycle/): what sleep and a restart keep.
