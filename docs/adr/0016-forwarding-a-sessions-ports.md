---
status: accepted
---

# Forwarding a Session's ports through the Hub, with a CLI the Hub serves

`claude-hub forward <session>` makes a Session's ports reachable on the machine it runs on, as if the Session's dev servers ran there: every port that is listening in the Sandbox opens 1:1 on `localhost`, and closes when it closes there. Because it is `localhost`, OAuth callbacks, cookies, `curl` and third-party apps work as they would locally. Traffic goes through the Hub, so it works from anywhere the Hub is reachable, whatever network the Runner is on.

The command comes with a CLI anyone can install from the Hub and sign in to, not only Hub and Runner operators. Spikes #169 (reaching a port in a Sandbox) and #170 (noticing which ports are open) measured the parts on microsandbox 0.7.6.

## How it works

- **Noticing ports.** While a Session is awake, the Runner reads the guest's `/proc/net/tcp` and `/proc/net/tcp6` every 2 s through the SDK's file read (about 5 ms each, against about 46 ms for an exec), and looks up the owning process only when the set changes. It reports `{port, addresses, process}` to the Hub on a change and clears the list on sleep. Every listening port counts, Docker's (shown as `docker-proxy`) included, except Claude Code's own OAuth callback port. Sandboxes are created with log level `warn`, since the reads would otherwise grow `runtime.log` by about 37 MB a day.
- **Reaching a port.** The Runner opens each connection into the guest with agentd's `core.tcp.connect` through the SDK's `AgentClient`. It needs nothing in the guest, works on a Sandbox that is already running, and reaches servers bound to `127.0.0.1`: about 0.5 ms to the first byte and 550 MiB/s. In this mode there is no flow control per connection, and agentd drops the whole client if a reader stalls for 5 s. So the Runner gives forwarding its own `AgentClient`, never stops reading from it, buffers per connection, and closes only a connection that goes past its cap. It passes only loopback addresses, and the address family the port listens on, since `localhost` binds only `::1` under Node 22 and Bun. `core.tcp.*` is agentd's internal protocol, so the microsandbox version stays pinned. The fallback is a 67 KB static `tcpcat` we ship, mounted read-only and run once per connection through exec: about 150 MiB/s, and capped well below the about 75 connections it held.
- **Through the Hub.** Each forwarded connection is its own pair of WebSockets. The CLI opens one to the Hub. The Hub sends the Session's Runner an `OpenTunnel` on its existing link, and the Runner dials a second one out to the Hub and opens the stream into the guest. The Hub pairs the two. Each connection gets its own backpressure, Runners still need no inbound port, and forwarded bytes never share the Runner's main WebSocket, so a large download can't hold up a Turn or terminal frames. Tunnel sockets need a longer idle timeout than Bun's default 10 s.
- **Who.** Anyone with access to the Session's Repo, checked when `forward` connects and again on every connection, like joining the Session (ADR 0003).
- **Picking a Session.** `forward` takes a Session's id, a unique prefix of it (the 6-character short id, like a git short sha), or its URL. With none, it offers a picker of Active Sessions with their short id, name, Repo and ports; without a terminal it prints that list.
- **On the local side.** It listens on `127.0.0.1` and `::1`, or on the LAN with `--bind`. Naming ports (`forward <session> 3000 5173`) narrows it to those, and `3000:3100` picks the local port. A local port already taken is skipped, with the process holding it and the `3000:3100` syntax, and retried once it is free. A low port the OS refuses is skipped and said so.
- **What it shows.** It runs in the foreground with a live list: each port's local URL, its process, a Docker label, and the Session's state. There is no background mode; that is for the desktop app (#171).

## Sleep: a toggle instead of guessing

A connected `forward` is presence: it keeps the Session awake like a Participant in it, and shows in its presence as "Alice · forwarding from macbook". `forward` on an Asleep Session wakes it. If the Session goes to sleep anyway, because someone put it to sleep or its Runner drained, `forward` says "the session went asleep" and disconnects.

Beyond that, a Session doesn't stay awake for what runs in it: not for background Bash commands or Monitors, not for open ports. Anything can open a port, Claude Code doesn't see processes a command leaves behind (`nohup …&`, `docker compose up -d`), and a forgotten task would keep a Session awake forever. Instead a Session has a **Keep awake** toggle in its header:

- Anyone with Repo access can turn it on or off. It shows who turned it on ("Kept awake by Alice"), and the sidebar and the Runners page mark Sessions that have it.
- It has no expiry. Putting the Session to sleep turns it off. A Runner drain or restart leaves it on, and the Session is woken again when its Runner is back.
- It is in the web UI only.

So a Session goes to sleep after `DefaultSleepAfter` (15 minutes) of being idle as before, where idle now also requires no connected `forward` and Keep awake off. A Running agent still keeps it awake (ADR 0014): that is Claude's own work, which the Hub tracks.

## The CLI

- **One CLI.** The operator CLI and the one for using Sessions are the same `claude-hub`. Operator commands say an install is needed on a machine without one.
- **Served by the Hub.** `curl https://<hub>/cli | sh` installs a binary built with `bun build --compile` from the Hub's own commit, for macOS and Linux on arm64 and x64. The CLI updates itself from the Hub, so it follows the Hub's commit like Runners do (ADR 0011). Windows is not supported.
- **Signing in.** `claude-hub login <hub>` opens the browser, and the Hub redirects back to the CLI on `localhost`, as Claude Code's login does. If that redirect can't reach the CLI, as over SSH, the page shows a code to paste into the terminal instead, and `--no-browser` goes straight to it. The CLI token is a new kind of credential: long-lived, listed and revocable on the Account page, and kept in a file only its owner can read (mode 0600). The CLI is signed in to one Hub at a time; logging in to another replaces it.

## Considered options

- **Keeping a Session awake for its background tasks.** Claude Code 2.1.289 sends the list of its running background tasks with every Stop hook, so the Hub could track them. It misses processes a command leaves behind, a persistent Monitor never ends by itself, and a forgotten task keeps a Session awake indefinitely. Rejected for the toggle.
- **Keeping a Session awake while ports are open.** A Session with a dev server or a database would never sleep. Rejected for the same reason.
- **A device-code flow** (#89's first idea), approved in the web UI. It works over SSH, but it is a detour on a laptop with a browser. Kept as the automatic fallback instead.
- **microsandbox's port publishing (`-p`).** Ports are fixed when the Sandbox is created, it doesn't reach servers bound to `127.0.0.1` (Vite's default), and it stopped at 256 connections. vsock only goes guest to host and ran at about 21 MiB/s. Both rejected in #169.
- **Multiplexing forwarded connections on the Runner's existing link.** One slow reader would back up every Session on that Runner, and base64 in JSON adds a third.
- **A separate CLI for users.** Two binaries, two installs, two update paths, for commands that share the Hub client.
- **A peer-to-peer tunnel between the CLI and the Runner.** Faster, but Runners are often behind NAT, and the Hub could no longer check access on each connection.

## Consequences

- **The Hub carries forwarded traffic.** Every forwarded byte passes through it, unlike model streams, which go from the Runner to Anthropic (ADR 0015). A Hub on a slow link makes forwarding slow, and each connection costs a WebSocket handshake on both legs, tens of ms over the internet. #19's Previews will reuse the same relay.
- **A forgotten Keep awake holds memory.** On macOS, a Sandbox gives none of the memory its guest has used back to the host until it stops: freed pages, the page cache and a live shrink all leave the host footprint where it peaked. A Session kept awake holds its peak for as long as it stays on, which is why the toggle is marked wherever Sessions are listed.
- **Anyone with Repo access can reach a Session's ports**, including databases and admin consoles a dev setup listens on. That matches who can already run commands in the Session.
- **A port forwarded with `--bind`** is reachable by anyone on that network, without signing in to the Hub.
