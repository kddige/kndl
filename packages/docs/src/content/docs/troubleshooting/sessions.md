---
title: Sessions and Sandboxes
description: A Session won't start or wake, its Sandbox fails, an Environment's Test build fails, or the web UI refuses an action.
sidebar:
  order: 4
---

When a Session can't start, it doesn't retry on its own. It goes Asleep with the reason in its transcript, and its queued prompts wait. Fix the cause, then send a prompt or press **Wake now** to try again. See [the Session lifecycle](/explanation/session-lifecycle/#when-a-start-fails).

## A Session goes Asleep as soon as it starts

**What you see.** A new or woken Session shows **This Session is Asleep**, and its transcript says:

```
The Session is Asleep: Claude Code could not start on build-box: …
```

The Runner logs `Session <id> failed to start: …` with the same reason.

**Why.** The reason after the colon is the Runner's. The common ones:

| Reason starts with | What failed |
|---|---|
| `git clone exited with …` | The Runner couldn't clone the Repo. See [GitHub and git](/troubleshooting/github-and-git/#the-runner-cant-clone-the-repo). |
| `The bootstrap script exited with …` | The Environment's Build failed on this Runner. |
| `Installing Docker exited with …` | The Build couldn't install Docker, for an Environment with Docker turned on. |
| `The start script exited with …` | The Start script failed in the Sandbox. |
| `Reading the login shell's environment failed: …` | A shell profile, such as `~/.bashrc` in the image, failed when the Runner read the Login environment. |
| `The Hub refused the Environment's variables: …` | The Hub wouldn't hand the Runner the Environment's variables, for example because the Session was archived while it started. |
| `The Sandbox failed: …` | microsandbox couldn't start the microVM. See below. |

**Fix.** Open the Session and expand **Show log** on its **Starting…** banner the next time it starts, to see the full output. Fix the script or setting, in the Repo's **Environment**, then wake the Session. If a script fails only on one Runner, compare that machine's resources and network with the others.

## The Sandbox fails to start

**What you see.** The transcript says `The Session is Asleep: The Sandbox failed: …`, or the start fails with a microsandbox error.

**Why.** Sandboxes are microsandbox microVMs. They need a Mac with Apple Silicon, or Linux with KVM that the Runner's user can open. They also need the memory and CPUs the Environment asks for, within the Runner's `RUNNER_SANDBOX_MAX_MEMORY_MIB` and `RUNNER_SANDBOX_MAX_CPUS`.

**Fix.**

- On Linux, check `/dev/kvm` exists and the Runner's user can open it, for example by adding it to the `kvm` group, then log in again.
- Lower the Environment's **CPUs** or **Memory (MiB)** if the machine is short, or stop other Sandboxes. `bun x msb list`, from `packages/runner`, lists them.
- After a microsandbox crash or an upgrade, restart the Runner.

### `host path … is not a directory`

**What you see.** On a machine whose Runner has never run a Session, the first Session on a Repo with an Environment fails with:

```
The Session is Asleep: The Sandbox failed: host path /Users/you/.claude-hub/claude-code is not a directory
```

**Why.** The Runner mounted its cache of Claude Code for Sandboxes before it had made that folder. Fixed in [#71](https://github.com/kddige/claude-hub/pull/71).

**Fix.** Update your checkout. On an older one, make the folder named in the message and wake the Session:

```sh
mkdir -p /Users/you/.claude-hub/claude-code
```

## Claude's tools are refused

**What you see.** Claude's tool calls come back refused, with text such as:

```
Bash could not run in this Session's Sandbox (the Sandbox's tool server is not up: preparing the Sandbox failed: the Sandbox image has no bash), so it did not run at all. It never runs on the host.
```

and the Runner logs `Session <id>: tool server down: …` with the same reason.

**Why.** Claude's tools run in the Sandbox, through `claude mcp serve` there. If that tool server can't start, or stops, the mod refuses each tool call rather than running it on the host. The Runner restarts the server with backoff, and logs each new reason once. Common reasons:

- `the Sandbox image has no bash`: Claude Code's Bash tool needs bash. On an Alpine-like image the Runner installs it with `apk`, but other images without bash can't get it.
- `no Claude Code at …`: the Linux build of Claude Code isn't where the Runner mounted it, for example after its cache folder was deleted while the Sandbox ran.

**Fix.** For a missing bash, install it in the Environment's Bootstrap script, or pick a base image that has it, such as the default `buildpack-deps:bookworm`. For anything else, restart the Session (**Sleep now**, then **Wake now**) so the Runner sets the Sandbox up again, and check the Runner's log for the reason.

## The Test build fails

**What you see.** On the Repo's **Environment** page, the Test build ends with **Test build failed** and the end of the failing step's output, such as:

```
The bootstrap script exited with 127:
bash: line 3: pnpm: command not found
```

**Why.** A Test build runs the Bootstrap script on the image, then the Start script on a fresh clone of the Repo, exactly as a Session's Build would. Whatever fails there would fail every new Session, so the Environment can't be applied.

**Fix.** Read the full Test build log, fix the draft and run the Test build again. **Apply** turns on once a Test build of exactly that draft passes. Install tools in the Bootstrap script, which runs once per Build without the Repo; set up the clone, such as its dependencies or a database, in the Start script. See [Set up an Environment](/how-to/set-up-an-environment/).

## A Sensitive variable can't be saved

**What you see.** Saving the Environment, or a Shared variable, is refused with one of:

```
NPM_TOKEN is Sensitive, but the Hub has no HUB_SECRETS_KEY to encrypt it with. Run `bun run secrets-key`, put the key in packages/hub/.env.local, and restart the Hub.
```

```
The value of NPM_TOKEN is under 4 characters: too short to redact from output. Make it Plain, or use a longer value.
```

**Why.** The Hub encrypts Sensitive values with `HUB_SECRETS_KEY`, so it can't save one without it. A Sensitive value is also redacted from everything Sessions show, which a very short value would make useless.

**Fix.** For the first, run `bun run secrets-key`, add the line it prints to `packages/hub/.env.local` and restart the Hub. For the second, make the variable Plain, or use the real, longer value. See [Use variables and secrets](/how-to/use-variables-and-secrets/).

## A Session is missing, or `There is no such Session.`

**What you see.** A teammate's Session isn't in your list, a link to it says `There is no such Session.`, or a Session you were in disappears. Starting a Session says `You have no access to owner/name on GitHub, or the GitHub App isn't installed on it.`

**Why.** You see only the Sessions of Repos you have access to on GitHub, as a collaborator, and only Repos the GitHub App is installed on. Someone who loses access is taken out of the Repo's Sessions within twice `HUB_REPO_ACCESS_TTL_MS`. `Could not check your access on GitHub; try again.` means GitHub didn't answer the Hub. See [Who can do what](/explanation/security-model/#who-can-do-what).

**Fix.** Have the Repo's owner add you on GitHub, or install the App on it. Its Sessions show up within twice `HUB_REPO_ACCESS_TTL_MS` (5 minutes by default), with no reload. Without `GITHUB_APP_ID` on the Hub, GitHub sign-ins see no Sessions at all: [set up the GitHub App](/how-to/set-up-the-github-app/).

## Restart or Sleep now is refused

**What you see.** Pressing **Restart** or **Sleep now** shows a refusal, such as:

| Refusal | Why, and what to do |
|---|---|
| `The Session is still starting; restart it once it has started.` | Wait for the **Starting…** banner to go. |
| `A Turn is running: stop it first, then restart.` | Stop the Turn, or wait for it to end. |
| `Prompts are waiting in the Session's queue.` | **Sleep now** won't drop queued prompts. Cancel them, or let them run. |
| `The Session's Runner is offline.` | See [Its Sessions are Frozen](/troubleshooting/runners/#its-sessions-are-frozen). |
| `Only an Active Session can be put to sleep; this one is Asleep.` | It is already asleep. |

## The Environment changed banner stays

**What you see.** An Active Session shows **Environment changed**: `This Sandbox runs version 2 of owner/name's Environment; version 3 is the latest.`

**Why.** Someone applied a new version of the Repo's Environment. A running Sandbox keeps the version it started on, so nothing changes under a Turn.

**Fix.** Press **Restart** when it suits you. The Session goes to sleep and wakes on a fresh Sandbox from the latest version, with its Workspace and conversation as they are. What it installed in its own Sandbox, outside the Workspace, is gone; see [Environments](/explanation/environments/).
