---
status: accepted
---

# Git remote operations run on the host; no GitHub token enters the Sandbox

The host gives the agent dedicated tools for committing, pushing, opening pull requests and reviewing. They run with a short-lived GitHub App token, against the Workspace on the host. Plain `git commit` and `git push` in the Sandbox's Bash are denied with a pointer to these tools.

Commits are authored by the GitHub App. Every Contributor who prompted since the previous commit is added as a `Co-authored-by` trailer, which the host tools guarantee.

The host also pushes the WIP ref automatically: after any Turn that changed the Workspace, before the Sandbox goes to sleep, and before the Session is archived.

## How it was built (#13)

- Only the Hub holds the App's private key. It mints the installation tokens and makes the pull request calls itself. A Runner gets a token over its WebSocket for one git command at a time, and passes it to git in that command's environment only.
- Without the GitHub App (dev mode), Runners clone, commit and push with their host's own git credentials and identity, and the pull request tools refuse with a message saying they need the App.
- Dev-login Participants have no GitHub account, so they get no `Co-authored-by` trailer. Neither do prompts typed into the tmux terminal. The guarantee holds for every Contributor who signed in with GitHub.
- The Workspace's `.git` is writable from the Sandbox, so host git never runs anything configured there. It runs with a git directory of the Runner's own, reading the Workspace's objects, index and files as data, with hooks off, and it pushes to a URL it builds itself rather than `remote.origin.url`.
- Refusing `git commit` and `git push` in Bash is guidance for the agent, not a security boundary. The boundary is that no token enters the Sandbox.

## Considered options

- **A short-lived token injected into the Sandbox**: simpler, but exposes push access to anything running there for up to an hour, under an unrestricted network (ADR 0004).
- **The session user's OAuth token**: puts a full user token in reach of the agent.
