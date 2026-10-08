---
title: Git from Sessions
description: How Claude commits, pushes and opens pull requests with plain git and gh, what the Sandbox's GitHub token can do, and what the Runner's own git does.
sidebar:
  order: 4
---

Claude, and anything else running in a Session's Sandbox, uses plain `git` and `gh` to commit, push, open pull requests and review ([ADR 0010](/reference/decisions/0010-the-sandbox-gets-a-github-token/)). There are no git tools in the mod, and nothing refuses `git commit` or `git push` in Bash.

## What a Session can do

With the [GitHub App](/how-to/set-up-the-github-app/) set up, each Sandbox holds a **Sandbox token**: a GitHub App installation token for the Session's Repo, with every permission the App's installation has. Anything in the Sandbox can push any branch of that Repo and merge its pull requests, while the Session runs. The token reaches no other Repo.

The guardrail is a GitHub ruleset on each Repo's default branch: require a pull request with at least one approval, and block force pushes. The App's token can't get around it unless the App is on the ruleset's bypass list. [Set one up](/how-to/set-up-the-github-app/#protect-the-default-branch) before giving the App a Repo you care about.

## The token

- **Minting.** Only the Hub holds the App's private key. A Runner asks it over its WebSocket for a token for a Session of its own, and the Hub mints a fresh installation token restricted to the Session's Repo. None is cached or shared.
- **When.** The Runner asks when the Sandbox starts or wakes, and every 45 minutes while it runs, since each token lasts an hour. If there is none (no GitHub App, or GitHub failing), the Session still starts: the Runner logs it once and asks again every five minutes.
- **Where it lives.** The Runner mounts a tmpfs at `/run/kndl` in the Sandbox (mode 0700) and writes the token to `/run/kndl/github-token` (mode 0600). It is only ever in the VM's memory: never in the VM's environment, which microsandbox stores in its database, and never on a disk.
- **Redaction.** The Hub masks the Session's current and previous token in the transcript, terminal frames and logs, like a Sensitive Variable.

## In the Sandbox

- **git.** A credential helper for `https://github.com` in the system gitconfig reads the token file, with username `x-access-token`, so `git push` and `git fetch` work anywhere in the Sandbox. It is set only if git is in the image when the token arrives, and again at each refresh.
- **gh.** `~/.config/gh/hosts.yml` links to a file beside the token that names it as `github.com`'s `oauth_token`, with `git_protocol: https`. `gh auth token` prints it; `gh auth login` isn't needed. kndl doesn't install gh: [install it in the Bootstrap script](/how-to/set-up-an-environment/#write-the-bootstrap-script).
- **Commits** are by the Session's Creator. When the Sandbox starts or wakes, the Runner sets `user.name` and `user.email` in the system gitconfig to the Creator's GitHub name and noreply address (`<id>+<login>@users.noreply.github.com`), so GitHub links the commits to their account. With dev login, the address is `<login>@dev-login.invalid`, which GitHub links to no one. There are no automatic `Co-authored-by` trailers.
- **Whose prompt it was doesn't change it.** A commit made in a Turn that Bob's prompt started is still by the Creator, so kndl never credits a guess. To credit Bob, ask Claude to add a `Co-authored-by` trailer.
- **The Environment's identity wins.** The Runner sets the identity only if the system gitconfig has none, so one the image or a script put there is kept. One set with `git config --global`, in the Repo's `.git/config`, or by `GIT_AUTHOR_*` and `GIT_COMMITTER_*` Variables wins anyway, since git reads those after the system gitconfig.

**Without the GitHub App**, as with dev login, the Sandbox gets no token: `git push` and `gh` there have nothing to authenticate with. The Runner still clones with its host's own git credentials.

## Host git

The Runner runs git on its own host for one thing: cloning the Repo into a new Session's Workspace. With the GitHub App it uses a separate token that can only read the Repo's contents, cached until five minutes before it expires and passed to the clone in its environment. It is never written to disk, a remote URL or `.git/config`, and never logged. Hooks and fsmonitor are off.

After the clone, the Runner adds `.claude/worktrees/` to the Workspace's `.git/info/exclude`, so a `git add -A` in the Sandbox leaves [subagents' worktrees](/how-to/work-with-subagents/) out.

The Runner never pushes. Work reaches GitHub only when git in the Sandbox pushes it. Until then it is in the Workspace on the Runner, which sleep, wake, archive and restore keep; losing the Runner's host loses what wasn't pushed ([ADR 0006](/reference/decisions/0006-workspace-on-host-sandbox-disposable/)).
