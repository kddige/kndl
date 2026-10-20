# kndl

kndl (said "kindle", written lowercase): multiplayer agentic sessions. A self-hosted platform where a team runs coding-agent sessions in sandboxes, on models from any Provider its members connect, and works in them together from the web.

> The definitions below describe the Pi Durable spike, an experimental branch. In it every Participant can drive a Session while the Creator's accounts still pay, and one Harness runs every Model. Accepted ADRs that this contradicts stay as written until the experiment is assessed; the design in `docs/design/durable-harness.md` lists them.

## Infrastructure

**Hub**:
The central server that people sign in to. It knows every Session, Runner and Participant, and relays prompts and events between them.
_Avoid_: server, backend, dashboard

**Runner**:
A host machine connected to the Hub that runs Sessions, each on its Creator's Connected providers.
_Avoid_: worker, agent, node, host

**Sysinfo**:
What a Runner reports of its host every 30 seconds: free and total disk of the volume holding its data, memory, CPU cores, load, OS, architecture and uptime. The Runners page warns on a Runner's row when the disk is under 10 GiB or a tenth free, and the row's Monitor shows the latest, and the free disk, available memory and 1-minute load of the last 7 days as charts. Display only: a low disk never stops a Session from starting.
_Avoid_: health check, heartbeat, metrics

**Claude credential**:
A person's own Claude subscription token, made with `claude setup-token`, stored write-only and encrypted on the Hub: their Connected provider for Anthropic. Claude's Models run on it in the Sessions they create, on any Runner; every Participant's prompts in those Sessions use the same credential.
_Avoid_: login, Runner login, OAuth token, Claude key, API key

**Pairing code**:
A short-lived, single-use code that lets a machine become a Runner of the Hub, or take over an existing Runner's place after it is reinstalled. Using it gives the machine its own lasting credential, and the code is spent.
_Avoid_: join code, invite, enrollment token

**Sandbox**:
The isolated, disposable virtual machine in which all of a Session's file and command work happens. It is booted from a Build of its Repo's Environment.
_Avoid_: container, VM

**Open port**:
A TCP port listening inside a Session's Sandbox, which its Runner notices while the Session is awake and reports with the process holding it.
_Avoid_: service, endpoint

**Forward**:
A `kndl forward` connection from someone's machine to a Session, which makes each of its Open ports reachable on that machine's `localhost`, 1:1, through the Hub. A connected Forward counts as presence in the Session.
_Avoid_: tunnel, port mapping, proxy

**Preview**:
An Open port made reachable in the browser on its own domain, for Participants.
_Avoid_: port forward, tunnel

**CLI token**:
The long-lived credential the `kndl` CLI signs in to a Hub with, made by `kndl login` and listed and revocable on its owner's Account page.
_Avoid_: API key, access token, session cookie

**Release**:
A version of kndl, a dated tag on `main` such as `2026.10.1`, with notes on what changed since the last one. A fix is always a new Release.
_Avoid_: version (alone), build, tag

**Channel**:
What an install of kndl follows: `stable`, the latest Release, or `dev`, the head of `main`. A Hub's Runners run what the Hub runs, whatever Channel each machine was installed with.
_Avoid_: track, branch, ring

## Models

**Harness**:
The program that runs a Session's agent in its Sandbox. The spike has one Harness, the durable agent, for every Model.
_Avoid_: driver, engine, agent, backend

**Durable agent**:
The headless program that runs every Session's agent in its Sandbox, built on Pi Durable. It keeps its conversation in storage on the Session's disk, so a Turn cut off by a restart goes on where it stopped. It runs the main conversation, Threads and Subagents, and is the one Harness.
_Avoid_: pi agent, bot, worker

**Claude bridge**:
How the durable agent runs Claude's Models: it runs Claude Code in the Sandbox as a model only, with none of Claude Code's own tools, on the Creator's Claude credential. It is the one place Claude Code still runs.
_Avoid_: Claude Code Harness

