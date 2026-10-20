---
title: Inside kndl
description: How the parts work underneath - the agent in the Sandbox, Builds, the Sandbox token, the Creator's token, the mod relay, the Gateway and redaction - for people working on kndl or auditing it.
sidebar:
  order: 3
---

The detail behind [How kndl works](/concepts/architecture/), [Environments](/concepts/environments/), [Git from Sessions](/concepts/git-from-sessions/) and the [security model](/concepts/security-model/), for people working on kndl or auditing it. The messages between the parts are in the [protocol reference](/contributing/protocol/).

## The agent in the Sandbox

Each Session's agent runs inside its Sandbox, so its tools run where it runs ([ADR 0013](/contributing/decisions/0013-claude-code-runs-in-the-sandbox/)). The agent is the durable agent: one headless Node.js process built on Pi Durable, the same for every Model. Its design is in [Pi Durable as kndl's only Harness](https://github.com/kddige/kndl/blob/main/docs/design/durable-harness.md), a spike, and its recovery rules are in the [mod's README](https://github.com/kddige/kndl/blob/main/packages/mod/durable/README.md#recovery-contract).

- **It runs in tmux in the VM,** in a session of its own, `<name>-agent`, started through the Sandbox backend's own exec, in `/workspace`. It runs as root, and asks nothing before a tool runs ([ADR 0004](/contributing/decisions/0004-the-sandbox-is-the-security-boundary/)).
- **The terminal is another tmux session,** `<name>`, a plain `bash -l` in `/workspace` that starts again when it exits. Only that one is mirrored to the web.
- **Its state is on a disk of the Session's own,** `/var/lib/kndl/claude`, as `KNDL_STATE_DIR`: its SQLite storage, `durable/session.sqlite`, and its log, `durable/agent.log`. The conversation survives sleep, a restart and the agent crashing. One process owns the database at a time, and the Runner starts at most one.
- **It runs on the pinned Node.js,** `node /opt/kndl/mod/<copy>/durable/agent.js`, mounted read-only. The copy is made each time the agent starts, so an update never changes the agent under a running Turn; a Session picks up an updated mod at its next start or wake ([ADR 0011](/contributing/decisions/0011-runners-follow-the-hubs-commit/#what-a-running-sessions-claude-code-loads-amended-in-159)). Its `@earendil-works/*` imports resolve through a `node_modules` symlink in the copy into the Pi Durable install mounted at `/opt/kndl/pi`.
- **It reaches the Hub through the Runner's** [mod relay](#the-mod-relay), which adds the Session's mod token.
- **Claude's Models run Claude Code as the model.** The agent's Claude bridge runs the pinned Claude Code through the Claude Agent SDK, on the Creator's setup token ([The Creator's token](#the-creators-token)). Claude Code has no tools of its own there, and loads no settings files, plugins or `.mcp.json`. Sessions don't run on Claude Code otherwise.

### How the Sandbox gets Node.js, Pi Durable and `claude`

The Runner prepares the agent's runtime as it starts and keeps it in the home's `pi/` ([Files and paths](/reference/files-and-paths/)): a pinned Node.js, one build for each C library (glibc and musl), checked against a pinned SHA-256, and a pinned install of Pi Durable's packages, from a committed lockfile. It mounts the directory read-only into every Sandbox at `/opt/kndl/pi`. A Runner that can't prepare it says so in its log and runs no Sessions until it next starts.

The Runner also downloads the Linux build of a pinned Claude Code version from the npm registry once, checks its integrity hash, keeps it in `claude-code/`, and mounts it read-only at `/opt/kndl/claude-code`. A Build records whether its Sandboxes use the musl or the glibc builds.

The versions are pinned so that the agent is tested with them. The agent also needs tmux 3.2 or later and bash, which every Build installs if its image lacks them.

### What a Runner gives the agent

The agent's environment is what the Start script gets: the package cache variables and, for a Repo with an Environment, the image's login environment with the Environment's Variables over it ([ADR 0009](/contributing/decisions/0009-environments/)). On top of it go these, set on the agent's process alone with `tmux -e`:

| Variable | What it is |
|---|---|
| `KNDL_SESSION_ID`, `KNDL_CONVERSATION_ID` | The Session's id, and the conversation the Hub knows it by. |
| `KNDL_URL` | The mod relay as the Sandbox reaches it: `http://host.microsandbox.internal:<RUNNER_RELAY_PORT>`. |
| `KNDL_MOD_TOKEN` | The Session token. |
| `KNDL_STATE_DIR` | `/var/lib/kndl/claude`, the agent's state. |
| `KNDL_HARNESS` | `Pi`, which is what the Hub calls the durable agent. |
| `KNDL_MODEL`, `KNDL_THINKING` | The Session's [model and thinking level](/guides/manage-a-session/#choose-the-model-and-thinking-level), when set. |
| `KNDL_MCP_SERVERS` | The Session's MCP servers: each Installation and its name, nothing secret. |
| `TZ` | The Runner's time zone, such as `Europe/Copenhagen`, so the times the agent's tools show are yours. |

With the Creator's Claude credential, these go on too, and win over a Variable of the same name:

| Variable | What it is |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | The Creator's setup token, fetched from the Hub as the Session starts or wakes. |
| `KNDL_CLAUDE_CODE` | Where the pinned Claude Code is, for the Claude bridge. |
| `CLAUDE_CONFIG_DIR`, `IS_SANDBOX` | Claude Code's state, which the Runner seeds so it asks nothing, and `1`, which lets it run as root. |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_AUTOUPDATER` | `1`: no telemetry, and no update away from the pinned version. |

Variables that would sign Claude Code in some other way, or send it elsewhere, are kept out of the agent's process, since it passes its environment on to Claude Code: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` and `CLAUDE_CODE_USE_FOUNDRY`. Without a credential, a setup token from anywhere else is kept out too. The Start script and the terminal still get them all.

The agent removes the mod token and the Claude token from the environment its coding tools inherit. That is hygiene, not a boundary: anything in the Sandbox runs as root and can read the agent's process.

## The terminal mirror

The Session view's **Terminal** shows the Session's shell, live, to everyone in the Session. They can type into it, for what the chat doesn't handle, such as their own commands, Esc and Ctrl-C. It is a plain `bash -l`, started without the agent's tokens.

- The Runner attaches to the shell's tmux session in control mode (`tmux -C`). Opening the terminal sends a snapshot of the pane, with its colours and cursor, then relays the pane's output. A reconnect waits for a fresh snapshot, so nothing is drawn twice. The agent's tmux session is never mirrored, so agent output and terminal output never share a stream.
- The terminal has one size, the tmux pane's. The tab that last typed into it or pressed **Fit to my window** sets it; the other tabs see it at that size, scaled down when it doesn't fit.
- The Hub sends terminal frames to every Participant's connections that opened the terminal, and relays keystrokes from them, only while the Session is Active.

## Open ports

While a Session is Active, its Runner watches what listens in its Sandbox. Every 2 seconds it reads the guest's `/proc/net/tcp` and `/proc/net/tcp6`, and when the listening sockets change it looks up the process holding each new one and sends the Hub the Session's whole list. Each port is listed once, with every address it listens on. Ports Docker publishes are held by `docker-proxy`. Claude Code's own login callback port is left out.

The Hub keeps the latest list in memory only and sends it to the web UI ([Forward a Session's ports](/guides/forward-a-sessions-ports/#see-a-sessions-open-ports)). It drops the list as soon as the Session is no longer Active, Frozen included. Open ports don't keep a Session awake ([ADR 0016](/contributing/decisions/0016-forwarding-a-sessions-ports/)).

## Sleep, wake and Frozen, in detail

**Going to sleep.** The Runner stops the agent, runs `docker stop` on the Sandbox's containers so databases shut down cleanly, and stops the Sandbox, keeping its disks, the agent's state among them, and the Workspace. Only when the Runner reports the Session stopped does the Hub record it Asleep; prompts sent meanwhile wait, and wake it once it is.

**Exiting on its own.** An agent that exits on its own leaves Keep awake on, but the Session stays Asleep, so a crashing agent isn't restarted over and over; it wakes when its Runner next connects, or on the next prompt.

**Resuming.** The agent resumes from its storage whenever it starts. A run that was going when it stopped continues, and the Hub logs a Turn with sender `Resumed` for it. The Hub ended the original as `aborted` when the agent stopped, and a Thread's Turn the same way. Events that hadn't reached the Hub are lost: see the [recovery contract](https://github.com/kddige/kndl/blob/main/packages/mod/durable/README.md#recovery-contract).

**Frozen.** When the Runner is back, the Session is Active if its agent is still running, and otherwise Asleep, woken at once if prompts are waiting, with its running subagents Interrupted. The agent runs in the Sandbox, not in the Runner, so it keeps running when the Runner's connection drops and when the Runner restarts. A restarted Runner reads each Session token back from the agent's tmux session, and the Hub gives the Session a fresh mod token; until then the mod relay asks the agent to retry, and a running Turn carries on meanwhile, since model calls reach the Provider by way of the Hub's Gateway, or Anthropic directly for Claude.

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
- The Start script and the agent, and so every command it runs, get that environment, with the Environment's Variables over it.

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
| A person's Claude credential, a setup token | encrypted on the Hub with `HUB_SECRETS_KEY`; the environment of the agent process of each of their awake Sessions | Yes, by design: in its Creator's Sessions ([The Creator's token](#the-creators-token)) |
| Session tokens, one per run of a Session | the mod relay's memory, as SHA-256 hashes | Yes, by design: they stand in for the mod token |
| The GitHub App's private key and client secret | the Hub | Never |
| `HUB_SECRETS_KEY` | the Hub | Never |
| Runner tokens | the Runner, as `RUNNER_TOKEN`; the Hub keeps a hash | Never |
| Mod tokens, one per run of a Session | the Runner's memory; the Hub keeps a hash | Never ([The mod relay](#the-mod-relay)) |
| Sign-in cookies | the browser; the Hub keeps a hash | Never |
| CLI tokens, one per machine signed in with `kndl login` | that machine's `cli.json`, readable only by its user; the Hub keeps a hash | Never |
| The Setup link and Invites ([Who gets in](/concepts/security-model/#who-gets-in)) | the link, with whoever it was given to; the Hub keeps a hash | Never |
| The Sandbox token, for `git` and `gh` | the Sandbox's memory | Yes, by design ([ADR 0010](/contributing/decisions/0010-the-sandbox-gets-a-github-token/)) |
| A Test build's clone token, read-only and for one Repo | the environment of the Runner's one `git clone` | Never |
| Environment Variables | encrypted on the Hub if Sensitive; in the Runner's memory while needed | Yes, by design: in every process's environment |
| An Installation's header secret values, an MCP server's keys | encrypted on the Hub with `HUB_SECRETS_KEY`, with a copy for each Session that started with them | Never ([The Gateway](#the-gateway)) |

### The Creator's token

A Session runs Claude's Models on its Creator's own `claude setup-token` token, and the agent holds it in the Sandbox for Claude Code ([ADR 0026](/contributing/decisions/0026-a-session-runs-on-and-is-driven-by-its-creator/)). A Runner has no Claude credential of its own.

- **Fetched as the Session starts or wakes.** The Runner asks the Hub over its WebSocket. The Hub answers only for a Session on that Runner whose Creator has a token and is a Member. Without one the agent still runs, but without Claude's Models, and never runs Claude Code without the token.
- **In the agent's process alone.** The Runner sets `CLAUDE_CODE_OAUTH_TOKEN` on the agent it starts, with `tmux -e`, not on the Sandbox or its terminal. It is never written to the VM's disk, and never logged.
- **No other way in.** The variables that would sign Claude Code in some other way are kept out of its process ([What a Runner gives the agent](#what-a-runner-gives-the-agent)). Claude Code talks to Anthropic as it does on a laptop, and learns the plan from Anthropic.
- **Masked.** The Hub masks the token in the Session's transcript, terminal frames and the agent's last output, like a Sensitive value ([Redaction](#redaction)).
- **Taken away.** When the Creator removes or replaces their token, or is removed as a Member, the Hub puts their Active Sessions to sleep, even mid-Turn, saying why. A replaced token reaches a Session at its next wake.

Anything in the Sandbox can read the token from the agent's environment, and use it anywhere until it expires, a year after it was made. Everyone in the Session prompts the agent, so any of them can ask it for the token. That is the risk of sharing a Session on your own token, with people who work on a Repo you trust.

### The mod relay

Each Runner runs a mod relay on its host's loopback, port `RUNNER_RELAY_PORT`, which every Sandbox reaches at `host.microsandbox.internal`. The agent holds only a Session token, so the mod token stays on the Runner, and no Sandbox needs a route to the Hub.

- **A Session token is the only identity.** The agent gets it in its own process's environment, and it is never written to the Sandbox's disk. Every Sandbox's connection reaches the relay from the host's own loopback address, so the relay tells Sessions apart by token alone. A token is 32 random bytes, issued as a Session starts or wakes and revoked as it sleeps, is archived, stops or exits; the relay keeps only its SHA-256. A request without a live token is answered 401. A restarted Runner reads the token of each Session still running back from its agent, and holds it for that Session alone, answering 503 until the Hub has given the Session a new mod token.
- **It relays the agent's calls to the Hub,** `/mod/*`, swapping the Session token for the Session's mod token. Its MCP traffic to the Installations and its model calls, `/gateway/*`, goes to the Hub's [Gateway](#the-gateway) the same way, streaming both ways. It relays nothing else, and never reaches Anthropic.
- **Nothing secret is logged.**

Anything in a Sandbox can read its Session token, and reach the Hub as the Session's mod while the Session is awake. It can't take the mod token away, or use the Session token after the Session sleeps.

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

An [MCP server](/reference/glossary/#mcp-server) is remote, and the agent reaches it through the Hub's Gateway, never directly ([ADR 0020](/contributing/decisions/0020-plugins-are-remote-mcp-servers-behind-the-hub/)). It learns the servers from `KNDL_MCP_SERVERS`, which names each Installation and nothing else secret, and connects to each at the mod relay with the Session token. Each server's tools are `mcp__<server>__<tool>`, deferred until the agent finds them with `tool_search`.

- **Only the Installations on for the Session's Repo.** The Gateway answers `403` for an Installation the Session didn't start with, or that was taken off its Repo since: taking one off stops it at once. It answers `401` without the mod token of an Active Session, which the mod relay puts in for a live Session token.
- **Turning one on takes access to its Repos.** Making or changing an Installation takes access on GitHub to every Repo it lists, as starting a Session does. A refusal reads the same whether the Repo exists or not, and an Installation on in a Repo someone can't see only says how many such Repos it lists.
- **Untouched, and not logged.** Request and answer stream both ways as they are. The Gateway drops the Session's token, cookies and forwarding headers on the way out, and the server's cookies on the way back. It logs each request's Session, Installation, method, status and time, never its content or headers.
- **No MCP server credential enters a Sandbox or a Runner.** The Hub calls the server from its own address. An MCP server that needs a key declares header secrets, such as `Authorization: Bearer {value}`, and each Installation holds its own value, which the Gateway adds to every request on the way out. A header of the same name from the Sandbox, by any case, is dropped first, so code in a Sandbox can't send its own in its place.
- **Header secret values are write-only.** The Hub encrypts them with `HUB_SECRETS_KEY` and never sends them to a browser, a Runner or a Sandbox: the web UI shows only who set each value and when, or that it needs one, and the change log names them by title. A Session runs with the values it started with, and a new one applies at its next wake or Restart. The Hub masks them in its Events and terminal frames like Sensitive values ([Redaction](#redaction)), in case a server echoes one back.
- **A value goes only to the server it was entered for.** Moving an MCP server's URL to another origin (scheme, host or port) clears every Installation's values, and changing a header secret's key or header clears its values, so an edit can't send a key elsewhere. The web UI says whose values it clears before saving.
- **OAuth tokens stay on the Hub.** An Installation of an OAuth MCP server is connected to one account by someone who may edit it (the Owner, for a global one), through the server's authorization server, with PKCE and a `state` bound to that person and Installation, used once and for at most 10 minutes. The Hub keeps the tokens and the client, the one it registered or the one someone entered for an authorization server without Dynamic Client Registration, encrypted with `HUB_SECRETS_KEY`, refreshes them itself, and never sends them to a browser, a Runner or a Sandbox, nor writes them to its log. A client secret entered is write-only: the browser learns only the client's ID and whether it has a secret, the secret goes only to the authorization server's token endpoint, and the Gateway redacts it, with the tokens, from what a Session sees. Entering a client takes the same rights as connecting, and the change log records who did, never the secret. The Gateway adds the token as it is now, so a disconnect stops running Sessions at once. It never passes the server's OAuth challenge on: no answer carries `WWW-Authenticate`, and nothing under the Installation's path, such as `/.well-known/oauth-protected-resource`, reaches the server, so the agent never signs in itself. Moving the MCP server to another origin drops the tokens and the client, so a URL edit can't send a token or a client secret elsewhere. The Hub talks to authorization servers on `https` alone (or plain `http` to `localhost` or a loopback address, which never leaves the Hub's machine), follows no redirect from them, and reads at most 256 KiB of each answer. To send a request again once its token is refreshed, the Gateway holds the request's body, at most 4 MiB of it: a larger one is refused with `413`, so a Sandbox can't make the Hub hold more.
- **A missing value is refused, not skipped.** A request through an Installation without a value for one of its header secrets is answered `409`, naming the Installation and the secret, and is never sent to the server without it.

## Redaction

The Hub masks Sensitive values, each character with `*`, in everything it stores or shows: a Session's Events (prompts, the agent's text, tool input and output, subagents and Threads included), its terminal frames, and Test build logs and results. A Session's set is its Repo's Sensitive Variables and linked Sensitive Shared variables, plus any value they replaced while a Session that started with it still runs, the header secret values of the Installations it started with, its current and previous Sandbox tokens, and its Creator's setup token.

- Besides the value itself, it looks for it trimmed, JSON-escaped, URL-encoded and, for a multi-line value such as a key, each of its long lines. Matching skips terminal colour codes and line breaks, so a value wrapped on screen is still found.
- The agent's text and terminal output stream in pieces, so the end of a piece that could start a value is held back until the next one, for at most 100 ms.
- A Sensitive value must be at least 4 characters, so it can be found reliably.

Redaction has limits. It can't find a value transformed before it is printed (base64, hashed, split up by the program printing it), or one the terminal wraps with indentation; the transcript is still masked. What a script writes to disk, such as a token in an `.npmrc`, stays there: the Bootstrap script's in the Build, on the Runner's disk.
