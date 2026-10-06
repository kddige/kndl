---
title: Run the Hub
description: Run an installed Hub as a service, or run it from a checkout with the web UI built or beside Vite, and choose how people sign in.
sidebar:
  order: 2
---

The Hub serves the web UI, holds the Sessions' state, and is where Runners connect. On an install it runs as a service; from a checkout you run it yourself.

## On an install

[`kndl onboard`](/how-to/install/#set-the-machine-up) installed the Hub as a service that starts at login and restarts if it crashes. It serves the web UI onboard built, at `HUB_PUBLIC_URL`, and logs to `~/.kndl/logs/hub.log`.

```sh
kndl hub status    # whether the service runs
kndl logs hub -f   # follow its log
kndl hub stop      # stop it until the next start or login
kndl hub start
```

Its settings are in `~/.kndl/hub.env`; every one is in the [configuration reference](/reference/configuration/#hub). After changing the file, `kndl hub install` restarts the Hub with it. `kndl onboard` changes the settings by asking, and restarts it too.

Next, [add a Runner](/how-to/add-a-runner/). To let other machines and people reach the Hub, see [Reach the Hub from other machines](/how-to/reach-the-hub-from-other-machines/).

## From a checkout

The web UI reaches the Hub on its own origin, so there are two ways to run them from a checkout. `HUB_PUBLIC_URL` names whichever origin browsers open.

| Setup | Commands | Open | `HUB_PUBLIC_URL` |
|---|---|---|---|
| **Built, served by the Hub**: one process on one port, as in production | `bun run web:build`, then `bun run hub` | <http://127.0.0.1:7777> | `http://127.0.0.1:7777`, the Hub's own URL |
| **Development**, with Vite's hot reload | `bun run hub` and `bun run web` | <http://localhost:5173> | `http://localhost:5173`, the default |

### Serve the built web UI from the Hub

```sh
bun run web:build
HUB_PUBLIC_URL=http://127.0.0.1:7777 bun run hub
```

`bun run web:build` builds the web UI into `packages/web/dist`, which is where the Hub looks by default (`HUB_WEB_DIR`). The Hub logs `Serving the web UI from …` at startup.

A new build shows on the next reload, without restarting the Hub: only the files under `/assets/`, which are named by a hash of their contents, are cached.

Without a build the Hub still starts. It logs a warning and its pages answer 503 with how to build one.

### Run the web UI with Vite

```sh
bun run hub     # the Hub, on http://127.0.0.1:7777
bun run web     # the web UI, on http://localhost:5173
```

Vite passes `/auth`, `/health`, `/runner/` and `/ws` through to the Hub (at `HUB_URL`, default `http://127.0.0.1:7777`), so the web UI and the Hub share one origin. `HUB_PUBLIC_URL` keeps its default, `http://localhost:5173`.

To work on the web UI with no Hub at all, `VITE_FAKE_HUB=1 bun run web` runs it against an in-process fake Hub that plays a scripted Session; `VITE_FAKE_HUB=signed-out` starts that signed out.

### Keep the configuration in `.env.local`

`bun run hub` and `bun run runner-token` run in `packages/hub`, where Bun reads `.env.local` when it exists. Values already in the environment win. git ignores `.env*` and `*.pem` files anywhere in the checkout.

```sh
# packages/hub/.env.local
HUB_PUBLIC_URL=http://127.0.0.1:7777
GITHUB_CLIENT_ID=Iv1.…
GITHUB_CLIENT_SECRET=…
GITHUB_APP_ID=…
GITHUB_APP_PRIVATE_KEY_PATH=/home/you/.kndl-dev/github-app.pem
HUB_SECRETS_KEY=…   # from `bun run secrets-key`
```

Every setting is in the [configuration reference](/reference/configuration/#hub).

### Make a secrets key

Sensitive Variables are encrypted at rest with `HUB_SECRETS_KEY`. Make one and put it in `.env.local`:

```sh
bun run secrets-key
```

:::danger[Back up the key with the database]
Once any Sensitive value is saved, the Hub refuses to start without the same key, and the values can't be read without it. Keep the key wherever you keep backups of the Hub's database (`hub.db`).
:::

## Choose how people sign in

The Hub needs at least one way to sign in:

- **GitHub sign-in**, for a team. Set up the GitHub App, which gives the Hub `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`: see [Set up the GitHub App](/how-to/set-up-the-github-app/). On an install, onboard offers to create it.
- **Dev login**, for trying it on one machine. `KNDL_DEV_LOGIN=1`, which onboard offers for a `local` Hub, lets anyone who reaches the Hub sign in as any name, without GitHub. The Hub refuses to start with it unless `HOST` and `HUB_PUBLIC_URL` are both loopback, and only answers it for loopback callers.

With neither, the sign-in page says the Hub has no way to sign in turned on.

## Stop the Hub

On an install, `kndl hub stop`; from a checkout, Ctrl-C (SIGINT) or SIGTERM. The Hub answers any waiting mod long poll with no commands, closes the Runner and web WebSockets with code 1001 (going away), and exits within a second. Runners reconnect when it comes back, and Sessions keep running on them in the meantime.

## Check it's up

```sh
curl http://127.0.0.1:7777/health
# {"status":"ok"}
```

`/health` needs no sign-in and answers once the Hub's database does. On an install, `kndl status` checks it for you, and `kndl doctor` checks everything else.
