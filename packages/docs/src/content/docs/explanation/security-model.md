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
- Auto memory is off. Claude Code would write its notes with its file tools, so they would land in the Sandbox and be lost with it, while it reads memory from the Runner's host. Each Session has its own directory too, so Sessions would never share it.
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
| A Test build's clone token, read-only and for one Repo | the environment of the Runner's one `git clone` | Never |
| Environment Variables | encrypted on the Hub if Sensitive; in the Runner's memory while needed | Yes, by design: in every process's environment |

Two things deliberately do reach the Sandbox, and anything running there can read them:

- **The Sandbox token** can push any branch of the Session's Repo and merge its pull requests, with whatever permissions the App's installation has. Protect each Repo's default branch with a ruleset. See [Git from Sessions](/explanation/git-from-sessions/).
- **Variables**, Sensitive ones included. Give a Sandbox only what its Sessions need.

## Every endpoint needs a credential

Code in a Sandbox can reach the Hub's address, so every Hub route but sign-in, `/health` and the web UI's files needs a credential: a sign-in cookie for people, a Runner token for Runners, a mod token for one Session's mod. The Hub keeps only SHA-256 hashes of them and compares in constant time. See the [protocol reference](/reference/protocol/#endpoints).

Cookie-authenticated requests must come from `HUB_PUBLIC_URL`'s origin, and the cookie is `HttpOnly`, `SameSite=Lax`, host-only and `Secure` unless the Hub is on loopback over HTTP. Dev login only works with the Hub bound to loopback, and only answers loopback callers.

## Who can do what

A Session belongs to its Repo, not to its Creator ([ADR 0003](/reference/decisions/0003-sessions-belong-to-the-repo/)). Whoever has access to the Repo on GitHub sees its Sessions, and can join, prompt, stop, type into the terminal of, put to sleep, wake, delete or restore any of them. No one else can.

The Repo's Environment follows the same access ([ADR 0009](/reference/decisions/0009-environments/#who-can-use-an-environment-amended-in-104)). Whoever has access to the Repo can open its Environment, run Test builds of drafts and apply new versions. No one else can.

- **Access to a Repo** means the GitHub App is installed on it, and GitHub says you are a collaborator on it: an outside collaborator, an organization member with access through a team or the organization's base permission, or its owner. A public Repo's other readers don't count. The Hub asks as the App's installation, which needs no permission beyond Metadata. Without the App (`GITHUB_APP_ID` unset), a GitHub sign-in has access to no Repo.
- **Dev login** has access to every Repo, while it is on.
- **The Hub checks every Session command** before it runs, in one place: the Session list and its updates, joining and the event log, prompts, Stop, the terminal, sleep and wake, delete and restore, and starting a Session in a Repo. A Session you have no access to answers as if it didn't exist.
- **It checks every Environment command too:** opening an Environment, checking a draft, starting a Test build and applying a version. A refusal reads the same whether the Repo exists or not, so it doesn't tell anyone which Repos exist or have an Environment.
- **Shared variables belong to no Repo,** so anyone signed in can manage them. Their values are write-only, and a Link only puts one into a Repo whose Environment you can already change.
- **Answers are cached** for `HUB_REPO_ACCESS_TTL_MS`, 5 minutes by default, to stay well within GitHub's rate limit. A refusal is cached for at most 30 seconds, so a Repo that was just shared with you or had the App installed works again soon. As often as the TTL, the Hub checks everyone connected again. So someone who loses access on GitHub is taken out of the Repo's Sessions and its Environment within twice the TTL: they leave its Sessions' presence and terminals, and the Sessions and the Environment screen leave their view. When GitHub can't answer, people keep the access they had, and no one gains any until it can.
- **A Test build clones with a token for its Repo only**, minted by the Hub with read access to the code and nothing else. The Runner passes it to git for that one clone and never writes it down. Only without the GitHub App does a Runner clone with its host's own git credentials, as it does for Sessions.

GitHub sign-in admits anyone with a GitHub account who can reach the Hub's sign-in page. They see no Session without access to its Repo, but still keep the Hub on a network, tailnet or proxy that only your team can reach.

:::caution[Known gaps]
There are no roles: everyone with access to a Repo can do everything with its Sessions and Environment, and any signed-in person can manage the Shared variables. A prompt already queued still runs after its sender loses access.
:::

## Every Session on a Runner uses its login

A Session runs on its Runner's Claude account, the Runner login, whoever prompts it ([ADR 0002](/reference/decisions/0002-sessions-use-the-runner-login/)). It is shown on every Session, so everyone knows whose account a Session spends. Only connect a Runner whose owner is happy for the team to use its account.

## Redaction

The Hub masks Sensitive values, each character with `*`, in everything it stores or shows: a Session's Events (prompts, Claude's text, tool input and output, subagents included), its terminal frames, and Test build logs and results. A Session's set is its Repo's Sensitive Variables and linked Sensitive Shared variables, plus any value they replaced while a Session that started with it still runs, and its current and previous Sandbox tokens.

- Besides the value itself, it looks for it trimmed, JSON-escaped, URL-encoded and, for a multi-line value such as a key, each of its long lines. Matching skips terminal colour codes and line breaks, so a value wrapped on screen is still found.
- Claude's text and terminal output stream in pieces, so the end of a piece that could start a value is held back until the next one, for at most 100 ms.
- A Sensitive value must be at least 4 characters, so it can be found reliably.

Redaction has limits. It can't find a value transformed before it is printed (base64, hashed, split up by the program printing it), or one Claude Code's own screen wraps with indentation in the terminal; the transcript is still masked. What a script writes to disk, such as a token in an `.npmrc`, stays there: the Bootstrap script's in the Build, on the Runner's disk.
