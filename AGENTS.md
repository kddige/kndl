# kndl

Multiplayer agentic sessions. kndl (said "kindle", always lowercase; formerly claude-hub) runs Claude Code sessions on any machine, and people watch and drive them together from a web UI. See `README.md` for the architecture and how to run it.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on kddige/kndl, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Releases

A Release is a dated tag on `main`, like `v2026.10.1`, cut by hand. See `docs/agents/releasing.md`.
