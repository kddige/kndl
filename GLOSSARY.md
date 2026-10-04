# Claude Hub

A self-hosted platform where a team runs Claude Code sessions in sandboxes and works in them together from the web, "pair-prompting" the way two people pair-program at one screen.

## Infrastructure

**Hub**:
The central server that people sign in to. It knows every Session, Runner and Participant, and relays prompts and events between them.
_Avoid_: server, backend, dashboard

**Runner**:
A host machine connected to the Hub that runs Sessions on its own Runner login.
_Avoid_: worker, agent, node, host

**Runner login**:
The Claude account signed in on a Runner. Every Session on that Runner uses it, and it is shown visibly on each Session.
_Avoid_: owner's subscription, credentials

**Pairing code**:
A short-lived, single-use code that lets a machine become a Runner of the Hub, or take over an existing Runner's place after it is reinstalled. Using it gives the machine its own lasting credential, and the code is spent.
_Avoid_: join code, invite, enrollment token

**Sandbox**:
The isolated, disposable virtual machine in which all of a Session's file and command work happens. It is booted from a Build of its Repo's Environment.
_Avoid_: container, VM

**Preview**:
A port served from inside a Sandbox, made reachable in the browser for Participants.
_Avoid_: port forward, tunnel

## Sessions

**Session**:
One ongoing Claude Code conversation working on one Repo, on its own Work branch. A Session belongs to its Repo, not to a person.
_Avoid_: chat, thread, agent, job

**Creator**:
The person who started a Session. Recorded for history only; it grants no special rights.
_Avoid_: owner

**Participant**:
Anyone currently in a Session. All Participants have equal rights, including deleting the Session.
_Avoid_: collaborator, member, viewer, guest

**Contributor**:
A Participant who has sent at least one prompt in a Session.
_Avoid_: author, collaborator

**Turn**:
One prompt and Claude's full response to it, including every tool call it made.
_Avoid_: message, run, step

**Prompt queue**:
The ordered prompts from Participants waiting for the Session to finish its current Turn.
_Avoid_: backlog, inbox

**Workspace**:
The Session's checkout of its Repo, which outlives any single Sandbox.
_Avoid_: working directory, volume, clone

**Work branch**:
The git branch a Session commits to, created from the base branch chosen when the Session started.
_Avoid_: session branch, feature branch

**WIP ref**:
A hidden git ref on the Repo's remote holding a Session's uncommitted work, so the work survives losing the Runner.
_Avoid_: backup, stash, snapshot

**Sandbox token**:
A short-lived GitHub App installation token for one Session's Repo, kept in that Session's Sandbox so plain `git` and `gh` reach GitHub. It has every permission the App's installation has, so anything in the Sandbox can push and merge in that Repo; a GitHub ruleset on the default branch is the guardrail (ADR 0010).
_Avoid_: GitHub credentials, PAT, git tools

**Repo**:
A GitHub repository the platform is installed on. Access to a Repo decides who can see and join its Sessions.
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
A Session whose Sandbox was stopped after being idle; it wakes on the next prompt with its Workspace and service data intact.
_Avoid_: paused, suspended, stopped

**Frozen**:
A Session whose Runner is offline. It stays readable, and prompts sent to it wait in its queue until the Runner returns.
_Avoid_: orphaned, dead, offline

**Archived**:
A deleted Session that can still be restored for 30 days, after which it is purged.
_Avoid_: deleted, trashed

**Move**:
Transferring a Frozen Session to another Runner so it continues on that Runner's login. Not part of v1.
_Avoid_: adopt, migrate, transfer
