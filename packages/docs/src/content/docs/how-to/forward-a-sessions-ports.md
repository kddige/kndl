---
title: Forward a Session's ports
description: Reach a Session's dev servers on localhost on your machine with kndl forward, as if they ran there.
sidebar:
  order: 12
---

`kndl forward` opens a Session's [Open ports](/how-to/work-in-a-session/#see-its-open-ports) at the same ports on `localhost` on your machine, so OAuth redirects, cookies and `curl` work as with a local dev server. The traffic goes through the Hub, so it works wherever you can reach the Hub. At the end of this page, a dev server running in a Session answers at `http://localhost:5173` on your machine.

## Before you start

- The `kndl` command on your machine, [installed from a Hub](/how-to/install-the-cli-from-a-hub/) or from a [kndl install](/how-to/install/), and [signed in](/how-to/sign-in-the-cli/) to the Hub.
- A Session in a Repo you have access to, with something listening in it, such as a dev server. Its header shows how many ports are open (**2 ports**).

## Forward a Session

1. On your machine, run:

   ```sh
   kndl forward
   ```

2. The CLI lists your Active Sessions, each with its short id, name, Repo and Open ports:

   ```
   Forward which Session?
   > 0b9256  claude/fix-login  owner/name  3000, 5173
     77ab12  Docs  owner/name  no open ports
   Up and down to choose, Enter to forward, Esc to quit
   ```

   Choose the Session with the arrow keys and press Enter.

3. The CLI shows each port it forwards, with its address on your machine and the process listening in the Session:

   ```
   Forwarding 0b9256 claude/fix-login · owner/name · Active
     http://localhost:3000    bun server · 1 connection
     http://localhost:5173    node vite
   Esc: forward another Session · Ctrl-C: stop
   ```

4. Open `http://localhost:5173` in your browser.

Ports that open or close in the Session later are added or removed as they do.

To skip the picker, name the Session: its id, the start of it, or its URL. The **2 ports** list in the Session's header shows the command with the short id:

```sh
kndl forward 0b9256
kndl forward https://hub.example.com/sessions/0b9256b9c0609f5a73defb11
```

A Session you name can be Asleep: see [While it forwards](#while-it-forwards).

## Choose the ports

To forward only some ports, name them after the Session. A port that nothing listens on yet is listed as `nothing listens on port 4000 in the Session yet`, and opens here once something does.

```sh
kndl forward 0b9256 5173 3000
```

To use another port on your machine, give both, the Session's first. This forwards the Session's port 3000 to port 3100 here:

```sh
kndl forward 0b9256 3000:3100
```

An app that redirects to its own address, as an OAuth sign-in does, works only at the same port here.

## When a port is taken here

When a port is in use on your machine, the CLI skips it and says which process holds it, when `lsof` can tell:

```
3000                     taken here by node (pid 4242): trying again until it's free. Or forward it to another port: kndl forward 0b9256 3000:3100
```

It forwards the port once it is free. To forward it now, stop the process holding it, or forward it to another port.

A port below 1024 may need privileges your user doesn't have. The CLI then skips it and says `Port 80 needs privileges here: forward it to a higher port, as 80:8080.`

## Listen on your network

By default only your machine reaches the ports (`127.0.0.1` and `::1`). To let other devices on your network reach them, such as a phone, give the address to listen on with `--bind`:

```sh
kndl forward 0b9256 --bind 0.0.0.0
```

:::caution
A port forwarded with `--bind` is reachable by anyone who can reach that address on your network, without signing in to the Hub.
:::

## While it forwards

- **It shows in the Session.** You are among the people present, and **Here now** lists you as forwarding from the machine your CLI token is named after, such as `forwarding from laptop`.
- **It keeps the Session awake.** A Session isn't put to sleep for being idle while a `forward` is connected.
- **It wakes an Asleep Session.** The ports open once its servers listen again. If it can't wake, the CLI stops with `The Session is Asleep, and couldn't be woken: …`.
- **It stops when the Session goes to sleep**, as on **Sleep now** or a Runner update, with `The Session went asleep (…).` Run it again to wake the Session.
- **It waits out the Hub.** If the connection drops, the CLI keeps its ports open and reconnects; new connections fail until it is back. While the Runner is offline, the CLI closes the ports and opens them again once it's back.

Signing the CLI out, revoking its CLI token on the **Account** page, archiving the Session or losing access to its Repo stops the forward, saying why.

## Switch Session or stop

- **Esc** closes the Session's ports and goes back to the picker, to forward another Session.
- **Ctrl-C** closes everything and stops: `Stopped forwarding 0b9256.`

Without a terminal, as in a script, `kndl forward` with no Session prints the Active Sessions and exits; with a Session, it prints a line for each change.

## Next steps

- [Commands](/reference/commands/#kndl-forward): `forward`'s arguments and flags.
- [Protocol](/reference/protocol/#forwards): the forward's connection to the Hub, and the [tunnel](/reference/protocol/#tunnels) each connection takes.
- [ADR 0016](/reference/decisions/0016-forwarding-a-sessions-ports/): why a forward keeps a Session awake, and Open ports by themselves don't.
