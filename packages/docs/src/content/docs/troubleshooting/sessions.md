---
title: Sessions and Sandboxes
description: A Session won't start or wake, its Sandbox fails, its tool calls fail or may have run, an Environment won't open or its Test build fails, or the web UI refuses an action.
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

- `The current working directory was deleted`: the Runner's tmux server was started by another process, from a directory since deleted. See [Sessions exit at once with "The current working directory was deleted"](/troubleshooting/runners/#sessions-exit-at-once-with-the-current-working-directory-was-deleted).
- A sign-in or usage message: Claude Code's login on that Runner needs attention. Run `claude` there as the Runner's user.

A Runner from before this was added sends no output: the banner has no **Show Claude Code's last output**, and its log only says `Session <id> exited with 1`. [Update it](/how-to/add-a-runner/).

### Waking it after Claude Code never got going

A Session whose Claude Code exited before it wrote its conversation has nothing to `--resume`. The Runner checks for the conversation's transcript in Claude Code's projects folder, `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`), and, with none, starts a new conversation with the same id instead, logging:

```
INFO (#2): Session <id>: Claude Code has no transcript of conversation <conversation id> in /Users/you/.claude/projects, so it starts a new one with that id instead of resuming it
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

## A tool call may have run, but its result was lost

**What you see.** A tool call comes back with text such as:

```
Bash may have run in this Session's Sandbox, but its result was lost (the tool bridge stopped answering: …). Check before running it again. It never runs on the host.
```

or, for a call that ran out of time or was interrupted:

```
Bash did not finish within 2.5 minutes, so it was stopped in this Session's Sandbox. It may have run in part: check before running it again. It never runs on the host.
Bash was interrupted, and stopped in this Session's Sandbox. It may have run in part: check before running it again. It never runs on the host.
```

**Why.** The tool bridge had taken the call, so the command may have done some or all of its work before the answer was lost. Lost answers come from the Sandbox or its tool server stopping mid-call, or the Runner's bridge not answering. A call stops when it runs past its tool's time (Bash's own `timeout`, at most 10 minutes; 5 minutes for the other tools) or when someone interrupts the Turn; see [Long tool calls](/explanation/architecture/#long-tool-calls). Claude is told to check before it runs the call again, since running a command like `git stash pop` twice can do harm.

**Fix.** Usually nothing: Claude checks, such as with `git status`, and goes on. For a command that needs longer than 10 minutes, have Claude split it, or run it in the background in the Sandbox with `nohup … &` and check its log. If calls keep getting lost, check the Runner's log for `tool server down`, and see [Claude's tools are refused](#claudes-tools-are-refused).

## Tool calls over 30 seconds fail

**What you see.** Every tool call that takes longer than 30 seconds fails, with:

```
Bash could not run in this Session's Sandbox (the tool bridge is unreachable: HooksError: hub-link: $.http.fetch(http://tool-bridge/tools/call) over …/tools.sock aborted: no complete answer within 30000ms), so it did not run at all. It never runs on the host.
```

or, from a newer mod:

```
Bash may have run in this Session's Sandbox, but its result was lost (the tool bridge gave no answer: …. This Session's Runner is older than its mod and can't wait on a call for longer than 30 seconds; update the Runner). Check before running it again. It never runs on the host.
```

**Why.** Before [#109](https://github.com/kddige/claude-hub/issues/109), the mod waited for a call in one request, which Claude Code gives up on after 30 seconds. The first message is wrong about the call not running: the bridge kept running it in the Sandbox. A newer mod waits in steps, but needs a Runner that can answer that way; with an older one, it falls back to the one request and its 30 seconds.

**Fix.** Update the Runner's checkout and restart the Runner, then restart the Session (**Sleep now**, then **Wake now**) so its Claude Code loads the new mod too. Until then, check what a failed call did before running it again.

## Claude doesn't follow the Repo's CLAUDE.md, or a skill is missing

**What you see.** Claude doesn't know an instruction from the Repo's `CLAUDE.md`, or `/repo:<name>` isn't a command. The Runner logs what it left out:

```
Session <id>: left out of the Repo's skills and CLAUDE.md: …
```

or, when it couldn't read the Workspace at all, `Session <id>: the Repo's skills and CLAUDE.md were not read`.

**Why.** The Runner copies only what is safe to hand to Claude Code on the host ([ADR 0001](/reference/decisions/0001-claude-on-host-tools-in-sandbox/#repo-skills-and-claudemd-amended-in-125)). It leaves out:

- `… a symbolic link is along its path`: the file, or a folder above it, is a symbolic link.
- `… larger than 65536 bytes`: the file is over 64 KiB. The instruction files together stop at 256 KiB.
- `… is outside the Workspace`: an `@` import points outside the Repo, such as `@~/notes.md` or `@../other.md`.
- `… not UTF-8 text` or `… not text`: the file isn't text, or isn't UTF-8.
- `… not a skill name`: a skill's folder name must start with a letter or digit, and hold only letters, digits, `.`, `_` and `-`, up to 64 characters.
- `… imports past depth 5` and `… past the limit of 32 imports`.

Files Claude Code would load in a checkout, but a Session never does, aren't listed: `CLAUDE.local.md`, `CLAUDE.md` files in subdirectories, `.claude/rules/` and commands. See [Use the Repo's skills and CLAUDE.md](/how-to/work-in-a-session/#use-the-repos-skills-and-claudemd).

The copy is taken when the Session starts or wakes. A `CLAUDE.md` changed after that, or one a woken Session started without, isn't in the conversation yet.

**Fix.** Move the file into the Repo, replace the link with the file, or split a large file. Then sleep and wake the Session (**Sleep now**, then send a prompt) and run `/clear` in the **Terminal**, so the conversation starts over with the new instructions. To keep a `CLAUDE.local.md` instruction, move it into `CLAUDE.md`.

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

## A Session is missing, or `There is no such Session.`

**What you see.** A teammate's Session isn't in your list, a link to it says `There is no such Session.`, or a Session you were in disappears. Starting a Session says `You have no access to owner/name on GitHub, or the GitHub App isn't installed on it.`

**Why.** You see only the Sessions of Repos you have access to on GitHub, as a collaborator, and only Repos the GitHub App is installed on. Someone who loses access is taken out of the Repo's Sessions within twice `HUB_REPO_ACCESS_TTL_MS`. `Could not check your access on GitHub; try again.` means GitHub didn't answer the Hub. See [Who can do what](/explanation/security-model/#who-can-do-what).

**Fix.** Have the Repo's owner add you on GitHub, or install the App on it. Its Sessions show up within twice `HUB_REPO_ACCESS_TTL_MS` (5 minutes by default), with no reload. Without `GITHUB_APP_ID` on the Hub, GitHub sign-ins see no Sessions at all, and `claude-hub doctor` fails its `GitHub App` check: [set up the GitHub App](/how-to/set-up-the-github-app/).

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
