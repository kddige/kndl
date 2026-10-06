---
title: Security model
description: What kndl protects and what it trusts - the Sandbox boundary, credentials and tokens, who can do what, and the limits of redaction.
sidebar:
  order: 5
---

kndl runs an AI agent with no approval prompts, on your machines, for a team. This page says what that trusts, and what keeps each credential where it belongs.

## The Sandbox is the boundary

Sessions never ask for tool approval: everything inside the Sandbox is allowed ([ADR 0004](/reference/decisions/0004-the-sandbox-is-the-security-boundary/)). That lets a Session run unattended, and keeps a shared Session from stalling on whoever happens to be watching. The Sandbox, a microVM per Session, is what contains it.

- Claude Code runs in the Sandbox, and so does everything it runs: its tools, the `!` shortcut, hooks, MCP servers and its subagents ([ADR 0013](/reference/decisions/0013-claude-code-runs-in-the-sandbox/)). Nothing a Session does runs on the Runner's host, so what a Repo can make Claude Code do, through its `settings.json`, hooks or skills, is what the Sandbox can do.
- Claude Code holds no Claude credential and no mod token there, only its Session token ([The credential proxy](#the-credential-proxy)).
- Auto memory is off. Each Session has its own Claude Code state, so Sessions would never share what it remembers.
- The Sandbox has **unrestricted network access**, including your LAN and the Runner's host, so agents can install packages and reach services. Treat anything a Sandbox can reach as reachable by the agent. Tightening this is a planned, additive change.

## Where each credential lives

| Credential | Lives on | Reaches a Sandbox? |
|---|---|---|
| A person's Claude credential, a subscription token or API key | encrypted on the Hub with `HUB_SECRETS_KEY`; the credential proxy's memory while one of their Sessions is awake | Never ([The credential proxy](#the-credential-proxy)) |
| The Runner's own Claude credential, for Sessions without their Creator's | the Runner owner's Keychain or a private file; the credential proxy's memory | Never ([The credential proxy](#the-credential-proxy)) |
| Session tokens, one per run of a Session | the credential proxy's memory, as SHA-256 hashes | Yes, by design: they stand in for the Claude credential and the mod token |
| The GitHub App's private key and client secret | the Hub | Never |
| `HUB_SECRETS_KEY` | the Hub | Never |
| Runner tokens | the Runner, as `RUNNER_TOKEN`; the Hub keeps a hash | Never |
| Mod tokens, one per run of a Session | the Runner's memory; the Hub keeps a hash | Never ([The credential proxy](#the-credential-proxy)) |
| Sign-in cookies | the browser; the Hub keeps a hash | Never |
| CLI tokens, one per machine signed in with `kndl login` | that machine's `cli.json`, readable only by its user; the Hub keeps a hash | Never |
| The Sandbox token, for `git` and `gh` | the Sandbox's memory | Yes, by design ([ADR 0010](/reference/decisions/0010-the-sandbox-gets-a-github-token/)) |
| A Test build's clone token, read-only and for one Repo | the environment of the Runner's one `git clone` | Never |
| Environment Variables | encrypted on the Hub if Sensitive; in the Runner's memory while needed | Yes, by design: in every process's environment |

Two things deliberately do reach the Sandbox, and anything running there can read them:

- **The Sandbox token** can push any branch of the Session's Repo and merge its pull requests, with whatever permissions the App's installation has. Protect each Repo's default branch with a ruleset. See [Git from Sessions](/explanation/git-from-sessions/).
- **Variables**, Sensitive ones included. Give a Sandbox only what its Sessions need.

## The credential proxy

Claude Code runs in the Sandbox ([ADR 0013](/reference/decisions/0013-claude-code-runs-in-the-sandbox/)), where anything Claude runs could read a credential it held. So it holds none: each Runner runs a credential proxy on its host's loopback, port `RUNNER_PROXY_PORT`, which every Sandbox reaches at `host.microsandbox.internal`, and Claude Code and its mod hold only a Session token.

- **A Session token is the only identity.** Claude Code gets it in its own process's environment, as its OAuth token and as the mod's, and it is never written to the Sandbox's disk. Every Sandbox's connection reaches the proxy from the host's own loopback address, so the proxy tells Sessions apart by token alone. A token is 32 random bytes, issued as a Session starts or wakes and revoked as it sleeps, is archived, stops or exits; the proxy keeps only its SHA-256. A request without a live token is answered 401. A restarted Runner reads the token of each Session still running back from its Claude Code, and holds it for that Session alone, answering 503 until the Hub has given the Session a new mod token.
- **It forwards three requests to Anthropic and nothing else:** `POST /v1/messages`, `POST /v1/messages/count_tokens` and `GET /v1/models`, the ones Claude Code sends. Anything else is answered 404, its path checked after `..` is resolved. It swaps the Session token for the Session's Claude credential: a subscription token as the bearer, an API key as `x-api-key`. A response streams back as it comes, with nothing buffered.
- **It relays the mod's calls to the Hub,** `/mod/*`, swapping the Session token for the Session's mod token, so the mod token stays on the Runner too.
- **Credentials stay in memory.** A Session's credential is its Creator's ([ADR 0015](/reference/decisions/0015-each-person-brings-their-claude-credential/)), held by the proxy for as long as the Session's token lives and dropped when it is revoked, never written to disk. A Session without one uses the Runner's own, read from the owner's Keychain or a file only the Runner's user can read ([The Runner's Claude credential](/reference/configuration/#the-runners-claude-credential)).
- **Nothing secret is logged.** The proxy logs one line per request to Anthropic, under its Session: method, path, status, time and whose credential it went with. Never a credential, a mod token or a Session token.

Anything in a Sandbox can read its Session token, and spend its Session's credential through the proxy while the Session is awake. It can't take the credential away, use it after the Session sleeps, or reach any API path but inference.

## Every endpoint needs a credential

Code in a Sandbox can reach the Hub's address, so every Hub route but sign-in, `/health`, the [`kndl` command it serves](/how-to/install-the-cli-from-a-hub/) and the web UI's files needs a credential: a sign-in cookie for people, a CLI token for a person's [`kndl` CLI](/how-to/sign-in-the-cli/) on its own endpoints, a Runner token for Runners, a mod token for one Session's mod. The Hub keeps only SHA-256 hashes of them and compares in constant time. See the [protocol reference](/reference/protocol/#endpoints).

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

## Whose Claude account a Session spends

A Session runs on its Creator's Claude account, whoever prompts it, on whichever Runner it is on ([ADR 0015](/reference/decisions/0015-each-person-brings-their-claude-credential/)). So do its subagents, which run in its Claude Code. A Session whose Creator has stored no credential runs on its Runner's own instead, if it has one, and the Hub refuses to start a Session when neither has one. Each Session's header says whose account it runs on, so everyone knows whose account a prompt spends. Only give a Runner a credential of its own if its owner is happy for the team to use that account; a Runner needs none.

A person's credential is write-only. The Hub checks it with Anthropic as it is saved, encrypts it with `HUB_SECRETS_KEY`, and never sends it back to a browser: its owner sees only its kind, its last 4 characters and its plan. It goes to one place, a Runner asking for it for a Session of that person's that runs on that Runner, over the Runner's authenticated connection. The Runner keeps it in memory for as long as the Session is awake and never writes it to disk. `secrets-reset` clears every stored credential with the other Sensitive values.

## Redaction

The Hub masks Sensitive values, each character with `*`, in everything it stores or shows: a Session's Events (prompts, Claude's text, tool input and output, subagents included), its terminal frames, and Test build logs and results. A Session's set is its Repo's Sensitive Variables and linked Sensitive Shared variables, plus any value they replaced while a Session that started with it still runs, and its current and previous Sandbox tokens.

- Besides the value itself, it looks for it trimmed, JSON-escaped, URL-encoded and, for a multi-line value such as a key, each of its long lines. Matching skips terminal colour codes and line breaks, so a value wrapped on screen is still found.
- Claude's text and terminal output stream in pieces, so the end of a piece that could start a value is held back until the next one, for at most 100 ms.
- A Sensitive value must be at least 4 characters, so it can be found reliably.

Redaction has limits. It can't find a value transformed before it is printed (base64, hashed, split up by the program printing it), or one Claude Code's own screen wraps with indentation in the terminal; the transcript is still masked. What a script writes to disk, such as a token in an `.npmrc`, stays there: the Bootstrap script's in the Build, on the Runner's disk.
