---
title: Set up the GitHub App
description: Create the GitHub App that signs people in and mints the tokens Runners clone with and Sessions push with, keep its permissions in step with the Hub's, and protect your default branch.
sidebar:
  order: 5
---

One GitHub App does two jobs for the Hub:

- **Sign-in.** With its client id and secret, people sign in with GitHub.
- **Tokens.** With its App id and private key, the Hub mints short-lived installation tokens: for Runners to clone Repos and push WIP refs, and for `git` and `gh` in each Session's Sandbox ([ADR 0010](/reference/decisions/0010-the-sandbox-gets-a-github-token/)).

Without it, use dev login on one machine, and Runners use their host's own git credentials. Sandboxes then get no GitHub token.

## Create the App with onboard

On the Hub's machine:

```sh
claude-hub onboard --github-app create
```

Onboard asks whether the App is your own account's or an organization's, then:

1. Serves a page on a free port on `127.0.0.1` and opens it in your browser. The page sends GitHub claude-hub's manifest: the App's name (`claude-hub-<machine>`), the Hub's sign-in callback, and [the permissions below](#the-permissions). Nothing is created yet.
2. On GitHub, change the name if you like, and create the App. GitHub sends the browser back to the page.
3. Onboard trades the code GitHub sent back for the App's settings. It saves the private key as `github-app-<id>.pem` in the home, readable only by you, and the App ID, Client ID and client secret in `hub.env`, with `GITHUB_APP_PRIVATE_KEY_PATH` pointing at the key. It never prints them.
4. It prints the App's install link. [Install the App](#install-the-app) on the Repos Sessions should work on.

Onboard then restarts the Hub as usual, and the sign-in page offers **Sign in with GitHub**.

The App's callback is the Hub's `HUB_PUBLIC_URL`. If people also reach the Hub at another URL, add its `/auth/github/callback` under **Callback URLs** in the App's settings.

### Over SSH, or with no browser on the Hub's machine

Onboard only opens a browser on a machine with a desktop, and never over SSH. Otherwise it prints the page's address, such as `http://127.0.0.1:41234/`, and the command that forwards its port. From your own machine:

```sh
ssh -L 41234:127.0.0.1:41234 hub-box
```

Then open the address in your own browser. GitHub sends the browser back to the same address, through the tunnel.

Without the tunnel, the page doesn't load on your machine, and neither does the one GitHub sends you back to. Forward the port and reload, or paste the address the browser was sent back to, which has `code=` in it, at onboard's prompt. A code works once, within an hour.

## The permissions

The App needs these repository permissions, and no webhook.

<!-- permissions:start -->
| Permission | Access | Why |
|---|---|---|
| Contents | read and write | Runners clone Repos and push WIP refs; git in the Sandbox pushes branches. |
| Pull requests | read and write | gh pr in the Sandbox: opening, reviewing and merging pull requests. |
| Issues | read and write | gh issue in the Sandbox: reading and commenting on issues. |
| Metadata | read-only | Repo access: the Hub asks GitHub who is a Repo's collaborator. GitHub gives every App this one. |
<!-- permissions:end -->

:::caution[The Sandbox token gets all of these]
Each Session's Sandbox gets a token with every one of these permissions, on its own Repo ([ADR 0010](/reference/decisions/0010-the-sandbox-gets-a-github-token/)). This list is what Claude, and anything else running in a Sandbox, can do there. Issues, for example, lets a Sandbox open, edit, comment on and close its Repo's issues, as well as read them. Every permission you add beyond the list, such as **Workflows: read and write** so Sessions can change `.github/workflows`, every Sandbox gets too.
:::

## Install the App

Open the install link onboard printed, or the App's settings on GitHub and **Install App**. Install it on your account or organization, choosing only the repositories you want Sessions to work on. Add Repos to the installation later the same way; no restart is needed.

## Keep the permissions in step

When claude-hub comes to need a new permission, the App's settings and each installation fall behind. Changing the App's permissions on GitHub asks each account it's installed on to accept them, and until one does, its installation keeps the old ones. GitHub has no API to change either, so claude-hub only says what's missing and where to fix it.

The Hub checks the App and every installation against [the list](#the-permissions) as it starts, then every hour:

- **In the web UI**, a banner lists what's missing, with links to the App's permissions page and to each installation's review of the request. **Check again** checks at once, after you've fixed it.
- **`claude-hub doctor`** fails its `GitHub App` check, with the same links.
- **The Hub's log** has a warning for each.

To fix it:

1. Open the App's permissions page (the first link), add what's missing, and **Save changes**.
2. For each installation, open its review link, as someone who can manage the account's Apps, and **Accept new permissions**.

## Set it up by hand

To use an App you made on GitHub yourself, create it at <https://github.com/settings/apps/new> (or an organization's **Settings**, **Developer settings**, **GitHub Apps**):

| Setting | Value |
|---|---|
| Callback URLs | `<HUB_PUBLIC_URL>/auth/github/callback`. Add one for each URL people reach the Hub at, such as `http://localhost:5173/auth/github/callback` for Vite, `http://127.0.0.1:7777/auth/github/callback` for the built web UI, and your HTTPS URL. |
| Request user authorization (OAuth) during installation | Unticked |
| Expire user authorization tokens | Ticked |
| Webhook, Active | Unticked |
| Repository permissions | [The permissions](#the-permissions) |
| Where can this GitHub App be installed? | Only on this account |

Then note its **App ID** and **Client ID**, and generate a **client secret** and a **private key**, which GitHub downloads as a `.pem` file. Move the key somewhere only you can read, such as the home, and `chmod 600` it.

Only the Hub's machine needs them. Runners never see the private key: they get short-lived tokens from the Hub.

- **An install:** run `claude-hub onboard --github-app manual`, and paste them. Onboard writes them to `hub.env`.
- **A checkout:** add them to `packages/hub/.env.local`, and restart the Hub:

  ```sh
  GITHUB_CLIENT_ID=Iv1.…
  GITHUB_CLIENT_SECRET=…
  GITHUB_APP_ID=…
  GITHUB_APP_PRIVATE_KEY_PATH=/home/you/.claude-hub-dev/github-app.pem
  ```

The warnings that GitHub sign-in is off and that the GitHub App is not configured are gone, and the sign-in page offers **Sign in with GitHub**. [Install the App](#install-the-app) as above.

## Protect the default branch

Anything running in a Session's Sandbox can push any branch of its Repo and merge its pull requests, for as long as the Session runs. claude-hub doesn't stop it. The guardrail is a GitHub ruleset on each Repo's default branch:

1. In the Repo on GitHub, open **Settings**, **Rules**, **Rulesets**, and add a branch ruleset that targets the default branch.
2. Require a pull request before merging, with at least one approval.
3. Block force pushes.
4. Leave the App off the ruleset's bypass list.

See [Git from Sessions](/explanation/git-from-sessions/) for what the token can and can't reach.
