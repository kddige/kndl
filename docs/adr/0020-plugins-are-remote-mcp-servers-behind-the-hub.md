---
status: accepted
---

# Plugins are remote MCP servers whose credentials the Hub holds

A Plugin adds a remote MCP server, such as Linear's, to a Repo's Sessions. The Hub holds its credentials and adds them to each request in its Gateway, so no Plugin credential ever enters a Sandbox or reaches a Runner.

Everything else a plugin could be is left out of v1: skills, CLIs, stdio MCP servers, hooks into Claude Code. Those already work through an Environment: the Bootstrap script installs them and Variables give them their values. But a Variable is readable by anything in the Sandbox, the agent and any prompt injection included (ADR 0004, ADR 0009), and nothing an Environment can do keeps an OAuth token for a remote MCP server out of the Sandbox. That is the one thing only the Hub can do, so it is what Plugins do first.

## How it works

- **Plugin.** A remote MCP server's definition: its URL, a display name, and the auth it needs. A Plugin is either a package or Hub-only.
  - **A package** is a folder with a `package.json` and a kndl manifest, added from a git repo (in its root or a subfolder) or an upload, and later from npm. Its id is the `package.json` `name`, so it is unique wherever npm's names are. The manifest holds everything else. A package is pinned to the version it was added at, and upgrading it is an explicit action.
  - **A Hub-only Plugin** is made in the web UI with "Create new" and lives only on this Hub. Its id is in a namespace npm names can't use (`hub:<slug>`), so it never clashes with a package. Editing it is like an upgrade.
  - Any Member can add or create a Plugin. A Plugin does nothing until it has an Installation. One with Installations can't be deleted.
- **Installation.** A named, configured copy of one Plugin, such as "Linear Work" and "Linear Personal". It holds the Plugin's credentials:
  - **OAuth.** The Hub runs MCP's OAuth flow, with Dynamic Client Registration when the server offers it, else with a client id and secret entered on the Installation, against the Hub's callback URL. Whoever creates the Installation connects the account. The Hub keeps the tokens and alone refreshes them, since refresh tokens rotate.
  - **Header secrets,** such as an API key sent as `Authorization: Bearer …`, for servers without OAuth.
  - Both are stored encrypted and write-only, like Sensitive Variables, and are never sent to the web, a Runner or a Sandbox.
- **Shared accounts only.** An Installation's credentials are an account the whole Repo may act as: a bot or a team account. Every Session that uses it acts as that account, whoever prompts.
- **Global or Repo-scoped.** A global Installation is on in every Repo. A Repo-scoped one lists the Repos it is on in, and on those it takes the place of a global Installation of the same Plugin. A Repo can also turn a global Installation off. A Repo has at most one Installation of each Plugin: adding a second, such as "Linear Personal" beside "Linear Work", is refused, since the two would expose the same tools.
- **Who manages them.** Only the Owner creates or edits global Installations, since every Sandbox on the Hub can use them. Anyone with access to every Repo a Repo-scoped Installation lists can create it, edit it or add Repos to it. That list is the gate: a Member can't put "Linear Work" on a Repo of their own and use it from there.
- **The Gateway.** Claude Code gets one MCP server per Installation that is on for the Session's Repo, named so it can't clash with the Repo's own `.mcp.json`. Each points at the Runner's relay, authenticated by the per-Session token (ADR 0013). The relay passes the request to the Hub, which checks that the Installation is on for that Session's Repo, adds the credential and forwards it to the MCP server. MCP traffic is small next to model streams, so it goes through the Hub, unlike the credential proxy (ADR 0015).
- **Separate from the Environment.** Turning Installations on or off doesn't create an Environment version. Each Repo keeps its own log of Plugin changes: who did what, and when. A Session picks up its Repo's Installations, and Plugin upgrades, on its next wake or Restart, and shows which Installations it runs with. Participants can't change them for one Session.
- **Failing loudly.** If an Installation that is on for a Repo isn't connected, or its credential is missing or rejected, the Session doesn't start. It names the Installation and gives the way out: connect or fix it, or turn it off for this Repo.

## Considered options

- **Plugins in the Sandbox (skills, CLIs, stdio MCP servers, hooks), with values as env vars.** The full scope of the first draft. It duplicates what an Environment already does, and each value is as readable in the Sandbox as a Variable. Deferred, not rejected; see below.
- **Claude Code's plugin and marketplace formats as kndl's.** Everything Claude Code supports would come free. But a format of kndl's own lets kndl absorb Claude Code's breaking changes, and later serve other harnesses.
- **The Gateway on the Runner,** with the Hub handing out short-lived access tokens, as it hands out Claude credentials. Tokens would reach Runners' memory for no gain: MCP traffic is light.
- **Running a Plugin's stdio MCP server on the Hub,** so its secrets never leave the Hub either. That runs third-party code on the Hub's host, outside any Sandbox.
- **Per-person credentials,** such as each Creator's own Linear account, like the Claude credential (ADR 0015). Other Participants would then act as the Creator in Linear: a security and compliance problem.
- **Installations in the Environment version,** for its history and Test builds. But a credential or Plugin change is not a change to how Sandboxes are built, and a global Installation would create a version in every Repo.
- **Global meaning available rather than on.** Every Repo would enable each Installation by hand. Global as on everywhere, with Repo overrides, fits Hub-wide servers like documentation lookups.

## Deferred

These were designed, and left for later:

- **Plugins with files:** skills, CLIs on `PATH` and stdio MCP servers, delivered by the Hub and cached on Runners by content hash.
- **Values in the Sandbox:** Plugin values as env vars, refused when a name clashes with an Environment Variable or another Plugin's, as Links are.
- **Hooks:** executables in a Plugin that receive kndl's own events as JSON, which kndl translates to and from Claude Code's hooks.
- **Setup scripts:** a Plugin's install step, run as a cached layer over the Build on each Runner, without a Test build. A failure fails the Session's start, with its log and the way out.
- **Per-person credentials:** only through the Gateway, and only as the person who sent the Turn's prompt, never the Creator.
- **The kndl-market:** a catalogue of packages.

## Consequences

- **The Owner gains a right.** Until now the Owner had no right the other Members lacked (ADR 0019). Global Installations are theirs alone.
- **MCP traffic passes through the Hub,** so a Hub that is down or slow takes Plugins with it, and the Hub sees each tool call's content. It logs per Session and Installation, never the content.
- **A broken global Installation stops every Repo's Sessions** until it is fixed or each Repo turns it off. The error says so, and anyone with access to a Repo can turn it off there.
- **The account acts for everyone in the Session.** What Claude does in Linear shows as the Installation's account, not the person who prompted it.
- **Plugins don't cover the rest yet.** A skill, a CLI or a stdio MCP server still goes in the Environment's Bootstrap script, with its values as Variables.
