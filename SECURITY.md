# Security policy

## Report a vulnerability

Report it privately: on this repository's **Security** tab, select **Report a vulnerability**. Don't open a public issue, pull request or discussion about it.

Include what you found, how to reproduce it, and what an attacker gains. We reply as soon as we can and keep you updated until it's fixed.

kndl is early and maintained in spare time. There is no bug bounty and no response-time guarantee. Fixes land on `main` and ship in the next Release; older Releases get no backports.

## What's in scope

kndl runs code that agents write, so the [Sandbox is the security boundary](docs/adr/0004-the-sandbox-is-the-security-boundary.md). Report anything that breaks the guarantees around it, for example:

- **Leaving the Sandbox.** Code in a Sandbox reaching the Runner's host, another Session's Sandbox or Workspace, or a Runner or Hub endpoint without its token.
- **Credentials leaking.** A Claude credential, the GitHub App's private key, a Runner token or a mod token reaching a Sandbox, a disk, a log or a transcript ([ADR 0015](docs/adr/0015-each-person-brings-their-claude-credential.md)). Anything that lets a Session's proxy token use another Session's credential.
- **The Sandbox's GitHub token** reaching beyond its Session's Repo, or outliving its Session ([ADR 0010](docs/adr/0010-the-sandbox-gets-a-github-token.md)).
- **Getting into a Hub.** Signing in without the Owner, a Member account, a Setup link or a valid Invite; reusing an Invite; or a removed Member keeping access ([ADR 0019](docs/adr/0019-invites-decide-who-gets-in.md)).
- **Crossing Repo access.** A Member seeing or driving Sessions, Environments or Variables of a Repo they can't access on GitHub.
- **Sensitive values** shown unmasked, or decryptable without the Hub's secrets key.
- **Third-party content.** A Plugin's icon or MCP server running script in the Hub's origin, or the Hub fetching where it shouldn't ([ADR 0021](docs/adr/0021-plugin-icons-are-fetched-by-the-hub-never-by-the-browser.md)).

## What's not a vulnerability

These are how kndl is designed. The ADRs explain why:

- Anything running in a Sandbox can read its Session's Environment Variables and use its GitHub token to push to and merge in that Repo. Protect the default branch with a GitHub ruleset.
- Sandboxes have unrestricted network access, including the LAN.
- A Runner's owner is trusted with the Workspaces and Claude credentials of the Sessions on their Runner.
- Every Member can do Hub-wide actions: make Pairing codes, remove Runners, edit Shared variables.
- Dev login, which only listens on loopback.
