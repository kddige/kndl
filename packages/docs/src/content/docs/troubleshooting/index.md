---
title: Troubleshooting
description: Find what went wrong with kndl by what you see, starting with kndl doctor.
sidebar:
  label: Start here
  order: 0
---

Find your symptom below, or start with `kndl doctor` on the machine that misbehaves.

## Run `kndl doctor`

```sh
kndl doctor
```

It checks the install, the settings, the services and the Hub's health, and prints `ok`, `!!` (a warning) or `XX` (a failure) for each, with what to do. To repair what it can, after asking:

```sh
kndl doctor --fix
```

## Where to look

| Where | What it tells you |
|---|---|
| `kndl status` | Whether the services run, the Hub answers and the Runner is connected. |
| `kndl logs hub`, `kndl logs runner` | Why a service won't start, refused connections, sign-in failures, what happened to Sandboxes. Add `-f` to follow. |
| A Session's transcript | A line each time its state changes, with why: `The Session is Asleep: …`. |
| **Show log** on a Session's **Starting…** banner | The output of its Build, Bootstrap script and Start script. |
| A Session's **Terminal** tab | Claude Code's own screen. |
| `https://<your Hub>/health` | `{"status":"ok"}` when the Hub is up. |

Running kndl from a checkout? The logs are in the terminals running `bun run hub` and `bun run runner`, and the Hub's settings in `packages/hub/.env.local`. See [Develop kndl](/contributing/develop-kndl/).

## By symptom

