---
title: Troubleshooting
description: Where claude-hub reports what went wrong, and an index of the problems these pages cover, by what you see.
sidebar:
  label: Start here
  order: 0
---

Each entry on these pages starts with what you see, quotes the message where claude-hub prints one, says why it happens, and how to fix it.

## Where to look

| Where | What it tells you |
|---|---|
| `claude-hub doctor` | On an installed machine: what's wrong with the install, the settings, the services and the Hub's health, and how to fix it. `--fix` repairs what it can. |
| `claude-hub status` | Whether the services run, the Hub answers and the Runner is connected. |
| The Hub's terminal, or `claude-hub logs hub` | Startup warnings and refusals, sign-in failures and refused Runner connections. |
| The Runner's terminal, or `claude-hub logs runner` | Why it won't start, whether it reached the Hub, and what happened to Sandboxes. |
| A Session's transcript | A line each time its state changes, with why: `The Session is Asleep: …`, and notes about its Sandbox and WIP ref. |
| A Session's **Starting…** banner | While a Session starts, **Show log** holds the output of its Build, Bootstrap script and Start script. |
| A Session's **Terminal** tab | Claude Code's own screen, as it runs in tmux on the Runner. |
| `/health` on the Hub | `{"status":"ok"}` when the Hub is up. It needs no sign-in. |

For a closer look on a Runner's machine, list its tmux sessions with `tmux -L claude-hub-dev ls` (`tmux -L claude-hub ls` installed) and its Sandboxes with `bun x msb list` from `packages/runner`. See [Files and paths](/reference/files-and-paths/) for what each is named.

## By symptom

### [Installing and the CLI](/troubleshooting/install/)

- install.sh says `Could not clone kddige/claude-hub: it's private, …`
- `claude-hub: command not found` after installing.
- `claude-hub is not installed in …`
- `onboard can't ask, so it needs --role hub|runner|both.`
- A service won't stay up.
- On Linux, the services stop when you log out.
- The Runner can't use KVM after onboard added you to the `kvm` group.
- `… is readable by others (mode 644); it holds secrets and should be 600.`
- `origin has no branch or tag named …, and it isn't a commit id.`
- `The install is pinned at …, so update stays there.`
- Uninstall refuses the home.

### [The Hub](/troubleshooting/hub/)

- The Hub exits at startup: `Failed to start server. Is port 7777 in use?`
- The Hub exits at startup with `HubConfigError: …`.
- The browser shows `The Hub's web UI isn't built.`
- The Hub refuses dev login: `Dev login (CLAUDE_HUB_DEV_LOGIN) is refused: …`
- The Hub refuses to start because of `HUB_SECRETS_KEY`.
- The Hub's settings in `.env.local` are ignored.

### [Signing in](/troubleshooting/sign-in/)

- Sign-in seems to work, then you're back on the sign-in page.
- `Sign-in failed: the sign-in expired or came from elsewhere. Try again.`
- `Sign-in failed: GitHub refused the sign-in: …`
- There's no **Sign in with GitHub** button.
- Requests fail with `Only the web UI at … may make this request`.
- **Sign in as dev** answers `Dev login only answers on loopback`.

### [Runners](/troubleshooting/runners/)

- The Runner exits with `ConfigError: SchemaError(Expected string at ["RUNNER_TOKEN"])`.
- The Runner exits with `RunnerLoginUnknown: No Claude account is signed in …`.
- The Runner exits with `The hub-link mod isn't built: …`.
- The Runner keeps logging `Hub connection: could not connect to …`.
- A Runner on another machine never shows up.
- A Session is Frozen.
- Sessions from before an update are gone.
- The Runner warns about Sandboxes it doesn't know.

### [Sessions and Sandboxes](/troubleshooting/sessions/)

- A new Session goes straight to Asleep: `Claude Code could not start on …`.
- `The Sandbox failed: host path … is not a directory`.
- Claude's tools are refused: `… could not run in this Session's Sandbox (…), so it did not run at all.`
- **Restart** or **Sleep now** is refused.
- The Test build fails.
- A Sensitive variable can't be saved.
- The **Environment changed** banner stays.

### [GitHub and git](/troubleshooting/github-and-git/)

- The Runner can't clone a Repo.
- `The GitHub App is not installed on owner/name, or can't see it: …`
- `git push` or `gh` in a Session fails: the Sandbox has no GitHub token.
- `The WIP ref could not be pushed: host git refused the Workspace: …`.
- Claude pushed to the default branch.

## Still stuck

Search the [issues](https://github.com/kddige/claude-hub/issues), and open one with what you ran, what you saw (the exact message) and the relevant lines from the Hub's and the Runner's logs. Remove tokens and keys first: claude-hub's own tokens start with `chr_`, `chm_` or `chs_`.
