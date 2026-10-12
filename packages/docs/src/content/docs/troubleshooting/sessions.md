---
title: Sessions and Sandboxes
description: A Session won't start or wake, its Sandbox fails, an Environment won't open or its Test build fails, or the web UI refuses an action.
sidebar:
  order: 5
---

A Session that can't start doesn't retry on its own. It goes Asleep with the reason in its transcript, and its queued prompts wait. Fix the cause, then send a prompt or press **Wake now**. See [the Session lifecycle](/concepts/session-lifecycle/#when-a-start-fails).

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
| `Installing tmux and bash exited with …` | The image lacks tmux 3.2 or later or bash, and has no apk, apt-get, dnf or yum to install them. Install them in the Bootstrap script, or use an image that has them, such as the default `buildpack-deps:bookworm`. |
| `The start script exited with …` | The Start script failed in the Sandbox. |
| `Reading the login shell's environment failed: …` | A shell profile in the image, such as `~/.bashrc`, failed. |
| `The Hub refused the Environment's variables: …` | The Hub wouldn't hand over the Environment's variables, for example because the Session was archived while it started. |
| `The Sandbox failed: …` | microsandbox couldn't start the microVM. See [The Sandbox fails to start](#the-sandbox-fails-to-start). |

**Fix.** Next time the Session starts, expand **Show log** on its **Starting…** banner for the full output. Fix the script or setting in the Repo's **Environment**, then wake the Session.

## Claude Code exited with code N

**What you see.** A Session shows **This Session is Asleep** with:

```
Claude Code exited with code 1. Its Sandbox is stopped. …
```

and, under it, **Show Claude Code's last output**.

**Why.** Claude Code ended on its own: it crashed, refused to start, or was quit from its terminal. Exit code 0 means it quit normally, as after `/exit`.

**Fix.** Press **Show Claude Code's last output** to read the last lines its terminal showed, with Sensitive values redacted. The Runner's log only notes the exit:

```
WARN (#2): Session <id> exited with 1; its last 3 line(s) of output are on the Session's page
```

Fix what the output names, then send a prompt or press **Wake now**. A sign-in or usage message means the Claude credential the Session runs on needs attention: its Creator's, which they [replace on their Account page](/guides/add-your-claude-credential/), or else [the Runner's own](/reference/configuration/#the-runners-claude-credential).

## The conversation starts over

**What you see.** A woken Session's history notes that Claude Code couldn't resume its conversation, and the Runner logs:

```
WARN (#2): Session <id>: Claude Code has no transcript of conversation <conversation id>, so it starts a new one with that id instead of resuming it
```

**Why.** Claude Code exited before it wrote the conversation, so there was nothing to resume.

**Fix.** Nothing: the Workspace is as it was, and only the conversation starts over.

## A Session can't start: variables need values

**What you see.** A Session shows **This Session can't start**, or a new one is refused, with:

```
kddige/kndl's Sessions can't start: NPM_TOKEN and GH_TOKEN (the shared variable GITHUB_TOKEN) need values. Enter them on the Repo's Environment screen and the Shared variables screen.
```

A Test build is refused with `NPM_TOKEN needs a value.`, and the variables show **needs a value**.

**Why.** The Hub's secrets key was lost and its Sensitive values were [reset](/guides/use-variables-and-secrets/#if-the-key-is-lost), keeping the variables without their values.

**Fix.** Press **Enter values**, type each value on the Repo's Environment and apply, and press **Enter value** on each Shared variable named. Then wake the Session.

## The Sandbox fails to start

**What you see.** The transcript says `The Session is Asleep: The Sandbox failed: …`, or the start fails with a microsandbox error.

**Why.** Sandboxes are microsandbox microVMs. They need a Mac with Apple Silicon, or Linux with KVM the Runner's user can open, and the memory and CPUs the Environment asks for, within `RUNNER_SANDBOX_MAX_MEMORY_MIB` and `RUNNER_SANDBOX_MAX_CPUS`.

**Fix.**

- On Linux, check `/dev/kvm` exists and the Runner's user can open it. See [The Runner can't use KVM](/troubleshooting/install/#the-runner-cant-use-kvm).
- Lower the Environment's **CPUs** or **Memory (MiB)**, or stop other Sandboxes. `bun x msb list`, from `packages/runner`, lists them.
- After a microsandbox crash, restart the Runner.

## The Test build fails

**What you see.** On the Repo's **Environment** page, the Test build ends with **Test build failed** and the end of the failing step's output, such as:

```
The bootstrap script exited with 127:
bash: line 3: pnpm: command not found
```

**Why.** A Test build runs the Bootstrap script on the image, then the Start script on a fresh clone, as a Session's Build would. What fails there would fail every new Session.

It can also fail before it clones, with:

```
The GitHub App isn't installed on owner/name, so a Test build can't clone it: install the App on the Repo, then try again.
```

```
could not get access to clone the Repo: The GitHub App is not installed on owner/name, or can't see it: …
```

The first is for a Dev login, which still needs the App to clone. The second means the App was taken off the Repo during the Test build.

**Fix.** Read the full log, fix the draft and run the Test build again; **Apply** turns on once a Test build of exactly that draft passes. Install tools in the Bootstrap script; set up the clone, such as its dependencies, in the Start script. See [Set up an Environment](/guides/set-up-an-environment/). For the App, see [The GitHub App can't see the Repo](/troubleshooting/github-and-git/#the-github-app-cant-see-the-repo).

## The Environment won't open, or New Session refuses the Repo

**What you see.** Entering a Repo in **New Session**, or opening its Environment page, says one of:

- **The GitHub App isn't installed on owner/name, or there's no such Repo.** With an **Install the App** link.
- **You don't have access to owner/name on GitHub.**

Applying, checking a draft or starting a Test build is refused with `You have no access to owner/name on GitHub, or the GitHub App isn't installed on it.`

**Why.** Only people with access to a Repo on GitHub can see or change its Environment, and only on Repos the GitHub App is installed on. A Repo that doesn't exist reads like one without the App. See [Who can do what](/concepts/security-model/#who-can-do-what).

**Fix.** Check the Repo's name. For the first, follow **Install the App** and install it on the Repo, then press **check again**. For the second, have the Repo's owner add you as a collaborator, then press **Check again**.

## A Sensitive variable can't be saved

**What you see.** Saving the Environment, or a Shared variable, is refused with one of:

```
NPM_TOKEN is Sensitive, but the Hub has no HUB_SECRETS_KEY to encrypt it with. Run `bun run secrets-key`, put the key in packages/hub/.env.local, and restart the Hub.
```

```
The value of NPM_TOKEN is under 4 characters: too short to redact from output. Make it Plain, or use a longer value.
```

**Why.** The Hub encrypts Sensitive values with `HUB_SECRETS_KEY`, and redacts them from everything Sessions show, which a very short value would make useless.

**Fix.** For the first, do what it says. For the second, make the variable Plain, or use the real, longer value. See [Use variables and secrets](/guides/use-variables-and-secrets/).

## New Session refuses: no Claude credential

**What you see.** New Session says:

```
Neither you nor build-box has a Claude credential: add yours on the Account page.
```

**Why.** A Session runs on its Creator's Claude credential, or else on its Runner's own, and neither has one.

**Fix.** [Add your Claude credential](/guides/add-your-claude-credential/) on your **Account** page, or pick a Runner with its own [Claude credential](/reference/configuration/#the-runners-claude-credential).

## A Claude credential can't be saved

**What you see.** Saving on the **Account** page says one of:

- `Anthropic rejected this token: …` or `Anthropic rejected this API key: …`. It was revoked, has expired, or was copied in part. Run `claude setup-token` again and paste the new one, on one line.
- `That isn't a Claude token or API key: …`. A token starts with `sk-ant-oat`, a key with `sk-ant-api`.
- `This Hub can't store a Claude credential: it needs HUB_SECRETS_KEY …`. Whoever runs the Hub sets it, as for [Sensitive variables](#a-sensitive-variable-cant-be-saved).

**Saved, with a warning.** `Saved without checking it: Anthropic couldn't be reached.` If it is wrong, your Sessions' Turns fail; replace it once the Hub can reach Anthropic.

## A Session is missing, or `There is no such Session.`

**What you see.** A teammate's Session isn't in your list, a link to it says `There is no such Session.`, or a Session you were in disappears. Starting a Session says `You have no access to owner/name on GitHub, or the GitHub App isn't installed on it.`

**Why.** You see only the Sessions of Repos you have access to on GitHub, and only Repos the GitHub App is installed on. `Could not check your access on GitHub; try again.` means GitHub didn't answer the Hub. See [Who can do what](/concepts/security-model/#who-can-do-what).

**Fix.** Have the Repo's owner add you on GitHub, or install the App on it. Its Sessions show up within twice `HUB_REPO_ACCESS_TTL_MS` (5 minutes by default), with no reload. Without `GITHUB_APP_ID` on the Hub, GitHub sign-ins see no Sessions at all: [set up the GitHub App](/self-hosting/set-up-the-github-app/).

## A Session doesn't go to sleep

**What you see.** A Session nobody uses stays Active long after `HUB_SLEEP_AFTER_MS` (15 minutes by default).

**Why.** Something keeps it busy: a Turn or subagent running, a prompt queued, a Participant with the Session open in a tab, or **Keep awake**, which the header shows as "Kept awake by …". See [Going to sleep](/concepts/session-lifecycle/#going-to-sleep).

**Fix.** Turn **Keep awake** off, or press **Sleep now**, which turns it off and puts the Session to sleep at once.

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

**Why.** Someone applied a new version of the Repo's Environment, and a running Sandbox keeps the version it started on.

**Fix.** Press **Restart** when it suits you. The Session wakes on a fresh Sandbox from the latest version, with its Workspace and conversation. What it installed outside the Workspace is gone; see [Environments](/concepts/environments/).
