---
title: Files and paths
description: Where an installed claude-hub and a checkout keep their state on disk, and what claude-hub names in tmux and microsandbox.
sidebar:
  order: 3
---

An install keeps everything in its home, `~/.claude-hub` (or `CLAUDE_HUB_HOME`): see [An installed home](#an-installed-home). The rest of this page is for a checkout, which uses the dev home `~/.claude-hub-dev`; an installed Hub and Runner keep the same files in their home instead, as [Homes](/reference/configuration/#homes) lists.

## An installed home

| Path | What it is |
|---|---|
| `~/.claude-hub/app/` | The install: a checkout of claude-hub, which the services and the `claude-hub` command run. `claude-hub update` moves it, and discards changes made in it. |
| `~/.claude-hub/hub.env` | The Hub's settings, read by its service and by `claude-hub runner token`. Readable only by you (`600`): it holds `HUB_SECRETS_KEY`. |
| `~/.claude-hub/runner.env` | The Runner's settings, with its `RUNNER_TOKEN`. Readable only by you. |
| `~/.claude-hub/github-app-<id>.pem` | The GitHub App's private key, when onboard created the App. Readable only by you. Back it up with `hub.env`, or generate another in the App's settings. |
| `~/.claude-hub/hub.db` | The Hub's database. Back it up together with `hub.env`. |
| `~/.claude-hub/runner-update.json` | The Runner's update under way, or its last failed one: what it moved from, so it can go back, and the error it reports to the Hub. An update is done once the Hub welcomes the Runner on the new commit; a failed one is kept until the checkout moves again, so a restarted Hub still hears of it. |
| `~/.claude-hub/hub.db.lock` | The lock the running Hub holds, so a second Hub or a `secrets reset` on the same database is refused. The operating system drops it when the Hub ends. |
| `~/.claude-hub/sessions/` | The Runner's sessions root, one directory per Session. |
| `~/.claude-hub/claude-code/` | Linux builds of Claude Code, for Sandboxes' tool bridges. |
| `~/.claude-hub/logs/hub.log`, `runner.log` | Each service's output. `claude-hub logs hub` prints it. |

Outside the home:

| Path | What it is |
|---|---|
| `~/.local/bin/claude-hub` | The `claude-hub` command: a small script that runs the install's CLI. |
| `~/Library/LaunchAgents/io.github.kddige.claude-hub.hub.plist`, `….runner.plist` | macOS: the services, as launchd agents. |
| `~/.config/systemd/user/claude-hub-hub.service`, `claude-hub-runner.service` | Linux: the services, as systemd user units (`$XDG_CONFIG_HOME/systemd/user` when that is set). |

Each service runs the install's Hub or Runner with its env file and `CLAUDE_HUB_HOME` set, logs to `logs/`, starts at login and restarts if it crashes. `claude-hub uninstall` removes the install, the command and the services, and keeps the rest of the home; `--purge` removes the home too.

An installed Runner's tmux server is `tmux -L claude-hub`.

## The Hub

| Path | What it is |
|---|---|
| `packages/hub/hub.db` | The Hub's SQLite database: Sessions, their Events, Runners, Environments and Variables. `HUB_DATABASE` moves it. |
| `packages/hub/hub.db.lock` | The lock the running Hub holds, beside its database wherever `HUB_DATABASE` puts it. |
| `packages/hub/.env.local` | The Hub's settings, read by `bun run hub` and `bun run runner-token`. git ignores it. |
| `packages/web/dist` | The web UI's build, which the Hub serves. `HUB_WEB_DIR` moves it. |

Back up `hub.db` together with `HUB_SECRETS_KEY`: Sensitive values in the database can't be read without the key. If it is lost, see [If the key is lost](/how-to/use-variables-and-secrets/#if-the-key-is-lost).

## A Runner

| Path | What it is |
|---|---|
| `~/.claude-hub-dev/sessions/` | The sessions root (`RUNNER_SESSIONS_ROOT`), with one directory per Session. |
| `~/.claude-hub-dev/claude-code/` | Linux builds of Claude Code, which Sandboxes run the tool bridge from (`RUNNER_SANDBOX_CLAUDE_CACHE`). |
| `packages/mod/` | The `hub-link` mod, loaded into each Session's Claude Code (`RUNNER_MOD_DIR`). |
| `~/.claude.json` | Claude Code's config file. The Runner reads the signed-in account from it and adds one folder-trust entry, for its sessions root. `$CLAUDE_CONFIG_DIR/.claude.json` when that is set. |
| `~/.microsandbox/` | microsandbox's home (`MSB_HOME`), with its Sandboxes, volumes, snapshots and their logs. |

### One Session's directory

Under the sessions root, `<session id>/` holds:

| Path | What it is |
|---|---|
| `claude/` | An empty directory that Claude Code runs in, so it reads no project files from the host ([ADR 0001](/reference/decisions/0001-claude-on-host-tools-in-sandbox/)). |
| `workspace/` | The Workspace: the Repo's checkout on the Session's Work branch, mounted into the Sandbox at `/workspace`. |
| `host-git/` | The Runner's own git directory for the Workspace. Never mounted into the Sandbox, so nothing in the Sandbox can change the config or hooks the Runner's git runs with. |
| `tools.sock` | The Unix socket of the Session's tool bridge, which the mod sends tool calls to. |

Archiving a Session keeps its directory; purging it deletes the directory and what Claude Code kept for it.

## Names

| What | Name |
|---|---|
| The Runner's tmux server | `tmux -L claude-hub-dev` (`RUNNER_TMUX_SOCKET`) |
| A Session's tmux session | `hub-<session id>` |
| A Session's Sandbox | `claude-hub-<session id>` |
| A Sandbox's volumes | `claude-hub-<session id>.<key>`, such as `.deps-node-modules` or `.docker` |
| A Repo's Environment builds | snapshots `b<build version>-<libc>`, in a group per Runner and Repo |

Everything a Runner makes in microsandbox is labelled `claude-hub.runner` with the Runner's mark, a digest of its tmux socket and sessions root. A Runner only stops or removes what carries its own mark.

## Inside a Sandbox

| Path | What it is |
|---|---|
| `/workspace` | The Workspace, mounted from the Runner. |
| `/workspace/node_modules` and other dependency folders | Each on a volume of its own, since many small files are slow on the host mount. |
| `/var/cache/claude-hub` | Package caches, on a volume. |
