---
title: Add your Claude credential
description: Store your own Claude subscription token or API key on the Hub once, so the Sessions you start run on your account on any Runner.
sidebar:
  order: 4
---

Paste your Claude credential once, on your **Account** page, and the Sessions you start run on your own Claude account on any Runner ([ADR 0015](/reference/decisions/0015-each-person-brings-their-claude-credential/)). Without one, your Sessions run on their Runner's own credential, where it has one; if no online Runner has one, **New Session** asks you to add yours first.

## Before you start

The Hub must have `HUB_SECRETS_KEY` set, since it stores your credential encrypted. See [Use variables and secrets](/how-to/use-variables-and-secrets/#before-you-start).

You need one of these:

- **A Claude subscription** (Pro, Max, Team or Enterprise), and Claude Code on any machine to make a token with.
- **An Anthropic API key** (`sk-ant-api…`), from the Claude Console, billed per token.

## Make a token

In a terminal on any machine with Claude Code:

```sh
claude setup-token
```

Sign in in the browser it opens. It prints a token starting `sk-ant-oat`, good for a year. Copy it all, on one line.

## Save it on the Hub

1. Open your **Account** page: press your name at the bottom of the sidebar, then **Account**.
2. Under **Claude**, paste the token or API key into **Token or API key**.
3. For a token, pick your **Plan**: Pro, Max 5x, Max 20x, Team or Enterprise.
4. Press **Save**.

The Hub checks it with Anthropic, at no cost, before storing it. If Anthropic rejects it, nothing is stored and the Hub says why, such as `Anthropic rejected this token: it is invalid.` Make a new token and paste that. If Anthropic can't be reached, the Hub stores it anyway and says so.

Once saved, the page shows its kind, its last 4 characters, its plan and when you added it, never the token itself.

## Replace or remove it

- **Replace**, to paste a new token, such as when the old one expires or your plan changes.
- **Remove**, to take it off the Hub. Your Sessions then run on their Runner's own credential.

A Session picks up the change when it next starts or wakes.

## See whose account a Session runs on

A Session's header says whose Claude account it runs on: its Creator's, such as **on Alice's Claude account**, or **on the Runner's Claude account**, followed by the Runner's credential as the Runners page shows it, when its Creator has none. Its subagents run on the same account.
