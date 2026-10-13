---
status: accepted
---

# The Sandbox is the security boundary: no tool approvals, unrestricted network

Sessions never ask for tool approval. Everything inside the Sandbox is allowed, which lets Sessions run unattended and keeps shared sessions from stalling on whoever is present. Sandboxes also get unrestricted network access, including the LAN and the host, so agents can install packages and reach services without hitting walls.

## Consequences

- Code running in a Sandbox can reach the Hub and the Runner. Every Hub and Runner endpoint therefore requires authentication: GitHub sign-in for people, per-Runner tokens for Runners, and per-Session tokens for the mod (amended in #7: each Session's mod gets its own token, scoped to that Session). Those tokens never enter a Sandbox.
- No GitHub or Claude credentials are placed in a Sandbox (see ADR 0005). Environment Variables are the deliberate exception (amended in #46, replacing Repo secrets): the Runner passes them to the processes it starts in the Sandbox, so anything running there can read them (ADR 0009). So is a short-lived GitHub App token for the Session's Repo (amended in #73, ADR 0010), for plain `git` and `gh`: anything running in the Sandbox can push to and merge in that Repo, and a GitHub ruleset on its default branch is the guardrail.
- Tightening the network to "no LAN/host" or to an allowlist is a later, additive change.

## Amendment: one per-Session token in the Sandbox (ADR 0013)

With Claude Code in the Sandbox, the Sandbox holds one secret of claude-hub's own: a random per-Session token for the Runner's credential proxy and mod relay. It reaches only those two, for that Session, while the Session is awake. The Runner revokes it on sleep and archive. The Claude credential and the mod token stay on the Runner, behind it.

## Amendment: the Creator's setup token is in the Sandbox (ADR 0026)

The Claude credential is now the second deliberate exception, after Variables and the Sandbox token. A Session's Claude Code has its Creator's setup token in its own environment and talks to Anthropic directly, so anything running in the Sandbox can read that token. Only the Creator drives a Session, so the only prompts that can ask Claude for it are the Creator's own. The per-Session token above now reaches only the mod relay.
