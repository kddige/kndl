---
title: Signing in
description: Sign-in fails, doesn't stick, or isn't offered, with GitHub, with dev login, or for the kndl CLI.
sidebar:
  order: 3
---

Fixes for signing in to the web UI and the CLI. Most web sign-in problems come from `HUB_PUBLIC_URL` in `hub.env`: the address people open the Hub at. GitHub sends people back to it, and the Hub accepts requests only from it.

## Only the web UI may make this request

**What you see.** The web UI loads but can't connect, or **Sign in as dev** answers:

```
{"error":"Only the web UI at http://127.0.0.1:7777 may make this request"}
```

**Why.** You opened the Hub at another address than `HUB_PUBLIC_URL`. `localhost` and `127.0.0.1` count as different addresses.

**Fix.** Open the Hub at exactly the address the message names. Or set `HUB_PUBLIC_URL` in `hub.env` to the address you use, and run `kndl hub install`. With GitHub sign-in, add that address's callback URL to the GitHub App too ([below](#github-refused-the-sign-in)).

## Sign-in doesn't stick

**What you see.** You sign in, and land back on the sign-in page. The Hub warned at startup:

```
Browsers reach the Hub over plain HTTP at http://192.168.1.10:7777 (HUB_PUBLIC_URL), so they will drop its Secure cookies and sign-in will fail. …
```

**Why.** Browsers drop the Hub's sign-in cookie over plain HTTP, except on `localhost` or `127.0.0.1`.

**Fix.** Give the Hub an HTTPS address, or reach it through an SSH tunnel to `localhost`. See [Reach the Hub from other machines](/self-hosting/reach-the-hub-from-other-machines/) for each option, including `HUB_INSECURE_COOKIES=1` and what it costs.

## The sign-in expired or came from elsewhere

**What you see.** After GitHub, the browser shows:

```
Sign-in failed: the sign-in expired or came from elsewhere. Try again.
```

**Why.** The sign-in took more than 10 minutes, started at another address than `HUB_PUBLIC_URL`, or the browser dropped its cookie over plain HTTP.

**Fix.** Start again from the Hub at exactly `HUB_PUBLIC_URL`. If it keeps happening, see [Sign-in doesn't stick](#sign-in-doesnt-stick).

## This Hub is invite-only

**What you see.** After GitHub, a page says **You weren't let in**:

```
This Hub is invite-only. Ask its owner for an invite.
```

**Why.** The Hub lets in only its Owner and the people the Owner invited, and the link you came with, if any, didn't work: it was used, revoked, expired, or tied to another GitHub account. A Member the Owner removed is turned away too.

**Fix.**

- **A new Hub with no Owner yet:** on the Hub's machine, print a Setup link and open it:

  ```sh
  kndl hub setup-link
  ```

- **Otherwise:** ask the Owner for a new Invite. If it's tied to a GitHub account, sign in to GitHub as that account.
- **You are the Owner:** you're signed in to github.com as another account. Sign out there, and sign in as yours.

See [Let people in](/self-hosting/let-people-in/).

## GitHub refused the sign-in

**What you see.** GitHub shows an error about the `redirect_uri`, or the Hub answers:

```
Sign-in failed: GitHub refused the sign-in: …
```

**Why.** GitHub accepts only callback URLs registered on the App, and the Hub sends `<HUB_PUBLIC_URL>/auth/github/callback`. Otherwise, the client secret is wrong.

**Fix.** On the App's settings page on GitHub, add the callback URL for each address people use, such as `https://hub.example.com/auth/github/callback`. Check `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `hub.env` are the App's current ones, then run `kndl hub install`. See [Set up the GitHub App](/self-hosting/set-up-the-github-app/).

## There's no Sign in with GitHub button

**What you see.** The sign-in page offers only **Sign in as dev**, or says:

```
This Hub has no way to sign in turned on. Set up GitHub sign-in, or start it on loopback with KNDL_DEV_LOGIN=1.
```

**Why.** `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` aren't set. The Hub warned `GitHub sign-in is off` at startup.

**Fix.** [Set up the GitHub App](/self-hosting/set-up-the-github-app/):

```sh
kndl onboard --github-app create
```

## Dev login only answers on loopback

**What you see.** **Sign in as dev** answers `Dev login only answers on loopback`.

**Why.** The Hub accepts dev login only from the Hub's own machine, and a proxy or tunnel made the request arrive from elsewhere.

**Fix.** Open the Hub in a browser on its own machine, without a proxy, or use GitHub sign-in.

## kndl login: the browser can't connect to 127.0.0.1

**What you see.** You ran `kndl login` and pressed **Approve**, and the browser can't reach `127.0.0.1`.

**Why.** The page sends the browser back to the CLI on the browser's machine, and the CLI runs on another one, as over SSH.

**Fix.** Go back a page: it shows the Login code. Paste it where the CLI asks `Waiting for the browser. Or paste the code the page shows`. Next time, run:

```sh
kndl login --no-browser
```

See [Sign in the CLI](/guides/sign-in-the-cli/).

## That code isn't valid

**What you see.** `kndl login` says:

```
That code isn't valid: it may have expired or been used. Run kndl login again.
```

**Why.** A Login code works once, for 10 minutes, only for the `kndl login` that opened its page.

**Fix.** Run `kndl login` again, and approve within 10 minutes.

## The Hub doesn't accept this machine's CLI token

**What you see.** `kndl whoami` says:

```
https://hub.example.com doesn't accept this machine's CLI token: it was revoked. Run kndl login to sign in again.
```

**Why.** Someone revoked the token under **CLI tokens** on the **Account** page, or the Hub was set up again with a new database.

**Fix.** Run `kndl login`.
