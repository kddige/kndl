---
title: Files and paths
description: Where an installed kndl and a checkout keep their state on disk, what's inside a Sandbox, and what kndl names in tmux and microsandbox.
sidebar:
  order: 3
---

## An installed home

An install keeps everything in its home, `~/.kndl`, or `KNDL_HOME`. Back up `hub.env` and `hub.db` together: the database's Sensitive values can't be read without the key in `hub.env`.

| Path | What it is |
|---|---|
| `app/` | The install: a checkout of kndl, which the services and the `kndl` command run. `kndl update` moves it, and discards changes made in it. |
| `hub.env` | The Hub's settings, with `HUB_SECRETS_KEY`. Readable only by you (`600`). |
| `runner.env` | The Runner's settings, with its `RUNNER_TOKEN`. Readable only by you. |
| `github-app-<id>.pem` | The GitHub App's private key, when onboard created the App. Readable only by you. |
| `hub.db` | The Hub's database: Sessions, their history, Runners, Environments and Variables. |
| `hub.db.lock` | The lock the running Hub holds, so a second Hub or a `secrets reset` on the same database is refused. |
| `sessions/` | The Runner's Sessions, one directory each. See [One Session's directory](#one-sessions-directory). |
| `claude-code/` | Linux builds of Claude Code, which runs Claude's Models, mounted read-only into every Sandbox. |
| `pi/` | The Node.js builds and the Pi Durable install that Sessions' agents run on, mounted read-only into every Sandbox. |
| `runner-update.json` | The Runner's update under way, or its last failed one, so it can go back. |
| `update/lock` | Held while `kndl update` runs: `{"pid":…,"startedAt":…,"source":"cli"}`. A lock whose process is gone is taken over by the next update. |
| `update/status.json` | The latest `kndl update`: where it started, where it moves to, the step it's at, and its `state`, `Running`, `Succeeded`, `Failed` or `RolledBack`, with the `error`. |
| `update/update.log` | What the latest `kndl update`'s steps ran and printed. Emptied as each update starts. |
| `update/launchd.plist` | On macOS, the launchd job of the latest update the Hub started from the web. |
| `logs/hub.log`, `logs/runner.log` | Each service's output. `kndl logs` prints it. |
| `logs/update.log` | What the updates the Hub started from the web printed, appended. |
| `cli/<commit>/kndl-<os>-<arch>` | The [`kndl` binaries the Hub serves](/reference/commands/#the-kndl-command-from-a-hub). |

`kndl uninstall` removes `app/`, the command and the services, and keeps the rest. `--purge` removes the whole home.

## Outside the home

| Path | What it is |
|---|---|
| `~/.local/bin/kndl` | The `kndl` command: a small script that runs the install's CLI. On a machine without an install, it can be the binary [installed from a Hub](/guides/install-the-cli-from-a-hub/). `KNDL_BIN_DIR` moves it. |
| `~/.config/kndl/cli.json` | The Hub the CLI is signed in to, and its CLI token after [`kndl login`](/guides/sign-in-the-cli/). Readable only by you. `$XDG_CONFIG_HOME/kndl/cli.json` when that's set. |
| `~/Library/LaunchAgents/io.github.kddige.kndl.hub.plist`, `….runner.plist` | macOS: the services, as launchd agents. |
| `~/.config/systemd/user/kndl-hub.service`, `kndl-runner.service` | Linux: the services, as systemd user units. |
| `~/.microsandbox/` | microsandbox's home, with its Sandboxes, volumes and snapshots. |
| `~/.claude.json`, `~/.claude/projects/` | Claude Code's config and transcripts, if Claude Code is on the machine. The Runner copies a Session's transcripts from there into its Sandbox, for Sessions from before they ran in Sandboxes, and removes them and their config entries when it purges the Session. Under `$CLAUDE_CONFIG_DIR` when that's set. Sessions never use this machine's Claude login. |

Each service runs the install's Hub or Runner with its env file and `KNDL_HOME`, logs to `logs/`, starts at login and restarts if it crashes.

## A checkout

A checkout keeps the Runner's files in the dev home, `~/.kndl-dev`, with the same names as an installed home. The Hub's are in the checkout:

| Path | What it is |
|---|---|
| `packages/hub/.env.local` | The Hub's settings. git ignores it. |
| `packages/hub/hub.db`, `hub.db.lock` | The Hub's database, and the lock the running Hub holds. `HUB_DATABASE` moves it. |
| `packages/web/dist/` | The web UI's build, which the Hub serves. `HUB_WEB_DIR` moves it. |
| `packages/mod/` | The mod, whose built durable agent each Session runs. `RUNNER_MOD_DIR` moves it. |

## One Session's directory

Under `sessions/`, each `<session id>/` holds:

| Path | What it is |
|---|---|
| `workspace/` | The Workspace: the Repo's checkout on the Session's Work branch, mounted at `/workspace` in the Sandbox. |
| `mod/` | The copy of the durable agent the Session runs, made each time it starts. |

Archiving a Session keeps its directory and the volume with the agent's state. Purging deletes both.

## Inside a Sandbox

| Path | What it is |
|---|---|
| `/workspace` | The Workspace, mounted from the Runner. |
| `/var/lib/kndl/deps` | The disk holding the Environment's dependency folders, bound over each match in `/workspace`, such as `node_modules`. |
| `/var/cache/kndl` | Package caches, on a disk. `XDG_CACHE_HOME`, `BUN_INSTALL_CACHE_DIR` and `npm_config_cache` point into it. |
| `/var/lib/kndl/claude` | The agent's state, its `KNDL_STATE_DIR`, and Claude Code's, its `CLAUDE_CONFIG_DIR`, on a disk kept when the Session is archived. |
| `/var/lib/kndl/claude/durable` | The agent's conversation, `session.sqlite`, and its log, `agent.log`. |
| `/opt/kndl/claude-code` | The Runner's Linux builds of Claude Code, read-only. |
| `/opt/kndl/pi` | The Runner's Node.js builds and Pi Durable install, read-only. |
| `/opt/kndl/mod` | The Session's copy of the mod, read-only. |
| `/run/kndl/github-token` | The [Sandbox token](/concepts/git-from-sessions/), in memory only. |

## Names

| What | Name |
|---|---|
| The tmux server in a Sandbox | `tmux -L kndl` |
| A Session's tmux session | `hub-<session id>` |
| A Session's Sandbox | `kndl-<session id>` |
| A Sandbox's volumes | `kndl-<session id>.<key>`: `.deps`, `.cache`, `.claude`, and `.docker` with Docker on. A Repo without an Environment has `.deps-node-modules` instead of `.deps`. |
| A Repo's Environment Builds | snapshots `b<build version>-<libc>`, in a group per Runner and Repo |

Everything a Runner makes in microsandbox is labelled `kndl.runner` with a digest of its tmux socket and sessions root. A Runner only stops or removes what carries its own label.
