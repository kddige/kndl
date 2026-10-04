---
status: accepted
supersedes: 0005
---

# The Sandbox gets a short-lived GitHub token; plain git and gh do the rest

Each Session's Sandbox holds a GitHub App installation token for the Session's Repo, so Claude, and anything else running there, uses plain `git` and `gh` to commit, push, open pull requests and review. The host git tools of ADR 0005 (`git_commit`, `git_push`, `open_pr`, `review_pr`) and the refusal of `git commit` and `git push` in Bash are gone.

**What this allows.** Anything in the Sandbox can push any branch of the Repo, merge its pull requests, and do whatever else the App's installation permissions allow on that Repo, for as long as the Session runs. The guardrail is not claude-hub: it is a GitHub ruleset on the Repo's default branch (require a pull request, require reviews, block force pushes), which the App's token can't bypass unless the App is added to the ruleset's bypass list. Set one up before giving the App a Repo you care about.

The token is scoped to the Session's one Repo, so a Session can't reach the App's other Repos.

## How it works (#73)

- **Minting.** Only the Hub holds the App's private key. A Runner asks for a token over its WebSocket for one of its own Sessions, as host git did in #13. The Hub mints a fresh installation token restricted to the Session's Repo, with no permissions list, so it has every permission the installation has. It is not cached or shared between Sessions.
- **When.** The Runner asks when the Sandbox starts or wakes, and every 45 minutes while it runs, since each token lasts an hour. If it can't get one (there is no GitHub App, as in dev mode, or GitHub fails), the Session still starts. The Runner logs that once, and tries again every five minutes.
- **Where it lives.** The Runner mounts a tmpfs at `/run/claude-hub` in the Sandbox, mode 0700, and writes the token there with the backend's file write, mode 0600. So it is only in the VM's memory. It is never in the VM's settings (spike #46: microsandbox keeps a VM's environment in its database in plaintext), never on the VM's root filesystem (an image on the Runner's disk), and never on the Runner's disk.
- **git.** A credential helper in the system gitconfig answers for `https://github.com` from that file, so it works in `/workspace` and every other directory, with username `x-access-token`.
- **gh.** `~/.config/gh/hosts.yml` links to a file beside the token that names it as `github.com`'s `oauth_token`, with `git_protocol: https`. `GH_HOST` and `GH_PROMPT_DISABLED` aren't needed. claude-hub doesn't install gh: an Environment's bootstrap script should, for example from Debian's archive or GitHub's own apt repository.
- **Redaction.** The Hub minted the token, so it knows it. It masks the Session's current token and the one before it, which a process may still hold, from the transcript, terminal frames and logs, with the Repo's Sensitive values (#48).
- **Host git stays.** The Runner still clones and pushes the WIP ref on the host (after a Turn that changed files, before sleep, before archive), with its own token minted with `contents:write` only, passed to git per command. That works whether or not the Sandbox has a token, and never runs anything the Sandbox configured in `.git`.
- **Commits.** They're authored by whatever the Sandbox's git is configured with. The `Co-authored-by` trailers ADR 0005 guaranteed are gone with the tools.

## Considered options

- **Keep the host tools (ADR 0005).** No token in the Sandbox, but Claude needs a tool for every git or GitHub operation, the tools never matched what `git` and `gh` can do, and a pattern match on Bash commands is easy to get around anyway.
- **The token in the VM's environment.** Simplest, but microsandbox stores it in plaintext in its database on the Runner's disk (spike #46).
- **The token in a file on the root filesystem, or a mounted host file.** Either way it lands on the Runner's disk.
- **A Runner-side credential proxy.** Holds the token out of the Sandbox, but anything in the Sandbox can use the proxy for the same effect, so it only adds code.
- **The session user's OAuth token.** Puts a full user token, for every Repo the user can reach, in the Sandbox.
