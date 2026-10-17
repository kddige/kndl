---
status: accepted
---

# The Owner updates the Hub from the web

Until now, updating a Hub meant SSHing into its machine and running `kndl update` (ADR 0011, ADR 0025). Nothing told anyone a newer kndl was out: they had to look at GitHub. So the Hub checks GitHub for a newer kndl itself, and its Owner sees what it found on a new Hub page in the web UI. From there they update the Hub, and pick its Channel, without a terminal (#359). Runners and the CLI binaries the Hub serves follow the Hub's commit, as they do today (ADR 0011).

## How it works

- **Only the Owner.** The update check goes only to the Owner's web connections, and the Hub refuses Check now, Update and the Channel picker from anyone else. A Runner's **Update** on the Runners page becomes the Owner's alone too. Moving the code every Session runs on is a Hub-wide act with no undo, and the Owner already decides who gets in (ADR 0019).
- **Only an installed Hub.** The feature is on only when the kndl service runs the Hub from the install's own checkout, `<home>/app` (`KNDL_SERVICE=hub`), which `kndl update` moves. That is the same test a Runner passes before it updates itself (ADR 0011, amended in #87). On any other Hub, such as a checkout run with `bun run hub`, there is nothing the web could move: the Hub doesn't poll, its Owner gets no Hub page and no banner, and the web never shows the page in its nav.
- **The check.** The Hub checks kndl's repository on GitHub, kddige/kndl, as it starts and then every 6 hours. It is always on. It reads public data, unauthenticated: one or two calls a check is well under GitHub's 60 an hour. The result is kept in the database for the commit and Channel it was made for, so a Hub that restarts shows the last one at once. **Check now** on the Hub page checks at once. What counts as newer follows the Channel (ADR 0025):
  - **stable:** a Release newer than the Hub's, compared by number. The page shows the notes of every Release in between, newest first, each with its Highlights first. A Hub on a commit that is no Release's, as after moving from dev, is offered only a Release that holds its commit, since the stable Channel never moves an install back.
  - **dev:** `main`'s head past the Hub's commit. The page shows how many commits it is behind, with the titles of the newest 50.
  - **pinned** (`--ref` pinned a branch other than main, a tag or a commit): nothing is offered, and the page says what it is pinned to. An install with no Channel recorded on `main` follows main, so it counts as dev.
  - **a failed check** keeps what the last one that worked found, beside the error and when it failed. With nothing found yet, the page links to GitHub's Releases.
- **The banner.** While an update exists, a small banner across the app tells the Owner, and links to the Hub page. Dismissing it lasts until the check finds another update: a newer Release on stable, or `main` moving again on dev. The dismissal is kept in the browser, as the sidebar's folds are.
- **Update and Update now.** **Update** waits up to about ten minutes for running Turns, as the CLI does, and while it waits the button becomes **Update now**, which cancels them. That is the Runner dialog's behaviour (ADR 0011).
- **The Channel picker.** On stable or dev, picking the other runs the update with `--channel`. Moving from stable to dev updates at once. Moving from dev to stable records the Channel and stays on the current commit until a Release newer than it exists, as the CLI does. On a pinned Hub, picking a Channel unpins it, after a confirmation.
- **The update runs `kndl update`, outside the Hub's service.** The Hub launches the real `kndl update --source hub` with the flags, under `systemd-run --user` on Linux or a launchd one-shot job on macOS, so the update survives the Hub restarting under it. There is one update path for the CLI and the web, and everything the CLI does on an update, the web gets.
- **One lock, a status file and a log, in `<home>/update/`.** Their shapes and paths are `protocol`'s `UpdateStatus`, which the CLI writes and the Hub reads:
  - `lock` is `{ pid, startedAt, source }`, `source` being `cli` or `hub`. `kndl update` takes it before anything else and holds it until it ends, from the CLI and the web alike. A second update finds it and is refused with "An update is already running (pid N, started …)", and the web shows the first one's progress instead. A lock whose process is gone is stale, and the next update takes it over.
  - `status.json` is the latest update: where it started from, its target, the step running now, its state (`Running`, `Succeeded`, `Failed` or `RolledBack`) and its error. It is rewritten, whole, as each step starts.
  - `update.log` holds the output of the latest update's steps, emptied as one starts.

  While an update runs, the Hub sends the Owner its step from `status.json`, then the web shows "Updating… Hub restarting" and reconnects on its own. The new Hub reads `status.json`, and the Hub page shows "Updated to X", or the failure with its error and the end of the log. An update started from the CLI shows there too.
- **Rollback is `kndl update`'s.** Before it moves the checkout, `kndl update` records the commit and branch it is on. If a step after that fails, or the new Hub isn't healthy within 30 seconds, it switches back to them, builds again and restarts the services: the update ends `RolledBack`, with the error. If rolling back fails too, it ends `Failed`, with both errors. Updates from the CLI get it too. No Runner is sent to the commit the Hub left: the push for Runners to follow is cleared.

## Considered options

- **The Hub updates itself in its own process.** No second process to launch, but the process doing the update is the one being replaced: a restart cuts it off halfway, with nobody left to roll back.
- **A Hub-side update path, apart from `kndl update`.** It could report progress natively, but it would duplicate the CLI's fetch, build and restart steps, and drift from them. Running the real `kndl update`, with a status file for progress, keeps one path.
- **Any Member can update.** Hub-wide actions have been open to every Member (ADR 0019), but an update changes what everyone's Sessions run on, and can't be taken back from the web. It is the Owner's, as admitting people is.
- **Checking only on demand, or an opt-in check.** Fewer calls to GitHub, but a Hub nobody looks at would stay behind without anyone knowing. Unauthenticated calls of public data every 6 hours cost nothing.
- **Dismissing the banner on the Hub, per Owner.** It would follow the Owner across browsers, but needs a table and a command for a preference, where the web already keeps the sidebar's folds in the browser.

## Consequences

- **The Owner has rights the other Members lack:** besides who gets in, updating the Hub and its Runners, and its Channel. ADR 0019 and ADR 0027 said the Owner had no rights beyond admitting people; that no longer holds.
- **A Hub reaches GitHub on its own,** every 6 hours, to read kddige/kndl. A Hub without internet access records the failure and goes on.
- **Only installed Hubs get any of it.** Developers running a checkout still pull and restart by hand, as their Runners do.
- **A rollback can't undo a migration.** The new Hub migrates its database as it starts. If it ran a migration before it failed its health check, the old code it rolls back to may not start on the migrated database, and the Hub stays down. The update then ends `Failed`, with both errors, and the Owner fixes it by hand on the Hub's machine, from the log.

## Amendment: updating from the page, as built (#362)

Building Update and the Channel picker settled what the above left open, and changed what Update now stops and which Channel picks are confirmed.

- **What Update now stops.** `kndl update` doesn't wait for Turns on the Hub's machine: it restarts the Hub at once, and the Runners are the ones that wait, each up to about ten minutes, before they follow (ADR 0011). So **Update now** in the update's confirmation runs it with `--now`, and once the Hub is back, while its Runners still wait, the page's **Update now** stops their Turns: it asks each the way the Runners page's does (`UpdateRunner` with `now`). The Hub runs no second update for it.
- **Every Channel pick is confirmed,** not only a pinned Hub's: any pick may update and restart the Hub, and the confirmation says which.
- **How it launches.** The update runs the Bun that runs the Hub, on `<home>/app`'s CLI, in the home, with `KNDL_HOME` and the Hub's PATH, as the services run (the CLI's `Services.ts`). On Linux it is `systemd-run --user --unit kndl-update-<id> --collect --service-type=exec`, so a Bun that can't start fails the launch at once. On macOS it is a launchd job with `RunAtLoad` and no `KeepAlive`, its plist in `<home>/update/launchd.plist`: the last update's job is unloaded before the next is loaded, under one label. Its output goes to `<home>/logs/update.log`. The Hub refuses a second Update while the one it launched hasn't written its status, for up to a minute.
- **How the Hub follows it.** The Hub reads `status.json` every second while an update runs or starts, and every 5 seconds otherwise, so an update started at a terminal shows too. An update it finds `Running` with no process holding the lock, as when it was killed, is shown `Failed`. The end of `update.log`, its last 80 lines, goes with an update that ended.
- **A Channel recorded without a restart.** Moving from dev to stable with no Release past the Hub's commit records the Channel and leaves the Hub running where it is. So when an update ends, the Hub reads its Channel again, from the checkout, and checks again on the new one.

One consequence the above didn't name: a Hub with dev login (`KNDL_DEV_LOGIN`) has no Owner, so nobody there updates a Runner from the web. A developer's Runner is updated by pulling and restarting it anyway (ADR 0011, amended in #87).
