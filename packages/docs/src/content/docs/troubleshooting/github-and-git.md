---
title: GitHub and git
description: A Repo won't clone, the GitHub App can't see it or lacks permissions, or git and gh in a Session can't reach GitHub.
sidebar:
  order: 6
---

Fixes for cloning and pushing. Two gits run for a Session: the Runner's, which clones the Repo, and the Sandbox's, which the agent uses. See [Git from Sessions](/concepts/git-from-sessions/) for how each gets access.

## git clone exited with 128

**What you see.** A new Session goes Asleep at once:

```
The Session is Asleep: Claude Code could not start on build-box: git clone exited with 128: …
```

followed by git's message, such as `could not read Username for 'https://github.com'` or `repository '…' not found`.

**Why.** One of:

- The Repo name or branch is wrong.
- The Hub has the GitHub App, and it isn't installed on the Repo.
- The Hub has no GitHub App, and the Runner's machine can't clone the Repo with its own git credentials.

**Fix.** Check the Repo and branch. With the App, see [the next entry](#the-github-app-is-not-installed-on-the-repo). Without it, sign the Runner's user in to GitHub for git, and check a `git clone` works there:

```sh
gh auth login
gh auth setup-git
```

## The GitHub App is not installed on the Repo

**What you see.**

```
The Session is Asleep: Claude Code could not start on build-box: The GitHub App is not installed on owner/name, or can't see it: …
```

**Why.** The App isn't installed on the Repo's account, or its installation is limited to other repositories.

**Fix.** On GitHub, open the App's settings, **Install App**, and add the Repo to the installation. No restart is needed.

## The GitHub App is missing permissions

**What you see.** The web UI shows **The GitHub App is missing permissions**, and `kndl doctor` fails with:

```
XX  GitHub App: The App kndl-build-box lacks Issues: read and write. Add it at https://github.com/settings/apps/kndl-build-box/permissions
      Its installation on ada lacks Issues: read and write. Once the App has it, accept it at https://github.com/settings/installations/12345/permissions/update
```

In a Session, what needs the permission fails, such as `gh issue comment` with `Resource not accessible by integration`.

**Why.** The App lacks a permission kndl needs, or an installation hasn't accepted it yet. GitHub keeps an installation on its old permissions until its account's owner accepts the new ones.

**Fix.** Follow the links in the message: add the permissions on the App's page and **Save changes**, then **Accept new permissions** on each installation's page. Then press **Check again** on the banner, or run `kndl doctor`. See [Keep the permissions in step](/self-hosting/set-up-the-github-app/#keep-the-permissions-in-step).

## git push or gh fails in a Session

**What you see.** In a Session, `git push` fails with `could not read Username`, or `gh` says you aren't logged in. The Runner logs:

```
Session 9af3111eb506f54cea59b83c: its Sandbox has no GitHub token, so git and gh there can't reach GitHub: …
```

**Why.** git and gh in the Sandbox use a short-lived token from the GitHub App, and the Sandbox has none: the Hub has no App, the App isn't installed on the Repo, or the image has no git. kndl doesn't install `gh`.

**Fix.** [Set up the GitHub App](/self-hosting/set-up-the-github-app/) and install it on the Repo. Install git and gh in the Environment's [Bootstrap script](/guides/set-up-an-environment/#write-the-bootstrap-script), then **Restart** the Session. Don't run `gh auth login` in the Sandbox.

## Claude pushed to the default branch

**What you see.** A Session pushed straight to `main`, or merged its own pull request.

**Why.** The Sandbox's token has every permission the App's installation has on the Repo ([ADR 0010](/contributing/decisions/0010-the-sandbox-gets-a-github-token/)).

**Fix.** Protect the default branch with a GitHub ruleset: require a pull request with an approval, block force pushes, and keep the App off the bypass list. See [Protect the default branch](/self-hosting/set-up-the-github-app/#protect-the-default-branch).
