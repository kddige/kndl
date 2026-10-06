---
title: Add a Runner
description: Connect a machine to the Hub as a Runner, on the Hub's own machine or another, and keep it running.
sidebar:
  order: 3
---

A Runner is a machine that runs Sessions. Each runs on its Creator's [Claude credential](/how-to/add-your-claude-credential/), or else on the Runner's own, if it has one: see [The Runner's Claude credential](/reference/configuration/#the-runners-claude-credential). A Runner needs no Claude Code and no Claude sign-in of its own. Add as many as you like: each connects out to the Hub, so the Hub never needs to reach it.

## Before you start

The machine needs what the [install guide](/how-to/install/#what-each-machine-needs) lists for a Runner: Bun, git, and microsandbox on a Mac with Apple Silicon or Linux with KVM. It must reach the Hub's URL, the one in the Hub's `HUB_PUBLIC_URL`.

## With a Pairing code

Nothing is done on the Hub's machine: anyone signed in to the web UI adds a Runner.

1. In the web UI, open **Runners** in the sidebar and choose **Add a Runner**. It shows a command with a [Pairing code](#pairing-codes) in it:

   ```sh
   claude-hub runner join 'https://hub.example.com#7K2QD-M9XRT-4VBNC-H8PWE'
   ```

2. On the **Runner's machine**, [install claude-hub](/how-to/install/#install), then paste the command.

`runner join` checks the machine has what a Runner needs (and offers to install what's missing), redeems the code with the Hub for the Runner's token, writes `~/.claude-hub/runner.env`, installs and starts the Runner's service, and waits until the Hub says the Runner is connected. The Runners page shows the new Runner as soon as the code is used.

The Runner is named after the machine's short hostname; `--name build-box` names it something else. The name is the Runner's identity on the Hub, so choose it with [Runner names](#runner-names) in mind. Without questions, for a script:

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

For a Hub from before Pairing codes, or to script everything from the Hub's machine. On the **Hub's machine**, issue the Runner's token:

```sh
claude-hub runner token build-box
```

On the **Runner's machine**, [install claude-hub](/how-to/install/#install). When onboard asks, choose **Runner**, then a Runner token, and give it the Hub's URL and the token. Or, without questions:

```sh
claude-hub onboard --role runner --hub-url https://hub.example.com --token chr_… --runner-name build-box
```

Onboard writes `~/.claude-hub/runner.env`, installs the Runner's service and waits for it to connect. `claude-hub status` shows whether it's connected, and `claude-hub logs runner` what it logged.

## The Runners page

**Runners** in the sidebar lists every Runner paired with the Hub: whether it's online, its own Claude credential (or **No Claude credential**), the commit it runs (and its branch), when it was last seen, and how many of its Sessions aren't Archived. A Runner on an older commit than the Hub is marked **behind the Hub**; see [Keep Runners on the Hub's commit](#keep-runners-on-the-hubs-commit). The header says which commit the Hub runs.

- **Re-pair** makes a code for that Runner. The machine that uses it takes the Runner's place: it keeps the Runner's name, id and Sessions, and gets a new token. The old token stops working, and a machine still connected with it is disconnected. Use it to put a reinstalled machine back in its own place, when a Runner's token is lost, or to move a Runner to a new machine. `--name` is ignored for a Re-pair.
- **Remove** revokes the Runner's token, and disconnects it if it's connected. It's refused while the Runner has Sessions that aren't Archived (Active, Asleep or Frozen): archive them first. The Runner's name is then free, and a machine paired later under it takes the removed Runner's place: see [Runner names](#runner-names).

### Runner names

A Runner's name is its identity on the Hub: its Sessions, Archived ones included, belong to the Runner of that name. It's the name the Runner was paired or issued its token under; `RUNNER_NAME` in its `runner.env` changes only what it says on connecting.

- **A reinstalled machine** goes back in its own place with **Re-pair**: it keeps its name and Sessions.
- **A name the Hub has** can't be taken by a new Runner. `runner join` refuses with `The Hub already has a Runner named build-box …`, and the code isn't used up.
- **A removed Runner's name** is free again. A machine paired later under it takes over the removed Runner's record, with its Archived Sessions, which can then be restored onto it. Removing a Runner and adding the machine again under the same name is that takeover.
- **For a clean slate**, with none of the old Runner's Sessions, pair the machine under a name the Hub has never had: `claude-hub runner join '<link>' --name build-box-2`.

`claude-hub runner token <name>` follows the same names without a Pairing code: for a Runner the Hub has, it replaces its token; for a removed one's name, it brings that Runner back.

## Keep Runners on the Hub's commit

Runners follow the Hub's commit ([ADR 0011](/reference/decisions/0011-runners-follow-the-hubs-commit/)). `claude-hub update` on the Hub's machine moves the Hub, and the Hub then asks each Runner to move to its commit as it reconnects. `--no-update-runners` leaves Runners on other machines where they are; the Runner on the Hub's own machine follows either way, since they share the install. See [`claude-hub update`](/reference/commands/#claude-hub-update).

A Runner **behind the Hub** keeps its running Sessions, but the Hub doesn't start or wake Sessions there: `CreateSession` and waking answer `build-box: this Runner needs an update. Update it on the Runners page.`, and prompts sent to its Asleep Sessions wait in their queue until it is updated.

**Update** on its row moves it to the Hub's commit:

1. The Runner checks it may: it fetches from origin, and moves only to a commit reachable from `origin/main`. A Runner whose `runner.env` sets `RUNNER_UPDATE_ANY_COMMIT=1` follows any commit origin has, such as a Hub running a branch. Otherwise its row says **refuses: not on main**, and why.
2. The Hub drains it: no Session starts or wakes there, running Turns get up to ten minutes to end before the Hub stops them, and each Active Session is put to sleep. **Update now** stops the running Turns at once. A sleeping Session keeps its conversation, and the next prompt wakes it on the new version.
3. The Runner checks out the commit, runs `bun install`, builds the `hub-link` mod, checks that it loads, and exits; its service starts it again on the new commit.

Meanwhile its row is marked **updating**, then **restarting**, with a line saying where it is, such as `No new Sessions. Waiting for 2 Sessions' Turns to end (stopped in 9 min if still running)…` or `Installing and building…`.

If a step fails, or the Runner starts three times on the new commit without the Hub welcoming it, the Runner goes back to the commit it ran, rebuilds it, reconnects and reports the error, which its row shows as **update failed** with git's or bun's message. It doesn't try that commit again by itself: fix the cause, then **Update** again.

Only a Runner installed as the claude-hub service updates itself, since only a service manager starts it again. Its row has no **Update**, and says why, when it:

- runs from a checkout (`bun run runner`): it never rewrites a developer's checkout. Pull the checkout to the Hub's commit and restart it.
- runs from a claude-hub from before Runners followed the Hub. Run `claude-hub update` on its machine once; it follows from then on.
- runs from another checkout than the install, or not as the service: run `claude-hub update` on its machine.

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

`bun run runner` builds the `hub-link` mod, then connects to the Hub's `/ws/runner` WebSocket (`wss:` for an `https:` Hub). It appears in the **Runner** list of **New Session** under its name.

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

- **Takes back its running Sessions.** Each Sandbox of its own whose Claude Code still runs keeps running, its terminal streamed again: the Runner reads the Session token back from that Claude Code, and the Hub sends a new mod token for it. It stops (never destroys) every other Sandbox of its own, and the Hub records those Sessions Asleep, waking those with prompts waiting. Sandboxes of other Runners on the same machine it only logs.

If the Hub goes away, the Runner reconnects with backoff, from half a second doubling up to 30 seconds.

## Stop or restart it

Ctrl-C (SIGINT) or SIGTERM stops the Runner at once; `claude-hub runner stop` stops an installed one. While it is offline its Sessions are Frozen: readable, with prompts waiting in their queues. Their Claude Code keeps running in their Sandboxes, so when the Runner starts again they are Active as they were, and the prompts that waited go out. A Session whose Claude Code stopped meanwhile is Asleep, and the next prompt wakes it with its conversation, in the same Sandbox.

To look at a Session's Claude Code by hand, open its **Terminal** tab. It runs in tmux in the Session's Sandbox, on server `claude-hub`, as session `hub-<session id>`.

## Run two Runners on one machine

Two Runners can share a machine, and so its microsandbox, for example a dev Runner from a checkout and an installed one. Give them different tmux sockets and sessions roots (`RUNNER_TMUX_SOCKET`, `RUNNER_SESSIONS_ROOT`): those two settings make up each Runner's mark, which decides which Sandboxes it reconciles. A Runner never touches another's.
