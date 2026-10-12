---
title: Signing in
description: Sign-in fails, doesn't stick, or isn't offered, with GitHub, with dev login, or for the kndl CLI.
sidebar:
  order: 3
---

Most sign-in problems come from `HUB_PUBLIC_URL`, the URL browsers use to reach the web UI (default `http://localhost:5173`, Vite's dev server). GitHub sends people back to it, the Hub accepts cookie-authenticated requests only from it, and it decides whether cookies are `Secure`.

## The address in the browser isn't `HUB_PUBLIC_URL`

**What you see.** The web UI loads but can't connect, or **Sign in as dev** answers:

```
{"error":"Only the web UI at http://localhost:5173 may make this request"}
```

**Why.** You opened the web UI at another address than `HUB_PUBLIC_URL`, such as the Hub's own `http://127.0.0.1:7777`. The Hub refuses requests from any other origin, so another site can't act with your cookie. `localhost` and `127.0.0.1` are different origins.

**Fix.** Open the web UI at exactly `HUB_PUBLIC_URL`, or set it to the address you use and restart the Hub:

```sh
HUB_PUBLIC_URL=http://127.0.0.1:7777 bun run hub
```

With GitHub sign-in, add the matching callback URL to the GitHub App too (see below).

## Sign-in doesn't stick

**What you see.** You sign in, and land back on the sign-in page. The Hub warned at startup:

```
Browsers reach the Hub over plain HTTP at http://192.168.1.10:7777 (HUB_PUBLIC_URL), so they will drop its Secure cookies and sign-in will fail. Serve it over HTTPS, reach it through an SSH tunnel to localhost or over Tailscale HTTPS, or, on a network you trust, set HUB_INSECURE_COOKIES=1.
```

**Why.** The sign-in cookie is `Secure` except on a loopback address over HTTP, and browsers drop `Secure` cookies sent over plain HTTP from any other address.

**Fix.** Give the Hub an HTTPS URL, or reach it through an SSH tunnel to `localhost`. See [Reach the Hub from other machines](/self-hosting/reach-the-hub-from-other-machines/) for each option, including `HUB_INSECURE_COOKIES=1` and its cost.

## "The sign-in expired or came from elsewhere"

**What you see.** After GitHub, the browser shows:

```
Sign-in failed: the sign-in expired or came from elsewhere. Try again.
```

**Why.** The Hub couldn't match GitHub's answer to the sign-in you started, because its 10-minute cookie was missing or different:

- more than 10 minutes passed on GitHub's pages;
- you started at another address than `HUB_PUBLIC_URL`, where GitHub sent you back;
- the browser dropped the cookie, as over plain HTTP on a LAN (above).

**Fix.** Start again from the web UI at exactly `HUB_PUBLIC_URL`. If it keeps happening, fix the address or HTTPS as above.

## "This Hub is invite-only"

**What you see.** After GitHub, the browser lands on a page that says **You weren't let in**:

```
This Hub is invite-only. Ask its owner for an invite.
```

The Hub logs `Turned away <login>, who has no Invite`.

**Why.** The Hub lets in only its Owner and the people the Owner invited ([Let people in](/self-hosting/let-people-in/)), and the link you came with, if any, didn't work: it was used, revoked, expired, replaced, or tied to another GitHub login. A Member the Owner removed is turned away too.

**Fix.**

- **On a new Hub, with no Owner yet,** run `kndl hub setup-link` on the Hub's machine (`bun run setup-link` from a checkout) and open the link it prints.
- **Otherwise,** ask the Owner for a new Invite, and open it in the browser where you'll sign in. If it is tied to a login, sign in to GitHub as that account.
- **If you are the Owner,** you signed in to GitHub as another account. Sign out of github.com and sign in as the Owner's.

## GitHub refuses the sign-in

**What you see.** GitHub shows an error about the `redirect_uri` instead of asking you to authorize the App, or the Hub answers:

```
Sign-in failed: GitHub refused the sign-in: …
```

**Why.** GitHub only accepts callback URLs registered on the App, and the Hub sends `<HUB_PUBLIC_URL>/auth/github/callback`. Otherwise the client secret is wrong, or the code expired; the text after the colon is GitHub's.

**Fix.** On the App's settings page, add a callback URL for each address people use, such as `https://hub.example.com/auth/github/callback`. Check `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are the App's current ones, and restart the Hub after changing them. See [Set up the GitHub App](/self-hosting/set-up-the-github-app/).

## There's no Sign in with GitHub button

**What you see.** The sign-in page offers only **Sign in as dev**, or says:

```
This Hub has no way to sign in turned on. Set up GitHub sign-in, or start it on loopback with KNDL_DEV_LOGIN=1.
```

**Why.** `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` aren't set where the Hub reads them. The Hub warned `GitHub sign-in is off` at startup.

**Fix.** Put both in `packages/hub/.env.local` and restart the Hub. See [The settings in `.env.local` are ignored](/troubleshooting/hub/#the-settings-in-envlocal-are-ignored).

## Dev login only answers on loopback

**What you see.** **Sign in as dev** answers `Dev login only answers on loopback`.

**Why.** The Hub accepts dev login only from `127.0.0.1` or `::1`, and a proxy or tunnel can make the request arrive from elsewhere.

**Fix.** Open the web UI on the Hub's own machine, without a proxy, or use GitHub sign-in.

## After Approve, the browser can't connect to `127.0.0.1`

**What you see.** You ran `kndl login` and pressed **Approve**, and the browser can't reach `127.0.0.1`.

**Why.** The page sends the browser back to the CLI on the browser's machine, and the CLI runs on another one.

**Fix.** Go back a page: it shows the Login code. Paste it in the terminal, where the CLI asks `Waiting for the browser. Or paste the code the page shows`. Next time, run `kndl login --no-browser`. See [Sign in the CLI](/guides/sign-in-the-cli/#sign-in-over-ssh).

## "That code isn't valid"

**What you see.** `kndl login` says:

```
That code isn't valid: it may have expired or been used. Run kndl login again.
```

**Why.** A Login code works once, for 10 minutes, only for the `kndl login` that opened its page, and not across a Hub restart.

**Fix.** Run `kndl login` again, open the address this run prints, and approve within 10 minutes.

## "doesn't accept this machine's CLI token"

**What you see.** `kndl whoami` says:

```
https://hub.example.com doesn't accept this machine's CLI token: it was revoked. Run kndl login to sign in again.
```

**Why.** Someone revoked the token on the **Account** page, under **CLI tokens**, or the Hub was set up again with a new database.

**Fix.** Run `kndl login`. See [Sign in the CLI](/guides/sign-in-the-cli/).
