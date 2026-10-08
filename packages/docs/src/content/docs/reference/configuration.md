---
title: Configuration
description: Every environment variable the Hub, a Runner, the kndl command from a Hub and the web UI's dev server read, with its default.
sidebar:
  order: 2
---

The Hub and Runners are configured with environment variables. `bun run hub` and `bun run runner-token` also read `packages/hub/.env.local` when it exists; values already in the environment win.

## Hub

| Variable | Default | What it does |
|---|---|---|
| `HOST` | `127.0.0.1` | The address the Hub listens on. |
| `PORT` | `7777` | The port the Hub listens on. |
| `HUB_PUBLIC_URL` | `http://localhost:5173` | Where browsers reach the web UI and, through it, the Hub: the Hub's own URL when it serves the web UI's build, or Vite's in development. GitHub sends people back here after sign-in, cookie-authenticated requests must come from this origin, and pairing links carry it, so new Runners must reach the Hub there. |
| `HUB_DATABASE` | `hub.db` in `packages/hub` | The SQLite database. With `KNDL_HOME` set, `hub.db` in that home. |
| `HUB_WEB_DIR` | `packages/web/dist` | The web UI's build, which the Hub serves. Without one, the Hub warns at startup and its pages answer 503. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | unset | The GitHub App's client id and secret. Set both, or neither; unset, GitHub sign-in is off. |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH` | unset | The GitHub App's id and the path to its private key (an RSA PEM). The Hub mints installation tokens from them for Runners' clones, for `git` and `gh` in Sandboxes, and to check who has access to a Repo. Set both, or neither; unset, Runners use their host's git credentials, Sandboxes get no GitHub token, and GitHub sign-ins have access to no Repo. The Hub checks the App's permissions against [the ones it needs](/how-to/set-up-the-github-app/#the-permissions) as it starts and every hour. `kndl onboard --github-app create` writes all four of the App's settings. |
| `GITHUB_WEBHOOK_SECRET` | unset | The GitHub App's webhook secret, which onboard saves for an App GitHub gave a webhook. The Hub doesn't read it. |
| `KNDL_DEV_LOGIN` | off | `1` turns on dev login, which signs anyone in as any name without GitHub. The Hub refuses to start with it unless `HOST` and `HUB_PUBLIC_URL` are both loopback, and only answers it for loopback callers. |
| `KNDL_DEV_USER` | `$USER`, else `dev` | Who dev login signs you in as when you give no name. |
| `HUB_INSECURE_COOKIES` | off | `1` drops `Secure` from the Hub's cookies when `HUB_PUBLIC_URL` is plain HTTP. Sign-in tokens then travel in cleartext. See [Reach the Hub from other machines](/how-to/reach-the-hub-from-other-machines/#last-resort-plain-http-on-a-network-you-trust). |
| `HUB_SLEEP_AFTER_MS` | `900000` (15 minutes) | How long an Active Session goes with no Turn running, no prompt queued and no Participant present before the Hub puts it to sleep. |
| `HUB_ARCHIVE_RETENTION_MS` | `2592000000` (30 days) | How long an Archived Session can be restored before the Hub purges it. |
| `HUB_REPO_ACCESS_TTL_MS` | `300000` (5 minutes) | How long the Hub trusts what GitHub said about a person's access to a Repo, and how often it checks everyone connected again. Someone who loses access is out of the Repo's Sessions within twice this. See [Who can do what](/explanation/security-model/#who-can-do-what). |
| `HUB_PLUGIN_CHECK_TIMEOUT_MS` | `5000` (5 seconds) | How long a Session's start waits on each of its Installations' MCP servers to answer the Hub's check. One that doesn't answer in time doesn't stop the start: the Session starts with a warning. See [When an Installation fails a Session](/how-to/add-a-remote-mcp-server-as-a-plugin/#when-an-installation-fails-a-session). |
| `HUB_SECRETS_KEY` | unset | 32 random bytes in base64, from `bun run secrets-key`, that Sensitive values, people's [Claude credentials](#peoples-claude-credentials) and Installations' [header secret values](/how-to/add-a-remote-mcp-server-as-a-plugin/#header-secret-values) are encrypted with. Unset, none can be saved; once any are saved, the Hub refuses to start without the same key. If it is lost, see [`bun run secrets-reset`](/reference/commands/#bun-run-secrets-reset---yes). |
| `KNDL_HOME` | unset | See [Homes](#homes). |

### People's Claude credentials

Each person can store one Claude credential on their **Account** page: a subscription token from `claude setup-token`, with the plan it is on, or an Anthropic API key ([ADR 0015](/reference/decisions/0015-each-person-brings-their-claude-credential/)). The Sessions they start run on it, on any Runner. It needs only `HUB_SECRETS_KEY`.

- The Hub checks it as it is saved with one free `POST https://api.anthropic.com/v1/messages/count_tokens`, and refuses one Anthropic rejects. When Anthropic can't be reached in time, it is saved anyway, with a warning.
- The plan picked for a token is passed to Claude Code as `CLAUDE_CODE_SUBSCRIPTION_TYPE` and its rate-limit tier. An API key has no plan.
- A Session whose Creator has none runs on [the Runner's own](#the-runners-claude-credential); the Hub refuses to create one when neither has a credential.
- `bun run secrets-reset` clears every stored credential with the other Sensitive values and the Installations' header secret values.

## Runner

| Variable | Default | What it does |
|---|---|---|
| `HUB_URL` | `http://127.0.0.1:7777` | The Hub. The Runner connects to `/ws/runner` on it, over `wss:` for an `https:` URL. |
| `RUNNER_TOKEN` | required | The Runner's token: `kndl runner join` writes it, from a Pairing code; `kndl runner token` or `bun run runner-token` issues one on the Hub's machine. Never reaches a Sandbox. |
| `RUNNER_NAME` | the short hostname | The name the Runner says hello with. The web UI shows the name the Runner was paired or issued its token with. |
| `RUNNER_SESSIONS_ROOT` | `~/.kndl-dev/sessions` | Where each Session's directory goes. |
| `RUNNER_TMUX_SOCKET` | `kndl-dev` | With `RUNNER_SESSIONS_ROOT`, marks the Sandboxes this Runner makes, so Runners sharing a machine keep to their own. |
| `RUNNER_MOD_DIR` | `packages/mod` in the checkout | The mod, whose plugins `hub-link` and `hub-link-commands` Claude Code loads. The Runner refuses to start if it isn't built. |
| `RUNNER_REPO_URL` | `https://github.com/{repo}.git` | Where Repos are cloned from; `{repo}` is `owner/name`. |
| `RUNNER_SANDBOX_IMAGE` | `docker:dind` | The image of a Session whose Repo has no Environment. |
| `RUNNER_SANDBOX_CLAUDE_VERSION` | the version this kndl is tested with | The Claude Code version Sessions run in their Sandboxes. Another may not work with the mod. |
| `RUNNER_SANDBOX_CLAUDE_CACHE` | `~/.kndl-dev/claude-code` | Where the Runner keeps Linux builds of Claude Code for Sandboxes. |
| `RUNNER_SANDBOX_MAX_CPUS` | the host's CPU count | The most CPUs a Sandbox gets, whatever its Environment asks for. |
| `RUNNER_SANDBOX_MAX_MEMORY_MIB` | half the host's memory | The most memory, in MiB, a Sandbox gets. |
| `RUNNER_SANDBOX_KEEP_BUILDS` | `3` | How many builds of each Repo's Environment the Runner keeps. |
| `RUNNER_PROXY_PORT` | `7779`; `7778` in an installed home | The port of the Runner's [credential proxy](/explanation/security-model/#the-credential-proxy) on the host's loopback, which Sandboxes reach at `host.microsandbox.internal`. If it is taken, the Runner logs an error and runs without the proxy. |
| `RUNNER_CLAUDE_CREDENTIAL` | `auto` | Where the Runner's own Claude credential is read from: see [The Runner's Claude credential](#the-runners-claude-credential). |
| `RUNNER_CLAUDE_PLAN` | the plan in Claude Code's config file | The plan the Runner's credential is on, `pro`, `max`, `team` or `enterprise`, passed to Claude Code in a Sandbox. |
| `RUNNER_CLAUDE_RATE_LIMIT_TIER` | Claude Code's for the plan: `default_claude_ai` for `pro`, `default_claude_max_5x` for `max` | The rate-limit tier of `RUNNER_CLAUDE_PLAN`, such as `default_claude_max_20x`. |
| `RUNNER_UPDATE_ANY_COMMIT` | unset | `1`: when the Hub asks, the Runner moves to its commit even if it isn't on `origin/main`, such as a Hub running a branch. Unset, it refuses such a commit ([Keep Runners on the Hub's commit](/how-to/add-a-runner/#keep-runners-on-the-hubs-commit)). |
| `KNDL_SERVICE` | unset | Set to `runner` (or `hub`) by the service files the `kndl` command installs. A Runner updates itself only when it is set and the Runner runs from the install, `<home>/app`. |
| `CLAUDE_CONFIG_DIR` | unset | Read as Claude Code reads it: the Runner looks for Claude Code's config file at `$CLAUDE_CONFIG_DIR/.claude.json` instead of `~/.claude.json`. |
| `KNDL_HOME` | unset | See [Homes](#homes). |

### The Runner's Claude credential

A Session whose Creator has no Claude credential runs on the Runner's own, if it has one ([ADR 0015](/reference/decisions/0015-each-person-brings-their-claude-credential/)). A Runner needs neither a credential of its own nor Claude Code. It is read from where `RUNNER_CLAUDE_CREDENTIAL` says:

| Value | Read from |
|---|---|
| `auto`, or unset | On macOS, the Keychain item `kndl-setup-token`; elsewhere, the file `<home>/claude-token`. Without either, Claude Code's own login on this host. |
| `keychain` | The Keychain item `kndl-setup-token`. |
| `keychain:<service>` | The Keychain item with that service name. |
| `file:<path>` | That file, which must be the Runner user's and readable by no one else (`chmod 600`). |
| `claude-code` | Claude Code's own login: its Keychain item `Claude Code-credentials` on macOS, else `~/.claude/.credentials.json` (in `CLAUDE_CONFIG_DIR` when set). |
| `none` | None: a Session without its own credential is answered 401 by the proxy. |

A setup-token is what `claude setup-token` prints, good for a year. On a Mac, put it in the Keychain and the Runner needs nothing else:

```sh
security add-generic-password -s kndl-setup-token -a "$USER" -w
```

`security` asks for the token, so it stays out of your shell's history. A Keychain item or file can hold an Anthropic API key (`sk-ant-api…`) instead.

The Runner reads its credential when it starts and logs where it came from, or why there is none; it starts either way. The Runners page shows it by its kind and last four characters, such as **Subscription token …x7Qa**, by the account of the Claude Code login it uses, or as **No Claude credential**. The Runner never logs it and never refreshes Claude Code's login: it reads the login again close to its expiry, and logs a warning once it has expired, until `claude` on the host refreshes it. It reads a credential again when Anthropic refuses it, so a replaced one is picked up without a restart.

## Homes

A Hub or Runner keeps its state in a home. From a checkout, that is the dev home, `~/.kndl-dev`. `KNDL_HOME` names another; the [`kndl` command](/reference/commands/#the-kndl-command) sets it to `~/.kndl` for the services it installs, so a dev Runner and an installed one can share a machine. An installed Hub and Runner read their settings from `<home>/hub.env` and `<home>/runner.env`; see [An installed home](/reference/files-and-paths/#an-installed-home). A variable that names a path wins over the home's.

| Setting | From a checkout | With `KNDL_HOME=<home>` |
|---|---|---|
| `RUNNER_SESSIONS_ROOT` | `~/.kndl-dev/sessions` | `<home>/sessions` |
| `RUNNER_SANDBOX_CLAUDE_CACHE` | `~/.kndl-dev/claude-code` | `<home>/claude-code` |
| `RUNNER_TMUX_SOCKET` | `kndl-dev` | `kndl` |
| `RUNNER_PROXY_PORT` | `7779` | `7778` |
| `HUB_DATABASE` | `hub.db` in `packages/hub`, beside the `.env.local` holding its `HUB_SECRETS_KEY` | `<home>/hub.db` |

## The `kndl` command from a Hub

The install script a Hub serves at `/cli`, and the binary it installs ([Install the CLI from a Hub](/how-to/install-the-cli-from-a-hub/)), read these. The CLI from an install reads none of them.

| Variable | Default | What it does |
|---|---|---|
| `KNDL_BIN_DIR` | `~/.local/bin` | Where the install script puts `kndl`. |
| `KNDL_URL` | the Hub's `HUB_PUBLIC_URL` origin | The Hub the install script downloads from and records, when your machine reaches it at another URL. |
| `XDG_CONFIG_HOME` | `~/.config` | Where the install script records the Hub, in `kndl/cli.json`, and where the binary reads it. `kndl login` keeps its CLI token there too, from either CLI. |
| `KNDL_NO_SELF_UPDATE` | unset | Set to anything, the binary never updates itself to the Hub's commit. |

## What a Runner gives Claude Code

Each Session's Claude Code runs in tmux in its Sandbox, in `/workspace`, with Claude Code's normal setting sources, so the Repo's `CLAUDE.md`, skills, hooks, settings and `.mcp.json` apply ([ADR 0013](/reference/decisions/0013-claude-code-runs-in-the-sandbox/)). Its command line is `claude` with:

- `--session-id` for a new Session, or `--resume` to wake one.
- `--plugin-dir /opt/kndl/mod/<copy>/hub-link` and `--plugin-dir /opt/kndl/mod/<copy>/hub-link-commands`, the mod's plugins ([ADR 0014](/reference/decisions/0014-subagents-replace-child-sessions/)), from the copy of `RUNNER_MOD_DIR` made for this start, mounted read-only.
- `--dangerously-skip-permissions`: the Sandbox is the boundary ([ADR 0004](/reference/decisions/0004-the-sandbox-is-the-security-boundary/)).
- `--model` and `--effort` when the Session's [model and effort](/how-to/work-in-a-session/#choose-the-model-and-effort) are set. Neither is written to its settings.

Its environment is what the Start script gets: the package cache variables and, for a Repo with an Environment, the image's login environment with the Environment's Variables over it ([ADR 0009](/reference/decisions/0009-environments/)). On top of it go these, the mod's and Claude Code's:

| Variable | What it is |
|---|---|
| `KNDL_SESSION_ID` | The Session's id. |
| `CLAUDE_CONFIG_DIR` | `/var/lib/kndl/claude`, Claude Code's state, on a volume of the Session's own. The Runner seeds it so Claude Code asks nothing before the conversation. |
| `IS_SANDBOX` | `1`, which lets `--dangerously-skip-permissions` run as root. |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `1`, since each Session would keep notes only for itself. It wins over any setting. |
| `CLAUDE_CODE_DISABLE_AGENT_VIEW` | `1`: no agent view, `/background`, `--bg` or background daemon, so the Session runs one Claude Code and each prompt runs once. |
| `DISABLE_INSTALLATION_CHECKS` | `1`: the Runner installs Claude Code, so `/status` doesn't ask for the native installer's `claude` command and install method. |
| `TZ` | The Runner's time zone, such as `Europe/Copenhagen`, so the times Claude Code and its tools show are yours. |

Claude Code and its mod reach Anthropic and the Hub through the [credential proxy](/explanation/security-model/#the-credential-proxy), holding only the Session token. These variables point them at it; the credential's kind decides which are set.

| Variable | What it is |
|---|---|
| `ANTHROPIC_BASE_URL`, `KNDL_URL` | The proxy as the Sandbox reaches it: `http://host.microsandbox.internal:<RUNNER_PROXY_PORT>`. |
| `KNDL_MOD_TOKEN` | The Session token. |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_AUTOUPDATER` | `1`: the proxy forwards inference alone. |
| `CLAUDE_CODE_OAUTH_TOKEN` | The Session token, for a subscription token. |
| `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`, `CLAUDE_CODE_OAUTH_SCOPES` | For a subscription token: Claude Code treats the proxy as Anthropic's API, with a setup-token's scopes. |
| `CLAUDE_CODE_SUBSCRIPTION_TYPE`, `CLAUDE_CODE_RATE_LIMIT_TIER` | For a subscription token, its plan, when known: the Creator's, or for the Runner's credential `RUNNER_CLAUDE_PLAN`. |
| `ANTHROPIC_AUTH_TOKEN` | The Session token, for an API key, in place of all the subscription variables. |

## Web UI dev server

| Variable | Default | What it does |
|---|---|---|
| `HUB_URL` | `http://127.0.0.1:7777` | The Hub Vite passes `/auth`, `/health`, `/runner/` and `/ws` through to. |
| `VITE_FAKE_HUB` | unset | `1` runs the web UI against an in-process fake Hub that plays a scripted Session; `signed-out` starts it signed out. |

## Tests

| Variable | What it does |
|---|---|
| `KNDL_SANDBOX_IT` | `1` adds the tests that boot real microsandbox Sandboxes to `bun test`. |
