---
title: Reach the Hub from other machines
description: Put the Hub behind HTTPS, an SSH tunnel or Tailscale, so teammates and Runners elsewhere can reach it and sign-in works.
sidebar:
  order: 4
---

The Hub listens on `127.0.0.1:7777` by default, so only its own machine can reach it. At the end of this page, teammates and Runners elsewhere reach it at one URL, `HUB_PUBLIC_URL`, which must be HTTPS or loopback.

## Why plain HTTP on a LAN doesn't work

Browsers drop the Hub's `Secure` sign-in cookie over plain HTTP anywhere but loopback, so at `http://192.168.1.10:7777` sign-in fails. The Hub warns at startup:

```
Browsers reach the Hub over plain HTTP at http://192.168.1.10:7777 (HUB_PUBLIC_URL), so they will drop its Secure cookies and sign-in will fail. …
```

## Option 1: HTTPS through a reverse proxy

Keep the Hub on loopback, and put a reverse proxy with a certificate in front of it, such as Caddy or nginx. It must pass WebSocket upgrades through. A Caddyfile, for example:

```
hub.example.com {
  reverse_proxy 127.0.0.1:7777
}
```

Then start the Hub with that URL:

```sh
HUB_PUBLIC_URL=https://hub.example.com bun run hub
```

Add `https://hub.example.com/auth/github/callback` to the GitHub App's callback URLs, and point Runners at it with `HUB_URL=https://hub.example.com`: they connect over `wss:`.

## Option 2: Tailscale Serve

On a tailnet, [Tailscale Serve](https://tailscale.com/kb/1312/serve) gives the Hub an HTTPS URL that only your tailnet can reach, with no certificate to manage. Turn on HTTPS certificates for the tailnet first, in its admin console's DNS settings:

```sh
tailscale serve --bg 7777
```

It prints the URL, such as `https://hub-box.your-tailnet.ts.net`. Use it as `HUB_PUBLIC_URL` and as each Runner's `HUB_URL`, and add its callback URL to the GitHub App.

## Option 3: an SSH tunnel

For one person, forward the Hub's port to your own machine, and keep the Hub on loopback with `HUB_PUBLIC_URL=http://127.0.0.1:7777`:

```sh
ssh -L 7777:127.0.0.1:7777 hub-box
```

Then open <http://127.0.0.1:7777> on your machine: exactly the URL `HUB_PUBLIC_URL` names, since browsers treat `localhost` and `127.0.0.1` as different origins. With Vite, forward `5173` instead and open <http://localhost:5173>.

## Last resort: plain HTTP on a network you trust

`HUB_INSECURE_COOKIES=1` drops `Secure` from the Hub's cookies when `HUB_PUBLIC_URL` is plain HTTP:

```sh
HOST=0.0.0.0 HUB_PUBLIC_URL=http://192.168.1.10:7777 HUB_INSECURE_COOKIES=1 bun run hub
```

:::caution
Sign-in tokens then travel in cleartext: anyone who can watch the network can take over a sign-in.
:::

## Whichever you pick

- **Dev login works only through an SSH tunnel**, since it needs `HOST` and `HUB_PUBLIC_URL` both on loopback. Set up [GitHub sign-in](/how-to/set-up-the-github-app/).
- **Bind to loopback behind a proxy or Tailscale.** Only set `HOST=0.0.0.0` when browsers connect to the Hub directly.
- **Everyone must use the one origin.** The Hub refuses cookie-authenticated requests from any origin but `HUB_PUBLIC_URL`'s.
