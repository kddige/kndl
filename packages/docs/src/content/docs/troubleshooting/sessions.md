---
title: Sessions and Sandboxes
description: A Session won't start or wake, its Sandbox fails, an Environment won't open or its Test build fails, or the web UI refuses an action.
sidebar:
  order: 5
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
| `Installing tmux and bash exited with …` | The image lacks tmux or bash, which Claude Code needs in the Sandbox, and has no apk, apt-get, dnf or yum to install them with, or has a tmux older than 3.2. Install them in the Bootstrap script, or pick an image that has them, such as the default `buildpack-deps:bookworm`. |
| `The start script exited with …` | The Start script failed in the Sandbox. |
| `Reading the login shell's environment failed: …` | A shell profile, such as `~/.bashrc` in the image, failed when the Runner read the Login environment. |
| `The Hub refused the Environment's variables: …` | The Hub wouldn't hand the Runner the Environment's variables, for example because the Session was archived while it started. |
| `The Sandbox failed: …` | microsandbox couldn't start the microVM. See below. |

**Fix.** Open the Session and expand **Show log** on its **Starting…** banner the next time it starts, to see the full output. Fix the script or setting, in the Repo's **Environment**, then wake the Session. If a script fails only on one Runner, compare that machine's resources and network with the others.

## Claude Code exited with code N

**What you see.** A Session that was running, or had just started, shows **This Session is Asleep** with:

```
Claude Code exited with code 1. Its Sandbox is stopped. …
```

and, under it, **Show Claude Code's last output**.

**Why.** Claude Code ended on its own rather than being put to sleep: it crashed, refused to start, or was quit from its terminal. Exit code 0 means it quit normally, as after `/exit`. What it printed before it exited says why.

**Fix.** Press **Show Claude Code's last output** to read the last lines its terminal showed (up to 40), as plain text. Sensitive values of the Repo's Environment are redacted there, as in the terminal. The Runner's log only notes the exit, never the output itself, since only the Hub can redact it:

```
WARN (#2): Session <id> exited with 1; its last 3 line(s) of output are on the Session's page
```

Fix what the output names, then send a prompt or press **Wake now**: the output stays under the banner until the Session wakes. Some causes:

