---
status: accepted
---

# The Sandbox is the security boundary: no tool approvals, unrestricted network

Sessions never ask for tool approval. Everything inside the Sandbox is allowed, which lets Sessions run unattended and keeps shared sessions from stalling on whoever is present. Sandboxes also get unrestricted network access, including the LAN and the host, so agents can install packages and reach services without hitting walls.

## Consequences

- Code running in a Sandbox can reach the Hub and the Runner. Every Hub and Runner endpoint therefore requires authentication: GitHub sign-in for people, per-Runner tokens for Runners and the mod. Those tokens never enter a Sandbox.
- No GitHub or Claude credentials are placed in a Sandbox (see ADR 0005). Repo secrets are the deliberate exception.
- Tightening the network to "no LAN/host" or to an allowlist is a later, additive change.
