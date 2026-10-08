---
title: Set up the GitHub App
description: Create the GitHub App that signs people in and mints the tokens Runners clone with and Sessions push with, keep its permissions in step with the Hub's, and protect your default branch.
sidebar:
  order: 5
---

One GitHub App does two jobs for the Hub:

- **Sign-in.** With its client id and secret, people sign in with GitHub.
- **Tokens.** With its App id and private key, the Hub mints short-lived installation tokens: for Runners to clone Repos, and for `git` and `gh` in each Session's Sandbox ([ADR 0010](/reference/decisions/0010-the-sandbox-gets-a-github-token/)).

Without it, use dev login on one machine; Runners then clone with their host's own git credentials, and Sandboxes get no GitHub token.

## Create the App with onboard

On the Hub's machine:

```sh
kndl onboard --github-app create
```

Onboard asks whether the App is your own account's or an organization's, then:

1. Onboard opens a page in your browser that sends GitHub kndl's manifest: the App's name (`kndl-<machine>`), the Hub's sign-in callback, and [the permissions below](#the-permissions).
2. On GitHub, change the name if you like, and create the App. GitHub sends the browser back to the page.
3. Onboard saves the private key as `github-app-<id>.pem` in the home, and the App's settings in `hub.env`.
4. It prints the App's install link. [Install the App](#install-the-app) on the Repos Sessions should work on.

The sign-in page then offers **Sign in with GitHub**, and onboard ends with the Hub's Setup link: [become the Owner](/how-to/let-people-in/#become-the-owner) with it.

Onboard creates the App private, which installs only on the account you chose. To install it on several, [make it public](/how-to/let-people-in/#make-the-github-app-public).

If people also reach the Hub at a URL other than `HUB_PUBLIC_URL`, add that URL's `/auth/github/callback` under **Callback URLs** in the App's settings.

### Over SSH, or with no browser on the Hub's machine

Over SSH, or on a machine without a desktop, onboard prints the page's address, such as `http://127.0.0.1:41234/`, and the command that forwards its port. From your own machine:

```sh
ssh -L 41234:127.0.0.1:41234 hub-box
```

Then open the address in your own browser. GitHub sends the browser back through the tunnel.

If the page GitHub sends you back to doesn't load, paste its address, which has `code=` in it, at onboard's prompt within an hour.

## The permissions

The App needs these repository permissions, the organization permission Members, and no webhook.

Members matters only on an organization: without it, the Hub refuses people who reach a Repo through the organization's owners, base permission or teams.

<!-- permissions:start -->
| Permission | Access | Why |
|---|---|---|
| Contents | read and write | Runners clone Repos; git in the Sandbox pushes branches. |
| Pull requests | read and write | gh pr in the Sandbox: opening, reviewing and merging pull requests. |
| Issues | read and write | gh issue in the Sandbox: reading and commenting on issues. |
| Metadata | read-only | Repo access: the Hub asks GitHub who is a Repo's collaborator. GitHub gives every App this one. |
| Members | read-only | Repo access on an organization: without it, GitHub hides access through the organization (owners, its base permission, teams), and the Hub refuses those people. An organization permission. |
<!-- permissions:end -->

:::caution[The Sandbox token gets all of these]
Each Session's Sandbox gets a token with every one of these permissions on its own Repo ([ADR 0010](/reference/decisions/0010-the-sandbox-gets-a-github-token/)), so this list is what anything running in a Sandbox can do there. Issues, for example, lets it open, edit and close issues. Every permission you add, such as **Workflows: read and write**, every Sandbox gets too, and on an organization a Sandbox can list the organization's members.
:::

## Install the App

Open the install link onboard printed, or the App's settings on GitHub and **Install App**. Install it on your account or organization, choosing only the repositories you want Sessions to work on. Add Repos to the installation later the same way; no restart is needed.

## Keep the permissions in step

The App and each installation must grant every permission in [the list](#the-permissions). The Hub checks them at startup and every hour. When one is missing, a banner in the web UI lists it, with links to fix it, and `kndl doctor` fails its `GitHub App` check. **Check again** in the banner checks at once.

To fix it:

1. Open the App's permissions page (the first link), add what's missing, and **Save changes**.
2. For each installation, open its review link as someone who can manage the account's Apps, and **Accept new permissions**.

## Set it up by hand

To use an App you made on GitHub yourself, create it at <https://github.com/settings/apps/new> (or an organization's **Settings**, **Developer settings**, **GitHub Apps**):

| Setting | Value |
|---|---|
| Callback URLs | `<HUB_PUBLIC_URL>/auth/github/callback`. Add one for each URL people reach the Hub at, such as `http://localhost:5173/auth/github/callback` for Vite, `http://127.0.0.1:7777/auth/github/callback` for the built web UI, and your HTTPS URL. |
| Request user authorization (OAuth) during installation | Unticked |
| Expire user authorization tokens | Ticked |
| Webhook, Active | Unticked |
| Repository permissions | [The permissions](#the-permissions) |
| Organization permissions | Members: read-only |
| Where can this GitHub App be installed? | Only on this account. Choose **Any account** to install it on several; see [Make the GitHub App public](/how-to/let-people-in/#make-the-github-app-public). |

Then note its **App ID** and **Client ID**, and generate a **client secret** and a **private key**, which GitHub downloads as a `.pem` file. On the Hub's machine, move the key somewhere only you can read, such as the home, and `chmod 600` it.

- **An install:** run `kndl onboard --github-app manual`, and paste them. Onboard writes them to `hub.env`.
- **A checkout:** add them to `packages/hub/.env.local`, and restart the Hub:

  ```sh
  GITHUB_CLIENT_ID=Iv1.…
  GITHUB_CLIENT_SECRET=…
  GITHUB_APP_ID=…
  GITHUB_APP_PRIVATE_KEY_PATH=/home/you/.kndl-dev/github-app.pem
  ```

The sign-in page offers **Sign in with GitHub**. [Install the App](#install-the-app), then [become the Owner](/how-to/let-people-in/#become-the-owner) with the Setup link onboard prints, or `bun run setup-link` from a checkout.

## Protect the default branch

Anything running in a Session's Sandbox can push any branch of its Repo and merge its pull requests. To guard the default branch, add a GitHub ruleset on each Repo:

1. In the Repo on GitHub, open **Settings**, **Rules**, **Rulesets**, and add a branch ruleset that targets the default branch.
2. Require a pull request before merging, with at least one approval.
3. Block force pushes.
4. Leave the App off the ruleset's bypass list.

See [Git from Sessions](/explanation/git-from-sessions/) for what the token can and can't reach.