**Handoff**:
The shortened history given to a legacy Session as it moves to the durable agent: who prompted what, the tools the agent called and what it answered. Reasoning, full tool results and Attachments do not carry over; the agent can read further back in the Session's history.
_Avoid_: summary, transcript, migration, context transfer

**Provider**:
A company whose Models a Session can run on, such as Anthropic or OpenAI.
_Avoid_: vendor, platform, backend

**Connected provider**:
A Member's own account at one Provider, connected on the Hub by signing in with a subscription or pasting an API key, and held write-only and encrypted there; for Anthropic, their Claude credential. Only the Sessions that Member creates use it.
_Avoid_: integration, linked account, API key (alone), Installation

**Model**:
One Provider's model, among those of its Creator's Connected providers, that a Session's Turns run on. Any Participant can switch it between Turns, to any of the Creator's Models, with the conversation carrying over.
_Avoid_: engine, LLM, backend

**Thinking level**:
How hard a Session's Model thinks before it answers, from Off to Max, set with its Model. With none set, the Model uses its usual level.
_Avoid_: effort, reasoning effort

## Who gets in

**Member**:
A person the Hub let in: its Owner, or someone who used an Invite. Only a Member can sign in, to the web UI or the CLI. Being one grants no Repo access: that is GitHub's to decide. A Member is a Participant only while in a Session.
_Avoid_: user, account, Participant (for someone not in a Session)

**Owner**:
The one Member who decides who gets in: they make Invites, and list and remove Members. They alone manage global Installations, see whether a newer Release or commit is out for the Hub, and update the Hub, its Channel and its Runners (ADR 0028). The Owner can't be removed, and has no other rights the other Members lack.
_Avoid_: admin, operator, Creator

**Setup link**:
A one-time link, made on the Hub's machine, that makes whoever signs in with it the Owner. Only a Hub without an Owner makes one, and a new one replaces the last.
_Avoid_: bootstrap token, claim link

**Invite**:
A link the Owner makes that admits one person as a Member, once, within 7 days: anyone with the link, or only the GitHub login it names. Using it, revoking it or its expiring ends it.
_Avoid_: invitation code, Pairing code, join link

## Sessions

**Session**:
One ongoing body of agent work on one Repo and Work branch, with a main conversation, optional Threads and Subagents, driven together by its Participants on its Creator's Connected providers. Who can see it is its Repo's to decide.
_Avoid_: chat, agent, job

**Subagent**:
An agent that a Session's agent starts to work alongside it, on any of the Creator's Models. It runs in the Session's Sandbox, is shown under the Session, and any Participant can message or stop it.
_Avoid_: Child Session, sub-session, worker

**Session name**:
A Session's editable display name. It defaults to the Session's Work branch, or, for a Session on its base branch itself, to that branch and the Session's short id.
_Avoid_: title, label

**Creator**:
The person who started a Session, whose Connected providers it runs on. Every Participant can drive it on those accounts. The git identity in its Sandbox is theirs.
_Avoid_: owner

**Participant**:
Anyone currently in a Session, the Creator included. Every Participant can drive the Session, read it live or Archived, and open its Previews and Forwards. Each is a Member of the Hub.
_Avoid_: collaborator, viewer, guest

**Turn**:
One prompt and the agent's full response to it, including every tool call it made.
_Avoid_: message, run, step

**Resumed**:
The sender of a Turn the durable agent continued after it restarted. The Hub had ended the first Turn as aborted when the agent stopped, so the run that was going goes on as a new Turn, marked as resumed.
_Avoid_: retried, replayed, restarted

**Compact**:
To summarize a conversation's older messages, so it keeps fitting its Model's context; the summary is a compaction. The agent does it on its own near the limit, and any Participant can ask for one, optionally saying what to keep. A divider in the transcript marks it, and the history still shows the messages it covers.
_Avoid_: truncate, trim, clear

**Thread**:
A conversation forked from the main conversation's Turn (the code and the design call the main conversation the main loop), with the context up to that answer, that runs beside the main conversation and other Threads. Participants can prompt it and choose its own Model from the Creator's Models; a prompt posted into a busy Thread steers it, outside the Prompt queue. A Thread keeps the Model it started on.
_Avoid_: Subagent, Child Session, branch

