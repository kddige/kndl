---
title: Runners
description: A Runner won't start, can't reach the Hub, or doesn't show up in the web UI.
sidebar:
  order: 3
---

A Runner checks its settings and Claude Code's login before it connects. Then it connects out to the Hub and keeps reconnecting while it can't, so a Runner that is running but never shows up in **New Session** is almost always a connection problem: look at its log.

## No Runner token

**What you see.** The Runner exits at once with:

```
ERROR (#2): ConfigError: SchemaError(Expected string
  at ["RUNNER_TOKEN"])
```

**Why.** `RUNNER_TOKEN` isn't set. Every Runner needs one, and the Runner doesn't read `packages/hub/.env.local`, which is the Hub's.

**Fix.** Issue a token on the Hub's machine with `bun run runner-token <name>`, and start the Runner with it. See [Add a Runner](/how-to/add-a-runner/).

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
- For a refused token, run `bun run runner-token <name>` on the Hub's machine again and restart the Runner with the new token.

The Runner keeps trying, so it connects on its own once the Hub is back.

## A Runner on another machine never shows up

**What you see.** The Runner on a second machine logs `could not connect to …` forever, although the Hub runs.

**Why.** The Hub listens on `127.0.0.1` by default, so only its own machine can reach it. `HUB_URL` also defaults to `http://127.0.0.1:7777`, which on the second machine names that machine itself.

**Fix.** Make the Hub reachable from the Runner's machine, and point `HUB_URL` at it. [Reach the Hub from other machines](/how-to/reach-the-hub-from-other-machines/) covers HTTPS, Tailscale and SSH tunnels. A Runner only needs to reach the Hub; nothing connects in to the Runner.

## Its Sessions are Frozen

**What you see.** A Session shows the banner **This Session is Frozen**: `Its Runner is offline. Prompts sent now wait in the queue until the Runner is back.`

**Why.** Its Runner isn't connected to the Hub: it was stopped, its machine is asleep or offline, or it can't reconnect (see above). A Session runs on its Runner's Claude Code login, so it waits for that Runner rather than moving to another.

**Fix.** Start the Runner again, or fix its connection. Once it is back, each Session is Active again if its Claude Code still runs in tmux, and otherwise Asleep, woken at once if prompts are waiting. If Sessions that were running come back Asleep instead, the Runner started with a different tmux socket or sessions root than before, so it didn't find them: start it with the same `RUNNER_TMUX_SOCKET`, `RUNNER_SESSIONS_ROOT` and `CLAUDE_HUB_HOME`. See [the Session lifecycle](/explanation/session-lifecycle/#frozen).

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