| What you see | Where |
|---|---|
| `kndl: command not found` right after installing | [Install](/troubleshooting/install/#kndl-command-not-found-right-after-installing) |
| `kndl install: Could not clone …` | [Install](/troubleshooting/install/#installsh-could-not-clone) |
| `kndl is not installed in …` | [Install](/troubleshooting/install/#kndl-is-not-installed) |
| `onboard can't ask, so it needs --role hub\|runner\|both.` | [Install](/troubleshooting/install/#onboard-cant-ask-so-it-needs-a-flag) |
| Onboard can't create the GitHub App | [Install](/troubleshooting/install/#onboard-cant-create-the-github-app) |
| A service won't stay up | [Install](/troubleshooting/install/#a-service-wont-stay-up) |
| On Linux, the services stop when you log out | [Install](/troubleshooting/install/#the-services-stop-when-you-log-out) |
| `KVM access: … can't open /dev/kvm.` | [Install](/troubleshooting/install/#kvm-access-cant-open-devkvm) |
| `sudo: a terminal is required to read the password` | [Install](/troubleshooting/install/#sudo-a-terminal-is-required-to-read-the-password) |
| `bun: command not found` while building | [Install](/troubleshooting/install/#build-the-web-ui-or-the-hub-link-mod-bun-command-not-found) |
| `… is readable by others (mode 644); …` | [Install](/troubleshooting/install/#an-env-file-is-readable-by-others) |
| `kndl update` stays where it is | [Install](/troubleshooting/install/#kndl-update-stays-where-it-is) |
| `kndl uninstall` refuses the home | [Install](/troubleshooting/install/#kndl-uninstall-refuses-the-home) |
| `Failed to start server. Is port 7777 in use?` | [Hub](/troubleshooting/hub/#failed-to-start-server-is-port-7777-in-use) |
| `The Hub's web UI isn't built.` | [Hub](/troubleshooting/hub/#the-hubs-web-ui-isnt-built) |
| `Dev login (KNDL_DEV_LOGIN) is refused: …` | [Hub](/troubleshooting/hub/#dev-login-kndl_dev_login-is-refused) |
| The Hub refuses `HUB_SECRETS_KEY` | [Hub](/troubleshooting/hub/#the-hub-refuses-hub_secrets_key) |
| The secrets key is lost | [Hub](/troubleshooting/hub/#the-secrets-key-is-lost) |
| `… a Hub is running on …/hub.db. Stop it first.` | [Hub](/troubleshooting/hub/#a-hub-is-running-on-hubdb) |
| `HubConfigError: …` about GitHub settings | [Hub](/troubleshooting/hub/#hubconfigerror-about-the-github-settings) |
| A Session can't start because of an MCP server Installation | [Hub](/troubleshooting/hub/#a-session-cant-start-because-of-an-installation) |
| An MCP server's tools fail in a running Session | [Hub](/troubleshooting/hub/#an-mcp-servers-tools-fail-in-a-session) |
| **Couldn't connect** an OAuth Installation | [Hub](/troubleshooting/hub/#couldnt-connect-an-oauth-installation) |
| **Enter a client** for an OAuth Installation | [Hub](/troubleshooting/hub/#an-oauth-installation-asks-for-a-client) |
| A **Global** Installation can't be changed | [Hub](/troubleshooting/hub/#a-global-installation-cant-be-changed) |
| `Only the web UI at … may make this request` | [Signing in](/troubleshooting/sign-in/#only-the-web-ui-may-make-this-request) |
| Sign-in doesn't stick | [Signing in](/troubleshooting/sign-in/#sign-in-doesnt-stick) |
| `the sign-in expired or came from elsewhere` | [Signing in](/troubleshooting/sign-in/#the-sign-in-expired-or-came-from-elsewhere) |
| `This Hub is invite-only.` | [Signing in](/troubleshooting/sign-in/#this-hub-is-invite-only) |
| `GitHub refused the sign-in: …` | [Signing in](/troubleshooting/sign-in/#github-refused-the-sign-in) |
| No **Sign in with GitHub** button | [Signing in](/troubleshooting/sign-in/#theres-no-sign-in-with-github-button) |
| `Dev login only answers on loopback` | [Signing in](/troubleshooting/sign-in/#dev-login-only-answers-on-loopback) |
| `kndl login`: the browser can't connect to `127.0.0.1` | [Signing in](/troubleshooting/sign-in/#kndl-login-the-browser-cant-connect-to-127001) |
| `That code isn't valid` | [Signing in](/troubleshooting/sign-in/#that-code-isnt-valid) |
| `… doesn't accept this machine's CLI token` | [Signing in](/troubleshooting/sign-in/#the-hub-doesnt-accept-this-machines-cli-token) |
| `Hub connection: could not connect to …` | [Runners](/troubleshooting/runners/#hub-connection-could-not-connect) |
| A Runner on another machine never shows up | [Runners](/troubleshooting/runners/#a-runner-on-another-machine-never-shows-up) |
| `That pairing code can't be used` | [Runners](/troubleshooting/runners/#that-pairing-code-cant-be-used) |
| `Runner: not connected to the Hub after 30 seconds` | [Runners](/troubleshooting/runners/#runner-not-connected-to-the-hub-after-30-seconds) |
| `The Hub doesn't accept this Runner's token` | [Runners](/troubleshooting/runners/#the-hub-doesnt-accept-this-runners-token) |
| `Runner … has … that aren't Archived.` | [Runners](/troubleshooting/runners/#remove-says-the-runner-has-sessions) |
| `this Runner needs an update`, or **behind the Hub** | [Runners](/troubleshooting/runners/#this-runner-needs-an-update) |
| **refuses: not on main** | [Runners](/troubleshooting/runners/#refuses-not-on-main) |
| **update failed** | [Runners](/troubleshooting/runners/#update-failed) |
| `The Hub turned this Runner away: …` | [Runners](/troubleshooting/runners/#the-hub-turned-this-runner-away) |
| A Session is Frozen | [Runners](/troubleshooting/runners/#a-session-is-frozen) |
| `Unknown Sandbox for Session …` | [Runners](/troubleshooting/runners/#unknown-sandbox-for-session) |
| `The hub-link mod isn't built` | [Runners](/troubleshooting/runners/#the-hub-link-mod-isnt-built) |
| `Expected string at ["RUNNER_TOKEN"]`, from a checkout | [Develop kndl](/contributing/develop-kndl/#run-a-runner) |
| `Claude Code could not start on …` | [Sessions](/troubleshooting/sessions/#claude-code-could-not-start) |
| `Claude Code exited with code …` | [Sessions](/troubleshooting/sessions/#claude-code-exited) |
| A woken Session's conversation starts over | [Sessions](/troubleshooting/sessions/#a-woken-sessions-conversation-starts-over) |
| `… Sessions can't start: … need values` | [Sessions](/troubleshooting/sessions/#variables-need-values) |
| `The Sandbox failed: …` | [Sessions](/troubleshooting/sessions/#the-sandbox-failed) |
| **Test build failed** | [Sessions](/troubleshooting/sessions/#test-build-failed) |
| `You don't have access to … on GitHub` | [Sessions](/troubleshooting/sessions/#you-dont-have-access-to-a-repo) |
| A Sensitive variable can't be saved | [Sessions](/troubleshooting/sessions/#a-sensitive-variable-cant-be-saved) |
| New Session asks for your Claude credential, or a Session sleeps for want of one | [Sessions](/troubleshooting/sessions/#you-have-no-claude-credential) |
| `Only …, who started this Session, can drive it` | [Sessions](/troubleshooting/sessions/#only-someone-else-can-drive-this-session) |
| A Claude credential can't be saved | [Sessions](/troubleshooting/sessions/#a-claude-credential-cant-be-saved) |
| `There is no such Session.` | [Sessions](/troubleshooting/sessions/#there-is-no-such-session) |
| A Session doesn't go to sleep | [Sessions](/troubleshooting/sessions/#a-session-doesnt-go-to-sleep) |
| **Restart** or **Sleep now** is refused | [Sessions](/troubleshooting/sessions/#restart-or-sleep-now-is-refused) |
| **Environment changed** stays | [Sessions](/troubleshooting/sessions/#environment-changed-stays) |
| `git clone exited with 128` | [GitHub and git](/troubleshooting/github-and-git/#git-clone-exited-with-128) |
| `The GitHub App is not installed on …, or can't see it` | [GitHub and git](/troubleshooting/github-and-git/#the-github-app-is-not-installed-on-the-repo) |
| **The GitHub App is missing permissions** | [GitHub and git](/troubleshooting/github-and-git/#the-github-app-is-missing-permissions) |
| `git push` or `gh` fails in a Session | [GitHub and git](/troubleshooting/github-and-git/#git-push-or-gh-fails-in-a-session) |
| Claude pushed to the default branch | [GitHub and git](/troubleshooting/github-and-git/#claude-pushed-to-the-default-branch) |

## Still stuck

Search the [issues](https://github.com/kddige/kndl/issues), or open one with:

- what you ran,
- the exact message you saw,
- the relevant lines of `kndl logs hub` and `kndl logs runner`,
- the output of `kndl status`.

Remove tokens and keys first. kndl's own tokens start with `ch`, a letter and `_`, such as `chr_…` or `chc_…`.
