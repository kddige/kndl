---
title: Security model
description: What claude-hub protects and what it trusts - the Sandbox boundary, credentials and tokens, who can do what, and the limits of redaction.
sidebar:
  order: 5
---

claude-hub runs an AI agent with no approval prompts, on your machines, for a team. This page says what that trusts, and what keeps each credential where it belongs.

## The Sandbox is the boundary

Sessions never ask for tool approval: everything inside the Sandbox is allowed ([ADR 0004](/reference/decisions/0004-the-sandbox-is-the-security-boundary/)). That lets a Session run unattended, and keeps a shared Session from stalling on whoever happens to be watching. The Sandbox, a microVM per Session, is what contains it.

- Every file and command tool runs in the Sandbox, never on the Runner's host, and a tool whose bridge is down is refused rather than run on the host ([ADR 0001](/reference/decisions/0001-claude-on-host-tools-in-sandbox/)).
- Claude Code starts with a fixed tool list, no MCP servers and no setting sources, from an empty directory, so nothing in the Repo (a `CLAUDE.md`'s `@`-mentions, hooks, `.mcp.json`) runs on the host.
- The Sandbox has **unrestricted network access**, including your LAN and the Runner's host, so agents can install packages and reach services. Treat anything a Sandbox can reach as reachable by the agent. Tightening this is a planned, additive change.

## Where each credential lives

| Credential | Lives on | Reaches a Sandbox? |
|---|---|---|
| The Runner login (Claude credentials) | each Runner | Never |
| The GitHub App's private key and client secret | the Hub | Never |
| `HUB_SECRETS_KEY` | the Hub | Never |
| Runner tokens | the Runner, as `RUNNER_TOKEN`; the Hub keeps a hash | Never; kept out of tmux and Claude Code's environment too |
| Mod tokens, one per run of a Session | Claude Code's environment on the Runner; the Hub keeps a hash | Never |
| Sign-in cookies | the browser; the Hub keeps a hash | Never |
| The Sandbox token, for `git` and `gh` | the Sandbox's memory | Yes, by design ([ADR 0010](/reference/decisions/0010-the-sandbox-gets-a-github-token/)) |
| Environment Variables | encrypted on the Hub if Sensitive; in the Runner's memory while needed | Yes, by design: in every process's environment |

Two things deliberately do reach the Sandbox, and anything running there can read them:

- **The Sandbox token** can push any branch of the Session's Repo and merge its pull requests, with whatever permissions the App's installation has. Protect each Repo's default branch with a ruleset. See [Git from Sessions](/explanation/git-from-sessions/).
- **Variables**, Sensitive ones included. Give a Sandbox only what its Sessions need.

## Every endpoint needs a credential

Code in a Sandbox can reach the Hub's address, so every Hub route but sign-in, `/health` and the web UI's files needs a credential: a sign-in cookie for people, a Runner token for Runners, a mod token for one Session's mod. The Hub keeps only SHA-256 hashes of them and compares in constant time. See the [protocol reference](/reference/protocol/#endpoints).

Cookie-authenticated requests must come from `HUB_PUBLIC_URL`'s origin, and the cookie is `HttpOnly`, `SameSite=Lax`, host-only and `Secure` unless the Hub is on loopback over HTTP. Dev login only works with the Hub bound to loopback, and only answers loopback callers.

## Who can do what

Today, everyone who can sign in is equal:

- Any signed-in person sees every Session, and can join, prompt, type into the terminal of, put to sleep or delete any of them. A Session belongs to its Repo, not to its Creator ([ADR 0003](/reference/decisions/0003-sessions-belong-to-the-repo/)).
- Any signed-in person can change any Repo's Environment and the Shared variables.

GitHub sign-in admits anyone with a GitHub account who can reach the Hub's sign-in page, so keep the Hub on a network, tailnet or proxy that only your team can reach.

:::caution[Known gaps]
Checking that a person has access to a Repo before showing or starting its Sessions is planned but not yet enforced, and there are no roles yet. Until then, treat everyone who can sign in to the Hub as trusted with every Repo the GitHub App is installed on.
:::

## Every Session on a Runner uses its login

A Session runs on its Runner's Claude account, the Runner login, whoever prompts it ([ADR 0002](/reference/decisions/0002-sessions-use-the-runner-login/)). It is shown on every Session, so everyone knows whose account a Session spends. Only connect a Runner whose owner is happy for the team to use its account.

## Redaction

The Hub masks Sensitive values, each character with `*`, in everything it stores or shows: a Session's Events (prompts, Claude's text, tool input and output, subagents included), its terminal frames, and Test build logs and results. A Session's set is its Repo's Sensitive Variables and linked Sensitive Shared variables, plus any value they replaced while a Session that started with it still runs, and its current and previous Sandbox tokens.

- Besides the value itself, it looks for it trimmed, JSON-escaped, URL-encoded and, for a multi-line value such as a key, each of its long lines. Matching skips terminal colour codes and line breaks, so a value wrapped on screen is still found.
- Claude's text and terminal output stream in pieces, so the end of a piece that could start a value is held back until the next one, for at most 100 ms.
- A Sensitive value must be at least 4 characters, so it can be found reliably.

Redaction has limits. It can't find a value transformed before it is printed (base64, hashed, split up by the program printing it), or one Claude Code's own screen wraps with indentation in the terminal; the transcript is still masked. What a script writes to disk, such as a token in an `.npmrc`, stays there: the Bootstrap script's in the Build, on the Runner's disk.
