---
title: Signing in
description: Sign-in fails, doesn't stick, or isn't offered, with GitHub or with dev login.
sidebar:
  order: 2
---

Most sign-in problems come from one setting: `HUB_PUBLIC_URL`, the URL browsers use to reach the web UI. It defaults to `http://localhost:5173`, Vite's dev server. GitHub sends people back to it, the Hub accepts cookie-authenticated requests only from it, and it decides whether cookies are `Secure`.

## The address in the browser isn't `HUB_PUBLIC_URL`

**What you see.** The web UI loads, but it can't connect, or **Sign in as dev** answers:

```
{"error":"Only the web UI at http://localhost:5173 may make this request"}
```

**Why.** You opened the web UI at one address, but `HUB_PUBLIC_URL` names another. The Hub refuses sign-in, sign-out and the web UI's connection from any other origin, so another site can't act with your sign-in cookie. A common case: you opened the Hub's own URL, `http://127.0.0.1:7777`, while `HUB_PUBLIC_URL` was left at its default for Vite. `localhost` and `127.0.0.1` are different origins, too.

**Fix.** Open the web UI at exactly `HUB_PUBLIC_URL`, or set `HUB_PUBLIC_URL` to the address you use and restart the Hub:

```sh
HUB_PUBLIC_URL=http://127.0.0.1:7777 bun run hub
```

With GitHub sign-in, add the matching callback URL to the GitHub App too (see below).

## Sign-in doesn't stick

**What you see.** You sign in, and land back on the sign-in page. The Hub warned at startup:

```
Browsers reach the Hub over plain HTTP at http://192.168.1.10:7777 (HUB_PUBLIC_URL), so they will drop its Secure cookies and sign-in will fail. Serve it over HTTPS, reach it through an SSH tunnel to localhost or over Tailscale HTTPS, or, on a network you trust, set HUB_INSECURE_COOKIES=1.
```

**Why.** The sign-in cookie is `Secure` unless the web UI is on a loopback address, such as `localhost` or `127.0.0.1`, over HTTP. Browsers drop `Secure` cookies sent over plain HTTP from any other address, such as a LAN IP or a hostname without HTTPS.

**Fix.** Give the Hub an HTTPS URL, or reach it through an SSH tunnel to `localhost`. [Reach the Hub from other machines](/how-to/reach-the-hub-from-other-machines/) walks through each option, and the last resort, `HUB_INSECURE_COOKIES=1`, with its trade-off.

## "The sign-in expired or came from elsewhere"

**What you see.** After GitHub, the browser shows:

```
Sign-in failed: the sign-in expired or came from elsewhere. Try again.
```

**Why.** The Hub couldn't match GitHub's answer to the sign-in you started. It keeps a short-lived cookie for that, for 10 minutes, and it was missing or different. That happens when:

- more than 10 minutes passed on GitHub's pages;
- you started at one address and GitHub sent you back to another, `HUB_PUBLIC_URL`, where that cookie doesn't exist;
- the browser dropped the cookie, as over plain HTTP on a LAN (above).

**Fix.** Start again from the web UI at exactly `HUB_PUBLIC_URL`. If it keeps happening, fix the address or HTTPS as above.

## GitHub refuses the sign-in

**What you see.** GitHub shows an error about the `redirect_uri` instead of asking you to authorize the App, or the Hub answers:

```
Sign-in failed: GitHub refused the sign-in: …
```

**Why.** The callback the Hub sends GitHub is `<HUB_PUBLIC_URL>/auth/github/callback`, and GitHub only accepts the callback URLs registered on the App. Otherwise, the client secret is wrong or was regenerated, or the code expired; the message after the colon is GitHub's own.

**Fix.** On the App's settings page, add a callback URL for each address people use, for example `http://localhost:5173/auth/github/callback` and `https://hub.example.com/auth/github/callback`. Check `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are the App's current ones, and restart the Hub after changing them. See [Set up the GitHub App](/how-to/set-up-the-github-app/).

## There's no Sign in with GitHub button

**What you see.** The sign-in page offers only **Sign in as dev**, or says:

```
This Hub has no way to sign in turned on. Set up GitHub sign-in, or start it on loopback with CLAUDE_HUB_DEV_LOGIN=1.
```

**Why.** `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` aren't set where the Hub reads them, so GitHub sign-in is off. The Hub warned `GitHub sign-in is off` at startup.

**Fix.** Put both in `packages/hub/.env.local` (not the checkout's root) and restart the Hub. See [The settings in `.env.local` are ignored](/troubleshooting/hub/#the-settings-in-envlocal-are-ignored).

## Dev login only answers on loopback

**What you see.** **Sign in as dev** answers `Dev login only answers on loopback`.

**Why.** Dev login is for one person on one machine, so the Hub only accepts it from `127.0.0.1` or `::1`. A proxy or tunnel in front of the Hub can make the request arrive from elsewhere.

**Fix.** Open the web UI on the Hub's own machine, without a proxy, or use GitHub sign-in.
