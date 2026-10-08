---
title: Runners
description: A Runner won't start, can't reach the Hub, or doesn't show up in the web UI.
sidebar:
  order: 4
---

A Runner checks its settings, then connects out to the Hub and keeps reconnecting while it can't. A Runner that runs but never shows up in **New Session** almost always has a connection problem: look at its log.

## No Runner token

**What you see.** The Runner exits at once with:

```
ERROR (#2): ConfigError: SchemaError(Expected string
  at ["RUNNER_TOKEN"])
```

**Why.** `RUNNER_TOKEN` isn't set. The Runner doesn't read `packages/hub/.env.local`, which is the Hub's.

**Fix.** Pair the machine with `kndl runner join`, which writes the token, or issue one on the Hub's machine with `bun run runner-token <name>` and start the Runner with it. See [Add a Runner](/how-to/add-a-runner/).

## The mod isn't built

**What you see.** The Runner exits at startup with:

```
The hub-link mod isn't built: …/packages/mod/plugins/hub-link/hooks/hub-link-lib.js is missing. Run `bun run mod:build`.
```

**Why.** The Runner loads the mod into each Session's Claude Code. `bun run runner` builds it; running the Runner's package directly doesn't.

**Fix.** Start the Runner with `bun run runner` from the checkout's root, or run `bun run mod:build` first.

## The Runner can't reach the Hub

**What you see.** The Runner logs, again and again, with waits growing up to 30 seconds:

```
WARN (#2): Hub connection: could not connect to ws://127.0.0.1:7777/ws/runner: An error occurred during Open
INFO (#2): Reconnecting to the Hub in 500 ms
```

**Why.** Check the Hub's log:

- **The Hub logs nothing.** The Hub isn't running, `HUB_URL` names the wrong host, port or scheme, or something between them blocks it.
- **The Hub logs `Unauthorized: Expected a Runner token`** for `/ws/runner`. The token was mistyped, is from another Hub's database, or was replaced by running `runner-token` again for this name.

**Fix.**

