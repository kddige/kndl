---
title: Run the Hub
description: Run an installed Hub as a service, or run it from a checkout with the web UI built or beside Vite, and choose how people sign in.
sidebar:
  order: 2
---

The Hub serves the web UI, holds the Sessions' state, and is where Runners connect. This page runs it as a service on an install, or by hand from a checkout, and chooses how people sign in.

## On an install

[`kndl onboard`](/self-hosting/install/#set-the-machine-up) installed the Hub as a service. It serves the web UI at `HUB_PUBLIC_URL`, and logs to `~/.kndl/logs/hub.log`.

```sh
kndl hub status    # whether the service runs
kndl logs hub -f   # follow its log
kndl hub stop      # stop it until the next start or login
kndl hub start
```

Its settings are in `~/.kndl/hub.env`, listed in the [configuration reference](/reference/configuration/#hub). After changing the file, run `kndl hub install` to restart the Hub with it, or change them with `kndl onboard`.

Next, [add a Runner](/self-hosting/add-a-runner/). To let other machines and people reach the Hub, see [Reach the Hub from other machines](/self-hosting/reach-the-hub-from-other-machines/).

## From a checkout

There are two ways to run the Hub and the web UI from a checkout. `HUB_PUBLIC_URL` names whichever origin browsers open.

| Setup | Commands | Open | `HUB_PUBLIC_URL` |
|---|---|---|---|
| **Built, served by the Hub**: one process on one port, as in production | `bun run web:build`, then `bun run hub` | <http://127.0.0.1:7777> | `http://127.0.0.1:7777`, the Hub's own URL |
| **Development**, with Vite's hot reload | `bun run hub` and `bun run web` | <http://localhost:5173> | `http://localhost:5173`, the default |

### Serve the built web UI from the Hub

```sh
bun run web:build
HUB_PUBLIC_URL=http://127.0.0.1:7777 bun run hub
```

`bun run web:build` builds the web UI into `packages/web/dist`, where the Hub looks by default (`HUB_WEB_DIR`). The Hub logs `Serving the web UI from …` at startup. A new build shows on the next reload, without restarting the Hub.

### Run the web UI with Vite

```sh
bun run hub     # the Hub, on http://127.0.0.1:7777
bun run web     # the web UI, on http://localhost:5173
```

Vite passes the Hub's routes through to it (at `HUB_URL`, default `http://127.0.0.1:7777`), so `HUB_PUBLIC_URL` keeps its default, `http://localhost:5173`. To work on the web UI with no Hub, see [Develop kndl](/contributing/develop-kndl/#work-on-the-web-ui).

### Keep the configuration in `.env.local`

`bun run hub` and the Hub's other scripts read `packages/hub/.env.local`; values already in the environment win. git ignores `.env*` and `*.pem` files.

```sh
# packages/hub/.env.local
HUB_PUBLIC_URL=http://127.0.0.1:7777
GITHUB_CLIENT_ID=Iv1.…
GITHUB_CLIENT_SECRET=…
GITHUB_APP_ID=…
GITHUB_APP_PRIVATE_KEY_PATH=/home/you/.kndl-dev/github-app.pem
HUB_SECRETS_KEY=…   # from `bun run secrets-key`
```

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

- **GitHub sign-in**, for a team: [set up the GitHub App](/self-hosting/set-up-the-github-app/), then [become the Hub's Owner](/self-hosting/let-people-in/#become-the-owner) and invite everyone else.
- **Dev login**, for trying it on one machine: `KNDL_DEV_LOGIN=1`, which onboard offers for a `local` Hub, lets anyone who reaches the Hub sign in as any name. The Hub refuses to start with it unless `HOST` and `HUB_PUBLIC_URL` are both loopback.

With neither, the sign-in page says the Hub has no way to sign in turned on.

## Stop the Hub

On an install, run `kndl hub stop`; from a checkout, press Ctrl-C. Sessions keep running on their Runners meanwhile, and the Runners reconnect when the Hub comes back.

## Check it's up

```sh
curl http://127.0.0.1:7777/health
# {"status":"ok"}
```

`/health` needs no sign-in. On an install, `kndl status` checks it for you.
