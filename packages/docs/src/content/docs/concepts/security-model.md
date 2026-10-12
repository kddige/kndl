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
- No long-lived credential enters a Sandbox: not a Claude credential, not a Runner token, not the GitHub App's key.

## What reaches a Sandbox

Three things reach a Sandbox by design. Anything running there can read them.

| What | What it can do | Limit |
|---|---|---|
| **The Session token** | Spend the Session's Claude credential, through the Runner's credential proxy | Only for inference, and only while the Session is awake |
| **The Sandbox token** | Push any branch of the Session's Repo and merge its pull requests | One Repo, one hour, renewed while the Session runs. Protect the default branch with a [ruleset](/concepts/git-from-sessions/#what-a-session-can-do) |
| **Variables** | Whatever the values unlock, Sensitive ones included | Only the Repo's own and the Shared variables it links. Give a Sandbox only what its Sessions need |

## The credential proxy

Each Runner runs a credential proxy on its machine's loopback. Claude Code in the Sandbox sends every request there with its Session token, and the proxy swaps in the real Claude credential on the way to Anthropic.

- To Anthropic, it forwards inference requests and nothing else. It also relays the mod's calls to the Hub, adding the Session's mod token.
- It holds credentials in memory only, and never logs them.
- A Session token is revoked when the Session sleeps, is archived or stops.

So code in a Sandbox can spend its Session's credential while the Session is awake. It can't take the credential away, use it later, or reach any other API.

## The Gateway

Claude Code reaches [MCP servers](/reference/glossary/#mcp-server) through the Hub's Gateway, never directly ([ADR 0020](/contributing/decisions/0020-plugins-are-remote-mcp-servers-behind-the-hub/)).

- A Session reaches only the Installations turned on for its Repo. Turning one off stops it at once.
- An MCP server's keys and OAuth tokens stay on the Hub. The Gateway adds them on the way out, so they never enter a Runner or a Sandbox.
- A key goes only to the server it was entered for. Moving a server to another address clears its keys.

## Who gets in

A Hub is invite-only ([ADR 0019](/contributing/decisions/0019-invites-decide-who-gets-in/)). GitHub proves who someone is, and the Hub decides whether they get in: as a Member already, as the Owner with the Setup link, or with an Invite from the Owner. Everyone else is refused alike. See [Let people in](/self-hosting/let-people-in/).

- **Only the Owner** invites and removes Members.
- **Removing a Member** signs them out everywhere at once, and closes their connections.
- **Setup links and Invites** are secrets the Hub keeps only as hashes.

So the GitHub App can be public. Still, keep the Hub on a network, tailnet or proxy only your team can reach, where you can.

## Who can do what

A Session belongs to its Repo, not to its Creator ([ADR 0003](/contributing/decisions/0003-sessions-belong-to-the-repo/)).

- **Access to a Repo** means the GitHub App is installed on it, and GitHub says you're a collaborator. A public Repo's other readers don't count.
- **With access**, you can see, prompt, stop, type into, sleep, wake, delete and restore every Session of the Repo, and change its Environment.
- **Without access**, a Session answers as if it didn't exist.
- **Losing access on GitHub** takes you out of the Repo's Sessions within twice [`HUB_REPO_ACCESS_TTL_MS`](/reference/configuration/#hub), 10 minutes by default.
- **Any Member** can pair and remove Runners, and manage Shared variables.
- **Dev login** has access to every Repo, and works only on the Hub's own machine.

## Whose Claude account a Session spends

A Session, with its subagents, runs on its Creator's Claude account, whoever prompts it ([ADR 0015](/contributing/decisions/0015-each-person-brings-their-claude-credential/)). Without one, it runs on its Runner's own. Each Session's header says whose account it uses. Give a Runner a credential of its own only if its owner is happy for the team to spend it.

A stored Claude credential is write-only. The Hub encrypts it with `HUB_SECRETS_KEY` and sends it only to the Runner of one of its owner's Sessions.

## Redaction

The Hub masks Sensitive values in everything it stores or shows: prompts, Claude's replies, tool input and output, terminal frames and Test build logs. That covers a Repo's Sensitive Variables, linked Shared variables, MCP server keys, and the Sandbox token. It finds a value even when it's JSON-escaped, URL-encoded or wrapped across lines.

Redaction can't find a value changed before it's printed, such as base64 or split up. What a script writes to disk, such as a token in an `.npmrc`, stays there.

## What isn't protected

- **The network.** Sandboxes have unrestricted network access, including your LAN and the Runner's machine. Treat anything a Sandbox can reach as reachable by the agent.
- **The Runner's owner.** They can read the Workspaces and Claude credentials of the Sessions on their machine.
- **Roles.** There are none but Owner. Everyone with access to a Repo can do everything with its Sessions and Environment.
- **Queued prompts.** A prompt already queued still runs after its sender loses access or is removed.

## Report a vulnerability

Report it privately, as [SECURITY.md](https://github.com/kddige/kndl/blob/main/SECURITY.md) describes, never in a public issue. For how each credential is stored and checked, see [Inside kndl](/contributing/internals/#credentials).
