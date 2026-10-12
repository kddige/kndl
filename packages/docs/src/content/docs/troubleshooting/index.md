---
title: Troubleshooting
description: Where kndl reports what went wrong, and an index of the problems these pages cover, by what you see.
sidebar:
  label: Start here
  order: 0
---

Each entry says what you see, why, and how to fix it.

## Where to look

| Where | What it tells you |
|---|---|
| `kndl doctor` | On an installed machine: what's wrong with the install, the settings, the services and the Hub's health, and how to fix it. `--fix` repairs what it can. |
| `kndl status` | Whether the services run, the Hub answers and the Runner is connected. |
| The Hub's terminal, or `kndl logs hub` | Startup warnings and refusals, sign-in failures and refused Runner connections. |
| The Runner's terminal, or `kndl logs runner` | Why it won't start, whether it reached the Hub, and what happened to Sandboxes. |
| A Session's transcript | A line each time its state changes, with why: `The Session is Asleep: …`, and notes about its Sandbox. |
| A Session's **Starting…** banner | While a Session starts, **Show log** holds the output of its Build, Bootstrap script and Start script. |
| A Session's **Terminal** tab | Claude Code's own screen, as it runs in tmux in the Session's Sandbox. |
| A Session's **Asleep** banner | When Claude Code exited on its own, **Show Claude Code's last output** holds the last lines its terminal showed. |
| `/health` on the Hub | `{"status":"ok"}` when the Hub is up. It needs no sign-in. |

For a closer look on a Runner's machine, list its Sandboxes with `bun x msb list` from `packages/runner`. See [Files and paths](/reference/files-and-paths/) for what each is named.

## By symptom

### [Installing and the CLI](/troubleshooting/install/)

- install.sh says `Could not clone https://github.com/kddige/kndl.git.`
- `kndl: command not found` after installing.
- `kndl is not installed in …`
- `onboard can't ask, so it needs --role hub|runner|both.`
- Onboard can't create the GitHub App.
- A service won't stay up.
- On Linux, the services stop when you log out.
- The Runner can't use KVM after onboard added you to the `kvm` group.
- `… is readable by others (mode 644); it holds secrets and should be 600.`
- `origin has no branch or tag named …, and it isn't a commit id.`
- `The install is pinned at …, so update stays there.`
- Uninstall refuses the home.

### [The Hub](/troubleshooting/hub/)

- The Hub exits at startup: `Failed to start server. Is port 7777 in use?`
- The browser shows `The Hub's web UI isn't built.`
- The Hub refuses dev login: `Dev login (KNDL_DEV_LOGIN) is refused: …`
- The Hub refuses to start because of `HUB_SECRETS_KEY`.
- The secrets key is lost.
- `… a Hub is running on …/hub.db. Stop it first.`
- The Hub exits with `HubConfigError: …` about the GitHub settings.
- The Hub's settings in `.env.local` are ignored.
- A warning at startup.

### [Signing in](/troubleshooting/sign-in/)

- Requests fail with `Only the web UI at … may make this request`.
- Sign-in seems to work, then you're back on the sign-in page.
- `Sign-in failed: the sign-in expired or came from elsewhere. Try again.`
- After GitHub: `This Hub is invite-only. Ask its owner for an invite.`
- `Sign-in failed: GitHub refused the sign-in: …`
- There's no **Sign in with GitHub** button.
- **Sign in as dev** answers `Dev login only answers on loopback`.
- After **Approve** for `kndl login`, the browser can't connect to `127.0.0.1`.
- `kndl login` says `That code isn't valid: …`
- `kndl whoami` says `… doesn't accept this machine's CLI token: it was revoked. …`

### [Runners](/troubleshooting/runners/)

- The Runner exits with `ConfigError: SchemaError(Expected string at ["RUNNER_TOKEN"])`.
- The Runner exits with `The hub-link mod isn't built: …`.
- The Runner keeps logging `Hub connection: could not connect to …`.
- A Runner on another machine never shows up.
- `kndl runner join` says `That pairing code can't be used: …`
- `kndl runner join` pairs, then says the Runner is `not connected to the Hub after 30 seconds`.
- The Runner logs `The Hub doesn't accept this Runner's token: …`
- **Remove** says the Runner has Sessions that aren't Archived.
- `… this Runner needs an update. Update it on the Runners page.`, or a Runner is **behind the Hub**.
- A Runner's row says **refuses: not on main**.
- A Runner's row says **update failed**.
- The Runner logs `The Hub turned this Runner away: …`.
- A Session is Frozen.
- The Runner warns `Unknown Sandbox for Session …`.

### [Sessions and Sandboxes](/troubleshooting/sessions/)

- A new Session goes straight to Asleep: `Claude Code could not start on …`.
- A Session is Asleep with `Claude Code exited with code N`.
- A woken Session's conversation starts over.
- A Session can't start: `… need values`.
- `The Session is Asleep: The Sandbox failed: …`
- The Test build fails.
- The Environment won't open, or **New Session** refuses the Repo.
- A Sensitive variable can't be saved.
- `Neither you nor … has a Claude credential`.
- A Claude credential can't be saved.
- A Session is missing, or `There is no such Session.`
- A Session doesn't go to sleep.
- **Restart** or **Sleep now** is refused.
- The **Environment changed** banner stays.

### [GitHub and git](/troubleshooting/github-and-git/)

- The Runner can't clone a Repo.
- `The GitHub App is not installed on owner/name, or can't see it: …`
- **The GitHub App is missing permissions**.
- `git push` or `gh` in a Session fails: the Sandbox has no GitHub token.
- Claude pushed to the default branch.

## Still stuck

Search the [issues](https://github.com/kddige/kndl/issues), and open one with what you ran, what you saw (the exact message) and the relevant lines from the Hub's and the Runner's logs. Remove tokens and keys first: kndl's own tokens start with `chr_`, `chm_` or `chs_`.
