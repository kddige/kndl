---
title: Work in a Session
description: Start, find and rename a Session, prompt it with others, choose its model and effort, use the Repo's skills and CLAUDE.md, use its terminal, put it to sleep, delete and restore it, and get its work out.
sidebar:
  order: 8
---

A Session is one Claude Code conversation working on one Repo, on its own Work branch, in its own Sandbox. Everyone signed in to the Hub can see every Session, join it and prompt it.

## Start a Session

1. Press **New Session**, at the top of the sidebar.
2. Enter the **Repo** as `owner/name` and the **Base branch** to start from.
3. Leave **Runner** on **Any online Runner**, or pick one. The Session runs on that Runner's machine for its whole life, on your Claude credential, or on the Runner's own if you have none.
4. Leave **Model** on Claude Code's default, or pick a model and effort level: see [Choose the model and effort](#choose-the-model-and-effort). With **Any online Runner**, it offers only the models and levels every online Runner has.
5. Press **Start Session**.

The Runner clones the Repo onto the Session's Work branch, builds the Environment if it hasn't yet, makes the Session's Sandbox and starts Claude Code. **Show log** on the **Starting…** banner follows along. If the Repo has no Environment yet, you set one up first: see [Set up an Environment](/how-to/set-up-an-environment/).

## Find and rename a Session

The sidebar lists every Session that isn't Archived under its Repo's `owner/name`, in the order they were started, the oldest first. Each row's dot shows the Session's state, and a spinner shows a Turn or a subagent running. A Session's [subagents](/how-to/work-with-subagents/#follow-an-agent) are listed under its row, whose chevron hides and shows them.

A Session is shown by its [Session name](/reference/glossary/), or by its Work branch until someone names it. **New Session** doesn't ask for a name. Anyone can rename a Session, in any state:

1. Press the pencil button beside the title in the Session's header, or on the Session's row in the sidebar. A row shows it while it's the open Session or you point at it.
2. Type the name and press Enter, or click elsewhere. Esc leaves the name as it was.

Everyone with the Session open sees the new name at once. A name is at most 80 characters; to show the Work branch again, clear the name. Once a Session is named, its header shows the Work branch next to the Repo.

## Prompt it together

Type a prompt and send it. While a Turn is running, a prompt from anyone waits in the Prompt queue, and Claude takes the queue in order. Each prompt in the transcript shows who sent it.

**Stop** in the prompt box stops the running Turn, for anyone in the Session. A tool call it was in the middle of shows as cut short. A Bash command isn't killed: Claude Code moves it to the background, where it runs to its end, and then starts a Turn of its own to read its output, as it does for any background command.

The Participants in a Session are shown at the top, and to Claude Code too, above its prompt box.

Claude Code runs in the Session's Sandbox, so Claude has its usual tools, and all of them run there: Bash, with background commands, file edits, WebFetch, subagents and the rest. It never asks for a permission ([ADR 0004](/reference/decisions/0004-the-sandbox-is-the-security-boundary/)). The `! <command>` shortcut in the **Terminal** runs in the Sandbox too. Its subagents show live in the transcript and the sidebar, and anyone can message or stop them: see [Work with subagents](/how-to/work-with-subagents/).

## Choose the model and effort

A Session's model and effort level are one setting for everyone in it. The button at the left of the prompt box shows it, such as **Sonnet 5.5 · High**; it shows only the model while the effort is Claude Code's default.

1. Press the button. It lists the models the Session's Runner's Claude Code has, each with a line on what it's for. **Default (recommended)** is Claude Code's own default model, named under it.
2. Pick a model, or open **Effort** and pick a level: **Low**, **Medium**, **High**, **Extra** or **Max**. The menu lists only the levels the Runner's Claude Code has. A model that takes no effort level shows **None** and drops the level that was set.

Anyone in the Session can change it, in any state but Archived. Each change shows in the transcript for everyone, such as "Alice Kim switched to Sonnet 5.5, High".

A change applies from the next Turn, never in the middle of one. While a Turn runs, the prompt box says "Sonnet 5.5 takes over when this Turn ends."; once it ends, the Runner starts Claude Code again with the new setting, resuming the same conversation in the same Sandbox, and the next prompt waits until it's back. An Asleep Session starts with the new setting when it next wakes, and a Frozen one once its Runner is back. The restart interrupts any subagents running, so while some are, the web UI asks first. A Turn that ran on another model than the one set now, such as one before a change, names its model in its footer.

The Runner passes the setting to Claude Code as `--model` and `--effort`, which last only for that run of the Session's Claude Code and are never written to its settings.

## Use the Repo's skills and CLAUDE.md

Claude Code runs in `/workspace`, the Repo's checkout, with its normal setting sources, so the Repo's own Claude Code files apply as they would in a checkout on your machine: `CLAUDE.md` files and their imports, `.claude/rules/`, skills, agents, commands, hooks and `.claude/settings.json`. Hooks and a skill's inline shell commands run in the Sandbox. Settings of yours on the Runner's machine never apply.

So does the Repo's `.mcp.json`: Claude Code starts its MCP servers without asking, and they run in the Sandbox too.

To change them, edit them in the Repo like any other file. Claude Code reads them as it always does: a `CLAUDE.md` at the start of a conversation, so a changed one reaches Claude once the conversation is cleared (`/clear` in the **Terminal**) or compacted.

## Use the terminal

The **Terminal** tab shows the Session's Claude Code screen, live, and everyone watching can type into it. Use it for what the chat doesn't handle: answering Claude Code's dialogs, Esc, Ctrl-C, arrow keys.

The terminal has one size. Whoever last typed into it, or pressed **Fit to my window**, sets it; everyone else sees it scaled down to fit. Only an Active Session has a terminal to type into.

## See its Open ports

While something listens on a TCP port in an Active Session's Sandbox, such as a dev server Claude started, the Session's header shows how many ports are open (**3 ports**). Press it for the list: each port with the addresses it listens on and the process holding it. A port a Docker container publishes shows the process `docker-proxy` and a **Docker** label. Below the list is the `claude-hub forward` command that opens the ports on `localhost` on your machine: see [Forward a Session's ports](/how-to/forward-a-sessions-ports/).

A port shows within about 2 seconds of a server starting to listen, and goes as soon after it stops. Claude Code's own login callback port is never listed. A Session that isn't Active has no Open ports: the list empties when it goes to sleep, and fills again once it wakes and its servers are running.

## Sleep and wake

A Session with no Turn or subagent running, no prompt queued and no one present, in the web UI or [forwarding its ports](/how-to/forward-a-sessions-ports/), goes to sleep after 15 minutes (the Hub's `HUB_SLEEP_AFTER_MS`). **Sleep now** in the Session's header does it at once, after asking while subagents are running. Sleeping stops Claude Code and the Sandbox, and keeps the Workspace and the Sandbox's disks; the subagents that were running are Interrupted, and resume when messaged (see [After sleep or a restart](/how-to/work-with-subagents/#after-sleep-or-a-restart)).

To keep a Session up while nobody is in it, for a dev server or a long background command, turn on **Keep awake** in its header. The header then says who turned it on, such as "Kept awake by Bob Lee", and the sidebar and the Runners page mark the Session with a sun. Anyone with access to the Repo can turn it off again, and **Sleep now** turns it off too. Turning it on wakes an Asleep Session. See [Keep awake](/explanation/session-lifecycle/#keep-awake) for what it outlives.

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
