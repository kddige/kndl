---
status: accepted
---

# Runners follow the Hub's commit, from main only

A Hub and its Runners run the same commit of claude-hub. When the Hub is updated (`claude-hub update`), it tells each Runner the commit it now runs, and each Runner updates itself to that commit and restarts. A Runner on the Hub's own machine always follows. `claude-hub update --no-update-runners` leaves the others alone, and the web UI's Runners page can update any one of them later.

A Runner checks out the Hub's commit only if it is reachable from `origin/main` on GitHub. A Runner whose `runner.env` sets `RUNNER_UPDATE_ANY_COMMIT=1` follows any commit, for a dev instance on a feature branch. So the Hub chooses *when* a Runner updates, never *what code* it runs: a compromised or misconfigured Hub can only move Runners to code already on main.

**Being behind is not allowed to linger.** A connected Runner on an older commit keeps its existing Sessions working but can't start or wake one: new tools and APIs may need the new Runner and mod. A Runner whose protocol version the Hub no longer speaks is rejected, and the rejection carries the Hub's commit in a shape every version can read, so it can still update. It never exits on a rejection, which a service manager would restart in a loop: it retries slowly and logs what to do.

**Sessions during an update.** The mod loaded in a running Claude Code is the old one. So a Runner stops taking new Sessions, lets running Turns finish (up to about ten minutes, or cancels them at once with `--now`), puts every Active Session to sleep, updates and restarts. The next prompt wakes each Session with the new mod and `--resume`, keeping its conversation, Workspace and Sandbox volumes. A failed update rolls back to the previous commit and is reported to the Hub.

## Considered options

- **Each machine updates by hand.** No Hub reaching into Runners, but Runners drift behind the Hub, and a Runner missing a new tool fails in confusing ways.
- **The Hub names any commit.** Lets a Hub on a branch bring its Runners along, but then whoever controls the Hub picks the code every Runner runs. Kept as a per-Runner opt-in instead.
- **Runners pull latest main themselves.** May run code newer than the Hub's.
- **Update under running Sessions, as a Runner restart does.** Faster, but old mods keep talking to the new Hub until each Session sleeps.
