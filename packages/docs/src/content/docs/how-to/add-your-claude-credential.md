---
title: Add your Claude credential
description: Store your own Claude subscription token or API key on the Hub once, so the Sessions you start run on your account on any Runner.
sidebar:
  order: 4
---

The Sessions you start run on your own Claude account, on whichever Runner they are on ([ADR 0015](/reference/decisions/0015-each-person-brings-their-claude-credential/)). You paste a credential once, on your **Account** page, and every Runner fetches it for your Sessions. Without one, your Sessions run on their Runner's own login, where it has one.

## Before you start

The Hub must have `HUB_SECRETS_KEY` set, since it stores your credential encrypted. See [Use variables and secrets](/how-to/use-variables-and-secrets/#before-you-start).

You need one of these:

- **A Claude subscription** (Pro, Max, Team or Enterprise), and Claude Code installed on any machine to make a token with.
- **An Anthropic API key** (`sk-ant-api…`), from the Claude Console. Your Sessions are then billed per token.

## Make a token

In a terminal on any machine with Claude Code:

```sh
claude setup-token
```

Sign in with your Claude account in the browser it opens. It prints a token that starts with `sk-ant-oat` and is good for a year. Copy it all, on one line.

## Save it on the Hub

1. Open your **Account** page: press your name at the bottom of the sidebar, then **Account**. New Session links to it too, while you have no credential.
2. Under **Claude**, paste the token or API key into **Token or API key**.
3. For a token, pick your **Plan**: Pro, Max 5x, Max 20x, Team or Enterprise. Claude Code is told it, since it can't ask Anthropic through the Runner's credential proxy. An API key has no plan.
4. Press **Save**.

The Hub checks it with Anthropic before it stores it, with a request that costs nothing:

- **Anthropic rejects it:** the Hub refuses it and says why, such as `Anthropic rejected this token: it is invalid.` Nothing is stored. Make a new token and paste that.
- **Anthropic can't be reached:** the Hub stores it anyway and says so, under the saved credential. If it turns out to be wrong, your Sessions can't run a Turn until you replace it.

Once saved, your credential is write-only. The page shows its kind, its last 4 characters, its plan and when you added it, never the token itself.

## Replace or remove it

- **Replace**, to paste a new token, such as when the old one expires or your plan changes. Sessions pick up the new one as they next start or wake.
- **Remove**, to take it off the Hub. Your Sessions then run on their Runner's own login, and the Hub refuses to start one on a Runner without one.

A Session that is awake keeps the credential it started with until it next sleeps.

## See whose account a Session runs on

A Session's header says whose Claude account it runs on: **on Alice's Claude account** for its Creator's, or **on the Runner's Claude account** with the Runner login, when its Creator has none. A Child Session runs on its Parent Session's Creator's.
