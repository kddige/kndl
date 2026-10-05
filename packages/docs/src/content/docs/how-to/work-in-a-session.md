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
3. Leave **Runner** on **Any online Runner**, or pick one. The Session runs on that Runner's machine, with its Claude login, for its whole life.
4. Leave **Model** on Claude Code's default, or pick a model and effort level: see [Choose the model and effort](#choose-the-model-and-effort). With **Any online Runner**, it offers only the models and levels every online Runner has.
5. Press **Start Session**.

The Runner clones the Repo onto the Session's Work branch, builds the Environment if it hasn't yet, makes the Session's Sandbox and starts Claude Code. **Show log** on the **Starting…** banner follows along. If the Repo has no Environment yet, you set one up first: see [Set up an Environment](/how-to/set-up-an-environment/).

## Find and rename a Session

The sidebar lists every Session that isn't Archived under its Repo's `owner/name`, in the order they were started, the oldest first. Each row's dot shows the Session's state, and a spinner shows a Turn running. [Child Sessions](/how-to/coordinate-with-child-sessions/#find-a-child-session) are listed under their Parent Session's row, whose chevron hides and shows them.

A Session is shown by its [Session name](/reference/glossary/), or by its Work branch until someone names it. **New Session** doesn't ask for a name. Anyone can rename a Session, in any state:

1. Press the pencil button beside the title in the Session's header, or on the Session's row in the sidebar. A row shows it while it's the open Session or you point at it.
2. Type the name and press Enter, or click elsewhere. Esc leaves the name as it was.

Everyone with the Session open sees the new name at once. A name is at most 80 characters; to show the Work branch again, clear the name. Once a Session is named, its header shows the Work branch next to the Repo.

## Prompt it together

Type a prompt and send it. While a Turn is running, a prompt from anyone waits in the Prompt queue, and Claude takes the queue in order. Each prompt in the transcript shows who sent it.

The Participants in a Session are shown at the top, and to Claude Code too, above its prompt box.

Claude's tools are limited to Bash, Read, Write, Edit and NotebookEdit, which run in the Sandbox; WebSearch, which runs at Anthropic; and the tools that hand work to Child Sessions, which ask the Hub (see [Coordinate with Child Sessions](/how-to/coordinate-with-child-sessions/)). Every other tool is denied, background commands are refused, and so is the `!` shell shortcut, which would run on the host. Claude is told so: to run a command, it uses Bash in the Sandbox rather than asking you to type `! <command>`. To have Claude read a web page, ask it to fetch the page: it uses `curl` in the Sandbox, because WebFetch is denied.

## Choose the model and effort

A Session's model and effort level are one setting for everyone in it. The button at the left of the prompt box shows it, such as **Sonnet 5.5 · High**; it shows only the model while the effort is Claude Code's default.

1. Press the button. It lists the models the Session's Runner's Claude Code has, each with a line on what it's for. **Default (recommended)** is Claude Code's own default model, named under it.
2. Pick a model, or open **Effort** and pick a level: **Low**, **Medium**, **High**, **Extra** or **Max**. The menu lists only the levels the Runner's Claude Code has. A model that takes no effort level shows **None** and drops the level that was set.

Anyone in the Session can change it, in any state but Archived. Each change shows in the transcript for everyone, such as "Alice Kim switched to Sonnet 5.5, High".

A change applies from the next Turn, never in the middle of one. While a Turn runs, the prompt box says "Sonnet 5.5 takes over when this Turn ends."; once it ends, the Runner starts Claude Code again with the new setting, resuming the same conversation in the same Sandbox, and the next prompt waits until it's back. An Asleep Session starts with the new setting when it next wakes, and a Frozen one once its Runner is back. A Turn that ran on another model than the one set now, such as one before a change, names its model in its footer.

The Runner passes the setting to Claude Code as `--model` and `--effort`, which last only for that Session's Claude Code: they never change the Runner's own `~/.claude/settings.json`. A Child Session starts on Claude Code's default.

## Use the Repo's skills and CLAUDE.md

Claude follows the Repo's `CLAUDE.md` and can use the Repo's skills, as it would in a checkout of the Repo. Each time the Session starts or wakes, the Runner reads them from the Workspace, in the Sandbox:

- `CLAUDE.md` and `.claude/CLAUDE.md` at the Repo's root, and the files they import with `@path`, when those are in the Repo too.
- Each skill's `.claude/skills/<name>/SKILL.md`. Run one with `/repo:<name>`, or with `/<name>` when no other skill has that name, or let Claude choose it. The skill's other files stay in the Workspace, where Claude reads them with its tools.

To change them, edit them in the Repo like any other file. A skill changes the next time the Session starts or wakes. A woken Session resumes its conversation with the instructions it started with, so a changed `CLAUDE.md` reaches Claude once the Session has woken and the conversation is cleared (`/clear` in the **Terminal**) or compacted.

Nothing in the Repo runs on the Runner's machine, so some files are left out:

- `CLAUDE.local.md`, `CLAUDE.md` files in subdirectories, and `.claude/rules/`.
- The Repo's `.claude/settings.json`, hooks, `.mcp.json`, agents and commands. A skill keeps only its name, `description`, `when_to_use`, `argument-hint`, `disable-model-invocation` and `user-invocable`. Other fields, such as `allowed-tools`, `hooks` and `model`, are ignored.
- A skill's inline shell commands (`` !`command` ``) don't run. Ask Claude to run the command instead.

In a skill, Claude sees a zero-width space before each `@` and between each `!` and a backtick. Claude Code acts on neither on the host, and the mod tells Claude to leave the spaces out of what it writes. If a file you expect is missing, see [Claude doesn't follow the Repo's CLAUDE.md, or a skill is missing](/troubleshooting/sessions/#claude-doesnt-follow-the-repos-claudemd-or-a-skill-is-missing).

## Use the terminal

The **Terminal** tab shows the Session's Claude Code screen, live, and everyone watching can type into it. Use it for what the chat doesn't handle: answering Claude Code's dialogs, Esc, Ctrl-C, arrow keys.

The terminal has one size. Whoever last typed into it, or pressed **Fit to my window**, sets it; everyone else sees it scaled down to fit. Only an Active Session has a terminal to type into.

## Sleep and wake

A Session with no Turn running, no prompt queued and no one present goes to sleep after 15 minutes (the Hub's `HUB_SLEEP_AFTER_MS`). **Sleep now** in the Session's header does it at once. Sleeping stops Claude Code and the Sandbox, and keeps the Workspace and the Sandbox's disks.

Any prompt wakes an Asleep Session, as does **Wake now** on its banner. Claude Code resumes the same conversation, with `node_modules`, caches and Docker's data as they were.

## When its Runner is offline

A Session whose Runner is offline is Frozen: you can read it, and prompts you send wait in its queue. When the Runner is back, the Session is Active again if its Claude Code kept running, and otherwise Asleep, and woken at once if prompts are waiting.

## Delete and restore

**Delete Session**, the trash button in the Session's header, archives the Session at once: the Runner stops Claude Code, pushes the WIP ref, and destroys the Sandbox, keeping the Workspace and Claude Code's state. Any Participant can do it. A Parent Session's Child Sessions are archived with it, so for a Parent Session the web UI lists them and asks first.

- **Undo** in the toast restores it straight away, but not its Child Sessions.
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
