# claude-hub

Multiplayer Claude Code: run sessions on any number of machines, watch and drive them from a web UI, together.

```
 machine A: runner ── tmux ── claude + hub-link mod ─┐
 machine B: runner ── tmux ── claude + hub-link mod ─┼──▶ hub ◀──▶ browsers (emil, alex, …)
 any terminal: claude --plugin-dir <repo>/mod ───────┘
```

| Piece | What it does |
|---|---|
| `mod/` | Claude Code mod (`hub-link`). Streams prompts, text, tool calls and turn ends to the hub; long-polls the hub for prompts and stops; tells Claude the session is shared; shows `● hub · 👥 viewers` above the prompt. |
| `hub/` | Bun server + SQLite. Keeps every session's event log (late joiners get a replay), a prompt queue per session, presence, and serves the UI at `/`. |
| `runner/` | One per machine. Starts sessions in tmux when the UI asks, mirrors the terminal screen to the UI and types keys into it (trust dialogs, permission prompts), reports exits. |

## Run it

```sh
brew install tmux          # the runner needs it
./start.sh                 # hub on http://127.0.0.1:7777 + a runner for this machine
open http://127.0.0.1:7777
```

Join a session you start by hand (no runner needed):

```sh
claude --plugin-dir ~/Development/github/kddige/claude-hub/mod
```

### More machines

```sh
# on the hub machine
HOST=0.0.0.0 HUB_TOKEN=some-long-secret bun hub/server.ts
# on every other machine
HUB_URL=http://<hub-ip>:7777 HUB_TOKEN=some-long-secret bun runner/runner.ts
# browsers
http://<hub-ip>:7777/?token=some-long-secret
```

## Config

| Env | Used by | Default |
|---|---|---|
| `PORT`, `HOST` | hub | `7777`, `127.0.0.1` |
| `HUB_TOKEN` | all | none (required by everyone when set) |
| `HUB_URL` | runner, mod | `http://127.0.0.1:7777` |
| `HUB_ROOTS` | runner | `$HOME` (comma-separated folders sessions may start in) |
| `HUB_MACHINE` | runner, mod | short hostname |

## Security, honestly

Anyone who can send a prompt can run code on that machine. The token is a single shared secret, there are no
roles yet, and traffic is plain HTTP. Keep it on localhost or a private network (Tailscale works well) until
auth and roles land.

## Next

- Permission prompts as first-class UI (approve/deny buttons) instead of terminal keys
- Accounts, invites, roles per session (viewer / prompter / approver)
- Visible, reorderable prompt queue; typing indicators
- Resume past sessions from the UI; Markdown rendering in the feed
