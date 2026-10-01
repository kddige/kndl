---
status: accepted
---

# Git remote operations run on the host; no GitHub token enters the Sandbox

The host gives the agent dedicated tools for committing, pushing, opening pull requests and reviewing. They run with a short-lived GitHub App token, against the Workspace on the host. Plain `git commit` and `git push` in the Sandbox's Bash are denied with a pointer to these tools.

Commits are authored by the GitHub App. Every Contributor who prompted since the previous commit is added as a `Co-authored-by` trailer, which the host tools guarantee.

The host also pushes the WIP ref automatically: after any Turn that changed the Workspace, before the Sandbox goes to sleep, and before the Session is archived.

## Considered options

- **A short-lived token injected into the Sandbox**: simpler, but exposes push access to anything running there for up to an hour, under an unrestricted network (ADR 0004).
- **The session user's OAuth token**: puts a full user token in reach of the agent.
