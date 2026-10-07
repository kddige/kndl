---
title: Let people in
description: Become your Hub's Owner with its Setup link, then invite people, revoke Invites and remove Members from the People page.
sidebar:
  order: 6
---

A Hub with GitHub sign-in is invite-only ([ADR 0019](/reference/decisions/0019-invites-decide-who-gets-in/)). GitHub proves who someone is; the Hub lets in only its Owner and the people the Owner invites. Everyone let in is a Member. Being a Member doesn't open any Repo: what each Member sees is still decided by their access to its Repo on GitHub ([Who can do what](/explanation/security-model/#who-can-do-what)).

Dev login needs none of this: on loopback, anyone who reaches the Hub signs in.

## Become the Owner

A new Hub has no Owner, and lets nobody in with GitHub but whoever brings its Setup link. `kndl onboard` prints one at the end when it sets up a Hub with GitHub sign-in:

```
The Hub has no Owner yet. Its Setup link, shown only now:

  https://hub.example.com/setup#cho_…

Open it and sign in with GitHub to become the Hub's Owner, then invite everyone else from the People page. It works once, and only until the Hub has an Owner; a new one replaces it.
```

1. Open the link in your browser.
2. Press **Continue with GitHub**, and sign in as the GitHub account that should own the Hub.

You're signed in, as the Hub's Owner, and the link no longer works. Anyone else who opens it, or signs in without an Invite, is told the Hub is invite-only.

To get a new link, run this on the Hub's machine. It replaces any earlier link, and is refused once the Hub has an Owner:

```sh
kndl hub setup-link        # an install
bun run setup-link         # a checkout
```

The link is a secret until it's used: anyone who opens it first becomes the Owner. Its secret is the part after `#`, which browsers never send to a server, so a proxy in front of the Hub doesn't log it. The Hub keeps only a hash of it.

:::note[Upgrading a Hub people already use]
Everyone who had signed in before the Hub became invite-only stays a Member, and the earliest of them to sign in with GitHub became the Owner. Nobody is locked out, and there is no Setup link to use.
:::

## Invite someone

The Owner has a **People** page in the sidebar. Nobody else sees it.

1. Open **People** and press **Invite someone**.
2. Optionally, type the GitHub login the Invite is for, such as `octocat`. Only that account can then use it, whatever its case. Leave it empty for anyone with the link.
3. Press **Make the link**, then **Copy link**, and send it to them yourself. kndl sends no email.

The link is shown only this once; the Hub keeps a hash of it. It admits one person, once, within 7 days. They open it, press **Continue with GitHub**, and are signed in as a Member. Then [install the App](/how-to/set-up-the-github-app/#install-the-app) on their Repos, or add them to yours, so they have a Repo to work in.

Under **Invites not used yet**, the People page lists each Invite until it is used or expires, with who it's for and how long it has left. **Revoke** ends one at once.

An Invite that was used, revoked, has expired or is for another login gets the same answer as no Invite at all: "This Hub is invite-only. Ask its owner for an invite." The Hub says nothing about which, and creates no account or sign-in for them. Make them a new Invite.

## Remove a Member

Under **Members**, press **Remove** beside someone, and confirm. At once:

- They're signed out of the web UI everywhere, and their open tabs and Forwards close.
- Their CLI tokens are revoked, so `kndl` on each of their machines needs `kndl login` again, and is refused until they're let back in.
- They can't sign in again without a new Invite.

Their Sessions stay, since a Session belongs to its Repo, and so does the Claude credential they stored: Sessions they created keep running on it. A tunnel they already had open stays open until it closes, and a Pairing code they made still works until it expires.

The Owner can't be removed, and there is one Owner. Other Members can do everything else the Owner can: [add Runners](/how-to/add-a-runner/), remove them and manage Shared variables.

## Make the GitHub App public

Since the Hub decides who gets in, the GitHub App needn't be private. A private App installs only on the account that owns it; a public one installs on any account, so one Hub can serve Repos across several organizations and people. In the App's settings on GitHub, open **Advanced** and press **Make public**. Anyone on GitHub can then install the App and try to sign in, but only Members get in, and each sees only the Repos they can reach.

Onboard still creates the App private. Making it public is your call.
