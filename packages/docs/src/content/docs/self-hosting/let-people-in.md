---
title: Let people in
description: Become your Hub's Owner with its Setup link, then invite people, revoke Invites and remove Members from the People page.
sidebar:
  order: 6
---

A Hub with GitHub sign-in lets in only its Owner and the people the Owner invites ([ADR 0019](/contributing/decisions/0019-invites-decide-who-gets-in/)). Everyone let in is a Member. Being a Member opens no Repo: each Member sees the Repos they can reach on GitHub ([Who can do what](/concepts/security-model/#who-can-do-what)).

With dev login, anyone who reaches the Hub signs in, and none of this applies.

## Become the Owner

Until it has an Owner, a Hub lets in only whoever brings its Setup link. `kndl onboard` prints it at the end:

```
The Hub has no Owner yet. Its Setup link, shown only now:

  https://hub.example.com/setup#cho_…

Open it and sign in with GitHub to become the Hub's Owner, then invite everyone else from the People page. It works once, and only until the Hub has an Owner; a new one replaces it.
```

1. Open the link in your browser.
2. Press **Continue with GitHub**, and sign in as the GitHub account that should own the Hub.

You're signed in as the Hub's Owner, and the link stops working.

To get a new link, run this on the Hub's machine. It replaces any earlier link, and is refused once the Hub has an Owner:

```sh
kndl hub setup-link        # an install
bun run setup-link         # a checkout
```

Keep the link secret until you've used it: whoever opens it first becomes the Owner.

## Invite someone

The Owner has a **People** page in the sidebar. Nobody else sees it.

1. Open **People** and press **Invite someone**.
2. Optionally, type the GitHub login the Invite is for, such as `octocat`. Only that account can then use it, whatever its case. Leave it empty for anyone with the link.
3. Press **Make the link**, then **Copy link**, and send it to them yourself. kndl sends no email.

The link is shown only this once. It admits one person, once, within 7 days. They open it, press **Continue with GitHub**, and are signed in as a Member. Then [install the App](/self-hosting/set-up-the-github-app/#install-the-app) on their Repos, or add them to yours, so they have a Repo to work in.

**Invites not used yet** lists each open Invite, with who it's for and how long it has left. **Revoke** ends one at once.

Someone with an Invite that was used, revoked, expired or is for another login sees "This Hub is invite-only. Ask its owner for an invite." Make them a new one.

## Remove a Member

Under **Members**, press **Remove** beside someone, and confirm. At once:

- They're signed out of the web UI everywhere, and their open tabs and Forwards close.
- Their CLI tokens are revoked, so `kndl` on each of their machines needs `kndl login` again, and is refused until they're let back in.
- They can't sign in again without a new Invite.

Their Sessions stay, and Sessions they created keep running on their Claude credential. A tunnel they had open stays open until it closes, and a Pairing code they made works until it expires.

The Owner can't be removed. Apart from the People page, Members can do what the Owner can: [add Runners](/self-hosting/add-a-runner/), remove them and manage Shared variables.

## Make the GitHub App public

A private GitHub App installs only on the account that owns it. To serve Repos across several accounts and organizations, make it public: in the App's settings on GitHub, open **Advanced** and press **Make public**. Anyone on GitHub can then install the App, but only Members get in, and each sees only the Repos they can reach.
