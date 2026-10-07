---
title: Work with subagents
description: Have a Session hand work to Claude Code's subagents, follow them live, message them, stop them, resume them, and merge their worktrees.
sidebar:
  order: 9
---

A Session can hand parts of its work to [subagents](/reference/glossary/): Claude Code's own agents, which Claude starts with its Agent tool, as it does in a terminal. They run in the Session's Sandbox, beside its Claude Code, and the web UI shows each one under its Session, live. At the end of this guide, a Session has agents working for it, and you've followed, messaged, stopped and resumed one. The design is [ADR 0014](/reference/decisions/0014-subagents-replace-child-sessions/).

## Before you start

- A Session: see [Work in a Session](/how-to/work-in-a-session/).

## Ask a Session to delegate

Subagents are started by Claude, not from the web UI. In the Session, ask for it in a prompt:

```
Use a background agent to write the changelog, and another, in a worktree, to update the API docs.
```

Claude Code decides how each agent runs, as in a terminal:

- **In the foreground**, the Turn waits for the agent and goes on with its result.
- **In the background**, the agent runs on after the Turn ends. When it's done or stopped, Claude Code starts a Turn of its own to read its result: see [Read what a background agent did](#read-what-a-background-agent-did). Claude Code runs an agent in the background unless Claude asks for the foreground.
- **In a worktree**, when Claude asks for `isolation: "worktree"`, the agent works in its own checkout, on its own branch: see [Merge a worktree agent's work](#merge-a-worktree-agents-work).

Every agent shares the Session's Sandbox: its CPU, memory, ports and Workspace. A Repo whose agents need more raises its [Environment's](/how-to/set-up-an-environment/) CPU and memory.

## Follow an agent

In the transcript, an agent is a card in place of the Agent call that started it. Its summary row shows its status, its description, its branch when it has a worktree, and how many tool calls it has made. While it runs, the card is open and streams the agent's text and tool calls; once it has finished, it folds. Open it to see what it did, its type and model, and whether it ran in the background. A background agent keeps streaming into its card after its Turn has ended.

In the sidebar, a Session's agents are listed under its row, each with its status's dot:

| Status | It means |
|---|---|
| Running | The agent is working. |
| Done | The agent finished. |
| Stopped | Someone, or Claude, stopped it. |
| Interrupted | The Session's Claude Code stopped while the agent ran: see [After sleep or a restart](#after-sleep-or-a-restart). |

The sidebar lists the open Session's agents, finished ones too, and only the Running and Interrupted agents of other Sessions. A Session whose agents are running shows a spinner, as during a Turn.

- To hide a Session's agents, press the chevron on its row. Press it again to show them. Your browser remembers which rows you've folded, across reloads.
- To open an agent's view, click its row, or **Message or stop it** in its card. Its Session's row unfolds so the agent's row is in view.

The agent's view shows its card full height, with a box to message it below. **Back to the chat** returns to the Session's transcript.

## Message an agent

Any Participant can message an agent, from its view. Type in the box and press **Send message**. The message shows in the agent's card with your name, and reaches the agent with your name too, as a prompt does.

A running agent reads a message at its next tool call, so a message to an agent in the middle of a long command waits for it. A message isn't a prompt: it doesn't go through the Prompt queue, and only the Session's own prompts start its Turns.

If the message can't reach the agent, a toast says "Your message could not be delivered to the agent: …".

## Stop an agent

While an agent runs, its view has **Stop agent**. Claude Code stops it as its TaskStop tool does, and its status turns Stopped. A tool call it was in the middle of shows as cut short. As when it's done, Claude Code then tells the Session's Claude, which starts a Turn from the agent.

**Stop** on a Turn stops the Turn's own work. A background agent it started runs on: to stop one, stop it from its view.

## Resume an agent

An agent that is Done, Stopped or Interrupted resumes when it's messaged. In its view, type what it should do and press **Resume**: the agent picks up where it left off, with its earlier work, and runs again as Running.

- A message to an agent of an Asleep Session wakes the Session first.
- An agent of a Frozen Session can't be messaged until its Runner is back, and one of an Archived Session until it's restored.

## Read what a background agent did

When a background agent is done or stopped, Claude Code tells the Session's Claude, which starts a Turn to read the result, once no other Turn is running. In the transcript, that Turn shows the agent's description, linked to its view, with **Agent** beside it, and the summary and result Claude Code passed on. Claude Code does the same when a command Claude ran in the background ends: that Turn shows as from a **Background task**.

## After sleep or a restart

Agents run inside the Session's Claude Code, so they stop when it does: when the Session goes to sleep, when a change of model or effort restarts it, when someone restarts it for a changed Environment, and when its Runner is lost. So while agents are running, **Sleep now**, a restart and a change of model or effort ask first, saying how many agents they would interrupt. A Session doesn't fall asleep on its own while an agent is running.

The Hub marks the agents that were running Interrupted, and a tool call one was in the middle of shows as cut short. Their work so far is kept: when the Session's Claude Code starts again, it tells Claude which agents can be resumed, and you can resume one from its view. A resumed agent repeats the tool call it was cut off in.

A Session that's Frozen keeps its agents Running: its Claude Code may still be running on the offline Runner.

## Merge a worktree agent's work

An agent in a worktree works in `/workspace/.claude/worktrees/agent-<agent id>`, on the branch `worktree-agent-<agent id>`, which its card shows. Claude Code keeps the worktree after the agent ends if it has changes.

To get its work onto the Session's Work branch, ask the Session, in a prompt, to merge the branch. Until then, the branch is a local branch of the Session's, like any other it makes: it lasts while the Session does, and reaches GitHub only if the Session pushes it. The Runner keeps `.claude/worktrees/` out of the Workspace's git status, so a `git add -A` never takes a worktree in.

## Next

- [Protocol](/reference/protocol/#subagents): how the mod reports agents, and the Hub's agent commands.
- [Session lifecycle](/explanation/session-lifecycle/): what sleep and a restart keep.
