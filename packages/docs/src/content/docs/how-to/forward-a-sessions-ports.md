---
title: Forward a Session's ports
description: Reach a Session's dev servers on localhost on your machine with claude-hub forward, as if they ran there.
sidebar:
  order: 12
---

`claude-hub forward` makes a Session's [Open ports](/how-to/work-in-a-session/#see-its-open-ports) reachable on `localhost` on your machine. Each port something listens on in the Session's Sandbox opens at the same port on your machine, and closes when it closes there. Because it is `localhost`, OAuth redirects, cookies, `curl` and other apps work as they do with a dev server on your machine. The traffic goes through the Hub, so it works wherever you can reach the Hub. At the end of this page, a dev server running in a Session answers at `http://localhost:5173` on your machine.

## Before you start

- The `claude-hub` command on your machine, [installed from a Hub](/how-to/install-the-cli-from-a-hub/) or from a [claude-hub install](/how-to/install/), and [signed in](/how-to/sign-in-the-cli/) to the Hub.
- A Session in a Repo you have access to, with something listening in it, such as a dev server Claude started. Its header shows how many ports are open (**2 ports**).

## Forward a Session

1. On your machine, run:

   ```sh
   claude-hub forward
   ```

2. The CLI lists your Active Sessions, each with its short id, name, Repo and Open ports:

   ```
   Forward which Session?
   > 0b9256  claude/fix-login  owner/name  3000, 5173
     77ab12  Docs  owner/name  no open ports
   Up and down to choose, Enter to forward, Esc to quit
   ```

   Choose the Session with the arrow keys and press Enter.

3. The CLI shows each port it forwards, with its address on your machine and the process listening in the Session, and keeps the list up to date:

   ```
   Forwarding 0b9256 claude/fix-login · owner/name · Active
     http://localhost:3000    bun server · 1 connection
     http://localhost:5173    node vite
   Esc: forward another Session · Ctrl-C: stop
   ```

4. Open `http://localhost:5173` in your browser.

A port that opens in the Session later appears in the list without reconnecting, and one that closes there is removed. A port a Docker container publishes shows a **Docker** label.

To skip the picker, name the Session: its id, the start of it, or its URL from the browser. The **2 ports** list in the Session's header shows the command with its short id, the first 6 characters of its id:

```sh
claude-hub forward 0b9256
claude-hub forward https://hub.example.com/sessions/0b9256b9c0609f5a73defb11
```

When the start of an id matches more than one Session, the CLI lists them and asks for more of it. A Session you name can be Asleep: see [While it forwards](#while-it-forwards).

## Choose the ports

To forward only some ports, name them after the Session. A port that nothing listens on yet is listed as `nothing listens on port 4000 in the Session yet`, and opens here once something does.

```sh
claude-hub forward 0b9256 5173 3000
```

To reach a Session's port at another port on your machine, give both, the Session's first: this forwards the Session's port 3000 to port 3100 here.

```sh
claude-hub forward 0b9256 3000:3100
```

An app that redirects to its own address, as an OAuth sign-in does, sends the browser to the Session's port, so it works only at the same port here.

## When a port is taken here

When a port is already in use on your machine, the CLI skips it and says which process holds it, when `lsof` can tell:

```
3000                     taken here by node (pid 4242): trying again until it's free. Or forward it to another port: claude-hub forward 0b9256 3000:3100
```

It tries the port again every 2 seconds and forwards it once it is free. To forward it now, stop the process holding it, or forward the port to another one, as the message shows.

A port below 1024 needs privileges your user may not have. The CLI skips it and says `Port 80 needs privileges here: forward it to a higher port, as 80:8080.`

## Listen on your network

By default the CLI listens on `127.0.0.1` and `::1`, so only your machine reaches the ports. To let other devices on your network reach them, such as a phone testing a site, give the address to listen on with `--bind`:

```sh
claude-hub forward 0b9256 --bind 0.0.0.0
```

:::caution
A port forwarded with `--bind` is reachable by anyone who can reach that address on your network, without signing in to the Hub.
:::

## While it forwards

- **It shows in the Session.** In the Session's header, you are among the people present while the CLI is connected. Press the avatars for **Here now**, which lists you as forwarding from the machine your CLI token is named after, such as `forwarding from laptop`. The Session's Claude Code sees it in its Participants line too.
- **It keeps the Session awake.** A Session isn't put to sleep for being idle while a `forward` is connected to it.
- **It wakes an Asleep Session.** Naming an Asleep Session wakes it, and the ports open once its servers are listening again. If it can't wake, the CLI says why and stops, as with `The Session is Asleep, and couldn't be woken: …`.
- **It stops when the Session goes to sleep.** If someone presses **Sleep now**, or the Session's Runner is updated, the CLI closes its ports and stops with `The Session went asleep (…).`, saying why. Run it again to wake the Session.
- **It waits out the Hub.** If the Hub restarts or the connection drops, the CLI keeps its ports open and reconnects, waiting longer each time up to 15 seconds. New connections fail until it is back. While the Session's Runner is offline, the Session is Frozen and has no Open ports: the CLI closes them and opens them again once the Runner is back.

Signing the CLI out, revoking its CLI token on the **Account** page, archiving the Session or losing access to its Repo stops the forward, saying why.

## Switch Session or stop

- **Esc** closes the Session's ports and goes back to the picker, to forward another Session. The first Session no longer shows you as forwarding from this machine.
- **Ctrl-C** closes everything and stops: `Stopped forwarding 0b9256.`

Without a terminal, as in a script, `claude-hub forward` without a Session prints the list of Active Sessions and exits. With a Session it prints a line for each change instead of the live list; Esc does nothing, and Ctrl-C stops it.

## Next steps

- [Commands](/reference/commands/#claude-hub-forward): `forward`'s arguments and flags.
- [Protocol](/reference/protocol/#forwards): the forward's connection to the Hub, and the [tunnel](/reference/protocol/#tunnels) each connection takes.
- [ADR 0016](/reference/decisions/0016-forwarding-a-sessions-ports/): why a forward keeps a Session awake, and Open ports by themselves don't.
