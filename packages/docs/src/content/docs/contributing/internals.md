---
title: Inside kndl
description: How the parts work underneath - Claude Code in the Sandbox, Builds, the Sandbox token, the credential proxy, the Gateway and redaction - for people working on kndl or auditing it.
sidebar:
  order: 3
---

The detail behind [How kndl works](/concepts/architecture/), [Environments](/concepts/environments/), [Git from Sessions](/concepts/git-from-sessions/) and the [security model](/concepts/security-model/), for people working on kndl or auditing it. The messages between the parts are in the [protocol reference](/contributing/protocol/).

## Claude Code in the Sandbox

Each Session's Claude Code runs inside its Sandbox, so its tools run where it runs ([ADR 0013](/contributing/decisions/0013-claude-code-runs-in-the-sandbox/)). Its tools, the `!` shortcut, hooks, the Repo's `settings.json`, skills, nested `CLAUDE.md` files and subagents behave as they do on a laptop, and stay in the VM.

- **It runs in tmux in the VM,** started through the Sandbox backend's own exec, in `/workspace` with Claude Code's normal setting sources and `--dangerously-skip-permissions` ([ADR 0004](/contributing/decisions/0004-the-sandbox-is-the-security-boundary/)). Claude runs as root there, so the Runner sets `IS_SANDBOX=1`.
- **Its state is on a disk of the Session's own,** `/var/lib/kndl/claude`, as `CLAUDE_CONFIG_DIR`, so the conversation and settings survive sleep. Before each start the Runner seeds it with onboarding done, `/workspace` trusted and bypass-permissions mode accepted, so no dialog waits for a person.
- **It holds no Claude credential.** It sends every request to the Runner's [credential proxy](/concepts/security-model/#the-credential-proxy) with a token for its Session alone, and the proxy puts the real credential in its place. The token is given to the Claude Code process, never written to the VM.
- **The mod loads read-only** from `/opt/kndl/mod`, each plugin with its own `--plugin-dir`, and reaches the Hub through the same proxy, which adds the Session's mod token. It is a copy of the Runner's mod made each time Claude Code starts, so an update never changes the mod under a running Turn; a Session picks up an updated mod at its next start, wake or change of model ([ADR 0011](/contributing/decisions/0011-runners-follow-the-hubs-commit/#what-a-running-sessions-claude-code-loads-amended-in-159)).
- **Auto memory is off.** Each Session has its own state, so Sessions would never share what it remembers.
- **Agent view is off.** A background job from Claude Code's agent view, `/background` or `--bg`, would be a second Claude Code that runs each prompt again.

### How the Sandbox gets `claude`

The Runner downloads the Linux build of a pinned Claude Code version from the npm registry once, checks its integrity hash, keeps it in the home's `claude-code/` ([Files and paths](/reference/files-and-paths/)), and mounts it read-only into every Sandbox at `/opt/kndl/claude-code`. Each Build checks its image and records whether its Sandboxes use the musl build (Alpine-like images) or the glibc build (Debian, Ubuntu and the like).

The version is pinned, rather than following the host's, because Claude Code learns its plan from variables that are not a public interface. A version is pinned only after a smoke test passes: its banner names the plan, `/status` answers, and a Turn runs a Bash command.

Claude Code also needs tmux 3.2 or later and bash, which every Build installs if its image lacks them.

### What a Runner gives Claude Code

Each Session's Claude Code runs in tmux in its Sandbox, in `/workspace`, with Claude Code's normal setting sources, so the Repo's `CLAUDE.md`, skills, hooks, settings and `.mcp.json` apply ([ADR 0013](/contributing/decisions/0013-claude-code-runs-in-the-sandbox/)). Its command line is `claude` with:

- `--session-id` for a new Session, or `--resume` to wake one.
- `--plugin-dir /opt/kndl/mod/<copy>/hub-link` and `--plugin-dir /opt/kndl/mod/<copy>/hub-link-commands`, the mod's plugins ([ADR 0014](/contributing/decisions/0014-subagents-replace-child-sessions/)), from the copy of `RUNNER_MOD_DIR` made for this start, mounted read-only.
- `--dangerously-skip-permissions`: the Sandbox is the boundary ([ADR 0004](/contributing/decisions/0004-the-sandbox-is-the-security-boundary/)).
- `--model` and `--effort` when the Session's [model and effort](/guides/work-in-a-session/#choose-the-model-and-effort) are set. Neither is written to its settings.

Its environment is what the Start script gets: the package cache variables and, for a Repo with an Environment, the image's login environment with the Environment's Variables over it ([ADR 0009](/contributing/decisions/0009-environments/)). On top of it go these, the mod's and Claude Code's:

| Variable | What it is |
|---|---|
| `KNDL_SESSION_ID` | The Session's id. |
| `CLAUDE_CONFIG_DIR` | `/var/lib/kndl/claude`, Claude Code's state, on a volume of the Session's own. The Runner seeds it so Claude Code asks nothing before the conversation. |
| `IS_SANDBOX` | `1`, which lets `--dangerously-skip-permissions` run as root. |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `1`, since each Session would keep notes only for itself. It wins over any setting. |
| `CLAUDE_CODE_DISABLE_AGENT_VIEW` | `1`: no agent view, `/background`, `--bg` or background daemon, so the Session runs one Claude Code and each prompt runs once. |
| `DISABLE_INSTALLATION_CHECKS` | `1`: the Runner installs Claude Code, so `/status` doesn't ask for the native installer's `claude` command and install method. |
| `TZ` | The Runner's time zone, such as `Europe/Copenhagen`, so the times Claude Code and its tools show are yours. |

Claude Code and its mod reach Anthropic and the Hub through the [credential proxy](/concepts/security-model/#the-credential-proxy), holding only the Session token. These variables point them at it; the credential's kind decides which are set.

| Variable | What it is |
|---|---|
| `ANTHROPIC_BASE_URL`, `KNDL_URL` | The proxy as the Sandbox reaches it: `http://host.microsandbox.internal:<RUNNER_PROXY_PORT>`. |
| `KNDL_MOD_TOKEN` | The Session token. |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_AUTOUPDATER` | `1`: the proxy forwards inference alone. |
| `CLAUDE_CODE_OAUTH_TOKEN` | The Session token, for a subscription token. |
| `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`, `CLAUDE_CODE_OAUTH_SCOPES` | For a subscription token: Claude Code treats the proxy as Anthropic's API, with a setup-token's scopes. |
| `CLAUDE_CODE_SUBSCRIPTION_TYPE`, `CLAUDE_CODE_RATE_LIMIT_TIER` | For a subscription token, its plan, when known: the Creator's, or for the Runner's credential `RUNNER_CLAUDE_PLAN`. |
| `ANTHROPIC_AUTH_TOKEN` | The Session token, for an API key, in place of all the subscription variables. |

## The terminal mirror

The Session view's **Terminal** tab shows the Session's Claude Code terminal, live. Everyone watching sees the same screen and can type into it, for what the chat doesn't handle, such as Claude Code's dialogs, Esc and Ctrl-C.

- The Runner attaches to the Session's tmux in control mode (`tmux -C`). Opening the tab sends a snapshot of the pane, with its colours and cursor, then relays the pane's output. A reconnect waits for a fresh snapshot, so nothing is drawn twice.
- The terminal has one size, the tmux pane's. Whoever last typed into it or pressed **Fit to my window** sets it; everyone else sees it at that size, scaled down when it doesn't fit.
- The Hub relays keystrokes only from someone who opened the terminal, and only while the Session is Active.

## Open ports

While a Session is Active, its Runner watches what listens in its Sandbox. Every 2 seconds it reads the guest's `/proc/net/tcp` and `/proc/net/tcp6`, and when the listening sockets change it looks up the process holding each new one and sends the Hub the Session's whole list. Each port is listed once, with every address it listens on. Ports Docker publishes are held by `docker-proxy`. Claude Code's own login callback port is left out.

The Hub keeps the latest list in memory only and sends it to the web UI ([Work in a Session](/guides/work-in-a-session/#see-its-open-ports)). It drops the list as soon as the Session is no longer Active, Frozen included. Open ports don't keep a Session awake ([ADR 0016](/contributing/decisions/0016-forwarding-a-sessions-ports/)).

## Sleep, wake and Frozen, in detail

**Going to sleep.** The Runner stops Claude Code, runs `docker stop` on the Sandbox's containers so databases shut down cleanly, and stops the Sandbox, keeping its disks, Claude Code's state among them, and the Workspace. Only when the Runner reports the Session stopped does the Hub record it Asleep; prompts sent meanwhile wait, and wake it once it is.

**Exiting on its own.** A Claude Code that exits on its own leaves Keep awake on, but the Session stays Asleep, so a crashing Claude Code isn't restarted over and over; it wakes when its Runner next connects, or on the next prompt.

**A conversation never written down.** A conversation Claude Code never wrote down, because it exited too early, can't be resumed. Waking such a Session starts a fresh conversation, with the same id, on the same Workspace, and a note in the Session's history says so: the history still shows the earlier conversation, which Claude Code doesn't remember.

**Frozen.** When the Runner is back, the Session is Active if its Claude Code is still running, and otherwise Asleep, woken at once if prompts are waiting, with its running subagents Interrupted. Claude Code runs in the Sandbox, not in the Runner, so it keeps running when the Runner's connection drops and when the Runner restarts. A restarted Runner reads each Session token back from its Claude Code, and the Hub gives the Session a fresh mod token; until then the credential proxy asks that Claude Code to retry, and a running Turn carries on once it can.

## Builds

A **Build** is one version made ready on one Runner. The first time a Session needs a version its Runner hasn't built, the Runner builds it, in the Session's start log:

1. It boots a Sandbox from the Environment's image, without the Workspace.
2. It installs Docker, if the Environment turns it on.
3. It installs tmux 3.2 or later and bash with the image's package manager, if the image lacks them.
4. It runs the Bootstrap script, with the Variables available at build.
5. It reads the Login environment (below).
6. It saves the Sandbox's disk as a microsandbox snapshot, and removes the Sandbox.

Sessions boot from that snapshot in a fraction of a second, each adding only its own writes on top. A failed Build fails the Session's start, with the end of the script's output.

Builds are keyed by the version that last changed the Build, so a change to resources alone needs no new Build. Each Runner keeps the last three Builds of each Repo (`RUNNER_SANDBOX_KEEP_BUILDS`).

### Test builds

A draft that changes the Build (the image, either script, Docker, the dependency folders, or any Variable available at build, its value included) can only be applied once a **Test build** of exactly that draft has passed. On the Runner you pick, it runs the Bootstrap script, then the Start script on a fresh clone of the Repo's default branch, streams the log to the web UI, and leaves nothing behind. The clone uses a read-only token for that Repo from the Hub's GitHub App, never the Runner host's git credentials. If the App isn't installed on the Repo, the Test build fails before cloning.

The Hub records each result against a digest of the draft's build inputs, so any later change to them needs another Test build. Changes that don't affect the Build, such as resources or a Sensitive value not available at build, apply at once.

### Each Sandbox's disks

A Session's Sandbox boots from its version's Build, with:

- the Workspace mounted at `/workspace`;
- one disk for all its dependency folders, bound at each boot to every folder the Environment's patterns match, and to where one would be beside each **Next to** file, so the first install already lands on the disk;
- one disk for package caches, at `/var/cache/kndl`, with `XDG_CACHE_HOME`, `BUN_INSTALL_CACHE_DIR` and `npm_config_cache` pointing into it;
- one disk for Docker's data, when Docker is on.

A new Sandbox then runs the Start script in `/workspace`. CPUs and memory are the Environment's, capped by the Runner's `RUNNER_SANDBOX_MAX_CPUS` and `RUNNER_SANDBOX_MAX_MEMORY_MIB`, with a note in the Session when it gives less.

### The Login environment

Installers such as mise, rustup, nvm and bun's put themselves on `PATH` through `~/.bashrc` or `~/.profile`, which nothing the Runner starts would read on its own. So each process the Runner starts in a Sandbox gets the environment a terminal would, as with VS Code dev containers' `userEnvProbe`:

- After the Bootstrap script, the Build runs one interactive login shell, `bash -lic` (`sh -lc` on an image without bash), and keeps the environment it ends with in the Build, at `/var/lib/kndl/login-env.json`.
- Each new Sandbox probes again in `/workspace` once its Start script has run, so tools set up by the Repo's own files, such as a `mise.toml`, are picked up too.
- The Start script and Claude Code, and so every command Claude runs, get that environment, with the Environment's Variables over it.

The probe runs with no Variable in its environment, so it captures no value. A login shell that fails, or takes more than 60 seconds, fails the Build with the end of its output. Scripts without a `#!` line run with `bash -e` where the image has bash, and `sh -e` otherwise.

What a Session changes in its own Login environment, such as a line added to `~/.bashrc`, reaches its tools only when its Sandbox is next made from a Build, on a later version, not at an ordinary wake.

### How Variables reach a Sandbox

The Hub never sends values with a Session's start: a Runner fetches them over its WebSocket, only for an Active Session of its own or a Test build it was sent, and keeps them in memory. It passes them in the environment of each process it starts in the Sandbox, and never sets them on the VM, whose settings microsandbox stores on disk. See [Use variables and secrets](/guides/use-variables-and-secrets/) and the [security model](/concepts/security-model/#redaction).

## The Sandbox token

- **Minting.** Only the Hub holds the App's private key. A Runner asks it over its WebSocket for a token for a Session of its own, and the Hub mints a fresh installation token restricted to the Session's Repo. None is cached or shared.
- **When.** The Runner asks when the Sandbox starts or wakes, and every 45 minutes while it runs, since each token lasts an hour. If there is none (no GitHub App, or GitHub failing), the Session still starts: the Runner logs it once and asks again every five minutes.
- **Where it lives.** The Runner mounts a tmpfs at `/run/kndl` in the Sandbox (mode 0700) and writes the token to `/run/kndl/github-token` (mode 0600). It is only ever in the VM's memory: never in the VM's environment, which microsandbox stores in its database, and never on a disk.
- **Redaction.** The Hub masks the Session's current and previous token in the transcript, terminal frames and logs, like a Sensitive Variable.

In the Sandbox:

- **git.** A credential helper for `https://github.com` in the system gitconfig reads the token file, with username `x-access-token`, so `git push` and `git fetch` work anywhere in the Sandbox. It is set only if git is in the image when the token arrives, and again at each refresh.
- **gh.** `~/.config/gh/hosts.yml` links to a file beside the token that names it as `github.com`'s `oauth_token`, with `git_protocol: https`. `gh auth token` prints it; `gh auth login` isn't needed. kndl doesn't install gh: [install it in the Bootstrap script](/guides/set-up-an-environment/#write-the-bootstrap-script).

### Host git

The Runner runs git on its own host for one thing: cloning the Repo into a new Session's Workspace. With the GitHub App it uses a separate token that can only read the Repo's contents, cached until five minutes before it expires and passed to the clone in its environment. It is never written to disk, a remote URL or `.git/config`, and never logged. Hooks and fsmonitor are off.

After the clone, the Runner adds `.claude/worktrees/` to the Workspace's `.git/info/exclude`, so a `git add -A` in the Sandbox leaves [subagents' worktrees](/guides/work-with-subagents/) out.

The Runner never pushes. Work reaches GitHub only when git in the Sandbox pushes it. Until then it is in the Workspace on the Runner, which sleep, wake, archive and restore keep; losing the Runner's host loses what wasn't pushed ([ADR 0006](/contributing/decisions/0006-workspace-on-host-sandbox-disposable/)).

## Credentials

### Where each credential lives

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
| The Setup link and Invites ([Who gets in](/concepts/security-model/#who-gets-in)) | the link, with whoever it was given to; the Hub keeps a hash | Never |
| The Sandbox token, for `git` and `gh` | the Sandbox's memory | Yes, by design ([ADR 0010](/contributing/decisions/0010-the-sandbox-gets-a-github-token/)) |
| A Test build's clone token, read-only and for one Repo | the environment of the Runner's one `git clone` | Never |
| Environment Variables | encrypted on the Hub if Sensitive; in the Runner's memory while needed | Yes, by design: in every process's environment |
| An Installation's header secret values, an MCP server's keys | encrypted on the Hub with `HUB_SECRETS_KEY`, with a copy for each Session that started with them | Never ([The Gateway](#the-gateway)) |

### The credential proxy

Anything Claude runs in the Sandbox could read a credential Claude Code held there, so it holds none. Each Runner runs a credential proxy on its host's loopback, port `RUNNER_PROXY_PORT`, which every Sandbox reaches at `host.microsandbox.internal`, and Claude Code and its mod hold only a Session token.

- **A Session token is the only identity.** Claude Code gets it in its own process's environment, as its OAuth token and as the mod's, and it is never written to the Sandbox's disk. Every Sandbox's connection reaches the proxy from the host's own loopback address, so the proxy tells Sessions apart by token alone. A token is 32 random bytes, issued as a Session starts or wakes and revoked as it sleeps, is archived, stops or exits; the proxy keeps only its SHA-256. A request without a live token is answered 401. A restarted Runner reads the token of each Session still running back from its Claude Code, and holds it for that Session alone, answering 503 until the Hub has given the Session a new mod token.
- **It forwards three requests to Anthropic and nothing else:** `POST /v1/messages`, `POST /v1/messages/count_tokens` and `GET /v1/models`. Anything else is answered 404, its path checked after `..` is resolved. It swaps the Session token for the Session's Claude credential: a subscription token as the bearer, an API key as `x-api-key`. Responses stream back unbuffered.
- **It relays the mod's calls to the Hub,** `/mod/*`, swapping the Session token for the Session's mod token, so the mod token stays on the Runner too. Claude Code's MCP traffic to its Installations, `/gateway/*`, goes to the Hub's [Gateway](#the-gateway) the same way, streaming both ways.
- **Credentials stay in memory.** A Session's credential is its Creator's ([ADR 0015](/contributing/decisions/0015-each-person-brings-their-claude-credential/)), held by the proxy while the Session's token lives and never written to disk. A Session without one uses the Runner's own, read from the owner's Keychain or a file only the Runner's user can read ([The Runner's Claude credential](/reference/configuration/#the-runners-claude-credential)).
- **Nothing secret is logged.** The proxy logs one line per request to Anthropic, under its Session: method, path, status, time and whose credential it used.

Anything in a Sandbox can read its Session token, and spend its Session's credential through the proxy while the Session is awake. It can't take the credential away, use it after the Session sleeps, or reach any API path but inference.

### Every endpoint needs a credential

Code in a Sandbox can reach the Hub, so every Hub route but sign-in, `/health`, the [`kndl` command it serves](/guides/install-the-cli-from-a-hub/) and the web UI's files needs a credential: a sign-in cookie for people, a CLI token for a person's [`kndl` CLI](/guides/sign-in-the-cli/) on its own endpoints, a Runner token for Runners, a mod token for one Session's mod and its MCP traffic to the [Gateway](#the-gateway). The Hub keeps only SHA-256 hashes of them and compares in constant time. See the [protocol reference](/contributing/protocol/#endpoints).

Cookie-authenticated requests must come from `HUB_PUBLIC_URL`'s origin, and the cookie is `HttpOnly`, `SameSite=Lax`, host-only and `Secure` unless the Hub is on loopback over HTTP. Dev login only works with the Hub bound to loopback, and only answers loopback callers.

### Repo access, in detail

- **Access to a Repo** means the GitHub App is installed on it, and GitHub says you are a collaborator on it: an outside collaborator, an organization member with access through a team or the base permission, or its owner. A public Repo's other readers don't count. The Hub asks as the App's installation, which needs only the Metadata permission. Without the App (`GITHUB_APP_ID` unset), a GitHub sign-in has access to no Repo.
- **The Hub checks every Session and Environment command** before it runs. A Session you have no access to answers as if it didn't exist, and an Environment refusal reads the same whether the Repo exists or not.
- **Answers are cached** for `HUB_REPO_ACCESS_TTL_MS`, 5 minutes by default, to stay within GitHub's rate limit; a refusal for at most 30 seconds. The Hub checks everyone connected again as often as the TTL, so someone who loses access on GitHub is taken out of the Repo's Sessions and its Environment within twice the TTL. When GitHub can't answer, people keep the access they had, and no one gains any.
- **A Test build clones with a token for its Repo only**, minted by the Hub with read access to the code and nothing else, used for that one clone and never written down. Only without the GitHub App does a Runner clone with its host's own git credentials.

### Sign-in, in detail

- **Everyone else is refused alike,** whatever they brought: an Invite used, expired, revoked, for another login or never made, or none. The page says only that the Hub is invite-only, and the Hub records nothing of them.
- **A Setup link and an Invite are secrets** in the link's fragment, which browsers never send to a server. The web UI hands one to the Hub in a `POST` just before going to GitHub, and the Hub keeps it in a cookie until GitHub sends the browser back. The Hub keeps only SHA-256 hashes of them.

## The Gateway

An [MCP server](/reference/glossary/#mcp-server) is remote, and Claude Code reaches it through the Hub's Gateway, never directly ([ADR 0020](/contributing/decisions/0020-plugins-are-remote-mcp-servers-behind-the-hub/)). Its `.mcp.json` holds the credential proxy's address and the Session token, and nothing else secret.

- **Only the Installations on for the Session's Repo.** The Gateway answers `403` for an Installation the Session didn't start with, or that was taken off its Repo since: taking one off stops it at once. It answers `401` without the mod token of an Active Session, which the credential proxy puts in for a live Session token.
- **Turning one on takes access to its Repos.** Making or changing an Installation takes access on GitHub to every Repo it lists, as starting a Session does. A refusal reads the same whether the Repo exists or not, and an Installation on in a Repo someone can't see only says how many such Repos it lists.
- **Untouched, and not logged.** Request and answer stream both ways as they are. The Gateway drops the Session's token, cookies and forwarding headers on the way out, and the server's cookies on the way back. It logs each request's Session, Installation, method, status and time, never its content or headers.
- **No MCP server credential enters a Sandbox or a Runner.** The Hub calls the server from its own address. An MCP server that needs a key declares header secrets, such as `Authorization: Bearer {value}`, and each Installation holds its own value, which the Gateway adds to every request on the way out. A header of the same name from the Sandbox, by any case, is dropped first, so code in a Sandbox can't send its own in its place.
- **Header secret values are write-only.** The Hub encrypts them with `HUB_SECRETS_KEY` and never sends them to a browser, a Runner or a Sandbox: the web UI shows only who set each value and when, or that it needs one, and the change log names them by title. A Session runs with the values it started with, and a new one applies at its next wake or Restart. The Hub masks them in its Events and terminal frames like Sensitive values ([Redaction](#redaction)), in case a server echoes one back.
- **A value goes only to the server it was entered for.** Moving an MCP server's URL to another origin (scheme, host or port) clears every Installation's values, and changing a header secret's key or header clears its values, so an edit can't send a key elsewhere. The web UI says whose values it clears before saving.
- **OAuth tokens stay on the Hub.** An Installation of an OAuth MCP server is connected to one account by someone who may edit it (the Owner, for a global one), through the server's authorization server, with PKCE and a `state` bound to that person and Installation, used once and for at most 10 minutes. The Hub keeps the tokens and the client, the one it registered or the one someone entered for an authorization server without Dynamic Client Registration, encrypted with `HUB_SECRETS_KEY`, refreshes them itself, and never sends them to a browser, a Runner or a Sandbox, nor writes them to its log. A client secret entered is write-only: the browser learns only the client's ID and whether it has a secret, the secret goes only to the authorization server's token endpoint, and the Gateway redacts it, with the tokens, from what a Session sees. Entering a client takes the same rights as connecting, and the change log records who did, never the secret. The Gateway adds the token as it is now, so a disconnect stops running Sessions at once. It never passes the server's OAuth challenge on: no answer carries `WWW-Authenticate`, and nothing under the Installation's path, such as `/.well-known/oauth-protected-resource`, reaches the server, so Claude Code never signs in itself. Moving the MCP server to another origin drops the tokens and the client, so a URL edit can't send a token or a client secret elsewhere. The Hub talks to authorization servers on `https` alone (or plain `http` to `localhost` or a loopback address, which never leaves the Hub's machine), follows no redirect from them, and reads at most 256 KiB of each answer. To send a request again once its token is refreshed, the Gateway holds the request's body, at most 4 MiB of it: a larger one is refused with `413`, so a Sandbox can't make the Hub hold more.
- **A missing value is refused, not skipped.** A request through an Installation without a value for one of its header secrets is answered `409`, naming the Installation and the secret, and is never sent to the server without it.

## Redaction

The Hub masks Sensitive values, each character with `*`, in everything it stores or shows: a Session's Events (prompts, Claude's text, tool input and output, subagents included), its terminal frames, and Test build logs and results. A Session's set is its Repo's Sensitive Variables and linked Sensitive Shared variables, plus any value they replaced while a Session that started with it still runs, the header secret values of the Installations it started with, and its current and previous Sandbox tokens.

- Besides the value itself, it looks for it trimmed, JSON-escaped, URL-encoded and, for a multi-line value such as a key, each of its long lines. Matching skips terminal colour codes and line breaks, so a value wrapped on screen is still found.
- Claude's text and terminal output stream in pieces, so the end of a piece that could start a value is held back until the next one, for at most 100 ms.
- A Sensitive value must be at least 4 characters, so it can be found reliably.

Redaction has limits. It can't find a value transformed before it is printed (base64, hashed, split up by the program printing it), or one Claude Code's own screen wraps with indentation in the terminal; the transcript is still masked. What a script writes to disk, such as a token in an `.npmrc`, stays there: the Bootstrap script's in the Build, on the Runner's disk.
