---
title: Runners
description: A Runner won't start, can't reach the Hub, or doesn't show up in the web UI.
sidebar:
  order: 4
---

A Runner checks its settings and Claude Code's login before it connects. Then it connects out to the Hub and keeps reconnecting while it can't, so a Runner that is running but never shows up in **New Session** is almost always a connection problem: look at its log.

## No Runner token

**What you see.** The Runner exits at once with:

```
ERROR (#2): ConfigError: SchemaError(Expected string
  at ["RUNNER_TOKEN"])
```

**Why.** `RUNNER_TOKEN` isn't set. Every Runner needs one, and the Runner doesn't read `packages/hub/.env.local`, which is the Hub's.

**Fix.** Pair the machine with `claude-hub runner join`, which writes the token, or issue one on the Hub's machine with `bun run runner-token <name>` and start the Runner with it. See [Add a Runner](/how-to/add-a-runner/).

## No Claude account is signed in

**What you see.** The Runner exits at startup with:

```
RunnerLoginUnknown: No Claude account is signed in according to /Users/you/.claude.json. Run `claude` and sign in, or set RUNNER_LOGIN.
```

**Why.** Every Session on a Runner uses the Claude Code login of the user that runs it. The Runner reads which account that is from Claude Code's config file, `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`), to show it on each Session, and found none.

**Fix.** As the user that runs the Runner, run `claude` and sign in, then start the Runner again. If Claude Code is signed in some way the file doesn't record, set `RUNNER_LOGIN` to how the login should be shown.

## The mod isn't built

**What you see.** The Runner exits at startup with:

```
The hub-link mod isn't built: …/packages/mod/hooks/hub-link-lib.js is missing. Run `bun run mod:build`.
```

**Why.** The Runner loads the `hub-link` mod into each Session's Claude Code, and it must be built first. `bun run runner` builds it for you; running the Runner's package directly doesn't.

**Fix.** Start the Runner with `bun run runner` from the checkout's root, or run `bun run mod:build` first.

## The Runner can't reach the Hub

**What you see.** The Runner starts, then logs, again and again, with longer waits up to 30 seconds:

```
WARN (#2): Hub connection: could not connect to ws://127.0.0.1:7777/ws/runner: An error occurred during Open
INFO (#2): Reconnecting to the Hub in 500 ms
```

**Why.** The Runner logs the same lines whether the Hub can't be reached or turned it away, so check the Hub's log too:

- **The Hub logs nothing.** The connection never arrived: the Hub isn't running, `HUB_URL` names the wrong host, port or scheme, or something between them blocks it.
- **The Hub logs `Unauthorized: Expected a Runner token`** with `"http.url": "/ws/runner"` and `"http.status": 401`. The Hub doesn't know the token: it was mistyped, it is from another Hub's database, or `runner-token` was run again for this name, which replaces the old token.

**Fix.**

