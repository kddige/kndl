---
status: accepted
---

# The Workspace lives on the host; Sandboxes are disposable

Each Session's Workspace (a clone of the Repo on its Work branch) and its Docker data live on host volumes mounted into the Sandbox. The Sandbox itself can be stopped or destroyed at any time without losing work. Asleep means the Sandbox is stopped after 15 minutes idle, and waking boots a fresh one on the same volumes. The WIP ref (ADR 0005) covers losing the host itself.

Memory snapshots were considered for faster wake and full process state. They are deferred, because snapshot files are large and the backend's snapshot support is young. Services started inside a Sandbox restart from their persisted data instead.

## Amendment: dependencies on per-Session disk volumes (#3, #9)

Spike #3 measured the host-directory mount as too slow for dependency installs: `bun install` on a 37k-file `node_modules` took 26 s cold and 19 s warm, against 6.8 s and 1.5 s on the host. So the Workspace is split:

- **Source** stays in the Workspace on the host directory mounted at `/workspace`, so the Runner's git on the host sees every change (ADR 0005).
- **Dependencies** (`node_modules`) and package caches go on per-Session disk volumes inside the Sandbox. With this layout `bun install` took 7.9 s cold and 0.67 s warm. These volumes survive stop and destroy-keeping-volumes, so a woken Session keeps its installed dependencies. They are not covered by the WIP ref; losing them means reinstalling, not losing work.
- **Docker data** stays on its own disk volume, as before.

Settings and limits found along the way:

- Before a Sandbox stops, the Runner runs `docker stop` on its containers. Stopping the VM alone kills them uncleanly, and databases have to crash-recover on the next boot.
- microsandbox 0.7.6 can't boot a disk volume whose guest path contains a `.`, so the package cache lives at `/var/cache/claude-hub` rather than `~/.cache`, with `XDG_CACHE_HOME`, `BUN_INSTALL_CACHE_DIR` and `npm_config_cache` pointed there. The backend refuses dotted volume paths before creating anything.
- The host mount uses `hostPermissions("mirror")` so executable bits survive, and an explicit quota, since the default silently caps guest writes at 4 GiB.

## Amendment: waking restarts the stopped Sandbox (#12)

Going to sleep stops the Sandbox's VM rather than destroying it, and waking starts that same VM again. Its root filesystem survives too, so what the Runner installed into it on the first start (`bash`, for Claude Code's Bash tool) need not be installed again, and a wake took about a second in the opt-in microsandbox test. A Sandbox that is gone anyway, such as one destroyed by hand, is created afresh on the Session's volumes, as above. Nothing a Session needs lives only in the root filesystem, so both paths keep its work.
