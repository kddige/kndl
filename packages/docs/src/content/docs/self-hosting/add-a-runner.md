---
title: Add a Runner
description: Connect a machine to the Hub as a Runner, on the Hub's own machine or another, and keep it running.
sidebar:
  order: 3
---

At the end of this page, a machine is connected to the Hub as a Runner and runs Sessions. Add as many as you like: each connects out to the Hub, so the Hub never needs to reach it.

A Runner needs no Claude Code and no Claude sign-in. Its Sessions run on their Creator's [Claude credential](/guides/add-your-claude-credential/), or on [the Runner's own](/reference/configuration/#the-runners-claude-credential) if it has one.

## Before you start

- The machine needs what the [install guide](/self-hosting/install/#what-each-machine-needs) lists for a Runner.
- It must reach the Hub's `HUB_PUBLIC_URL`.

## With a Pairing code

Anyone signed in to the web UI can add a Runner, without touching the Hub's machine.

1. In the web UI, open **Runners** in the sidebar and choose **Add a Runner**. It shows a command with a [Pairing code](#pairing-codes) in it:

   ```sh
   kndl runner join 'https://hub.example.com#7K2QD-M9XRT-4VBNC-H8PWE'
   ```

2. On the **Runner's machine**, [install kndl](/self-hosting/install/#install), then paste the command.

`runner join` offers to install what's missing, writes `~/.kndl/runner.env`, installs and starts the Runner's service, and waits until it's connected. The Runners page shows the new Runner.

The Runner is named after the machine's short hostname; `--name build-box` names it something else (see [Runner names](#runner-names)). Without questions, for a script:

```sh
kndl runner join 'https://hub.example.com#7K2QD-M9XRT-4VBNC-H8PWE' --name build-box --non-interactive
```

`kndl onboard --role runner --pair '<link>'` does the same. See [the command reference](/reference/commands/#kndl-runner-join).

### Pairing codes

- A code works **once**, for **15 minutes**, and is shown only once. Unused ones are listed under **Pairing codes not used yet** on the Runners page, where anyone signed in can revoke them.
- Anyone with the code can pair a machine with the Hub, so share it only with whoever is setting up the Runner.
- Revoking a code, or letting it expire, doesn't affect a Runner already paired with it.
- Case, dashes and spaces don't matter, so a code read aloud still works.

## With a Runner token

To script everything from the Hub's machine, use a token. On the **Hub's machine**, issue the Runner's token:

```sh
kndl runner token build-box
```

On the **Runner's machine**, [install kndl](/self-hosting/install/#install). When onboard asks, choose **Runner**, then a Runner token, and give it the Hub's URL and the token. Or, without questions:

```sh
kndl onboard --role runner --hub-url https://hub.example.com --token chr_… --runner-name build-box
```

`kndl status` shows whether it's connected, and `kndl logs runner` what it logged.

## The Runners page

**Runners** in the sidebar lists every Runner: whether it's online, its Claude credential, the commit it runs, when it was last seen, and how many of its Sessions aren't Archived. A commit that is a Release's shows the Release first, such as `2026.10.1 (824de4a1f0c3)` ([ADR 0025](/contributing/decisions/0025-releases-and-channels/)); the Hub's own is at the top of the page. A Runner whose commit is behind the Hub's is marked **behind the Hub**: see [Keep Runners on the Hub's commit](#keep-runners-on-the-hubs-commit).

- **Re-pair** makes a code for that Runner. The machine that uses it takes the Runner's place, with its name and Sessions, and the old token stops working. Use it for a reinstalled machine, a lost token, or to move a Runner to a new machine.
- **Remove** revokes the Runner's token and disconnects it. Archive its Sessions first: it's refused while any aren't Archived.

### Runner names

A Runner's name is its identity on the Hub: its Sessions, Archived ones included, belong to the Runner of that name. It's the name it was paired or issued its token under.

- **A name the Hub has** can't be taken by a new Runner: `runner join` refuses with `The Hub already has a Runner named build-box …`, and the code isn't used up. To put a reinstalled machine back in its place, use **Re-pair**.
- **A removed Runner's name** is free again. A machine paired under it takes over the removed Runner's Archived Sessions, which can then be restored onto it.
- **For a clean slate**, pair under a name the Hub has never had: `kndl runner join '<link>' --name build-box-2`.

`kndl runner token <name>` follows the same rules: for a Runner the Hub has, it replaces its token.

## Keep Runners on the Hub's commit

Runners follow the Hub's commit ([ADR 0011](/contributing/decisions/0011-runners-follow-the-hubs-commit/)). After `kndl update` on the Hub's machine, the Hub asks each Runner to move to its commit; `--no-update-runners` leaves Runners on other machines where they are. See [`kndl update`](/reference/commands/#kndl-update).

A Runner **behind the Hub** keeps its running Sessions, but no Session starts or wakes there: the Hub answers `build-box: this Runner needs an update. Update it on the Runners page.`, and prompts to its Asleep Sessions wait in their queue.

To move it to the Hub's commit, press **Update** on its row:

1. The Runner moves only to a commit reachable from `origin/main`, unless its `runner.env` sets `RUNNER_UPDATE_ANY_COMMIT=1`. Otherwise its row says **refuses: not on main**.
2. Running Turns get up to ten minutes to end, then each Active Session goes to sleep; **Update now** stops the Turns at once. The next prompt wakes a Session on the new version.
3. The Runner updates, rebuilds and restarts. Its row shows **updating**, then **restarting**, with a line saying where it is.

If a step fails, the Runner goes back to the commit it ran and its row shows **update failed** with the error. Fix the cause, then press **Update** again.

Only a Runner installed as the kndl service updates itself. Otherwise its row has no **Update** and says why: pull a checkout to the Hub's commit and restart it, or run `kndl update` on the Runner's machine.

## From a checkout

The machine needs a checkout of kndl with `bun install` run.

### Issue a Runner token

On the **Hub's machine**, in its checkout, name the Runner and issue its token:

```sh
bun run runner-token build-box
```

It prints a token that starts with `chr_`. Copy it now: it isn't shown again. Running `runner-token` again for the same name replaces the token, and keeps the Runner's Sessions.

### Start the Runner

On the **Runner's machine**, in its checkout:

```sh
HUB_URL=https://hub.example.com RUNNER_TOKEN=chr_… bun run runner
```

It appears in the **Runner** list of **New Session** under its name. On the Hub's own machine, leave out `HUB_URL`: it defaults to `http://127.0.0.1:7777`.

To keep the settings out of your shell history, put them in an env file and start it with `bun --env-file`:

```sh
# ~/.kndl-dev/runner.env (chmod 600)
HUB_URL=https://hub.example.com
RUNNER_TOKEN=chr_…
```

```sh
bun --env-file="$HOME/.kndl-dev/runner.env" run runner
```

Every Runner setting is in the [configuration reference](/reference/configuration/#runner).

## Stop or restart it

`kndl runner stop` stops an installed Runner; Ctrl-C stops one from a checkout. While it is offline its Sessions are [Frozen](/concepts/session-lifecycle/#frozen), and their Claude Code keeps running. When the Runner starts again they carry on, and the prompts that waited go out. If the Hub goes away, the Runner reconnects by itself.

To look at a Session's Claude Code by hand, open its **Terminal** tab. It runs in tmux in the Session's Sandbox, on server `kndl`, as session `hub-<session id>`.

## Run two Runners on one machine

Two Runners can share a machine, such as a dev Runner from a checkout and an installed one. Give them different `RUNNER_TMUX_SOCKET` and `RUNNER_SESSIONS_ROOT` settings, so each keeps to its own Sandboxes. A checkout and an install differ in both by default.