- Check the Hub is up from the Runner's machine: `curl <HUB_URL>/health` should answer `{"status":"ok"}`.
- Check `HUB_URL` is the Hub's own URL, with `https:` if the Hub is behind HTTPS. The Runner adds `/ws/runner`, over `wss:` for an `https:` URL.
- For a refused token, see [The Hub doesn't accept the Runner's token](#the-hub-doesnt-accept-the-runners-token).

The Runner keeps trying, so it connects on its own once the Hub is back.

## A Runner on another machine never shows up

**What you see.** The Runner on a second machine logs `could not connect to …` forever, although the Hub runs.

**Why.** The Hub listens on `127.0.0.1` by default, so only its own machine can reach it. `HUB_URL` also defaults to `http://127.0.0.1:7777`, which on the second machine names that machine itself.

**Fix.** Make the Hub reachable from the Runner's machine, and point `HUB_URL` at it. [Reach the Hub from other machines](/how-to/reach-the-hub-from-other-machines/) covers HTTPS, Tailscale and SSH tunnels. A Runner only needs to reach the Hub; nothing connects in to the Runner.

## The Pairing code can't be used

**What you see.** `claude-hub runner join` stops before writing anything with:

```
That pairing code can't be used: it may be mistyped, expired (codes last 15 minutes), already used or revoked. Make a new one on the Hub's Runners page (Add a Runner).
```

**Why.** The Hub gives the same answer for every code it won't take, so as not to tell a guesser which codes exist. A code works once, for 15 minutes; one made with **Re-pair** also stops working when its Runner is removed.

**Fix.** Make a new code on the Runners page and paste the new command. Pasting the whole command, quotes included, avoids typos; a code typed by hand may use any case, and dashes and spaces are optional.

A few other answers come before the Hub is asked, or instead:

- `The code after # isn't a whole pairing code …`: part of the link is missing. Copy the command again.
- `The Hub already has a Runner named build-box …`: the short hostname is taken by another Runner. Join with `--name` and another name, or, if this machine should take that Runner's place, **Re-pair** it on the Runners page and join with that code. The code isn't used up.
- `… doesn't pair Runners with codes: it runs a claude-hub from before them`: update the Hub, or issue a token on its machine with `claude-hub runner token <name>` and run `claude-hub onboard --role runner --hub-url <url> --token <token>`.
- `Couldn't reach the Hub at …`: the machine can't reach the URL in the link, the Hub's `HUB_PUBLIC_URL`. See [A Runner on another machine never shows up](#a-runner-on-another-machine-never-shows-up).

## The Runner was paired but doesn't connect

**What you see.** `runner join` pairs, then says `` Runner: not connected to the Hub after 30 seconds: see `claude-hub logs runner` ``.

**Why.** The token is in `runner.env` and the Runners page lists the Runner, offline, but the service didn't start or can't reach the Hub over its WebSocket. A proxy that passes plain HTTP but not WebSockets does this.

**Fix.** Read `claude-hub logs runner` and run `claude-hub doctor`. Once it's fixed, `claude-hub runner start` (or `claude-hub onboard`, which keeps the token) finishes the job: the code is already used, and the token doesn't expire.

## The Hub doesn't accept the Runner's token

**What you see.** The Runner logs, at every reconnect:

```
The Hub doesn't accept this Runner's token: the Runner was removed on the Hub's Runners page, or paired again with a new token. …
```

and `claude-hub status` says the Hub doesn't accept the token.

**Why.** Someone removed the Runner on the Runners page, or Re-paired it, and another `runner join` used that code, here or on another machine. Either way, the Hub closed this Runner's connection and the token stopped working. Its Sessions keep running in tmux.

**Fix.** If the machine should still be a Runner, make a code on the Runners page and run `claude-hub runner join` with it: **Re-pair** the Runner if it's still listed, to keep its Sessions; **Add a Runner** if it was removed. If it shouldn't, stop it with `claude-hub runner stop`, or `claude-hub uninstall`.

## A Runner can't be removed

**What you see.** **Remove** on the Runners page says `Runner build-box has 2 Sessions that aren't Archived. Archive them first, then remove the Runner.`

**Why.** A removed Runner can never connect again, so its Active, Asleep and Frozen Sessions would be stuck.

**Fix.** Archive each of its Sessions (the count on the Runners page says how many), then remove it. A Frozen Session can be archived while its Runner is offline.

## A Runner is behind the Hub

**What you see.** The Runners page marks a Runner **behind the Hub**, or **not the Hub's commit**. Starting a Session on it, or waking one of its Sessions, fails with:

```
build-box: this Runner needs an update. Update it on the Runners page.
```

**Why.** It runs an older commit of claude-hub than the Hub, or one the Hub's history doesn't have, such as another branch's. A new or woken Session may need what the Hub's commit added, so the Hub starts and wakes none there; Sessions already running there go on, and prompts to its Asleep Sessions wait in their queue. Runners report their commit when they connect; a Runner from before that is listed with **Version unknown**.

**Fix.** Press **Update** on its row ([Keep Runners on the Hub's commit](/how-to/add-a-runner/#keep-runners-on-the-hubs-commit)). A row without **Update** says why the Runner doesn't update itself:

- It runs from a checkout (`bun run runner`): pull the checkout to the Hub's commit and restart it.
- It's from before Runners followed the Hub, or isn't run as the claude-hub service: run `claude-hub update` on its machine.

While it updates, Sessions fail with `build-box: this Runner is updating. Sessions start and wake there again once it is back.`

## A Runner refuses to update

**What you see.** The Runner's row says **refuses: not on main**:

```
1a2b3c4d5e6f isn't on origin/main. To follow any commit, set RUNNER_UPDATE_ANY_COMMIT=1 in the Runner's runner.env.
```

or **refuses: commit not on origin** (`origin has no commit 1a2b3c4d5e6f: push it before the Hub's Runners can follow it.`), or **couldn't check the commit** (`It couldn't fetch from origin: …`).

**Why.** A Runner moves only to a commit it can fetch, and by default only to one on `origin/main`, so a Hub running a branch or an unpushed commit can't move its Runners there unasked.

**Fix.** For **not on main**: run the Hub on `main`, or, to let this Runner follow any commit, add `RUNNER_UPDATE_ANY_COMMIT=1` to its `runner.env`, restart it with `claude-hub runner stop` and `claude-hub runner start`, and press **Update** again. For **not on origin**: push the commit the Hub runs. For **couldn't check**: the Runner's machine can't fetch from origin; run `git fetch` in its install, `~/.claude-hub/app`, to see why (the same credentials `claude-hub update` uses).

## A Runner's update failed

**What you see.** The Runner's row says **update failed**:

```
Moving to 1a2b3c4d5e6f failed, so it went back to the commit it ran: bun install failed: …
```

**Why.** A step of the update failed: checking out the commit, `bun install`, building the mod, the check that the Runner loads, or the Runner, restarted on the new commit, didn't get the Hub's welcome in three starts. The Runner went back to the commit it ran, rebuilt it and reconnected, and its Sessions wake there. If going back failed too, the row says `and so did going back; see its log`.

**Fix.** Read `claude-hub logs runner` on its machine for the full output, fix the cause (often the network, or disk space), and press **Update** again. The Runner doesn't try the same commit again by itself. If going back failed, run `claude-hub update` on its machine, which puts the install back in order.

## The Hub turns the Runner away

**What you see.** The Runner logs, and tries again every minute:

```
The Hub turned this Runner away: Protocol version mismatch: the peer speaks version 1, this side speaks version 2. Update the peer.
Updating this Runner to the Hub's commit (the Hub runs 1a2b3c4d5e6f on main).
```

or, for a Runner that doesn't update itself:

```
To connect again, this Runner needs the Hub's version (the Hub runs 1a2b3c4d5e6f on main): run `claude-hub update` on this machine. Retrying meanwhile.
```

**Why.** The Hub and the Runner speak different protocol versions. The Hub's answer always says which commit it runs, whatever the version, so a Runner that updates itself moves to it, as it would for **Update**, and restarts. Its Sessions keep running in tmux meanwhile; the Hub can't put them to sleep while it turns the Runner away.

**Fix.** Usually nothing: the Runner connects again on the Hub's commit. If it can't follow (the log says it failed to update to that commit, or how to update it), run `claude-hub update` on its machine, or for a checkout, pull it to the Hub's commit and restart `bun run runner`.

## Its Sessions are Frozen

**What you see.** A Session shows the banner **This Session is Frozen**: `Its Runner is offline. Prompts sent now wait in the queue until the Runner is back.`

**Why.** Its Runner isn't connected to the Hub: it was stopped, its machine is asleep or offline, or it can't reconnect (see above). A Session runs on its Runner's Claude Code login, so it waits for that Runner rather than moving to another.

**Fix.** Start the Runner again, or fix its connection. Once it is back, each Session is Active again if its Claude Code still runs in tmux, and otherwise Asleep, woken at once if prompts are waiting. If Sessions that were running come back Asleep instead, the Runner started with a different tmux socket or sessions root than before, so it didn't find them: start it with the same `RUNNER_TMUX_SOCKET`, `RUNNER_SESSIONS_ROOT` and `CLAUDE_HUB_HOME`. See [the Session lifecycle](/explanation/session-lifecycle/#frozen).

## Sessions exit at once with "The current working directory was deleted"

**What you see.** Every new or woken Session goes Asleep at once with `Claude Code exited with code 1`, and its last output (see [Claude Code exited with code N](/troubleshooting/sessions/#claude-code-exited-with-code-n)) is:

```
error: The current working directory was deleted, so that command didn't work. Please cd into a different directory and try again.
```

`claude-hub doctor` warns:

```
!!  tmux server  The tmux server on socket claude-hub runs in /Users/you/claude-hub/packages/runner, which was deleted; has PWD /Users/you/claude-hub/packages/runner, which was deleted; …
```

**Why.** A Runner starts each Session in a tmux server on its socket (`RUNNER_TMUX_SOCKET`, `claude-hub` for an install). The server outlives the Runner that started it, so the next Runner on that socket reuses it, and every process the server starts gets its global environment: the directory, `PWD` and `PATH` of whatever started it. When that was a Runner run from a checkout since deleted, `PWD` names a directory that no longer exists. Claude Code trusts `PWD`, finds it gone, and exits. Before [#94](https://github.com/kddige/claude-hub/pull/94), dev Runners used socket `claude-hub` too, so a dev Runner could leave such a server for the installed one.

Runners now launch Claude Code with its own `PWD` and the Runner's `PATH`, whatever the server has. At startup a Runner also claims the server: one with no sessions is stopped, and the next Session starts a fresh one; one with sessions is kept, and given the Runner's `PATH` with `PWD` and `OLDPWD` unset. The Runner logs what it changed:

```
INFO (#2): Stopped the tmux server on socket claude-hub, which had no sessions, so the next Session starts a fresh one with the Runner's environment (PATH was …; PWD was /Users/you/claude-hub/packages/runner)
WARN (#2): Kept the tmux server on socket claude-hub, which has 2 session(s), and set its environment to the Runner's (PWD was …)
```

**Fix.** [Update](/how-to/add-a-runner/) the Runner and restart it: `claude-hub runner stop`, then `claude-hub runner start`. Then wake the Session. On an older Runner, stop the server yourself, once no Session runs in it:

```sh
tmux -L claude-hub list-sessions   # "no server running" or nothing listed: safe to stop
tmux -L claude-hub kill-server
```

`claude-hub doctor` checks the server too: it warns when the server runs in a deleted directory, has a `PWD` other than the home, or a `PATH` other than the one in the Runner's service file. A server started elsewhere whose `PWD` is unset and `PATH` is right, as one the Runner kept and refreshed, passes. Stopping a server ends every Session in it, so neither the Runner nor doctor stops one that has any.

## Sessions from before an update are gone

**What you see.** After updating your checkout, Sessions that were running before don't come back: the Runner re-adopts none of them, and waking one fails because its Workspace can't be found.

**Why.** Runners run from a checkout used to keep their state in `~/.claude-hub/sessions`, `~/.claude-hub/claude-code` and tmux socket `claude-hub`. They now use the dev home, `~/.claude-hub-dev`, and tmux socket `claude-hub-dev`, so that a dev Runner and an installed one can share a machine (see [the dev home](/reference/configuration/#homes)). Nothing is migrated. The new defaults point at a new socket and sessions root, so the Runner finds none of the old Sessions, and it has a new Runner mark, so it leaves their Sandboxes alone.

**Fix.** Either delete the old Sessions, or keep running a Runner with the old values:

```sh
RUNNER_SESSIONS_ROOT=$HOME/.claude-hub/sessions \
RUNNER_TMUX_SOCKET=claude-hub \
RUNNER_SANDBOX_CLAUDE_CACHE=$HOME/.claude-hub/claude-code \
RUNNER_TOKEN=chr_… bun run runner
```

To clean up once you no longer need them: run `tmux -L claude-hub kill-server`, remove their Sandboxes (named `claude-hub-<session id>`) with microsandbox's `msb`, and delete `~/.claude-hub/sessions` and `~/.claude-hub/claude-code`. Keep `~/.claude-hub/github-app.pem` if `GITHUB_APP_PRIVATE_KEY_PATH` points there.

## It warns about Sandboxes it doesn't know

**What you see.** At startup the Runner logs one of:

```
WARN (#2): Unknown Sandbox for Session 0cb88decd7211ad04f6a64a8: Stopped (stopped now); volumes: …
WARN (#2): Sandbox for Session 9af3111eb506f54cea59b83c carries no Runner mark, so it belongs to no Runner; left Running; volumes: …
```

**Why.** At startup a Runner reconciles the microsandbox Sandboxes on its machine. One marked as its own, whose Session it no longer runs, is left over, for example from a crash: the Runner stops it but keeps its disks. One with no mark at all was made by an older Runner, from before Sandboxes were marked, and the Runner leaves it alone.

**Fix.** Nothing is lost: stopping never deletes a Sandbox's disks. To clean up one you no longer need, run `bun x msb list` from `packages/runner` and remove it with microsandbox's CLI.
