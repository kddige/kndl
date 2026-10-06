---
title: Environments
description: Why each Repo has one Environment, how versions, Builds and Test builds work, and how a Sandbox gets the same PATH a terminal would.
sidebar:
  order: 3
---

An Environment is the recipe a Repo's Sandboxes are built from: an image, a Bootstrap script, an optional Start script, Docker on or off, CPU and memory, dependency folders and Variables. Each Repo has exactly one ([ADR 0009](/reference/decisions/0009-environments/)). The Hub keeps it, Runners build it, and the web UI edits it. The steps are in [Set up an Environment](/how-to/set-up-an-environment/).

## Versions

Changes are a draft, applied as a whole. Each apply makes a new **Environment version**, recorded with who applied it and when, never with values.

A Session runs on one version. New Sessions start on the latest; a running one moves to a newer version when it next wakes, or at once with **Restart**. Either way its Sandbox is made again from the new version's Build, on the same Workspace and disks, and the conversation goes on.

## Builds

A **Build** is one version made ready on one Runner. The first time a Session needs a version its Runner hasn't built, the Runner builds it, showing the output in the Session's start log:

1. It boots a Sandbox from the Environment's image, without the Workspace.
2. It installs Docker, if the Environment turns it on.
3. It installs tmux and bash with the image's package manager, if the image lacks them: Claude Code runs in tmux, 3.2 or later, and its Bash tool needs bash.
4. It runs the Bootstrap script, with the Variables available at build.
5. It reads the Login environment (below).
6. It saves the Sandbox's disk as a microsandbox snapshot, and removes the Sandbox.

Sessions then boot from that snapshot in a fraction of a second, each adding only its own writes on top. A failed Build fails the Session's start, with the end of the script's output.

Builds are keyed by the version that last changed the Build, so a change to resources alone needs no new Build. Each Runner keeps the last three Builds of each Repo (`RUNNER_SANDBOX_KEEP_BUILDS`).

## Test builds

A draft that changes the Build can only be applied once a **Test build** of exactly that draft has passed. That covers the image, either script, Docker, the dependency folders, and any Variable available at build, its value included. You pick a Runner; it runs the Bootstrap script, then the Start script on a fresh clone of the Repo's default branch, streams the log to the web UI, and leaves nothing behind. The clone uses a read-only token for that Repo from the Hub's GitHub App, so the Runner host's own git credentials are never involved; if the App isn't installed on the Repo, the Test build fails before cloning.

The Hub records each result against a keyed digest of the draft's build inputs, so changing anything that affects the Build after a Test build needs another one. Changes that don't affect the Build, such as resources or rotating a Sensitive value not available at build, apply at once.

## Each Sandbox

A Session's Sandbox boots from its version's Build, with:

- the Workspace mounted at `/workspace`;
- one disk for all its dependency folders, bound at each boot to every folder the Environment's patterns match, and to where one would be beside each **Next to** file, so the first install already lands on the disk;
- one disk for package caches, at `/var/cache/claude-hub`, with `XDG_CACHE_HOME`, `BUN_INSTALL_CACHE_DIR` and `npm_config_cache` pointing into it;
- one disk for Docker's data, when Docker is on.

A new Sandbox then runs the Start script in `/workspace`. CPUs and memory are the Environment's, capped by the Runner's `RUNNER_SANDBOX_MAX_CPUS` and `RUNNER_SANDBOX_MAX_MEMORY_MIB`, with a note in the Session when it gives less.

## The Login environment

Installers such as mise, rustup, nvm and bun's put themselves on `PATH` through `~/.bashrc` or `~/.profile`, which nothing the Runner starts would read on its own. So each process the Runner starts in a Sandbox gets the environment a terminal on your own machine would, the way VS Code dev containers' `userEnvProbe` does it:

- After the Bootstrap script, the Build runs one interactive login shell, `bash -lic` (`sh -lc` on an image without bash), and keeps the environment it ends with in the Build, at `/var/lib/claude-hub/login-env.json`.
- Each new Sandbox probes again in `/workspace` once its Start script has run, so tools set up by the Repo's own files, such as a `mise.toml`, are picked up too.
- The Start script and Claude Code, and so every command Claude runs, get that environment, with the Environment's Variables over it.

The probe runs with no Variable in its environment, so it captures no value. A login shell that fails, or takes more than 60 seconds, fails the Build with the end of its output. Scripts without a `#!` line run with `bash -e` where the image has bash, and `sh -e` otherwise.

What a Session changes in its own Login environment, such as a line added to `~/.bashrc`, reaches its tools only when its Sandbox is next made from a Build, on a new version, not at an ordinary wake.

## Variables

A Variable is Plain, shown to everyone, or Sensitive: write-only once saved, encrypted on the Hub and redacted from everything it stores or shows. Shared variables are Hub-wide, and an Environment uses one through a Link, under a name chosen there.

The Hub never sends values with a Session's start: a Runner fetches them over its WebSocket, only for an Active Session of its own or a Test build it was sent, and keeps them in memory. It passes them in the environment of each process it starts in the Sandbox, and never sets them on the VM, whose settings microsandbox stores on disk. See [Use variables and secrets](/how-to/use-variables-and-secrets/) and the [security model](/explanation/security-model/#redaction).

## Why scripts and snapshots

- **Not a Dockerfile.** Runners would need an image builder. A script run against a chosen image gives most of the flexibility with what microsandbox already provides.
- **Not a bootstrap on every boot.** Installing Docker alone took about 33 seconds, against about a quarter of a second to boot from a Build. A second Session on the same Build costs only its own writes on disk.

## Who can change an Environment

An Environment follows its Repo's access, as the Repo's Sessions do. Anyone with access to the Repo on GitHub can open its Environment, run Test builds and apply versions, and everyone who can has the same rights: there are no roles. Someone who loses access loses the Environment screen too. Shared variables belong to no Repo, so anyone signed in can manage them. See the [security model](/explanation/security-model/#who-can-do-what).
