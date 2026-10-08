---
title: Work in a Session
description: Start, find and rename a Session, prompt it with others, answer Claude's questions, choose its model and effort, use the Repo's skills and CLAUDE.md, use its terminal, put it to sleep, delete and restore it, and get its work out.
sidebar:
  order: 8
---

A Session is one Claude Code conversation working on one Repo, on its own Work branch, in its own Sandbox. Everyone signed in to the Hub can see every Session, join it and prompt it.

## Start a Session

1. Press **New Session**, at the top of the sidebar.
2. Enter the **Repo** as `owner/name` and the **Base branch** to start from. Case doesn't matter.
3. Leave **Runner** on **Any online Runner**, or pick one. The Session runs on that Runner for its whole life, on your [Claude credential](/how-to/add-your-claude-credential/), or on the Runner's own if you have none.
4. Leave **Model** on Claude Code's default, or pick a model and effort level: see [Choose the model and effort](#choose-the-model-and-effort).
5. Press **Start Session**.

**Show log** on the **Starting…** banner follows the Runner as it clones the Repo, builds the Environment and starts Claude Code. If the Repo has no Environment yet, you set one up first: see [Set up an Environment](/how-to/set-up-an-environment/).

## Find and rename a Session

The sidebar lists every Session that isn't Archived under its Repo, oldest first. Each row's dot shows the Session's state, and a spinner shows a Turn or a subagent running. A Session's [subagents](/how-to/work-with-subagents/#follow-an-agent) are listed under its row.

A Session is shown by its [Session name](/reference/glossary/), or by its Work branch until someone names it. Anyone can rename a Session:

1. Press the pencil button beside the title in the Session's header, or on its row in the sidebar.
2. Type the name, at most 80 characters, and press Enter. Esc cancels.

To show the Work branch again, clear the name.

## Prompt it together

Type a prompt and send it. While a Turn is running, prompts from anyone wait in the Prompt queue, and Claude takes them in order. Each prompt in the transcript shows who sent it.

To have Claude read a queued prompt now, press **Steer** on it. Claude reads it at its next step in the running Turn, usually after the tool call it's in. The transcript shows it as *Steered in*, then where Claude read it. If the Turn ends before Claude reads it, Claude reads it with the next prompt. If the Hub can't hand it over, the prompt keeps its place in the queue and you're told why. See [ADR 0018](/reference/decisions/0018-steering-a-prompt-into-the-running-turn/).

**Stop** in the prompt box stops the running Turn, for anyone in the Session. A running Bash command isn't killed: Claude Code moves it to the background, and starts a Turn to read its output once it ends.

Claude has its usual tools, and all of them run in the Session's Sandbox. It never asks for a permission ([ADR 0004](/reference/decisions/0004-the-sandbox-is-the-security-boundary/)). Claude Code sees the Participants above its prompt box. For subagents, see [Work with subagents](/how-to/work-with-subagents/).

## Answer Claude's questions

When Claude asks a question, the Session's row gets an amber dot, its header says **Waiting on you**, and a card above the prompt box asks the questions one at a time. Anyone in the Session can answer:

- **Pick an option**: click it or press its number. Where a question takes several options, **Next** or **Submit** confirms them.
- **Something else**: type your own answer in the last row and press Enter.
- **Skip** leaves a question unanswered.
- ↑ and ↓ move between options, ← and → between questions.

Answering the last question sends all the answers to Claude. Until then, everyone sees what the others have picked.

To reply in your own words instead, type in the prompt box (**Or reply directly…**) and press **Reply**: Claude reads your text as what to do instead. The **×** on the card dismisses the question, and Claude stops and waits for a prompt.

The same question is in the **Terminal**, and the first answer, from either place, is the one Claude reads. A Session with an open question doesn't go to sleep. A subagent's questions show only in the **Terminal**.

## Choose the model and effort

A Session's model and effort level are one setting for everyone in it, shown on the button at the left of the prompt box, such as **Sonnet 5.5 · High**.

1. Press the button. It lists the models the Session's Runner's Claude Code has. **Default (recommended)** is Claude Code's own default.
2. Pick a model, or open **Effort** and pick a level: **Low**, **Medium**, **High**, **Extra** or **Max**.

Anyone in the Session can change it unless it's Archived, and the change shows in the transcript. It applies from the next Turn: the Runner restarts Claude Code with the new setting, resuming the same conversation, and the next prompt waits until it's back. The restart interrupts running subagents, so the web UI asks first while any run.

## Use the Repo's skills and CLAUDE.md

Claude Code runs in `/workspace`, the Repo's checkout, so the Repo's own Claude Code files apply as in a checkout on your machine: `CLAUDE.md`, `.claude/rules/`, skills, agents, commands, hooks, `.claude/settings.json` and `.mcp.json`. MCP servers start without asking. Hooks and MCP servers run in the Sandbox. Your settings on the Runner's machine never apply.

To change them, edit them in the Repo. A changed `CLAUDE.md` reaches Claude once the conversation is cleared (`/clear` in the **Terminal**) or compacted.

## Use the terminal

The **Terminal** tab shows the Session's Claude Code screen, live, and everyone can type into it. Use it for what the chat doesn't handle: Claude Code's other dialogs, a subagent's questions, Esc, Ctrl-C.

The terminal has one size, set by whoever last typed into it or pressed **Fit to my window**. Only an Active Session has a terminal.

## See its Open ports

While something listens on a TCP port in an Active Session's Sandbox, such as a dev server, the Session's header shows how many ports are open (**3 ports**). Press it for the list: each port, its addresses and the process holding it, with a **Docker** label for a port a container publishes. Below the list is the `kndl forward` command that opens them on your machine: see [Forward a Session's ports](/how-to/forward-a-sessions-ports/).

A port shows within about 2 seconds of a server starting to listen. A Session that isn't Active has no Open ports.

## Sleep and wake

A Session goes to sleep after 15 minutes (the Hub's `HUB_SLEEP_AFTER_MS`) with no Turn or subagent running, no prompt queued, no [open question](#answer-claudes-questions) and no one present, in the web UI or [forwarding its ports](/how-to/forward-a-sessions-ports/). **Sleep now** in the header does it at once. Sleeping stops Claude Code and the Sandbox and keeps the Workspace and the Sandbox's disks. Running subagents are Interrupted: see [After sleep or a restart](/how-to/work-with-subagents/#after-sleep-or-a-restart).

To keep a Session up while nobody is in it, for a dev server or a long command, turn on **Keep awake** in its header. The header says who turned it on, and the sidebar marks the Session with a sun. Anyone with access to the Repo can turn it off, and **Sleep now** turns it off too. See [Keep awake](/explanation/session-lifecycle/#keep-awake).

Any prompt wakes an Asleep Session, as does **Wake now** on its banner. Claude Code resumes the same conversation, with `node_modules`, caches and Docker's data as they were.

## When its Runner is offline

A Session whose Runner is offline is Frozen: you can read it, and prompts wait in its queue. When the Runner is back, the Session is Active again if its Claude Code kept running, or else Asleep, and woken at once if prompts are waiting.

## Delete and restore

**Delete Session**, the trash button in the Session's header, archives the Session: the Runner stops Claude Code and destroys the Sandbox, keeping the Workspace and the conversation. Any Participant can do it.

To restore it, press **Undo** in the toast, or **Restore** on it in **Archived Sessions**, in the sidebar. A restored Session is Asleep, and the next prompt wakes it in a fresh Sandbox: its `node_modules` and Docker's data are gone.

30 days after it was archived (the Hub's `HUB_ARCHIVE_RETENTION_MS`), the Session is purged from the Hub and its Runner, Workspace included.

## Get the work out

Claude can commit, push and open pull requests with `git` and `gh` once the Hub has the GitHub App: see [Git from Sessions](/explanation/git-from-sessions/).

Until work is pushed, it is only in the Workspace on the Runner. Sleep, wake, delete and restore keep it, but if the Runner's disk is lost, unpushed work is lost with it. To keep work safe, ask Claude to commit and push the Work branch.
