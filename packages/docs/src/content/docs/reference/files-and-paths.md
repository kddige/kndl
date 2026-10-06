---
title: Files and paths
description: Where an installed kndl and a checkout keep their state on disk, and what kndl names in tmux and microsandbox.
sidebar:
  order: 3
---

An install keeps everything in its home, `~/.kndl` (or `KNDL_HOME`): see [An installed home](#an-installed-home). The rest of this page is for a checkout, which uses the dev home `~/.kndl-dev`; an installed Hub and Runner keep the same files in their home instead, as [Homes](/reference/configuration/#homes) lists.

## An installed home

| Path | What it is |
|---|---|
| `~/.kndl/app/` | The install: a checkout of kndl, which the services and the `kndl` command run. `kndl update` moves it, and discards changes made in it. |
| `~/.kndl/hub.env` | The Hub's settings, read by its service and by `kndl runner token`. Readable only by you (`600`): it holds `HUB_SECRETS_KEY`. |
| `~/.kndl/runner.env` | The Runner's settings, with its `RUNNER_TOKEN`. Readable only by you. |
| `~/.kndl/github-app-<id>.pem` | The GitHub App's private key, when onboard created the App. Readable only by you. Back it up with `hub.env`, or generate another in the App's settings. |
| `~/.kndl/hub.db` | The Hub's database. Back it up together with `hub.env`. |
| `~/.kndl/runner-update.json` | The Runner's update under way, or its last failed one: what it moved from, so it can go back, and the error it reports to the Hub. An update is done once the Hub welcomes the Runner on the new commit; a failed one is kept until the checkout moves again, so a restarted Hub still hears of it. |
| `~/.kndl/hub.db.lock` | The lock the running Hub holds, so a second Hub or a `secrets reset` on the same database is refused. The operating system drops it when the Hub ends. |
| `~/.kndl/sessions/` | The Runner's sessions root, one directory per Session. |
| `~/.kndl/claude-code/` | Linux builds of Claude Code, which Sessions run in their Sandboxes. |
| `~/.kndl/claude-token` | Off macOS, the Runner's [Claude credential](/reference/configuration/#the-runners-claude-credential) for Sessions without their own, if you put one there: a setup-token or API key. It must be readable only by you (`600`). |
| `~/.kndl/logs/hub.log`, `runner.log` | Each service's output. `kndl logs hub` prints it. |
| `~/.kndl/cli/<commit>/kndl-<os>-<arch>` | The [`kndl` binaries the Hub serves](/reference/commands/#the-kndl-command-from-a-hub), each built the first time it's asked for. The Hub removes other commits' when it builds one. |

Outside the home:

| Path | What it is |
|---|---|
| `~/.local/bin/kndl` | The `kndl` command: a small script that runs the install's CLI. On a machine with no install, it can be the binary [installed from a Hub](/how-to/install-the-cli-from-a-hub/) instead (`KNDL_BIN_DIR` moves it). |
| `~/.config/kndl/cli.json` | The Hub the CLI is signed in to or was installed from, as `{"hub":"https://hub.example.com"}`, and after [`kndl login`](/how-to/sign-in-the-cli/), its CLI token, `"token":"chc_…"`. A binary installed from a Hub updates itself from that Hub. Readable only by you (`0600`, in a `0700` directory). `$XDG_CONFIG_HOME/kndl/cli.json` when that is set. |
| `~/Library/LaunchAgents/io.github.kddige.kndl.hub.plist`, `….runner.plist` | macOS: the services, as launchd agents. |
| `~/.config/systemd/user/kndl-hub.service`, `kndl-runner.service` | Linux: the services, as systemd user units (`$XDG_CONFIG_HOME/systemd/user` when that is set). |

Each service runs the install's Hub or Runner with its env file and `KNDL_HOME` set, logs to `logs/`, starts at login and restarts if it crashes. `kndl uninstall` removes the install, the command and the services, and keeps the rest of the home; `--purge` removes the home too.

## The Hub

| Path | What it is |
|---|---|
| `packages/hub/hub.db` | The Hub's SQLite database: Sessions, their Events, Runners, Environments and Variables. `HUB_DATABASE` moves it. |
| `packages/hub/hub.db.lock` | The lock the running Hub holds, beside its database wherever `HUB_DATABASE` puts it. |
| `packages/hub/.env.local` | The Hub's settings, read by `bun run hub` and `bun run runner-token`. git ignores it. |
| `packages/web/dist` | The web UI's build, which the Hub serves. `HUB_WEB_DIR` moves it. |
| `~/.kndl-dev/cli/` | The `kndl` binaries the Hub serves, by commit, as in [an installed home](#an-installed-home). |

Back up `hub.db` together with `HUB_SECRETS_KEY`: Sensitive values in the database can't be read without the key. If it is lost, see [If the key is lost](/how-to/use-variables-and-secrets/#if-the-key-is-lost).

## A Runner

| Path | What it is |
|---|---|
| `~/.kndl-dev/sessions/` | The sessions root (`RUNNER_SESSIONS_ROOT`), with one directory per Session. |
| `~/.kndl-dev/claude-code/` | Linux builds of Claude Code, mounted read-only into every Sandbox, which Sessions run (`RUNNER_SANDBOX_CLAUDE_CACHE`). |
| `packages/mod/` | The mod, whose plugins in `plugins/` each Session's Claude Code loads, copied into the Session's directory each time it starts (`RUNNER_MOD_DIR`). |
| `~/.claude.json` | Claude Code's config file, if Claude Code is on the host; the Runner needs none. When the Runner's own Claude credential is Claude Code's login, the Runner reads that login's account and plan from it. It drops the entries of a Session that ran on the host when it purges that Session. `$CLAUDE_CONFIG_DIR/.claude.json` when that is set. |
| `~/.microsandbox/` | microsandbox's home (`MSB_HOME`), with its Sandboxes, volumes, snapshots and their logs. |

### One Session's directory

Under the sessions root, `<session id>/` holds:

| Path | What it is |
|---|---|
| `claude/` | Only in a Session from before Claude Code ran in its Sandbox: the empty directory it ran in on the host. The Session's first wake copies its conversation from there into the Sandbox. |
| `workspace/` | The Workspace: the Repo's checkout on the Session's Work branch, mounted into the Sandbox at `/workspace`. |
| `host-git/` | The Runner's own git directory for the Workspace. Never mounted into the Sandbox, so nothing in the Sandbox can change the config or hooks the Runner's git runs with. |
| `mod/` | The copy of the mod the Session's Claude Code runs with, in a directory named for that start, made anew each time it starts: an update changes the mod a running Session uses only at its next start. Mounted read-only into the Sandbox at `/opt/kndl/mod`. |

Archiving a Session keeps its directory, and the volume with Claude Code's state; purging it deletes both.

## Names

| What | Name |
|---|---|
| The tmux server in a Sandbox | `tmux -L kndl` |
| A Session's tmux session | `hub-<session id>` |
| A Session's Sandbox | `kndl-<session id>` |
| A Sandbox's volumes | `kndl-<session id>.<key>`, such as `.deps-node-modules`, `.docker` or `.claude` |
| A Repo's Environment builds | snapshots `b<build version>-<libc>`, in a group per Runner and Repo |

Everything a Runner makes in microsandbox is labelled `kndl.runner` with the Runner's mark, a digest of its tmux socket and sessions root. A Runner only stops or removes what carries its own mark.

## Inside a Sandbox

| Path | What it is |
|---|---|
| `/workspace` | The Workspace, mounted from the Runner. |
| `/workspace/node_modules` and other dependency folders | Each on a volume of its own, since many small files are slow on the host mount. |
| `/var/cache/kndl` | Package caches, on a volume. |
| `/var/lib/kndl/claude` | Claude Code's state, its `CLAUDE_CONFIG_DIR`, with the Session's transcripts: on a volume, kept when the Session is archived. |
| `/opt/kndl/claude-code` | The Runner's Linux builds of Claude Code, read-only. |
| `/opt/kndl/mod` | The Session's copy of the mod, read-only: its plugins `<copy>/hub-link` and `<copy>/hub-link-commands`. |