**Plan**:
The agent's live checklist for a conversation, kept with its `update_plan` tool, with steps pending, in progress or done. Everyone in the Session sees it live. A Thread starts with the Plan at its fork and then keeps its own.
_Avoid_: task list, roadmap

**Prompt queue**:
The ordered prompts from Participants waiting for the Session's main conversation to finish its current Turn. A queued prompt waits unless a Participant steers it.
_Avoid_: backlog, inbox

**Attachment**:
A file a Participant attaches in the web UI, pasted, dropped or picked, to a prompt, a message to a subagent or a reply to an Open question: an image, such as a screenshot, or a PDF. The Hub keeps it for the life of its Session once it is sent, and deletes one nobody sent a day after upload; the prompt names it with a marker, `[Image #1: shot.png (attachment <id>)]` or `[PDF #1: spec.pdf (attachment <id>)]`, and the agent opens it with its attachment tool (ADR 0024): an image as itself, a PDF as a file at a path.
_Avoid_: upload, paste, file (for what the prompt carries)

**Steer**:
To take a queued prompt out of the Prompt queue and feed it into the running Turn, which reads it at its next step. The Turn stays the one its first prompt started. A prompt posted into a busy Thread steers it directly, with no queue.
_Avoid_: interrupt, inject, push

**Open question**:
A question the agent asked in a Turn, with its question tool, that no one has answered yet. Any Participant answers it from the web UI; the first answer is the one the agent reads. Only the main conversation's agent asks: Threads and Subagents don't. While it is open, the Session is waiting on an answer and doesn't go to sleep. An agent may ask it _async_: it works on meanwhile, the question stays open after the Turn ends, and the answer reaches it as a message, into the Turn if it still runs, else as a Turn of its own.
_Avoid_: prompt, dialog, permission request

**Workspace**:
The Session's checkout of its Repo, which outlives any single Sandbox.
_Avoid_: working directory, volume, clone

**Work branch**:
The git branch a Session commits to: a new `claude/<id>` branch made from the base branch, a new branch the person named, or the base branch itself, as chosen when the Session started (ADR 0023).
_Avoid_: session branch, feature branch

**Base branch**:
The branch a Session's Repo is cloned on when it starts, chosen in New Session. The Work branch is made from it, unless the Work branch is the base branch.
_Avoid_: source branch, parent branch

**Sandbox token**:
A short-lived GitHub App installation token for one Session's Repo, kept in that Session's Sandbox so plain `git` and `gh` reach GitHub. It has every permission the App's installation has, so anything in the Sandbox can push and merge in that Repo; a GitHub ruleset on the default branch is the guardrail (ADR 0010).
_Avoid_: GitHub credentials, PAT, git tools

**Repo**:
A GitHub repository that Sessions work on. Access to a Repo decides who can see and join its Sessions. Its `owner/name` is case-insensitive, as on GitHub.
_Avoid_: project, codebase

## Environments

**Environment**:
The recipe a Repo's Sandboxes are built from: an image, a Bootstrap script, an optional Start script, Docker on or off, CPU and memory, dependency folders and Variables. Each Repo has exactly one.
_Avoid_: image, template, config, devcontainer

**Environment version**:
One applied state of an Environment, recording who applied it and when. A Session runs on one version and moves to a newer one when it wakes or restarts.
_Avoid_: revision, release

**Build**:
An Environment version made ready on one Runner: the image after the Bootstrap script ran, which Sandboxes boot from. Each Runner builds a version the first time it needs it.
_Avoid_: image, snapshot, template

**Test build**:
A Build of an unapplied Environment change on a chosen Runner, which also runs the Start script against a fresh clone. A change that affects the Build can only be applied once its Test build passes.
_Avoid_: dry run, preview build

**Bootstrap script**:
The Environment's script that installs tools into a Build, with no Workspace present.
_Avoid_: setup script, install script, Dockerfile

**Start script**:
The Environment's optional script that runs in each new Sandbox with the Workspace present.
_Avoid_: init script, entrypoint, setup script

