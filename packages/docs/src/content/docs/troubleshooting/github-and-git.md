---
title: GitHub and git
description: A Repo won't clone, the GitHub App can't see it or lacks permissions, or git and gh in a Session can't reach GitHub.
sidebar:
  order: 6
---

Two kinds of git run for a Session: the Runner's, on its host, which clones the Repo, and the Session's, in its Sandbox, which Claude uses. They get their access differently. See [Git from Sessions](/concepts/git-from-sessions/).

## The Runner can't clone the Repo

**What you see.** A new Session goes Asleep at once, with:

```
The Session is Asleep: Claude Code could not start on build-box: git clone exited with 128: …
```

followed by git's own message, such as `fatal: could not read Username for 'https://github.com': terminal prompts disabled` or `fatal: repository '…' not found`.

**Why.** One of:

- **Without the GitHub App**, the Runner clones over HTTPS with its host's own git credentials, and can't ask for a password.
- **With the GitHub App**, the App isn't installed on the Repo.
- The Repo name (`owner/name`) or branch is wrong.

**Fix.** Without the App, sign the Runner's user in to GitHub for HTTPS git, for example with `gh auth login` and `gh auth setup-git`, and check a manual `git clone` works. With the App, see the next entry. To clone from a mirror, set `RUNNER_REPO_URL`, where `{repo}` stands for `owner/name`.

## The GitHub App can't see the Repo

**What you see.** A new Session goes Asleep at once, with:

```
The Session is Asleep: Claude Code could not start on build-box: The GitHub App is not installed on owner/name, or can't see it: …
```

The Runner's warning that a Sandbox has no GitHub token (below) can end the same way.

**Why.** The App isn't installed on the Repo's owner, or its installation is limited to other repositories.

**Fix.** On GitHub, open the App's settings, **Install App**, and add the Repo to the installation, or install it on that account or organisation. No restart is needed.

## The GitHub App is missing permissions

**What you see.** The web UI shows a banner, **The GitHub App is missing permissions**, listing them. `kndl doctor` fails with:

```
XX  GitHub App: The App kndl-build-box lacks Issues: read and write. Add it at https://github.com/settings/apps/kndl-build-box/permissions
      Its installation on ada lacks Issues: read and write. Once the App has it, accept it at https://github.com/settings/installations/12345/permissions/update
```

and the Hub logs the same as warnings. What needs the permission fails, such as `gh issue comment` in a Session with `Resource not accessible by integration`.

**Why.** The App lacks a permission kndl needs, or an installation hasn't accepted it yet: GitHub keeps an installation on its old permissions until someone who manages the account accepts the new ones.

**Fix.** Follow the links: add the permissions on the App's page and **Save changes**, then on each installation's page **Accept new permissions**. Click **Check again** on the banner, or run `kndl doctor`. See [Keep the permissions in step](/self-hosting/set-up-the-github-app/#keep-the-permissions-in-step).

If doctor warns `Couldn't check its permissions` instead, the Hub's App settings are wrong or GitHub can't be reached: the message says which.

## git and gh in a Session can't reach GitHub

**What you see.** In a Session, `git push` fails with `could not read Username`, or `gh` says you aren't logged in. The Runner logs:

```
WARN (#2): Session 9af3111eb506f54cea59b83c: its Sandbox has no GitHub token, so git and gh there can't reach GitHub: …
```

**Why.** git and gh in the Sandbox use a short-lived GitHub App token for the Session's Repo, and the Sandbox has none:

- The Hub has no GitHub App configured.
- The App isn't installed on the Repo (see above), or GitHub failed. The Runner asks again every five minutes and logs `its Sandbox has a GitHub token again` once it gets one.
- git wasn't in the image when the token arrived. The next refresh, within 45 minutes, or a restart of the Session sets it up.
- `gh` isn't installed. kndl doesn't install it.

**Fix.** [Set up the GitHub App](/self-hosting/set-up-the-github-app/) and install it on the Repo. Install git and gh in the Environment's [Bootstrap script](/guides/set-up-an-environment/#write-the-bootstrap-script). Don't run `gh auth login` in the Sandbox.

## Claude pushed to the default branch

**What you see.** A Session pushed straight to `main`, or merged its own pull request.

**Why.** The Sandbox token has every permission the App's installation has on the Session's Repo, by design ([ADR 0010](/contributing/decisions/0010-the-sandbox-gets-a-github-token/)).

**Fix.** Protect the default branch with a GitHub ruleset: require a pull request with at least one approval, block force pushes, and keep the App off the bypass list. See [Protect the default branch](/self-hosting/set-up-the-github-app/#protect-the-default-branch).
