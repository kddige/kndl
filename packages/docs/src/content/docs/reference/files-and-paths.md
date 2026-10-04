---
title: Files and paths
description: Where the Hub and a Runner keep their state on disk, and what claude-hub names in tmux and microsandbox.
sidebar:
  order: 3
---

Paths here are for a checkout, which uses the dev home `~/.claude-hub-dev`. With `CLAUDE_HUB_HOME` set, read that home instead: see [Homes](/reference/configuration/#homes).

## The Hub

| Path | What it is |
|---|---|
| `packages/hub/hub.db` | The Hub's SQLite database: Sessions, their Events, Runners, Environments and Variables. `HUB_DATABASE` moves it. |
| `packages/hub/.env.local` | The Hub's settings, read by `bun run hub` and `bun run runner-token`. git ignores it. |
| `packages/web/dist` | The web UI's build, which the Hub serves. `HUB_WEB_DIR` moves it. |

Back up `hub.db` together with `HUB_SECRETS_KEY`: Sensitive values in the database can't be read without the key.

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
