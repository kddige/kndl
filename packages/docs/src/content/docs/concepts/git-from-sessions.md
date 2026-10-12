---
title: Git from Sessions
description: How Claude commits, pushes and opens pull requests with plain git and gh, what the Sandbox's GitHub token can do, and how to protect your default branch.
sidebar:
  order: 4
---

Claude, and anything else in a Session's Sandbox, uses plain `git` and `gh` to commit, push and open pull requests ([ADR 0010](/contributing/decisions/0010-the-sandbox-gets-a-github-token/)). kndl adds no git tools of its own, and refuses no git command.

## What a Session can do

With the [GitHub App](/self-hosting/set-up-the-github-app/) set up, each Sandbox holds a **Sandbox token**: a GitHub token for the Session's Repo, with every permission the App's installation has. While the Session runs, anything in the Sandbox can push any branch of that Repo and merge its pull requests. The token reaches no other Repo.

:::caution[Protect your default branch]
The guardrail is a GitHub ruleset on each Repo's default branch: require a pull request with an approval, and block force pushes. The App can't get around it unless it's on the ruleset's bypass list. [Set one up](/self-hosting/set-up-the-github-app/#protect-the-default-branch) before you give the App a Repo you care about.
:::

The Hub mints a fresh token for each Session, and the Runner renews it every 45 minutes. It lives only in the Sandbox's memory, never on a disk, and the Hub masks it in everything a Session shows.

## In the Sandbox

- **`git push` and `git fetch` work** anywhere in the Sandbox, with no setup.
- **`gh` is signed in**, if the image has it. kndl doesn't install `gh`: [add it in the Bootstrap script](/guides/set-up-an-environment/#write-the-bootstrap-script).
- **Commits are by the Session's Creator**, with their GitHub name and noreply address, so GitHub links the commits to their account. With dev login, the address is `<login>@dev-login.invalid`, which GitHub links to no one.
- **Whose prompt it was doesn't change the author.** To credit someone else, ask Claude to add a `Co-authored-by` trailer.
- **Your Environment's git identity wins.** One set by the image, a script, `git config --global`, the Repo's `.git/config` or `GIT_AUTHOR_*` and `GIT_COMMITTER_*` Variables is kept.

Without the GitHub App, as with dev login, the Sandbox gets no token, so `git push` and `gh` have nothing to sign in with.

## On the Runner

The Runner runs git on its host for one thing: cloning the Repo into a new Session's Workspace. With the GitHub App, it clones with a separate read-only token. Without it, it uses the host's own git credentials.

The Runner never pushes. Work reaches GitHub only when git in the Sandbox pushes it. Until then it is in the Workspace on the Runner, which sleep, wake, archive and restore keep. Losing the Runner's machine loses what wasn't pushed ([ADR 0006](/contributing/decisions/0006-workspace-on-host-sandbox-disposable/)).

For how the token is minted, stored and given to `git` and `gh`, see [Inside kndl](/contributing/internals/#the-sandbox-token).
