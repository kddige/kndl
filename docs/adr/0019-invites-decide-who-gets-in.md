---
status: accepted
---

# Invites decide who gets in

A Hub is invite-only (#209). GitHub proves who someone is; the Hub decides whether they get in.

Until now the Hub signed in whoever GitHub sent back, and the GitHub App being private was the only limit: GitHub lets only the owning account's members authorize a private App. But a private App installs only on the account that owns it, so one Hub couldn't serve several organizations or people. With a public App, anyone on GitHub could sign in. Repo access (ADR 0003, ADR 0009) would still keep them out of your Repos' Sessions and Environments, but everything open to anyone signed in would be open to strangers: starting a Session on your Runners in a Repo of their own, pairing a Runner of their own for your teammates' Sessions to land on, removing your Runners, and overwriting the Shared variables your Environments link.

## How it works

- **The Owner.** A Hub has one Owner, a Participant. A new Hub has none, and lets nobody in with GitHub but whoever brings its **Setup link**: a one-time secret made on the Hub's machine, by `kndl onboard` as it sets up a Hub with GitHub sign-in, or by `kndl hub setup-link` later. Whoever signs in with it becomes the Owner, and it stops working. A new Setup link replaces the last, and none is made once the Hub has an Owner. The first person to sign in doesn't become the Owner: that would let whoever reaches a new Hub first take it.
- **Invites.** The Owner makes Invites on the web UI's People page. Each is a link with a random secret, which admits one person, once, within 7 days. It can be tied to one GitHub login, matched ignoring case, or left for anyone with the link. The Owner sees the link once, lists the Invites not yet used, and can revoke one.
- **Members.** Everyone admitted is a Member. The Owner lists them and can remove anyone but themselves. Removing someone revokes their sign-ins and CLI tokens at once, and closes their web connections and Forwards. They need a new Invite to come back. Their Sessions belong to their Repos (ADR 0003) and their Claude credential (ADR 0015) is theirs, so both stay.
- **Signing in.** When GitHub sends someone back, the Hub lets them in as the Owner or a Member already; else, while there's no Owner, with a valid Setup link; else with a valid Invite. Anyone else is turned away with the same page, "This Hub is invite-only. Ask its owner for an invite.", whatever they brought: an Invite that was used, expired, revoked, for another login or never made, or none at all. The Hub creates no Participant and no sign-in for them.
- **Secrets stay out of logs.** A Setup link's or Invite's secret is the link's fragment (`/setup#cho_…`, `/invite#chi_…`), which browsers never send to a server. The page hands it to the Hub in a `POST` just before going to GitHub, and the Hub keeps it in a cookie beside the OAuth state until GitHub sends the browser back. It trusts nothing from GitHub's redirect beyond the code. Both secrets are stored as hashes, like a Pairing code's.
- **Upgrading.** A Hub that already had Participants keeps every one of them admitted, and the earliest to have signed in with GitHub becomes its Owner. Nobody already using a Hub is locked out.

What doesn't change: Repo access still decides what each Member sees and can do in Sessions and Environments. Hub-wide actions (Pairing codes, removing Runners, Shared variables) stay open to every Member. Dev login, on loopback only, needs no Invite; its people are Members but never the Owner.

## Considered options

- **A `HUB_ALLOWED_OWNERS` environment variable** listing who may sign in. It is set by hand on the Hub's machine, needs a restart for every change, and duplicates what GitHub already knows about people.
- **Approving the App's installations and admitting their members,** checked with `GET /user/installations` at sign-in. It works, but it needs an approval flow, and an operator role to approve, anyway.
- **A separate OAuth App for sign-in.** Anyone can authorize an OAuth App, so the Hub still needs its own admission check, with worse tools: `read:org`, and each organization approving third-party apps.
- **One private App per organization.** GitHub would then decide who gets in, but it takes an App per account, a picker at sign-in, routing each Repo to its App, and it leaves out outside collaborators.

Invites are the simplest. They work with one public App, cover organization members, personal accounts and outside collaborators alike, and don't depend on GitHub's membership rules.

## Consequences

- **The GitHub App can be made public,** so it installs on several accounts. That is each Hub's call; onboard still creates it private.
- **One more thing to hand out.** Each new person needs an Invite from the Owner. Admitting an organization's members automatically could come later, if inviting by hand gets tedious.
- **One Owner, no other roles.** Nobody else can invite or remove people, and ownership can't be handed over from the web UI. Hub-wide actions stay open to every Member, as before.
- **Losing the Owner's GitHub account** leaves the Hub without anyone to invite people until ownership is changed in its database. Removal never applies to the Owner.
- **Removal is about signing in.** A removed Member's web connections and Forwards close at once, but a Pairing code they made still works until it expires, a tunnel already open stays open until it closes, and a prompt they queued still runs, as when someone loses Repo access or a CLI token is revoked.

## Amendment: a removed Member's Sessions sleep (ADR 0026)

A removed Member's Sessions still belong to their Repos, and their setup token is still theirs. But the Hub won't hand that token to a Runner any more. It puts the removed Member's awake Sessions to sleep and says why. Those Sessions stay readable, and Fork (#332) is how someone else carries one on.

## Amendment: the Owner updates the Hub (ADR 0028)

"One Owner, no other roles" still holds, but the Owner now has rights beyond who gets in. They alone see whether a newer kndl is out, on the Hub page, and update the Hub, pick its Channel and update its Runners from the web UI: each changes what every Member's Sessions run on. The Hub refuses those from anyone else. Other Hub-wide actions stay open to every Member.
