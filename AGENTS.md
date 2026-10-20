# kndl

Multiplayer agentic sessions. kndl (said "kindle", always lowercase; formerly claude-hub) runs coding-agent Sessions in Sandboxes, shared through a web UI. This branch is an experimental Pi Durable replacement: every Participant can drive a Session, on its Creator's accounts. When changing the agent, its launch, threads or driving rules, read `docs/design/durable-harness.md`; it describes the spike's deliberate departures from ADRs 0026, 0029 and 0030. See `README.md` for how to run it.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on kddige/kndl, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Releases

A Release is a dated tag on `main`, like `v2026.10.1`, cut by hand. See `docs/agents/releasing.md`.
