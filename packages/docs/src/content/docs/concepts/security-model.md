---
title: Security model
description: What kndl isolates, what it trusts, and what it doesn't protect, for deciding whether to run it for your team.
sidebar:
  order: 5
---

kndl runs an AI agent with no approval prompts, on your machines, for a team. This page says what that isolates, what it trusts, and what it leaves to you.

## What's isolated

**The Sandbox is the boundary** ([ADR 0004](/contributing/decisions/0004-the-sandbox-is-the-security-boundary/)). Sessions never ask for approval, so a Session runs unattended and a shared one never waits on whoever is watching. Instead, each Session runs in its own microVM.

- Claude Code runs in the Sandbox, and so does everything it starts: its tools, hooks, MCP servers and subagents ([ADR 0013](/contributing/decisions/0013-claude-code-runs-in-the-sandbox/)). Nothing a Session does runs on the Runner's machine.
- Each Session has its own Sandbox, Workspace and disks.
- No credential of kndl's own enters a Sandbox: not a Runner token, not a mod token, not the GitHub App's key.

## What reaches a Sandbox

Four things reach a Sandbox by design. Anything running there can read them.

| What | What it can do | Limit |
|---|---|---|
| **The Creator's setup token** | Make model requests on the Creator's Claude subscription, from anywhere | Lasts a year. Only the Creator prompts Claude. See [The Creator's token](#the-creators-token) |
| **The Session token** | Reach the Hub as the Session's mod, through the Runner's mod relay | Only `/mod/*` and the Session's MCP servers, and only while the Session is awake |
| **The Sandbox token** | Push any branch of the Session's Repo and merge its pull requests | One Repo, one hour, renewed while the Session runs. Protect the default branch with a [ruleset](/concepts/git-from-sessions/#what-a-session-can-do) |
| **Variables** | Whatever the values unlock, Sensitive ones included | Only the Repo's own and the Shared variables it links. Give a Sandbox only what its Sessions need |

## The Creator's token

A Session runs on its Creator's own `claude setup-token` token ([ADR 0026](/contributing/decisions/0026-a-session-runs-on-and-is-driven-by-its-creator/)). As the Session starts or wakes, its Runner fetches the token from the Hub and gives it to Claude Code's own process as `CLAUDE_CODE_OAUTH_TOKEN`. Claude Code talks to Anthropic directly.

- **It's never written to the Sandbox's disk.** It lives in the Claude Code process's environment.
- **Anything in the Sandbox can read it.** Claude runs as root there, so Claude and whatever it runs, such as the Repo's hooks, plugins and dependencies, can read the token and use it anywhere.
- **Only the Creator can ask Claude for it.** Only they prompt the Session, so this is the risk of running your own Claude Code on your own token. Start Sessions only on Repos you trust.
- **Runner owners can read it too,** as they can read the Workspaces of the Sessions they run.

[Replacing or removing](/guides/add-your-claude-credential/#replace-or-remove-it) your token on the **Account** page puts your awake Sessions to sleep. It doesn't revoke the token with Anthropic.

## The mod relay

The mod reaches the Hub through a relay on the Runner's machine, on its loopback. The Sandbox never needs a route to the Hub.

- The mod and Claude Code's MCP traffic send `/mod/*` and `/gateway/*` there with the Session token. The relay swaps in the Session's mod token on the way to the Hub, so the mod token stays on the Runner.
- It relays nothing else. It doesn't reach Anthropic.
- A Session token is revoked when the Session sleeps, is archived or stops.

## The Gateway

Claude Code reaches [MCP servers](/reference/glossary/#mcp-server) through the Hub's Gateway, never directly ([ADR 0020](/contributing/decisions/0020-plugins-are-remote-mcp-servers-behind-the-hub/)).

- A Session reaches only the Installations turned on for its Repo. Turning one off stops it at once.
- An MCP server's keys and OAuth tokens stay on the Hub. The Gateway adds them on the way out, so they never enter a Runner or a Sandbox.
- A key goes only to the server it was entered for. Moving a server to another address clears its keys.

## Who gets in

A Hub is invite-only ([ADR 0019](/contributing/decisions/0019-invites-decide-who-gets-in/)). GitHub proves who someone is, and the Hub decides whether they get in: as a Member already, as the Owner with the Setup link, or with an Invite from the Owner. Everyone else is refused alike. See [Let people in](/self-hosting/let-people-in/).

- **Only the Owner** invites and removes Members.
- **Removing a Member** signs them out everywhere at once, closes their connections, and puts their awake Sessions to sleep.
- **Setup links and Invites** are secrets the Hub keeps only as hashes.

So the GitHub App can be public. Still, keep the Hub on a network, tailnet or proxy only your team can reach, where you can.

## Who can do what

A Session's Repo decides who sees it, and its Creator is the only one who drives it ([ADR 0026](/contributing/decisions/0026-a-session-runs-on-and-is-driven-by-its-creator/)).

- **Access to a Repo** means the GitHub App is installed on it, and GitHub says you're a collaborator. A public Repo's other readers don't count.
- **With access**, you watch every Session of the Repo: its transcript, live or Archived, and its Attachments. You can forward its ports. You can change the Repo's Environment.
- **As a Session's Creator**, you also drive it: prompt it, steer and cancel its queued prompts, answer its questions, stop its Turns and subagents, and use its terminal. Sleep, wake, Keep awake, restart, the model and effort, rename, delete and restore are yours alone too.
- **Without access**, a Session answers as if it didn't exist.
- **Losing access on GitHub** takes you out of the Repo's Sessions within twice [`HUB_REPO_ACCESS_TTL_MS`](/reference/configuration/#hub), 10 minutes by default.
- **Any Member** can pair and remove Runners, and manage Shared variables.
- **Dev login** has access to every Repo, and works only on the Hub's own machine.

## Whose Claude account a Session spends

A Session, with its subagents, runs on its Creator's Claude account, and only the Creator's prompts reach it. A Runner has no Claude credential of its own, so a Session whose Creator has none doesn't start or wake.

A stored Claude credential is write-only. The Hub encrypts it with `HUB_SECRETS_KEY` and sends it only to the Runner of one of its owner's Sessions, as that Session starts or wakes. Removing a Member stops that: their awake Sessions go to sleep, and the Hub won't hand their token out again.

## Redaction

The Hub masks Sensitive values in everything it stores or shows: prompts, Claude's replies, tool input and output, terminal frames and Test build logs. That covers a Repo's Sensitive Variables, linked Shared variables, MCP server keys, the Sandbox token, and the Creator's setup token. It finds a value even when it's JSON-escaped, URL-encoded or wrapped across lines.

Redaction can't find a value changed before it's printed, such as base64 or split up. What a script writes to disk, such as a token in an `.npmrc`, stays there. The terminal is where a token is easiest to see, so only the Creator sees a Session's terminal.

## What isn't protected

- **The network.** Sandboxes have unrestricted network access, including your LAN and the Runner's machine. Treat anything a Sandbox can reach as reachable by the agent.
- **The Creator's token in the Sandbox.** Code in the Sandbox can read it, as above.
- **The Runner's owner.** They can read the Workspaces and Claude credentials of the Sessions on their machine.
- **Roles.** There are none but Owner and Creator. Everyone with access to a Repo can change its Environment.
- **Queued prompts.** A prompt already queued still runs after its Creator loses access to the Repo.

## Report a vulnerability

Report it privately, as [SECURITY.md](https://github.com/kddige/kndl/blob/main/SECURITY.md) describes, never in a public issue. For how each credential is stored and checked, see [Inside kndl](/contributing/internals/#credentials).
