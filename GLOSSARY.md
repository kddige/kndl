# kndl

kndl (said "kindle", written lowercase): multiplayer agentic sessions. A self-hosted platform where a team runs Claude Code sessions in sandboxes and works in them together from the web, "pair-prompting" the way two people pair-program at one screen.

## Infrastructure

**Hub**:
The central server that people sign in to. It knows every Session, Runner and Participant, and relays prompts and events between them.
_Avoid_: server, backend, dashboard

**Runner**:
A host machine connected to the Hub that runs Sessions, each on its Creator's Claude credential or else on the Runner's own, if it has one.
_Avoid_: worker, agent, node, host

**Claude credential**:
A person's own Claude subscription token or Anthropic API key, stored write-only and encrypted on the Hub. The Sessions they create, and their subagents, run on it on any Runner, and each Session shows whose account it runs on. A Runner may have one of its own too, kept on its host: a Session whose Creator has none runs on that, and the Runners page shows it by its kind and last four characters, or by the account of Claude Code's login it uses. A Runner needs neither Claude Code nor a credential of its own.
_Avoid_: login, Runner login, OAuth token, Claude key

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

## Who gets in

**Member**:
A person the Hub let in: its Owner, someone who used an Invite, or someone who signed in before the Hub was invite-only. Only a Member can sign in, to the web UI or the CLI. Being one grants no Repo access: that is still GitHub's to decide. Every Participant is a Member, but a Member is a Participant only while in a Session.
_Avoid_: user, account, Participant (for someone not in a Session)

**Owner**:
The one Member who decides who gets in: they make Invites, and list and remove Members. A Hub has one Owner, who can't be removed; they have no other rights the other Members lack.
_Avoid_: admin, operator, Creator

**Setup link**:
A one-time link, made on the Hub's machine, that a Hub without an Owner lets in with GitHub: whoever signs in with it becomes the Owner. A new one replaces the last, and none is made once the Hub has an Owner.
_Avoid_: bootstrap token, claim link

**Invite**:
A link the Owner makes that admits one person as a Member, once, within 7 days: anyone with the link, or only the GitHub login it names. Using it, revoking it or its expiring ends it.
_Avoid_: invitation code, Pairing code, join link

## Sessions

**Session**:
One ongoing Claude Code conversation working on one Repo, on its own Work branch. A Session belongs to its Repo, not to a person.
_Avoid_: chat, thread, agent, job

**Subagent**:
A Claude Code agent that a Session's Claude starts with the Agent tool. It runs in the Session's Sandbox, is shown under the Session, and any Participant can message or stop it.
_Avoid_: Child Session, sub-session, worker

**Session name**:
A Session's editable display name. It defaults to the Session's Work branch.
_Avoid_: title, label

**Creator**:
The person who started a Session. It grants no special rights in the Session, but the Repo access check and the git identity in its Sandbox are theirs.
_Avoid_: owner

**Participant**:
Anyone currently in a Session. All Participants have equal rights, including deleting the Session. Each is a Member of the Hub; "Member" names the person whether or not they are in a Session.
_Avoid_: collaborator, viewer, guest

**Contributor**:
A Participant who has sent at least one prompt in a Session.
_Avoid_: author, collaborator

**Turn**:
One prompt and Claude's full response to it, including every tool call it made.
_Avoid_: message, run, step

**Prompt queue**:
The ordered prompts from Participants waiting for the Session to finish its current Turn. A queued prompt waits unless someone steers it.
_Avoid_: backlog, inbox

**Steer**:
To take a queued prompt out of the Prompt queue and feed it into the running Turn, which reads it at its next step, as Claude Code does with a prompt typed while it works. The Turn stays the one its first prompt started.
_Avoid_: interrupt, inject, push

**Open question**:
A question Claude asked in a Turn, with AskUserQuestion, that no one has answered yet. Any Participant may answer it, from the web UI or at the terminal; the first answer is the one Claude reads. While it is open, the Session is waiting on its Participants and doesn't go to sleep.
_Avoid_: prompt, dialog, permission request

**Workspace**:
The Session's checkout of its Repo, which outlives any single Sandbox.
_Avoid_: working directory, volume, clone

**Work branch**:
The git branch a Session commits to, created from the base branch chosen when the Session started.
_Avoid_: session branch, feature branch

**Sandbox token**:
A short-lived GitHub App installation token for one Session's Repo, kept in that Session's Sandbox so plain `git` and `gh` reach GitHub. It has every permission the App's installation has, so anything in the Sandbox can push and merge in that Repo; a GitHub ruleset on the default branch is the guardrail (ADR 0010).
_Avoid_: GitHub credentials, PAT, git tools

**Repo**:
A GitHub repository the platform is installed on. Access to a Repo decides who can see and join its Sessions. Its `owner/name` is one Repo however it is spelled, as on GitHub: the Hub keeps the spelling GitHub gives it, and finds a Repo's Sessions, Environment and access by any spelling.
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

## Session lifecycle

**Active**:
A Session whose Sandbox is running.

**Asleep**:
A Session whose Sandbox was stopped after being idle; it wakes on the next prompt, or a Forward, with its Workspace and service data intact. A Session is idle when it has no Turn or Running agent, nobody present, no connected Forward, and Keep awake off. Background commands and Open ports don't keep it awake.
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

**Move**:
Transferring a Frozen Session, with its Sandbox and Workspace, to another Runner so it continues there. Not part of v1.
_Avoid_: adopt, migrate, transfer
