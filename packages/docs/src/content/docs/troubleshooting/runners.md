---
title: Runners
description: A Runner can't reach the Hub, won't pair, falls behind the Hub, or fails to update.
sidebar:
  order: 4
---

Fixes for Runners. A Runner connects out to the Hub and keeps retrying while it can't, so a Runner that never shows up almost always has a connection problem. Read its log:

```sh
kndl logs runner
```

## Hub connection: could not connect

**What you see.** The Runner logs, again and again:

```
Hub connection: could not connect to ws://127.0.0.1:7777/ws/runner: …
Reconnecting to the Hub in 500 ms
```

**Why.** The Hub isn't running, `HUB_URL` in `runner.env` is wrong, or something between them blocks it.

**Fix.** From the Runner's machine, check the Hub answers at the Runner's `HUB_URL`:

```sh
curl https://hub.example.com/health
```

It should print `{"status":"ok"}`. Fix `HUB_URL`, including `https:` behind HTTPS, and restart the Runner with `kndl runner install`. The Runner connects by itself once the Hub is reachable.

## A Runner on another machine never shows up

**What you see.** The Runner on a second machine logs `could not connect to …` forever, although the Hub runs.

**Why.** The Hub listens only on `127.0.0.1` unless you set it up for other machines.

**Fix.** Make the Hub reachable from the Runner's machine, and point the Runner's `HUB_URL` at it. See [Reach the Hub from other machines](/self-hosting/reach-the-hub-from-other-machines/).

## That pairing code can't be used

**What you see.** `kndl runner join` stops with:

```
That pairing code can't be used: it may be mistyped, expired (codes last 15 minutes), already used or revoked. Make a new one on the Hub's Runners page (Add a Runner).
```

**Why.** A Pairing code works once, for 15 minutes.

**Fix.** Make a new one with **Add a Runner** on the Runners page, and paste the whole command. Other answers:

| Message | Fix |
|---|---|
| `The code after # isn't a whole pairing code …` | Copy the command again: part of the link is missing. |
| `The Hub already has a Runner named build-box …` | Join with `--name` and another name, or **Re-pair** that Runner to replace it. |
| `Couldn't reach the Hub at …` | See [A Runner on another machine never shows up](#a-runner-on-another-machine-never-shows-up). |

## Runner: not connected to the Hub after 30 seconds

**What you see.** `kndl runner join` pairs, then says:

```
Runner: not connected to the Hub after 30 seconds: see `kndl logs runner`
```

**Why.** The token is saved, but the service didn't start, or can't reach the Hub's WebSocket, as behind a proxy that doesn't pass WebSockets.

**Fix.** Read `kndl logs runner` and run `kndl doctor`. Once fixed, run `kndl runner start`. The token is saved and doesn't expire.

## The Hub doesn't accept this Runner's token

**What you see.** The Runner logs, at every reconnect:

```
The Hub doesn't accept this Runner's token: the Runner was removed on the Hub's Runners page, or paired again with a new token. …
```

**Why.** Someone removed the Runner on the Runners page, or re-paired it.

**Fix.** Make a code on the Runners page and run `kndl runner join` with it: **Re-pair** the Runner if it's still listed, to keep its Sessions, or **Add a Runner** if it was removed. To stop using the machine instead, run `kndl uninstall`.

## Remove says the Runner has Sessions

**What you see.** **Remove** on the Runners page says:

```
Runner build-box has 2 Sessions that aren't Archived. Archive them first, then remove the Runner.
```

**Why.** A removed Runner never connects again, so its Sessions would be stuck.

**Fix.** Archive each of its Sessions, then remove it. You can archive a Frozen Session while its Runner is offline.

## This Runner needs an update

**What you see.** The Runners page marks a Runner **behind the Hub** or **not the Hub's commit**, and starting or waking a Session there says:

```
build-box: this Runner needs an update. Update it on the Runners page.
```

**Why.** The Runner runs a different commit of kndl than the Hub. Its running Sessions go on, but none starts or wakes there until it matches.

**Fix.** Press **Update** on its row. If the row has no **Update**, run `kndl update` on the Runner's machine. See [Keep Runners on the Hub's commit](/self-hosting/add-a-runner/#keep-runners-on-the-hubs-commit).

## Refuses: not on main

**What you see.** The Runner's row says one of:

| Row | Message |
|---|---|
| **refuses: not on main** | `1a2b3c4d5e6f isn't on origin/main. To follow any commit, set RUNNER_UPDATE_ANY_COMMIT=1 in the Runner's runner.env.` |
| **refuses: commit not on origin** | `origin has no commit 1a2b3c4d5e6f: push it before the Hub's Runners can follow it.` |
| **couldn't check the commit** | `It couldn't fetch from origin: …` |

**Why.** A Runner moves only to a commit it can fetch, and only to one on `origin/main` unless told otherwise.

**Fix.**

- **Not on main:** run the Hub on `main` or a Release. For a dev Hub on a branch, add `RUNNER_UPDATE_ANY_COMMIT=1` to the Runner's `runner.env`, run `kndl runner install`, and press **Update** again.
- **Not on origin:** push the commit the Hub runs.
- **Couldn't check:** run `git fetch` in `~/.kndl/app` on the Runner's machine to see why.

## Update failed

**What you see.** The Runner's row says **update failed**:

```
Moving to 1a2b3c4d5e6f failed, so it went back to the commit it ran: bun install failed: …
```

**Why.** A step of the update failed, so the Runner went back to the commit it ran. If that failed too, the row says `and so did going back; see its log`.

**Fix.** Read `kndl logs runner` on the Runner's machine, fix the cause (often the network or disk space), and press **Update** again. If going back failed, run `kndl update` there.

## The Hub turned this Runner away

**What you see.** The Runner logs, and tries again every minute:

```
The Hub turned this Runner away: Protocol version mismatch: the peer speaks version 1, this side speaks version 2. Update the peer.
Updating this Runner to the Hub's commit (the Hub runs 1a2b3c4d5e6f on main).
```

**Why.** The Hub and the Runner speak different protocol versions. A Runner installed as the kndl service moves to the Hub's commit by itself.

**Fix.** Usually nothing. If it logs `To connect again, this Runner needs the Hub's version …`, run `kndl update` on its machine.

## A Session is Frozen

**What you see.** A Session shows **This Session is Frozen**.

**Why.** Its Runner isn't connected to the Hub. The Session's Sandbox and Workspace are on that Runner, so it waits for it.

**Fix.** Start the Runner again, or fix its connection. Prompts sent meanwhile wait, and run once the Runner is back. See [Frozen](/concepts/session-lifecycle/#frozen).

## The hub-link mod isn't built

**What you see.** The Runner exits at startup with:

```
The hub-link mod isn't built: …/packages/mod/plugins/hub-link/hooks/hub-link-lib.js is missing. Run `bun run mod:build`.
```

**Why.** The Runner loads the mod into each Session's Claude Code, and nothing has built it.

**Fix.**

```sh
kndl doctor --fix
```

It builds the mod. Then run `kndl runner start`.

## Unknown Sandbox for Session

**What you see.** At startup the Runner logs:

```
Unknown Sandbox for Session 0cb88decd7211ad04f6a64a8: Stopped (stopped now); volumes: …
```

**Why.** The Sandbox is the Runner's, but no longer runs a Session, as after a crash. The Runner stops it and keeps its disks.

**Fix.** Nothing is lost, and nothing needs doing.