**Login environment**:
The environment a login shell in a Sandbox ends with, after its profile and `~/.bashrc` ran. The Build records it, and every process the Runner starts in the Sandbox gets it, under the Variables.
_Avoid_: shell env, user env, dotfiles

**Variable**:
A named value an Environment passes to the processes in its Sandboxes. It is Plain, or Sensitive: write-only once saved, encrypted on the Hub and redacted from everything it stores or shows.
_Avoid_: Repo secret, secret, env var, credential

**Shared variable**:
A Hub-wide Variable that Environments can use through a Link.
_Avoid_: global secret, org secret

**Link**:
A Shared variable placed into one Environment under a name chosen there.
_Avoid_: reference, import, binding

## MCP servers

**MCP server**:
A remote server, speaking MCP, that the Hub can add to Sessions: a package, identified by its package name, or one made on this Hub alone. They are managed on the MCP page. kndl's own code in each Sandbox, the mod, is not an MCP server. The agent finds a server's tools as `mcp__<server>__<tool>`, with `tool_search`.
_Avoid_: plugin, integration, extension, connector, mod

**MCP server icon**:
The small picture beside an MCP server on the MCP page. The Hub finds it, from the package's manifest or the favicon of the MCP server's URL, keeps it and serves it; browsers never fetch it from the third party. An MCP server with none shows a letter.
_Avoid_: logo, favicon (a favicon is one place it may come from)

**Upgrade**:
Moving a packaged MCP server to what its source holds now, once someone has seen what that changes. A packaged MCP server is pinned to its version, and changes only by an Upgrade.
_Avoid_: update, sync, refresh

**Installation**:
A named, configured copy of one MCP server, holding the credentials of the account it acts as: header secret values, or, for an OAuth MCP server, the tokens of the account someone connected it to and the client it connects with, which only the Hub holds. It is global, on in every Repo, or on in the Repos it lists, and a Repo has at most one Installation of each MCP server on: one that lists the Repo takes a global one's place there, and a Repo can turn a global one off.
_Avoid_: connection, instance, config

**Header secret**:
A credential an MCP server declares it takes in an HTTP header, such as `Authorization: Bearer {value}`. Each Installation holds its own value, write-only and encrypted on the Hub, which the Gateway puts in the header.
_Avoid_: API key setting, token field, header variable

**Gateway**:
The Hub's path from a Session to an Installation's MCP server, or to a Connected provider's Models, which adds the credentials on the way, so they never enter a Sandbox. A Claude credential is the exception: Claude Code holds it itself.
_Avoid_: MCP proxy, credential proxy, mod relay, model gateway, LLM proxy

## Session lifecycle

**Active**:
A Session whose Sandbox is running.

**Asleep**:
A Session whose Sandbox was stopped after being idle; it wakes on the next prompt, or a Forward, with its Workspace and service data intact. A Session is idle when it has no running main or thread Turn or Running agent, nobody present, no connected Forward, and Keep awake off. Background commands and Open ports don't keep it awake.
_Avoid_: paused, suspended, stopped

**Keep awake**:
A Session's toggle that stops it going Asleep when idle, until someone turns it off or puts the Session to sleep. Anyone with access to its Repo can set it, and it shows who did.
_Avoid_: pin, pinned, always on

**Frozen**:
A Session whose Runner is offline. It stays readable, and prompts sent to it wait in its queue until the Runner returns.
_Avoid_: orphaned, dead, offline

**Archived**:
A deleted Session that can still be restored for 30 days, after which it is purged.
_Avoid_: deleted, trashed

**Purge**:
To delete an Archived Session for good: its history from the Hub, and its Workspace, with any work it never pushed, from its Runner. It happens when its 30 days are up, or sooner by the hand of anyone who can see it, to free its Runner's disk (ADR 0027). A purged Session can't be restored.
_Avoid_: hard delete, destroy, empty trash

**Move**:
Transferring a Frozen Session, with its Sandbox and Workspace, to another Runner so it continues there. Not part of v1.
_Avoid_: adopt, migrate, transfer
