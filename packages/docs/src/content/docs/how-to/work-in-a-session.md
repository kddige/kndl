---
title: Work in a Session
description: Start a Session, prompt it with others, use its terminal, put it to sleep, delete and restore it, and get its work out.
sidebar:
  order: 7
---

A Session is one Claude Code conversation working on one Repo, on its own Work branch, in its own Sandbox. Everyone signed in to the Hub can see every Session, join it and prompt it.

## Start a Session

1. Press **New Session**, at the top of the sidebar.
2. Enter the **Repo** as `owner/name` and the **Base branch** to start from.
3. Leave **Runner** on **Any online Runner**, or pick one. The Session runs on that Runner's machine, with its Claude login, for its whole life.
4. Press **Start Session**.

The Runner clones the Repo onto the Session's Work branch, builds the Environment if it hasn't yet, makes the Session's Sandbox and starts Claude Code. **Show log** on the **Starting…** banner follows along. If the Repo has no Environment yet, you set one up first: see [Set up an Environment](/how-to/set-up-an-environment/).

## Prompt it together

Type a prompt and send it. While a Turn is running, a prompt from anyone waits in the Prompt queue, and Claude takes the queue in order. Each prompt in the transcript shows who sent it.

The Participants in a Session are shown at the top, and to Claude Code too, above its prompt box.

Claude's tools are limited to Bash, Read, Write, Edit, NotebookEdit, Glob and Grep, and run in the Sandbox. Every other tool is denied, background commands are refused, and so is the `!` shell shortcut, which would run on the host.

## Use the terminal

The **Terminal** tab shows the Session's Claude Code screen, live, and everyone watching can type into it. Use it for what the chat doesn't handle: answering Claude Code's dialogs, Esc, Ctrl-C, arrow keys.

The terminal has one size. Whoever last typed into it, or pressed **Fit to my window**, sets it; everyone else sees it scaled down to fit. Only an Active Session has a terminal to type into.

## Sleep and wake

A Session with no Turn running, no prompt queued and no one present goes to sleep after 15 minutes (the Hub's `HUB_SLEEP_AFTER_MS`). **Sleep now** in the Session's header does it at once. Sleeping stops Claude Code and the Sandbox, and keeps the Workspace and the Sandbox's disks.

Any prompt wakes an Asleep Session, as does **Wake now** on its banner. Claude Code resumes the same conversation, with `node_modules`, caches and Docker's data as they were.

## When its Runner is offline

A Session whose Runner is offline is Frozen: you can read it, and prompts you send wait in its queue. When the Runner is back, the Session is Active again if its Claude Code kept running, and otherwise Asleep, and woken at once if prompts are waiting.

## Delete and restore

**Delete Session**, the trash button in the Session's header, archives the Session at once: the Runner stops Claude Code, pushes the WIP ref, and destroys the Sandbox, keeping the Workspace and Claude Code's state. Any Participant can do it.

- **Undo** in the toast restores it straight away.
- **Archived Sessions**, in the sidebar, lists the Archived Sessions of every Repo, with who deleted each and when, and a **Restore** button.

A restored Session is Asleep, and the next prompt wakes it in a fresh Sandbox, on the kept Workspace, with the conversation intact; its `node_modules` and Docker's data are gone with the old Sandbox.

30 days after it was archived (the Hub's `HUB_ARCHIVE_RETENTION_MS`), a Session is purged: the Hub deletes its log and queue, and its Runner deletes its directory.

## Get the work out

Claude can commit, push and open pull requests with plain `git` and `gh`, once the Hub has the GitHub App: see [Git from Sessions](/explanation/git-from-sessions/).

Whatever happens, the Runner pushes the Workspace's whole state, uncommitted and untracked files included, to a WIP ref on origin: after each Turn that changed it, before sleep and before archiving. To get it:

```sh
git fetch origin refs/claude-hub/wip/<session id>
git switch --detach FETCH_HEAD
```

The Session id is the last part of its URL, `/sessions/<session id>`.
