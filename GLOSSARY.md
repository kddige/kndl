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

**Sandbox**:
The isolated, disposable virtual machine in which all of a Session's file and command work happens.
_Avoid_: container, VM, environment

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

**Repo**:
A GitHub repository the platform is installed on. Access to a Repo decides who can see and join its Sessions.
_Avoid_: project, codebase

**Repo secret**:
A named secret value scoped to a Repo and given to every Session of that Repo.
_Avoid_: env var, credential, key

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
