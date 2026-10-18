---
title: Sessions
description: A Session won't start or wake, its Sandbox fails, a Test build fails, or the web UI refuses an action.
sidebar:
  order: 5
---

Fixes for Sessions, Sandboxes and Environments. A Session that can't start doesn't retry by itself: it goes Asleep with the reason in its transcript, and its prompts wait. Fix the cause, then send a prompt or press **Wake now**.

## Claude Code could not start

**What you see.** A new or woken Session shows **This Session is Asleep**, and its transcript says:

```
The Session is Asleep: Claude Code could not start on build-box: …
```

**Why.** The Runner's reason follows the colon:

| Reason starts with | What failed |
|---|---|
| `git clone exited with …` | The Runner couldn't clone the Repo. See [git clone exited with 128](/troubleshooting/github-and-git/#git-clone-exited-with-128). |
| `The bootstrap script exited with …` | The Environment's Bootstrap script, as the Runner built the image. |
| `Installing Docker exited with …` | Installing Docker, for an Environment with Docker on. |
| `Installing tmux and bash exited with …` | The image lacks tmux 3.2 or bash, and has no package manager kndl knows. Install them in the Bootstrap script, or use an image that has them. |
| `The start script exited with …` | The Environment's Start script, in the Sandbox. |
| `Reading the login shell's environment failed: …` | A shell profile in the image, such as `~/.bashrc`. |
| `The Sandbox failed: …` | The microVM. See [The Sandbox failed](#the-sandbox-failed). |

**Fix.** Press **Wake now**, and open **Show log** on the **Starting…** banner for the full output. Fix the script in the Repo's **Environment**, run a **Test build**, and apply it. See [Set up an Environment](/guides/set-up-an-environment/).

## Claude Code exited

**What you see.** A Session shows **This Session is Asleep** with:

```
Claude Code exited with code 1. Its Sandbox is stopped. …
```

**Why.** Claude Code ended by itself: it crashed, refused to start, or was quit from its terminal. Code 0 means it quit normally, as after `/exit`.

**Fix.** Open **Show Claude Code's last output** under the message, fix what it names, and press **Wake now**. A sign-in or usage message means the Claude credential the Session runs on needs attention: its Creator [replaces theirs](/guides/add-your-claude-credential/#replace-or-remove-it) on their **Account** page.

## A woken Session's conversation starts over

**What you see.** A woken Session's history says Claude Code, or pi, couldn't resume its conversation.

**Why.** The agent exited before it saved the conversation, so there was nothing to resume.

**Fix.** Nothing. The Workspace is as it was; only the conversation starts over.

## Variables need values

**What you see.** A Session shows **This Session can't start**, or New Session refuses, with:

```
kddige/kndl's Sessions can't start: NPM_TOKEN and GH_TOKEN (the shared variable GITHUB_TOKEN) need values. Enter them on the Repo's Environment screen and the Shared variables screen.
```

**Why.** The Hub's secrets key was lost and its Sensitive values [cleared](/troubleshooting/hub/#the-secrets-key-is-lost). The variables are kept without values.

**Fix.** Press **Enter values**, type each value on the Repo's **Environment** and apply, and press **Enter value** on each Shared variable it names. Then wake the Session.

## The Sandbox failed

**What you see.** The transcript says:

```
The Session is Asleep: The Sandbox failed: …
```

**Why.** The Runner couldn't start the Session's microVM. It needs a Mac with Apple Silicon or Linux with KVM, and the memory and CPUs the Environment asks for.

**Fix.**

- **On Linux:** run `kndl doctor` on the Runner's machine, and see [KVM access](/troubleshooting/install/#kvm-access-cant-open-devkvm).
- **Not enough room:** lower the Environment's **CPUs** or **Memory (MiB)**, or put other Sessions to sleep.
- **Otherwise:** restart the Runner with `kndl runner install`.

## Test build failed

**What you see.** On the Repo's **Environment** page, the Test build ends with **Test build failed** and the end of the failing step's output:

```
The bootstrap script exited with 127:
bash: line 3: pnpm: command not found
```

**Why.** A Test build runs your scripts as a Session's start would. What fails there fails every new Session.

**Fix.** Read the log, fix the draft, and run the Test build again. **Apply** turns on once a Test build of that exact draft passes. Install tools in the Bootstrap script, and set up the clone, such as its dependencies, in the Start script.

If it fails before cloning with `The GitHub App isn't installed on owner/name, so a Test build can't clone it: …`, install the App on the Repo: see [The GitHub App is not installed on the Repo](/troubleshooting/github-and-git/#the-github-app-is-not-installed-on-the-repo).

## You don't have access to a Repo

**What you see.** New Session or a Repo's **Environment** page says one of:

- **The GitHub App isn't installed on owner/name, or there's no such Repo.**
- **You don't have access to owner/name on GitHub.**

**Why.** You can see and change only Repos you have access to on GitHub, and only those the GitHub App is installed on.

**Fix.** Check the Repo's name. Then:

- **App not installed:** follow **Install the App**, add the Repo, and press **Check again**.
- **No access:** have the Repo's owner add you on GitHub, then press **Check again**.

## A Sensitive variable can't be saved

**What you see.** Saving an Environment or a Shared variable is refused with one of:

```
NPM_TOKEN is Sensitive, but the Hub has no HUB_SECRETS_KEY to encrypt it with. …
The value of NPM_TOKEN is under 4 characters: too short to redact from output. Make it Plain, or use a longer value.
```

**Why.** The Hub encrypts Sensitive values with `HUB_SECRETS_KEY`, and hides them in everything Sessions show, which a very short value would defeat.

**Fix.**

- **No key:** whoever runs the Hub makes one with `kndl secrets key`, puts it in `hub.env`, and runs `kndl hub install`.
- **Too short:** make the variable Plain, or use the real, longer value.

## You have no Claude credential

**What you see.** New Session says **Add your setup token first**, or a Session went to sleep saying its Creator has none, or removed or replaced theirs.

**Why.** A Claude Code Session, and Claude's Models in any Session, run on the Creator's Claude credential, and a Runner has none of its own. Removing or replacing a credential, or removing its owner as a Member, puts their awake Sessions to sleep.

**Fix.** The Session's Creator [adds theirs](/guides/add-your-claude-credential/) and wakes it. A Session whose Creator is no longer a Member stays readable, but can't wake.

## You have no Models

**What you see.** New Session says **Connect a Provider first**, its **Model** button says **No Models: connect a Provider**, or a Session went to sleep with:

```
Put to sleep: it runs on the Models of alice, who started it, and they have none
```

**Why.** A pi Session runs on its Creator's Models: those of their Connected providers, and Claude's when they have a Claude credential. A Runner has none of its own.

**Fix.** The Session's Creator [connects a Provider](/guides/connect-your-providers/), or [adds their Claude credential](/guides/add-your-claude-credential/), and wakes it.

## A Turn fails on a Provider's Model

**What you see.** In a pi Session, a Turn's footer says **Failed**. The **Terminal** tab shows why, such as:

```
The Session's Creator hasn't connected OpenAI: they connect it on the Account page.
```

**Why.** The Provider of the Session's Model refused the call, or the Creator disconnected it. A sign-in the Provider stopped renewing shows **It doesn't work anymore** on its card on the **Account** page.

**Fix.** The Creator [connects the Provider again](/guides/connect-your-providers/#replace-or-disconnect-it), or [switches the Session's Model](/guides/manage-a-session/#choose-the-model-and-thinking-level), and sends the prompt again.

## New Sessions run Claude Code

**What you see.** New Session's **Model** offers Claude Code's models, or New Session says **Add your setup token first**, though the address has no `?harness=claude-code`. Or a start fails with:

```
… This Runner doesn't run pi Sessions: its log says why.
```

**Why.** The Runner can't run pi, so it runs Claude Code Sessions alone. With **Any online Runner**, New Session starts pi only when every online Runner runs it. A Runner gets pi as it starts: see [What a Runner downloads](/self-hosting/add-a-runner/#what-a-runner-downloads).

**Fix.** On the Runner's machine, find why in its log:

```sh
kndl logs runner -n 10000 | grep 'Sessions run Claude Code alone'
```

Fix what it names, such as no route to the npm registry or `nodejs.org`, then restart the Runner with `kndl runner stop` and `kndl runner start`. Meanwhile, pick a Runner that runs pi in **Runner**.

## Only someone else can drive this Session

**What you see.** The prompt box is off, there's no **Terminal** tab, and a command is refused with:

```
Only Alice Lee, who started this Session, can drive it: it runs on their Claude credential.
```

**Why.** Only a Session's Creator prompts it, answers it, stops it, controls it and uses its terminal. Everyone else watches.

**Fix.** Ask its Creator, or start a Session of your own on its Work branch once it's pushed.

## A Claude credential can't be saved

**What you see.** Saving on the **Account** page says one of:

| Message | Fix |
|---|---|
| `Anthropic rejected this token: …` | It was revoked, expired, or copied in part. Run `claude setup-token` again and paste the new one on one line. |
| `That isn't a Claude setup token: it starts with sk-ant-oat.` | Paste the whole token `claude setup-token` printed. |
| `API keys aren't taken for now. …` | Run `claude setup-token`, and paste the token it prints. |
| `That doesn't look like a whole token. …` | Copy it again, all on one line. |
| `This Hub can't store a Claude credential: it needs HUB_SECRETS_KEY …` | Whoever runs the Hub sets `HUB_SECRETS_KEY`, as for [Sensitive variables](#a-sensitive-variable-cant-be-saved). |
| `Saved without checking it: …` | Saved, but the Hub couldn't reach Anthropic to check it. If it's wrong, Turns fail: replace it then. |

## There is no such Session.

**What you see.** A link to a Session says `There is no such Session.`, a teammate's Session isn't in your list, or one you were in disappears.

**Why.** You see only the Sessions of Repos you have access to on GitHub, on which the GitHub App is installed.

**Fix.** Have the Repo's owner add you on GitHub, or install the App on the Repo. Its Sessions appear within a few minutes, with no reload. A Hub without the GitHub App shows no Sessions to people signed in with GitHub: [set up the GitHub App](/self-hosting/set-up-the-github-app/).

## A Session doesn't go to sleep

**What you see.** A Session nobody uses stays Active long after 15 minutes.

**Why.** Something keeps it busy: a Turn or subagent running, a prompt queued, someone with the Session open, or **Keep awake**, which the header shows as "Kept awake by …". See [Going to sleep](/concepts/session-lifecycle/#going-to-sleep).

**Fix.** Turn **Keep awake** off, or press **Sleep now**.

## Restart or Sleep now is refused

**What you see.** **Restart** or **Sleep now** shows a refusal:

| Refusal | Fix |
|---|---|
| `The Session is still starting; restart it once it has started.` | Wait for the **Starting…** banner to go. |
| `A Turn is running: stop it first, then restart.` or `A Turn is running: stop it first.` | Stop the Turn, or wait for it to end. |
| `Prompts are waiting in the Session's queue.` | Cancel the queued prompts, or let them run. |
| `The Session's Runner is offline.` | See [A Session is Frozen](/troubleshooting/runners/#a-session-is-frozen). |
| `Only an Active Session can be put to sleep; this one is Asleep.` | Nothing: it's asleep. |

## Environment changed stays

**What you see.** A Session shows **Environment changed**: `This Sandbox runs version 2 of owner/name's Environment; version 3 is the latest.`

**Why.** Someone applied a new version of the Repo's Environment, and a running Sandbox keeps the version it started on.

**Fix.** Press **Restart** when it suits you. The Session wakes on a fresh Sandbox, with its Workspace and conversation. Anything it installed outside the Workspace is gone: see [Environments](/concepts/environments/).