- From the Runner's machine, `curl <HUB_URL>/health` should answer `{"status":"ok"}`.
- Check `HUB_URL` is the Hub's own URL, with `https:` if the Hub is behind HTTPS.
- For a refused token, see [The Hub doesn't accept the Runner's token](#the-hub-doesnt-accept-the-runners-token).

The Runner connects on its own once the Hub is reachable.

## A Runner on another machine never shows up

**What you see.** The Runner on a second machine logs `could not connect to …` forever, although the Hub runs.

**Why.** The Hub listens on `127.0.0.1` by default, and `HUB_URL` defaults to `http://127.0.0.1:7777`, which on the second machine names that machine itself.

**Fix.** Make the Hub reachable from the Runner's machine and point `HUB_URL` at it. See [Reach the Hub from other machines](/how-to/reach-the-hub-from-other-machines/). Nothing connects in to the Runner.

## The Pairing code can't be used

**What you see.** `kndl runner join` stops before writing anything with:

```
That pairing code can't be used: it may be mistyped, expired (codes last 15 minutes), already used or revoked. Make a new one on the Hub's Runners page (Add a Runner).
```

**Why.** A code works once, for 15 minutes; one made with **Re-pair** also stops working when its Runner is removed. The Hub gives the same answer for every code it won't take.

**Fix.** Make a new code on the Runners page and paste the whole command. A code typed by hand may use any case, and dashes and spaces are optional.

Other answers:

- `The code after # isn't a whole pairing code …`: part of the link is missing. Copy the command again.
- `The Hub already has a Runner named build-box …`: join with `--name` and another name, or, if this machine should replace that Runner, **Re-pair** it on the Runners page and join with that code. The code isn't used up.
- `Couldn't reach the Hub at …`: the machine can't reach the Hub's `HUB_PUBLIC_URL`. See [A Runner on another machine never shows up](#a-runner-on-another-machine-never-shows-up).

## The Runner was paired but doesn't connect

**What you see.** `runner join` pairs, then says `` Runner: not connected to the Hub after 30 seconds: see `kndl logs runner` ``.

**Why.** The token is saved and the Runners page lists the Runner, offline, but the service didn't start or can't reach the Hub over its WebSocket, as behind a proxy that doesn't pass WebSockets.

**Fix.** Read `kndl logs runner` and run `kndl doctor`. Once fixed, run `kndl runner start`: the token is already saved and doesn't expire.

## The Hub doesn't accept the Runner's token

**What you see.** The Runner logs, at every reconnect:

```
The Hub doesn't accept this Runner's token: the Runner was removed on the Hub's Runners page, or paired again with a new token. …
```

and `kndl status` says the Hub doesn't accept the token.

**Why.** Someone removed the Runner on the Runners page, or Re-paired it and the code was used. Its Sessions keep running in their Sandboxes.

**Fix.** To keep the machine as a Runner, make a code on the Runners page and run `kndl runner join` with it: **Re-pair** the Runner if it's still listed, to keep its Sessions; **Add a Runner** if it was removed. Otherwise run `kndl runner stop`, or `kndl uninstall`.

## A Runner can't be removed

**What you see.** **Remove** on the Runners page says `Runner build-box has 2 Sessions that aren't Archived. Archive them first, then remove the Runner.`

**Why.** A removed Runner never connects again, so its Sessions would be stuck.

**Fix.** Archive each of its Sessions, then remove it. A Frozen Session can be archived while its Runner is offline.

## A Runner is behind the Hub

**What you see.** The Runners page marks a Runner **behind the Hub**, or **not the Hub's commit**. Starting a Session on it, or waking one of its Sessions, fails with:

```
build-box: this Runner needs an update. Update it on the Runners page.
```

**Why.** It runs an older commit of kndl than the Hub, or one the Hub's history doesn't have. The Hub starts and wakes no Session there until it matches; running Sessions go on, and prompts to Asleep ones wait in their queue.

**Fix.** Press **Update** on its row ([Keep Runners on the Hub's commit](/how-to/add-a-runner/#keep-runners-on-the-hubs-commit)). Without **Update**, the row says why:

- It runs from a checkout (`bun run runner`): pull the checkout to the Hub's commit and restart it.
- It isn't run as the kndl service: run `kndl update` on its machine.

While it updates, Sessions fail with `build-box: this Runner is updating. Sessions start and wake there again once it is back.`

## A Runner refuses to update

**What you see.** The Runner's row says **refuses: not on main**:

```
1a2b3c4d5e6f isn't on origin/main. To follow any commit, set RUNNER_UPDATE_ANY_COMMIT=1 in the Runner's runner.env.
```

or **refuses: commit not on origin** (`origin has no commit 1a2b3c4d5e6f: push it before the Hub's Runners can follow it.`), or **couldn't check the commit** (`It couldn't fetch from origin: …`).

**Why.** A Runner moves only to a commit it can fetch, and by default only to one on `origin/main`.

**Fix.**

- **not on main**: run the Hub on `main`, or add `RUNNER_UPDATE_ANY_COMMIT=1` to the Runner's `runner.env`, restart it with `kndl runner stop` and `kndl runner start`, and press **Update** again.
- **not on origin**: push the commit the Hub runs.
- **couldn't check**: run `git fetch` in the Runner's install, `~/.kndl/app`, to see why.

## A Runner's update failed

**What you see.** The Runner's row says **update failed**:

```
Moving to 1a2b3c4d5e6f failed, so it went back to the commit it ran: bun install failed: …
```

**Why.** A step of the update failed, such as `bun install`, building the mod, or the restarted Runner reaching the Hub. The Runner went back to the commit it ran. If that failed too, the row says `and so did going back; see its log`.

**Fix.** Read `kndl logs runner` on its machine, fix the cause (often the network or disk space), and press **Update** again. If going back failed, run `kndl update` on its machine.

## The Hub turns the Runner away

**What you see.** The Runner logs, and tries again every minute:

```
The Hub turned this Runner away: Protocol version mismatch: the peer speaks version 1, this side speaks version 2. Update the peer.
Updating this Runner to the Hub's commit (the Hub runs 1a2b3c4d5e6f on main).
```

or, for a Runner that doesn't update itself:

```
To connect again, this Runner needs the Hub's version (the Hub runs 1a2b3c4d5e6f on main): run `kndl update` on this machine. Retrying meanwhile.
```

**Why.** The Hub and the Runner speak different protocol versions. A Runner that updates itself moves to the Hub's commit; its Sessions keep running.

**Fix.** Usually nothing. If the Runner can't follow, run `kndl update` on its machine, or pull a checkout to the Hub's commit and restart `bun run runner`.

## Its Sessions are Frozen

**What you see.** A Session shows **This Session is Frozen**: `Its Runner is offline. Prompts sent now wait in the queue until the Runner is back.`

**Why.** Its Runner isn't connected to the Hub. A Session's Sandbox and Workspace are on its Runner, so it waits for that Runner.

**Fix.** Start the Runner again, or fix its connection. Each Session is then Active if its Claude Code still runs, and otherwise Asleep, woken at once if prompts are waiting. See [the Session lifecycle](/explanation/session-lifecycle/#frozen).

## It warns about Sandboxes it doesn't know

**What you see.** At startup the Runner logs:

```
WARN (#2): Unknown Sandbox for Session 0cb88decd7211ad04f6a64a8: Stopped (stopped now); volumes: …
```

**Why.** The Sandbox is the Runner's own, but it no longer runs its Session, for example after a crash. The Runner stops it and keeps its disks.

**Fix.** Nothing is lost. To clean up, run `bun x msb list` from `packages/runner` and remove the Sandbox with microsandbox's CLI.
