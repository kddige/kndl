---
title: Add a Runner
description: Connect a machine to the Hub as a Runner, on the Hub's own machine or another, and keep it running.
sidebar:
  order: 4
---

A Runner is a machine that runs Sessions, on its own Claude login. Add as many as you like: each connects out to the Hub, so the Hub never needs to reach it.

:::note[Coming: Pairing codes]
Soon a Runner joins from a one-paste command made on a Runners page in the web UI, without touching the Hub's machine ([#85](https://github.com/kddige/claude-hub/issues/85)). Until then, issue its token on the Hub's machine as below.
:::

## Before you start

The machine needs what the [install guide](/how-to/install/#what-each-machine-needs) lists for a Runner: Bun, git, tmux, Claude Code signed in, and microsandbox on a Mac with Apple Silicon or Linux with KVM. It must reach the Hub's URL.

## With the `claude-hub` command

On the **Hub's machine**, issue the Runner's token:

```sh
claude-hub runner token build-box
```

On the **Runner's machine**, [install claude-hub](/how-to/install/#install). When onboard asks, choose **Runner**, then give it the Hub's URL and the token. Or, without questions:

```sh
claude-hub onboard --role runner --hub-url https://hub.example.com --token chr_… --runner-name build-box
```

Onboard writes `~/.claude-hub/runner.env`, installs the Runner's service and waits for it to connect. `claude-hub status` shows whether it's connected, and `claude-hub logs runner` what it logged.

The rest of this page runs a Runner from a checkout. What the Runner does once it runs is the same either way.

## From a checkout

The machine needs a checkout of claude-hub with `bun install` run.

### Issue a Runner token

On the **Hub's machine**, in its checkout, name the Runner and issue its token:

```sh
bun run runner-token build-box
```

It prints a token that starts with `chr_`. The Hub keeps only a hash of it, so copy it now. Running `runner-token` again for the same name keeps the Runner's id and its Sessions, and replaces the token, so the old one stops working.

### Start the Runner

On the **Runner's machine**, in its checkout:

```sh
HUB_URL=https://hub.example.com RUNNER_TOKEN=chr_… bun run runner
```

`bun run runner` builds the `hub-link` mod, then connects to the Hub's `/ws/runner` WebSocket (`wss:` for an `https:` Hub). It appears in the **Runner** list of **New Session** under its name, with its Claude login.

On the Hub's own machine, `HUB_URL` can stay at its default, `http://127.0.0.1:7777`.

To keep the settings out of your shell history, put them in an env file and start it with `bun --env-file`:

```sh
# ~/.claude-hub-dev/runner.env (chmod 600)
HUB_URL=https://hub.example.com
RUNNER_TOKEN=chr_…
```

```sh
bun --env-file="$HOME/.claude-hub-dev/runner.env" run runner
```

Every Runner setting is in the [configuration reference](/reference/configuration/#runner).

## What the Runner does on start

- **Trusts its sessions root** in Claude Code's config file (`~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`), so Sessions skip Claude Code's folder-trust dialog. It sets one entry, for the root, and never creates the file: if Claude Code has never run on the machine, it warns and each Session asks.
- **Re-adopts its Sessions** still running in tmux from before, restarting each one's Sandbox if it stopped.
- **Reconciles its Sandboxes.** It stops (never destroys) a Sandbox of its own whose Session it doesn't run, and only logs Sandboxes of other Runners on the same machine.

If the Hub goes away, the Runner reconnects with backoff, from half a second doubling up to 30 seconds.

## Stop or restart it

Ctrl-C (SIGINT) or SIGTERM stops the Runner at once; `claude-hub runner stop` stops an installed one. Its Sessions keep running in tmux, on its own tmux server (`tmux -L claude-hub-dev` from a checkout, `tmux -L claude-hub` installed), and it re-adopts them when it starts again. While it is offline its Sessions are Frozen: readable, with prompts waiting in their queues.

To look at a Session's Claude Code by hand:

```sh
tmux -L claude-hub-dev attach -t hub-<session id>
```

## Run two Runners on one machine

Two Runners can share a machine, and so its microsandbox, for example a dev Runner from a checkout and an installed one. Give them different tmux sockets and sessions roots (`RUNNER_TMUX_SOCKET`, `RUNNER_SESSIONS_ROOT`): those two settings make up each Runner's mark, which decides which Sessions it re-adopts and which Sandboxes it reconciles. A Runner never touches another's.
