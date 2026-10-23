---
status: proposed
---

# A Member has a Hearth: one persistent Session that drives the others

A spike. Every Session works on a GitHub Repo, and lasts as long as the work on its branch. People want one more Session: a main session that is always theirs, remembers across days, and starts, prompts and follows their other Sessions for them, the way a personal agent does.

So each Member can light a **Hearth**:

- **One per Member, on their accounts.** A Hearth is a Session like any other, run on and driven by its Creator (ADR 0026), so it acts as them. A Member has at most one: a second is refused, and a Hearth can't be archived, only put to sleep. Its name is Hearth.
- **A Repo of its own: `~/<login>`.** No GitHub login can be `~`, so the name never clashes with a real Repo, and it is a Repo to everything else in kndl. It has an Environment, if it is given one, and runs on the Runner's default image until then. It has Installations: global ones, and Repo-scoped ones that list `~/<login>`, as granular as any Repo's (ADR 0020). It has a Sandbox, sleep and wake, and its history. Repo access (ADR 0003) gives it to the Member of that login alone, dev login included, and never asks GitHub. Nobody else sees it.
- **Its Workspace is made on its Runner, not cloned.** The Runner `git init`s it on `main`, with no remote, and seeds an `AGENTS.md` (a `CLAUDE.md` imports it) that says what a Hearth is, plus a `MEMORY.md` and `notes/` for what it should remember. It outlives every Sandbox (ADR 0006), and is the Hearth's memory. The Hub answers its git asks with a refusal: there is no Sandbox token.
- **The kndl MCP server.** The Hub serves an MCP server of its own at `/gateway/kndl`, which ADR 0022 left room for, and gives it to every Hearth's StartSession beside its Installations, as `kndl`. The Runner's relay and both Harnesses already reach Gateway servers, so the mod is unchanged. It answers only a Hearth's mod token. Its tools are `list_sessions`, `get_session`, `read_session` (the Turns, as `session_history` gives them), `list_repos`, `create_session` (with a first prompt), `send_prompt`, `stop_turn`, `answer_question` and `wait_for_session` (up to 25 s a call).
- **Each tool runs as a web client of the Creator.** The server opens a web connection of the Creator's for the call, sends the web UI's own commands through the Session relay and reads its answers. So the Hearth can see exactly the Sessions its Creator may, and drive only theirs, under every rule the web UI is under, with no second set of checks to drift. It reads itself, but doesn't prompt or stop itself.

## Considered options

- **One Hearth for the whole Hub.** It would run on someone's accounts and act for everyone, which ADR 0026 rules out.
- **Mod tools in both Harnesses**, as `session_history` is. Two implementations, a pi extension and a Claude Code plugin, against one MCP server the Gateway already carries to both.
- **A Session with no Repo.** The protocol, the database, Environments, Installations and Repo access all key on a Repo. A reserved Repo name gets all of them as they are.
- **A Hearth's Workspace kept apart from its Session,** so a new Hearth would find an old one's memory. Refusing to archive keeps the one Workspace instead, with nothing new on the Runner.

## Consequences

- **Prompts a Hearth sends show as its Creator's.** That is who they act as, but the transcript doesn't say an agent typed them. A sender of its own is for later.
- **A Hearth lives on one Runner,** since its Workspace is on that Runner's disk, as any Session's is. Losing the Runner's disk loses its memory, unless the Hearth pushes it somewhere.
- **The kndl server isn't an Installation.** It isn't listed on the MCP page or in the Session's MCP servers, isn't checked as a start begins, and can't be turned off.
- **Not yet:** a Hearth waking on its own (a schedule or a heartbeat), Sessions telling their Hearth when they finish or ask, and the kndl server for Sessions other than a Hearth.
