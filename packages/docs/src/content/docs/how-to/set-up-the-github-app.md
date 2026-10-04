---
title: Set up the GitHub App
description: Create the GitHub App that signs people in and mints the tokens Runners clone with and Sessions push with, and protect your default branch.
sidebar:
  order: 3
---

One GitHub App does two jobs for the Hub:

- **Sign-in.** With its client id and secret, people sign in with GitHub.
- **Tokens.** With its App id and private key, the Hub mints short-lived installation tokens: for Runners to clone Repos and push WIP refs, and for `git` and `gh` in each Session's Sandbox ([ADR 0010](/reference/decisions/0010-the-sandbox-gets-a-github-token/)).

Without it, use dev login on one machine, and Runners use their host's own git credentials. Sandboxes then get no GitHub token.

:::note[Coming]
`claude-hub onboard` will create the App from a manifest and check its permissions for drift ([#86](https://github.com/kddige/claude-hub/issues/86)). Until then, create it by hand as below.
:::

## Create the App

Go to <https://github.com/settings/apps/new> and fill it in:

| Setting | Value |
|---|---|
| Callback URLs | `<HUB_PUBLIC_URL>/auth/github/callback`. Add one for each URL people reach the Hub at, such as `http://localhost:5173/auth/github/callback` for Vite, `http://127.0.0.1:7777/auth/github/callback` for the built web UI, and your HTTPS URL. |
| Request user authorization (OAuth) during installation | Unticked |
| Expire user authorization tokens | Ticked |
| Webhook, Active | Unticked |
| Repository permissions | Contents: read and write. Pull requests: read and write. Metadata: read-only, which GitHub adds itself. |
| Where can this GitHub App be installed? | Only on this account |

:::caution[Grant only what Claude should have]
Each Session's Sandbox gets a token with every permission you grant here, on its own Repo. Add **Workflows: read and write** only if Sessions should be able to change `.github/workflows`.
:::

## Collect the credentials

1. Note the **App ID** and the **Client ID**.
2. Generate a **client secret**, and a **private key**. GitHub downloads the key as a `.pem` file.
3. Install the App on your account, choosing only the repositories you want Sessions to work on.

## Give them to the Hub

Only the Hub's machine needs them. Runners never see the private key: they get short-lived tokens from the Hub.

1. Move the private key into the dev home, readable only by you:

   ```sh
   mkdir -p ~/.claude-hub-dev
   mv ~/Downloads/<app-name>.*.private-key.pem ~/.claude-hub-dev/github-app.pem
   chmod 600 ~/.claude-hub-dev/github-app.pem
   ```

2. Add the four settings to `packages/hub/.env.local`:

   ```sh
   GITHUB_CLIENT_ID=Iv1.…
   GITHUB_CLIENT_SECRET=…
   GITHUB_APP_ID=…
   GITHUB_APP_PRIVATE_KEY_PATH=/home/you/.claude-hub-dev/github-app.pem
   ```

3. Restart the Hub. The warnings that GitHub sign-in is off and that the GitHub App is not configured are gone, and the sign-in page offers **Sign in with GitHub**.

## Protect the default branch

Anything running in a Session's Sandbox can push any branch of its Repo and merge its pull requests, for as long as the Session runs. claude-hub doesn't stop it. The guardrail is a GitHub ruleset on each Repo's default branch:

1. In the Repo on GitHub, open **Settings**, **Rules**, **Rulesets**, and add a branch ruleset that targets the default branch.
2. Require a pull request before merging, with at least one approval.
3. Block force pushes.
4. Leave the App off the ruleset's bypass list.

See [Git from Sessions](/explanation/git-from-sessions/) for what the token can and can't reach.
