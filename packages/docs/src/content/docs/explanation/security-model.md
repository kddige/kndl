---
title: Security model
description: What kndl protects and what it trusts - the Sandbox boundary, credentials and tokens, who can do what, and the limits of redaction.
sidebar:
  order: 5
---

kndl runs an AI agent with no approval prompts, on your machines, for a team. This page says what that trusts, and where each credential lives.

## The Sandbox is the boundary

Sessions never ask for tool approval: everything inside the Sandbox is allowed ([ADR 0004](/reference/decisions/0004-the-sandbox-is-the-security-boundary/)), so a Session runs unattended and a shared one never stalls on whoever is watching. The Sandbox, a microVM per Session, contains it.

- Claude Code runs in the Sandbox, and so does everything it runs: its tools, the `!` shortcut, hooks, MCP servers and its subagents ([ADR 0013](/reference/decisions/0013-claude-code-runs-in-the-sandbox/)). Nothing a Session does runs on the Runner's host, so what a Repo can make Claude Code do is what the Sandbox can do.
- Claude Code holds no Claude credential and no mod token there, only its Session token ([The credential proxy](#the-credential-proxy)).
- The Sandbox has **unrestricted network access**, including your LAN and the Runner's host, so agents can install packages and reach services. Treat anything a Sandbox can reach as reachable by the agent.

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
| The Setup link and Invites ([Who gets in](#who-gets-in)) | the link, with whoever it was given to; the Hub keeps a hash | Never |
| The Sandbox token, for `git` and `gh` | the Sandbox's memory | Yes, by design ([ADR 0010](/reference/decisions/0010-the-sandbox-gets-a-github-token/)) |
| A Test build's clone token, read-only and for one Repo | the environment of the Runner's one `git clone` | Never |
| Environment Variables | encrypted on the Hub if Sensitive; in the Runner's memory while needed | Yes, by design: in every process's environment |
| An Installation's header secret values, a Plugin's keys | encrypted on the Hub with `HUB_SECRETS_KEY`, with a copy for each Session that started with them | Never ([The Gateway](#the-gateway)) |

Two things reach the Sandbox by design, and anything running there can read them:

- **The Sandbox token** can push any branch of the Session's Repo and merge its pull requests, with whatever permissions the App's installation has. Protect each Repo's default branch with a ruleset. See [Git from Sessions](/explanation/git-from-sessions/).
- **Variables**, Sensitive ones included. Give a Sandbox only what its Sessions need.

## The credential proxy

Anything Claude runs in the Sandbox could read a credential Claude Code held there, so it holds none. Each Runner runs a credential proxy on its host's loopback, port `RUNNER_PROXY_PORT`, which every Sandbox reaches at `host.microsandbox.internal`, and Claude Code and its mod hold only a Session token.

- **A Session token is the only identity.** Claude Code gets it in its own process's environment, as its OAuth token and as the mod's, and it is never written to the Sandbox's disk. Every Sandbox's connection reaches the proxy from the host's own loopback address, so the proxy tells Sessions apart by token alone. A token is 32 random bytes, issued as a Session starts or wakes and revoked as it sleeps, is archived, stops or exits; the proxy keeps only its SHA-256. A request without a live token is answered 401. A restarted Runner reads the token of each Session still running back from its Claude Code, and holds it for that Session alone, answering 503 until the Hub has given the Session a new mod token.
- **It forwards three requests to Anthropic and nothing else:** `POST /v1/messages`, `POST /v1/messages/count_tokens` and `GET /v1/models`. Anything else is answered 404, its path checked after `..` is resolved. It swaps the Session token for the Session's Claude credential: a subscription token as the bearer, an API key as `x-api-key`. Responses stream back unbuffered.
- **It relays the mod's calls to the Hub,** `/mod/*`, swapping the Session token for the Session's mod token, so the mod token stays on the Runner too. Claude Code's MCP traffic to its Installations, `/gateway/*`, goes to the Hub's [Gateway](#the-gateway) the same way, streaming both ways.
- **Credentials stay in memory.** A Session's credential is its Creator's ([ADR 0015](/reference/decisions/0015-each-person-brings-their-claude-credential/)), held by the proxy while the Session's token lives and never written to disk. A Session without one uses the Runner's own, read from the owner's Keychain or a file only the Runner's user can read ([The Runner's Claude credential](/reference/configuration/#the-runners-claude-credential)).
- **Nothing secret is logged.** The proxy logs one line per request to Anthropic, under its Session: method, path, status, time and whose credential it used.

Anything in a Sandbox can read its Session token, and spend its Session's credential through the proxy while the Session is awake. It can't take the credential away, use it after the Session sleeps, or reach any API path but inference.

## The Gateway

A [Plugin](/reference/glossary/#plugin) is a remote MCP server, and Claude Code reaches it through the Hub's Gateway, never directly ([ADR 0020](/reference/decisions/0020-plugins-are-remote-mcp-servers-behind-the-hub/)). Its `.mcp.json` holds the credential proxy's address and the Session token, and nothing else secret.

- **Only the Installations on for the Session's Repo.** The Gateway answers `403` for an Installation the Session didn't start with, or that was taken off its Repo since: taking one off stops it at once. It answers `401` without the mod token of an Active Session, which the credential proxy puts in for a live Session token.
- **Turning one on takes access to its Repos.** Making or changing an Installation takes access on GitHub to every Repo it lists, as starting a Session does. A refusal reads the same whether the Repo exists or not, and an Installation on in a Repo someone can't see only says how many such Repos it lists.
- **Untouched, and not logged.** Request and answer stream both ways as they are. The Gateway drops the Session's token, cookies and forwarding headers on the way out, and the server's cookies on the way back. It logs each request's Session, Installation, method, status and time, never its content or headers.
- **No Plugin credential enters a Sandbox or a Runner.** The Hub calls the server from its own address. A Plugin that needs a key declares header secrets, such as `Authorization: Bearer {value}`, and each Installation holds its own value, which the Gateway adds to every request on the way out. A header of the same name from the Sandbox, by any case, is dropped first, so code in a Sandbox can't send its own in its place.
- **Header secret values are write-only.** The Hub encrypts them with `HUB_SECRETS_KEY` and never sends them to a browser, a Runner or a Sandbox: the web UI shows only who set each value and when, or that it needs one, and the change log names them by title. A Session runs with the values it started with, and a new one applies at its next wake or Restart. The Hub masks them in its Events and terminal frames like Sensitive values ([Redaction](#redaction)), in case a server echoes one back.
- **A value goes only to the server it was entered for.** Moving a Plugin's URL to another origin (scheme, host or port) clears every Installation's values, and changing a header secret's key or header clears its values, so an edit can't send a key elsewhere. The web UI says whose values it clears before saving.
- **OAuth tokens stay on the Hub.** An Installation of an OAuth Plugin is connected to one account by someone who may edit it (the Owner, for a global one), through the server's authorization server, with PKCE and a `state` bound to that person and Installation, used once and for at most 10 minutes. The Hub keeps the tokens and the client it registered encrypted with `HUB_SECRETS_KEY`, refreshes them itself, and never sends them to a browser, a Runner or a Sandbox, nor writes them to its log. The Gateway adds the token as it is now, so a disconnect stops running Sessions at once. It never passes the server's OAuth challenge on: no answer carries `WWW-Authenticate`, and nothing under the Installation's path, such as `/.well-known/oauth-protected-resource`, reaches the server, so Claude Code never signs in itself. Moving the Plugin to another origin drops the tokens and the client, so a URL edit can't send a token elsewhere. The Hub talks to authorization servers on `https` alone (or plain `http` to `localhost` or a loopback address, which never leaves the Hub's machine), follows no redirect from them, and reads at most 256 KiB of each answer. To send a request again once its token is refreshed, the Gateway holds the request's body, at most 4 MiB of it: a larger one is refused with `413`, so a Sandbox can't make the Hub hold more.
- **A missing value is refused, not skipped.** A request through an Installation without a value for one of its header secrets is answered `409`, naming the Installation and the secret, and is never sent to the server without it.

## Every endpoint needs a credential

Code in a Sandbox can reach the Hub, so every Hub route but sign-in, `/health`, the [`kndl` command it serves](/how-to/install-the-cli-from-a-hub/) and the web UI's files needs a credential: a sign-in cookie for people, a CLI token for a person's [`kndl` CLI](/how-to/sign-in-the-cli/) on its own endpoints, a Runner token for Runners, a mod token for one Session's mod and its MCP traffic to the [Gateway](#the-gateway). The Hub keeps only SHA-256 hashes of them and compares in constant time. See the [protocol reference](/reference/protocol/#endpoints).

Cookie-authenticated requests must come from `HUB_PUBLIC_URL`'s origin, and the cookie is `HttpOnly`, `SameSite=Lax`, host-only and `Secure` unless the Hub is on loopback over HTTP. Dev login only works with the Hub bound to loopback, and only answers loopback callers.

## Who can do what

A Session belongs to its Repo, not to its Creator ([ADR 0003](/reference/decisions/0003-sessions-belong-to-the-repo/)). Whoever has access to the Repo on GitHub sees its Sessions, and can join, prompt, stop, type into the terminal of, put to sleep, wake, delete or restore any of them. The Repo's Environment follows the same access ([ADR 0009](/reference/decisions/0009-environments/#who-can-use-an-environment-amended-in-104)): open it, run Test builds and apply versions. No one else can do either.

- **Access to a Repo** means the GitHub App is installed on it, and GitHub says you are a collaborator on it: an outside collaborator, an organization member with access through a team or the base permission, or its owner. A public Repo's other readers don't count. The Hub asks as the App's installation, which needs only the Metadata permission. Without the App (`GITHUB_APP_ID` unset), a GitHub sign-in has access to no Repo.
- **Dev login** has access to every Repo, while it is on.
- **The Hub checks every Session and Environment command** before it runs. A Session you have no access to answers as if it didn't exist, and an Environment refusal reads the same whether the Repo exists or not.
- **Shared variables belong to no Repo,** so anyone signed in can manage them. Their values are write-only, and a Link only puts one into a Repo whose Environment you can already change.
- **Answers are cached** for `HUB_REPO_ACCESS_TTL_MS`, 5 minutes by default, to stay within GitHub's rate limit; a refusal for at most 30 seconds. The Hub checks everyone connected again as often as the TTL, so someone who loses access on GitHub is taken out of the Repo's Sessions and its Environment within twice the TTL. When GitHub can't answer, people keep the access they had, and no one gains any.
- **A Test build clones with a token for its Repo only**, minted by the Hub with read access to the code and nothing else, used for that one clone and never written down. Only without the GitHub App does a Runner clone with its host's own git credentials.

## Who gets in

GitHub proves who someone is, and the Hub decides whether they get in ([ADR 0019](/reference/decisions/0019-invites-decide-who-gets-in/)). A GitHub sign-in gets in only as a Member already, as the Owner with the Hub's Setup link while it has no Owner, or with an Invite from the Owner. See [Let people in](/how-to/let-people-in/).

- **Everyone else is refused alike,** whatever they brought: an Invite used, expired, revoked, for another login or never made, or none. The page says only that the Hub is invite-only, and the Hub records nothing of them.
- **A Setup link and an Invite are secrets** in the link's fragment, which browsers never send to a server. The web UI hands one to the Hub in a `POST` just before going to GitHub, and the Hub keeps it in a cookie until GitHub sends the browser back. The Hub keeps only SHA-256 hashes of them.
- **Being a Member grants no Repo access;** GitHub decides that. Any Member can pair and remove Runners, and manage the Shared variables.
- **Only the Owner** makes, lists and revokes Invites, and lists and removes Members. The Hub refuses those commands from anyone else.
- **Removing a Member** revokes their sign-ins and CLI tokens at once, and closes their web connections and Forwards. A tunnel already open stays open until it closes.
- **Dev login** lets anyone on loopback in, without an Invite.

So the GitHub App can be public: anyone on GitHub can install it and try to sign in, and only Members get in. Still, where you can, keep the Hub on a network, tailnet or proxy that only your team can reach.

:::caution[Known gaps]
There are no roles but Owner: everyone with access to a Repo can do everything with its Sessions and Environment, and every Member can pair and remove Runners and manage the Shared variables. A prompt already queued still runs after its sender loses access or is removed.
:::

## Whose Claude account a Session spends

A Session, with its subagents, runs on its Creator's Claude account, whoever prompts it and on whichever Runner ([ADR 0015](/reference/decisions/0015-each-person-brings-their-claude-credential/)). If the Creator has stored no credential, it runs on its Runner's own; if neither has one, the Hub refuses to start it. Each Session's header says whose account it runs on. Only give a Runner a credential of its own if its owner is happy for the team to use that account.

A person's credential is write-only. The Hub checks it with Anthropic as it is saved, encrypts it with `HUB_SECRETS_KEY`, and never sends it back to a browser: its owner sees only its kind, last 4 characters and plan. The Hub sends it only to the Runner of one of that person's Sessions, over the Runner's authenticated connection, which keeps it in memory while the Session is awake. `secrets-reset` clears every stored credential with the other Sensitive values, and every Installation's header secret values.

## Redaction

The Hub masks Sensitive values, each character with `*`, in everything it stores or shows: a Session's Events (prompts, Claude's text, tool input and output, subagents included), its terminal frames, and Test build logs and results. A Session's set is its Repo's Sensitive Variables and linked Sensitive Shared variables, plus any value they replaced while a Session that started with it still runs, the header secret values of the Installations it started with, and its current and previous Sandbox tokens.

- Besides the value itself, it looks for it trimmed, JSON-escaped, URL-encoded and, for a multi-line value such as a key, each of its long lines. Matching skips terminal colour codes and line breaks, so a value wrapped on screen is still found.
- Claude's text and terminal output stream in pieces, so the end of a piece that could start a value is held back until the next one, for at most 100 ms.
- A Sensitive value must be at least 4 characters, so it can be found reliably.

Redaction has limits. It can't find a value transformed before it is printed (base64, hashed, split up by the program printing it), or one Claude Code's own screen wraps with indentation in the terminal; the transcript is still masked. What a script writes to disk, such as a token in an `.npmrc`, stays there: the Bootstrap script's in the Build, on the Runner's disk.
