---
title: GitHub and git
description: A Repo won't clone, the GitHub App can't see it or lacks permissions, git and gh in a Session can't reach GitHub, or the WIP ref won't push.
sidebar:
  order: 6
---

Two kinds of git run for a Session: the Runner's own, on its host, which clones the Repo and pushes the WIP ref, and the Session's, in its Sandbox, which Claude uses. They get their access differently. See [Git from Sessions](/explanation/git-from-sessions/).

## The Runner can't clone the Repo

**What you see.** A new Session goes Asleep at once, with:

```
The Session is Asleep: Claude Code could not start on build-box: git clone exited with 128: …
```

What follows is git's own message, such as `fatal: could not read Username for 'https://github.com': terminal prompts disabled` or `fatal: repository '…' not found`.

**Why.**

- **Without the GitHub App**, the Runner clones with its host's own git credentials, over HTTPS by default, and can't ask for a password. If the user that runs the Runner can't `git clone https://github.com/owner/name.git` without typing anything, neither can the Runner.
- **With the GitHub App**, the Hub mints a token for the clone, and the App must be installed on that Repo.
- The Repo name or branch is wrong. The Repo is `owner/name`, as on GitHub, in any case.

**Fix.** Without the App, sign the Runner's user in to GitHub for HTTPS git, for example with `gh auth login` and `gh auth setup-git`, and check a manual clone works. With the App, see the next entry. To clone from somewhere else, such as a mirror, set `RUNNER_REPO_URL`, where `{repo}` stands for `owner/name`.

## The GitHub App can't see the Repo

**What you see.** A new Session goes Asleep at once, with:

```
The Session is Asleep: Claude Code could not start on build-box: The GitHub App is not installed on owner/name, or can't see it: …
```

The same words can end the Runner's warning that a Sandbox has no GitHub token (below).

**Why.** The Hub mints every token from the App's installation on the Repo's owner. The App isn't installed there, or its installation was limited to other repositories.

**Fix.** On GitHub, open the App's settings, **Install App**, and add the Repo to the installation, or install it on that account or organisation. No restart is needed.

## The GitHub App is missing permissions

**What you see.** The web UI shows a banner, **The GitHub App is missing permissions**, that lists them. `claude-hub doctor` fails with:

```
XX  GitHub App: The App claude-hub-build-box lacks Issues: read and write. Add it at https://github.com/settings/apps/claude-hub-build-box/permissions
      Its installation on ada lacks Issues: read and write. Once the App has it, accept it at https://github.com/settings/installations/12345/permissions/update
```

and the Hub logs the same lines as warnings. Meanwhile what needs the permission fails, such as `gh issue comment` in a Session with `Resource not accessible by integration`.

**Why.** claude-hub came to need a permission the App was created without, or someone removed one. Or the App has it, but an installation hasn't accepted it yet: GitHub keeps an installation on its old permissions until someone who manages the account accepts the new ones.

**Fix.** Follow the links: add the permissions on the App's page and **Save changes**, then on each installation's page **Accept new permissions**. Click **Check again** on the banner, or run `claude-hub doctor`. The Hub also checks every hour on its own. See [Keep the permissions in step](/how-to/set-up-the-github-app/#keep-the-permissions-in-step).

If the banner never appears and doctor warns `Couldn't check its permissions`, the Hub's App settings are wrong, or GitHub can't be reached: the message says which.

## git and gh in a Session can't reach GitHub

**What you see.** In a Session, `git push` asks for a username or fails with `could not read Username`, or `gh` says you aren't logged in. The Runner logs:

```
WARN (#2): Session 9af3111eb506f54cea59b83c: its Sandbox has no GitHub token, so git and gh there can't reach GitHub: …
```

**Why.** git and gh in the Sandbox use the Sandbox token, a short-lived GitHub App token for the Session's Repo, which the Runner asks the Hub for. Without it they have nothing to authenticate with:

- The Hub has no GitHub App configured (it warned `The GitHub App is not configured` at startup). Sandboxes then never get a token, by design.
- The App isn't installed on the Repo (see above), or GitHub failed. The Runner asks again every five minutes and logs `its Sandbox has a GitHub token again` when it gets one.
- git wasn't in the image when the token arrived, so the credential helper wasn't set yet. It is set again at the next refresh, within 45 minutes; restarting the Session sets it at once.
- `gh` isn't installed. claude-hub doesn't install it.

**Fix.** [Set up the GitHub App](/how-to/set-up-the-github-app/) and install it on the Repo. Install git and gh in the Environment's [Bootstrap script](/how-to/set-up-an-environment/#write-the-bootstrap-script). Don't run `gh auth login` in the Sandbox: the token is already in place.

## The WIP ref could not be pushed

**What you see.** A Session's transcript notes:

```
The WIP ref could not be pushed: …
```

**Why.** The Runner pushes each Session's uncommitted work to `refs/claude-hub/wip/<session id>` after a Turn, and before sleep and archive. A failed push is noted and doesn't hold anything up, but the work isn't safe off the Runner until a push succeeds. Common reasons are the clone problems above, and these, from the Runner's checks of the Workspace:

| Message | Why |
|---|---|
| `host git refused the Workspace: its .git/objects/info/alternates points git at other object directories. Remove it so WIP pushes work.` | Something in the Sandbox, such as `git clone --reference` or `git worktree`, pointed the Workspace at objects elsewhere. The Runner won't read objects outside the Workspace. |
| `host git refused the Workspace: its .git… is a link or not a plain git file` | A part of `.git` was replaced by a link, which the Runner never follows. |
| `the Workspace has no HEAD commit` | The Workspace's branch has no commit to build on. |

**Fix.** Remove what the message names from the Workspace's `.git`, in the Session's terminal or by asking Claude, and the next push goes through. Until then, the work is still in the Workspace on the Runner.

## Claude pushed to the default branch

**What you see.** A Session pushed straight to `main`, or merged its own pull request.

**Why.** The Sandbox token has every permission the App's installation has, on the Session's Repo, and claude-hub doesn't restrict what git and gh do with it. That is by design ([ADR 0010](/reference/decisions/0010-the-sandbox-gets-a-github-token/)).

**Fix.** Protect the default branch with a GitHub ruleset: require a pull request with at least one approval, block force pushes, and keep the App off the bypass list. See [Protect the default branch](/how-to/set-up-the-github-app/#protect-the-default-branch).
