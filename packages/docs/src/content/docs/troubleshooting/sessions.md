---
title: Sessions
description: A Session won't start or wake, its Sandbox fails, a Test build fails, or the web UI refuses an action.
sidebar:
  order: 5
---

Fixes for Sessions, Sandboxes and Environments. A Session that can't start doesn't retry by itself: it goes Asleep with the reason in its transcript, and its prompts wait. Fix the cause, then send a prompt or press **Wake now**.

## The agent could not start

**What you see.** A new or woken Session shows **This Session is Asleep**, and its transcript says:

```
The Session is Asleep: The agent could not start on build-box: …
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

## The agent exited

**What you see.** A Session shows **This Session is Asleep** with:

```
The agent exited with code 1. Its Sandbox is stopped. …
```

**Why.** The agent's process ended by itself: it couldn't open its storage, hit a fatal storage error, or crashed. The terminal is a separate shell, so quitting it doesn't end the agent.

**Fix.** Open **Show its last output** under the message, fix what it names, and press **Wake now**. The agent's own log is `durable/agent.log` under `/var/lib/kndl/claude` in the Sandbox: see [Files and paths](/reference/files-and-paths/#inside-a-sandbox).

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

## You have no Models

**What you see.** New Session says **Connect a Provider first**, the **Model** list is empty, or a Session went to sleep with:

```
Put to sleep: it runs on the Models of alice, who started it, and they have none
```

Someone else's attempt to wake it is refused with:

```
alice, who started this Session, has no Models to run it on: they can connect a Provider on the Account page.
```

**Why.** A Session runs on its Creator's Models: those of their Connected providers, and Claude's when they have a Claude credential. A Runner has none of its own.

**Fix.** The Session's Creator [connects a Provider](/guides/connect-your-providers/), or [adds their Claude credential](/guides/add-your-claude-credential/), and anyone wakes the Session.

## A Session went to sleep when its Claude credential changed

**What you see.** A Session's transcript says one of:

```
The Session is Asleep: Put to sleep: the Claude credential it ran on was removed
The Session is Asleep: Put to sleep, to wake on a new Claude credential: the one it ran on was replaced
```

**Why.** Removing or replacing a Claude credential puts its owner's awake Sessions to sleep, even mid-Turn. So does removing the owner as a Member.

**Fix.** The Creator [adds a credential](/guides/add-your-claude-credential/) if they removed theirs, and anyone wakes the Session. A Session whose Creator is no longer a Member stays readable, but can't wake.

## A Turn fails on a Provider's Model

**What you see.** A Turn's footer says **Failed**, with the reason under it, such as:

```
The Session's Creator hasn't connected OpenAI: they connect it on the Account page.
```

**Why.** The Provider of the Model the Turn ran on refused the call, or the Creator disconnected it. A sign-in the Provider stopped renewing shows **It doesn't work anymore** on its card on the **Account** page.

**Fix.** The Creator [connects the Provider again](/guides/connect-your-providers/#replace-or-disconnect-it), or anyone [switches the Session's Model](/guides/manage-a-session/#choose-the-model-and-thinking-level), and sends the prompt again.

## A Runner can't run the agent

**What you see.** New Session or a wake is refused with one of the first two, or a start ends with the third:

```
build-box hasn't connected since the Hub started, so it isn't known to run the durable agent.
build-box runs a version from before the durable agent: update it on the Runners page.
The Session is Asleep: The agent could not start on build-box: This Runner can't run Sessions: its log says why.
```

**Why.** A Runner runs Sessions once it has the agent's Node.js and packages. It gets them as it starts. If it couldn't, its log says `Sessions can't run: …`, and it runs none until it next starts. The Hub gives that Runner the second message, since it can't tell it from one that is out of date.

**Fix.** On the Runner's machine, find why in its log:

```sh
kndl logs runner -n 10000 | grep "Sessions can't run"
```

Fix what it names, such as no route to the npm registry or `nodejs.org`, then restart the Runner with `kndl runner stop` and `kndl runner start`. Meanwhile, pick another Runner in **Runner**. See [What a Runner downloads](/self-hosting/add-a-runner/#what-a-runner-downloads).

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

**Why.** Something keeps it busy: a Turn running in the main conversation or a Thread, a subagent running, a prompt queued, someone with the Session open, or **Keep awake**, which the line under the Session's title shows as "Kept awake by …". See [Going to sleep](/concepts/session-lifecycle/#going-to-sleep).

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
