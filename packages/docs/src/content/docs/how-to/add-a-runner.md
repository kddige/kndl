---
title: Add a Runner
description: Connect a machine to the Hub as a Runner, on the Hub's own machine or another, and keep it running.
sidebar:
  order: 4
---

A Runner is a machine that runs Sessions, on its own Claude login. Add as many as you like: each connects out to the Hub, so the Hub never needs to reach it.

## Before you start

The machine needs what the [install guide](/how-to/install/#what-each-machine-needs) lists for a Runner: Bun, git, tmux, Claude Code signed in, and microsandbox on a Mac with Apple Silicon or Linux with KVM. It must reach the Hub's URL, the one in the Hub's `HUB_PUBLIC_URL`.

## With a pairing code

Nothing is done on the Hub's machine: anyone signed in to the web UI adds a Runner.

1. In the web UI, open **Runners** in the sidebar and choose **Add a Runner**. It shows a command with a [pairing code](#pairing-codes) in it:

   ```sh
   claude-hub runner join 'https://hub.example.com#7K2QD-M9XRT-4VBNC-H8PWE'
   ```

2. On the **Runner's machine**, [install claude-hub](/how-to/install/#install), then paste the command.

`runner join` checks the machine has what a Runner needs (and offers to install what's missing), redeems the code with the Hub for the Runner's token, writes `~/.claude-hub/runner.env`, installs and starts the Runner's service, and waits until the Hub says the Runner is connected. The Runners page shows the new Runner as soon as the code is used.

The Runner is named after the machine's short hostname; `--name build-box` names it something else. Without questions, for a script:

```sh
claude-hub runner join 'https://hub.example.com#7K2QD-M9XRT-4VBNC-H8PWE' --name build-box --non-interactive
```

`claude-hub onboard --role runner --pair '<link>'` does the same, and onboard run without flags asks whether the Runner has a pairing link or a token. See [the command reference](/reference/commands/#claude-hub-runner-join).

### Pairing codes

- A code works **once**, for **15 minutes**. Unused ones are listed under **Pairing codes not used yet** on the Runners page, where anyone signed in can revoke them.
- Anyone with the code can pair a machine with the Hub until it's used or expires, so share it only with whoever is setting up the Runner. The Hub keeps only a hash of it, and the page shows the code only once.
- The code is only how the Runner gets its token. Revoking a code, or letting it expire, never affects a Runner already paired with it.
- A code is 20 letters and digits. Case, dashes and spaces don't matter, and `O`, `I` and `L` are read as `0`, `1` and `1`, so a code read aloud still works.

## With a Runner token

For a Hub from before pairing codes, or to script everything from the Hub's machine. On the **Hub's machine**, issue the Runner's token:

```sh
claude-hub runner token build-box
```

On the **Runner's machine**, [install claude-hub](/how-to/install/#install). When onboard asks, choose **Runner**, then a Runner token, and give it the Hub's URL and the token. Or, without questions:

```sh
claude-hub onboard --role runner --hub-url https://hub.example.com --token chr_… --runner-name build-box
```

Onboard writes `~/.claude-hub/runner.env`, installs the Runner's service and waits for it to connect. `claude-hub status` shows whether it's connected, and `claude-hub logs runner` what it logged.

## The Runners page

**Runners** in the sidebar lists every Runner paired with the Hub: whether it's online, the Claude login it runs Sessions on, the commit it runs (and its branch), when it was last seen, and how many of its Sessions aren't Archived. A Runner on an older commit than the Hub is marked **behind the Hub**: update it with `claude-hub update` on its machine. The header says which commit the Hub runs.

- **Re-pair** makes a code for that Runner. The machine that uses it takes the Runner's place: it keeps the Runner's name, id and Sessions, and gets a new token. The old token stops working, and a machine still connected with it is disconnected. Use it when a Runner's token is lost, or to move a Runner to a new machine. `--name` is ignored for a Re-pair.
- **Remove** revokes the Runner's token, and disconnects it if it's connected. It's refused while the Runner has Sessions that aren't Archived (Active, Asleep or Frozen): archive them first. To use the machine again, add it again with **Add a Runner**: a Runner added by a removed one's name takes its place, and its Archived Sessions can be restored again.

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
