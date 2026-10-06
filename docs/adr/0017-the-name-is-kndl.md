---
status: accepted
---

# The name is kndl

claude-hub is renamed **kndl**, said "kindle" and written lowercase everywhere: the wordmark, the web UI's title, the docs and the command. It is short for kindling, the small things that get a fire going. The tagline is "multiplayer agentic sessions". It doesn't name Claude Code, and the docs still say what kndl runs where they need to.

We can't use "Claude" in the product's name. So everything is renamed in one go (#196): the command `kndl`, the home `~/.kndl`, the `KNDL_*` variables (the Runner's, the mod's and Claude Code's), the `@kndl/*` packages, the tmux, Sandbox and volume names `kndl-*`, the WIP ref `refs/kndl/wip/<session>`, the services `io.github.kddige.kndl.<role>` and `kndl-<role>.service`, and onboard's default GitHub App name, `kndl-<machine>`. The domain words stay as they are: Hub, Runner, Session, Environment and Sandbox, and the mod's `hub-link` and `hub-link-commands` plugins. ADRs written before this one keep the old name.

## Moving an install

An install made under the old name moves with its next update, once. After that, nothing reads the old names.

- **Who moves it.** The first update runs the old name's own `update`, which restarts the old services on the new code. A Hub or Runner started by a service of the old name doesn't start: it waits for that update to end, answering the Hub's `/health` meanwhile, and moves the install (`packages/cli/src/Rename.ts`). The new `update` moves an install first too, for one without services. A lock keeps the Hub's and the Runner's moves on one machine apart. A move cut short is finished by the next one.
- **What moves.** The old services are stopped and unregistered. `~/.claude-hub` moves to `~/.kndl`, unless both are in use, when the move leaves both alone and says so. A home the old variable put somewhere of its own stays where it is. The `CLAUDE_HUB_*` keys in `hub.env` and `runner.env` become `KNDL_*`, and paths in the old home point to the new one; every other line stays as it was. The services are registered and started under the new names, and the old command becomes `kndl`. The service the move runs under is stopped last, since that stops the move.
- **Sessions.** Running Sessions are put to sleep, and wake under the new names. A Runner following its Hub to the new commit drains first, through the normal sleep path. On a machine where it didn't, the move stops the Runner's Sandboxes under the old names before the home moves, as a Runner restart stops the Sandboxes it doesn't take back. Either way the Workspaces move with the home (ADR 0006), and nothing adopts a process or Sandbox of the old name. The old host tmux server is stopped.
- **The CLI a Hub serves.** A binary named `claude-hub` renames itself to `kndl`, and moves its config to kndl's directory, when it next updates itself. The Hub also sends its commit under the old header, for binaries that predate the rename.

## Considered options

- **Reading both names for a while.** Old installs would keep working without a move, but every path, variable and label would have two names for as long as anyone might be on the old one, and nothing would ever say when to stop.
- **A separate command for the move.** Clearer to describe, but people update, and an install that missed the command would break on the next update. The move runs from `update` instead, and from the services the old `update` restarts.
- **Carrying the Sandboxes and volumes over.** A woken Session would keep Claude Code's state, but microsandbox has no way to rename a Sandbox or a volume, and adopting them under the old names is what the rename rules out.

## Consequences

- **Claude Code starts afresh** in a woken Session, with the conversation from the Hub's history, as for a Session that moves to another Runner. The old Sandboxes, their volumes and the Environments' snapshots stay in microsandbox, stopped, until someone removes them. The move lists them, and Environments' snapshots rebuild under the new names.
- **Everyone signs in again once:** the web UI's sign-in cookie is named after kndl now. CLI tokens are kept.
- **`KNDL_*` is reserved** in Environments' Variables, as `CLAUDE_HUB_*` was.
- **What stays behind:** WIP refs pushed under `refs/claude-hub/wip/` stay on the remotes, the `PATH` line install.sh added to the shell's startup file keeps its old mark (it still works), and existing GitHub Apps keep their names. A checkout's dev home isn't moved: a checkout makes a new one.
