---
title: Environments
description: Why each Repo has one Environment, and how versions, Builds and Test builds make its Sandboxes.
sidebar:
  order: 3
---

An Environment is the recipe a Repo's Sandboxes are built from. Each Repo has exactly one ([ADR 0009](/contributing/decisions/0009-environments/)). To write one, see [Set up an Environment](/guides/set-up-an-environment/).

An Environment has:

- an **image**, `buildpack-deps:bookworm` by default;
- a **Bootstrap script**, run once per Build to install tools;
- a **Start script**, optional, run in each new Sandbox to install the Repo's dependencies;
- **Docker**, on or off;
- **CPUs and memory**;
- **dependency folders**, such as `node_modules`, kept on a fast disk;
- **Variables**, plain or Sensitive.

The Hub keeps the Environment, Runners build it, and anyone with access to the Repo edits it in the web UI.

## Versions

Changes are a draft until you apply them. Each apply makes an **Environment version**, recorded with who applied it and when.

A new Session starts on the latest version. A running Session moves to a newer version when it next wakes, or at once with **Restart**. Its Sandbox is made again on the same Workspace and disks, and the conversation carries on.

## Builds

A **Build** is one version made ready on one Runner. The first time a Session needs a version its Runner hasn't built, the Runner builds it, and the Session's start log shows it:

1. Boot a Sandbox from the image.
2. Install Docker, if it's on, and tmux and bash, if the image lacks them.
3. Run the Bootstrap script.
4. Save the disk as a snapshot.

Sessions boot from that snapshot in a fraction of a second, each adding only its own writes. A failed Build fails the Session's start, with the end of the script's output.

A change to CPUs or memory alone needs no new Build. Each Runner keeps the last three Builds of each Repo ([`RUNNER_SANDBOX_KEEP_BUILDS`](/reference/configuration/#runner)).

## Test builds

A draft that changes the Build, such as the image, a script or a Variable available at build, can only be applied after a **Test build** of that exact draft passes. A Test build:

1. runs on the Runner you pick;
2. runs the Bootstrap script, then the Start script on a fresh clone of the Repo's default branch;
3. streams its log to the web UI;
4. leaves nothing behind.

Any later change to the draft's build inputs needs another Test build. Changes that don't touch the Build, such as resources, apply at once.

## Each Sandbox

A Session's Sandbox boots from its version's Build with:

- the Workspace at `/workspace`;
- one disk for the dependency folders, bound over each match in the Workspace;
- one disk for package caches;
- one disk for Docker's data, when Docker is on.

A new Sandbox then runs the Start script in `/workspace`. CPUs and memory are capped by the Runner's [`RUNNER_SANDBOX_MAX_CPUS` and `RUNNER_SANDBOX_MAX_MEMORY_MIB`](/reference/configuration/#runner), and the Session notes when it gets less than it asked for.

## Tools on `PATH`

Installers such as mise, rustup, nvm and Bun's add themselves to `PATH` in `~/.bashrc` or `~/.profile`. So kndl runs a login shell once after the Bootstrap script, and again in each new Sandbox, and gives every process it starts the environment that shell ends with. The Start script, Claude Code and every command Claude runs see the same `PATH` a terminal would.

## Variables

A Variable is **Plain**, shown to everyone, or **Sensitive**: write-only once saved, encrypted on the Hub, and masked in everything kndl shows. A Shared variable is Hub-wide, and an Environment uses it through a Link.

A Runner fetches values only for its own Active Sessions and Test builds, and keeps them in memory. Each process in the Sandbox gets them in its environment. See [Use variables and secrets](/guides/use-variables-and-secrets/).

## Why scripts and snapshots

- **Not a Dockerfile.** Runners would need an image builder. A script on a chosen image gives most of the flexibility with what microsandbox already does.
- **Not a script on every boot.** Installing Docker alone takes about 33 seconds. Booting from a Build takes about a quarter of a second.

## Who can change an Environment

Anyone with access to the Repo on GitHub can open its Environment, run Test builds and apply versions. There are no roles. Anyone signed in can manage Shared variables. See [Who can do what](/concepts/security-model/#who-can-do-what).