- A sign-in or usage message: the Claude credential the Session runs on needs attention. That is its Creator's, which they [replace on their Account page](/how-to/add-your-claude-credential/), or else [the Runner's own](/reference/configuration/#the-runners-claude-credential).

A Runner from before this was added sends no output: the banner has no **Show Claude Code's last output**, and its log only says `Session <id> exited with 1`. [Update it](/how-to/add-a-runner/).

### Waking it after Claude Code never got going

A Session whose Claude Code exited before it wrote its conversation has nothing to `--resume`. The Runner checks for the conversation's transcript in Claude Code's state in the Sandbox, `/var/lib/claude-hub/claude/projects`, and, with none, starts a new conversation with the same id instead, logging:

```
INFO (#2): Session <id>: Claude Code has no transcript of conversation <conversation id>, so it starts a new one with that id instead of resuming it
```

The Session's Workspace is as it was; only the conversation starts over. A Runner from before this fix keeps trying `--resume` and the Session can't wake: update it.

## A Session can't start: variables need values

**What you see.** A Session shows **This Session can't start**, or a new one is refused, with:

```
kddige/claude-hub's Sessions can't start: NPM_TOKEN and GH_TOKEN (the shared variable GITHUB_TOKEN) need values. Enter them on the Repo's Environment screen and the Shared variables screen.
```

A Test build of the Environment is refused with `NPM_TOKEN needs a value.`, and the variables show **needs a value** on the Environment and **Shared variables** screens.

**Why.** The Hub's secrets key was lost and its Sensitive values were [reset](/how-to/use-variables-and-secrets/#if-the-key-is-lost). The variables were kept without their values, and a Sandbox started without them would fail in confusing ways, so the Repo's Sessions wait for them.

**Fix.** Press **Enter values**, type each value on the Repo's Environment and apply, and press **Enter value** on each Shared variable named. Then wake the Session: its queued prompts are still there.

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

## The Test build fails

**What you see.** On the Repo's **Environment** page, the Test build ends with **Test build failed** and the end of the failing step's output, such as:

```
The bootstrap script exited with 127:
bash: line 3: pnpm: command not found
```

**Why.** A Test build runs the Bootstrap script on the image, then the Start script on a fresh clone of the Repo, exactly as a Session's Build would. Whatever fails there would fail every new Session, so the Environment can't be applied.

A Test build can also fail before it starts, or before it clones, with one of:

```
The GitHub App isn't installed on owner/name, so a Test build can't clone it: install the App on the Repo, then try again.
```

```
build-box runs an older claude-hub, which would clone the Repo with its machine's own git credentials: update it to run Test builds on it.
```

```
could not get access to clone the Repo: The GitHub App is not installed on owner/name, or can't see it: …
```

The first is for a Dev login, which has access to every Repo but still needs the App to clone one. The second means the Runner predates Test builds cloning with a token from the Hub. The third means the App was taken off the Repo while the Test build ran.

**Fix.** Read the full Test build log, fix the draft and run the Test build again. **Apply** turns on once a Test build of exactly that draft passes. Install tools in the Bootstrap script, which runs once per Build without the Repo; set up the clone, such as its dependencies or a database, in the Start script. See [Set up an Environment](/how-to/set-up-an-environment/). If the App isn't installed on the Repo, install it there or add the Repo to its installation; see [the GitHub App can't see the Repo](/troubleshooting/github-and-git/#the-github-app-cant-see-the-repo). If the Runner is older, [update it](/how-to/add-a-runner/), or pick another Runner.

## The Environment won't open, or New Session refuses the Repo

**What you see.** Entering a Repo in **New Session**, or opening its Environment page, says one of:

- **The GitHub App isn't installed on owner/name, or there's no such Repo.** With an **Install the App** link.
- **You don't have access to owner/name on GitHub.**

An Environment page you had open can switch to the second once you lose access, and the Repo leaves **Environments**. Applying, checking a draft or starting a Test build is refused with `You have no access to owner/name on GitHub, or the GitHub App isn't installed on it.`

**Why.** A Repo's Environment follows the Repo's access, like its Sessions: only people with access to the Repo on GitHub can see or change it, and only on Repos the GitHub App is installed on. The Hub doesn't say whether a Repo you can't use exists, so a Repo that doesn't exist reads like one without the App. See [Who can do what](/explanation/security-model/#who-can-do-what).

**Fix.** Check the Repo's name. For the first, follow **Install the App** and install it on the Repo, or add the Repo to its installation, then press **check again**: that asks GitHub afresh rather than the Hub's cache. For the second, have the Repo's owner add you as a collaborator, then press **Check again**. A refusal is remembered for at most 30 seconds. Shared variables belong to no Repo, so they stay open to everyone signed in.

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

## New Session refuses: no Claude credential

**What you see.** New Session says:

```
Neither you nor build-box has a Claude credential: add yours on the Account page.
```

**Why.** A Session runs on its Creator's Claude credential, or else on its Runner's own, and neither you nor that Runner has one ([ADR 0015](/reference/decisions/0015-each-person-brings-their-claude-credential/)).

**Fix.** [Add your Claude credential](/how-to/add-your-claude-credential/) on your **Account** page, then start the Session again. Or pick a Runner with its own [Claude credential](/reference/configuration/#the-runners-claude-credential).

## A Claude credential can't be saved

**What you see.** Saving on the **Account** page says one of:

- `Anthropic rejected this token: …` or `Anthropic rejected this API key: …`. The token was revoked or has expired, or it was copied only in part. Run `claude setup-token` again and paste the new one, all on one line.
- `That isn't a Claude token or API key: …`. A token starts with `sk-ant-oat`, a key with `sk-ant-api`.
- `This Hub can't store a Claude credential: it needs HUB_SECRETS_KEY …`. Whoever runs the Hub sets it, as for [Sensitive variables](#a-sensitive-variable-cant-be-saved).

**Saved, with a warning.** `Saved without checking it: Anthropic couldn't be reached.` The Hub couldn't reach `api.anthropic.com` and stored it anyway. If it is wrong, your Sessions start but their Turns fail; replace it once the Hub can reach Anthropic.

## A Session is missing, or `There is no such Session.`

**What you see.** A teammate's Session isn't in your list, a link to it says `There is no such Session.`, or a Session you were in disappears. Starting a Session says `You have no access to owner/name on GitHub, or the GitHub App isn't installed on it.`

**Why.** You see only the Sessions of Repos you have access to on GitHub, as a collaborator, and only Repos the GitHub App is installed on. Someone who loses access is taken out of the Repo's Sessions within twice `HUB_REPO_ACCESS_TTL_MS`. `Could not check your access on GitHub; try again.` means GitHub didn't answer the Hub. See [Who can do what](/explanation/security-model/#who-can-do-what).

**Fix.** Have the Repo's owner add you on GitHub, or install the App on it. Its Sessions show up within twice `HUB_REPO_ACCESS_TTL_MS` (5 minutes by default), with no reload. Without `GITHUB_APP_ID` on the Hub, GitHub sign-ins see no Sessions at all, and `claude-hub doctor` fails its `GitHub App` check: [set up the GitHub App](/how-to/set-up-the-github-app/).

## A Session doesn't go to sleep

**What you see.** A Session nobody uses stays Active long after `HUB_SLEEP_AFTER_MS` (15 minutes by default).

**Why.** Something keeps it busy: a Turn or subagent running, a prompt queued, a Participant with the Session open in a tab, or **Keep awake**, which the header shows as "Kept awake by …" and the sidebar marks with a sun. See [Going to sleep](/explanation/session-lifecycle/#going-to-sleep).

**Fix.** Turn **Keep awake** off, or press **Sleep now**, which turns it off and puts the Session to sleep at once. Anyone with access to the Repo can do either.

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
