---
title: Coordinate with Child Sessions
description: Have a Session hand parts of its work to Child Sessions, follow their Reports, prompt them yourself, and delete them.
sidebar:
  order: 9
---

A Session can hand parts of its work to [Child Sessions](/reference/glossary/): full Sessions that each work on one task, on their own Work branch and in their own Sandbox, while the Session that created them, their [Parent Session](/reference/glossary/), goes on with its own. Each Child Session sends a [Report](/reference/glossary/) when a Turn ends. At the end of this guide, one Session coordinates the others and tells you what they did. The design is [ADR 0012](/reference/decisions/0012-parent-and-child-sessions/).

## Before you start

- A Session to coordinate from: see [Work in a Session](/how-to/work-in-a-session/). Any Session can be a Parent Session, except a Child Session.
- An online Runner that can take more Sessions.

## Ask a Session to delegate

Child Sessions are created by Claude, not from the web UI. In the Session, ask for it in a prompt:

```
Hand the API docs and the changelog to two Child Sessions, and tell me when both are done.
```

Claude calls its `create_child` tool once per task, with a brief, a name such as "API docs", and optionally a base branch. Each Child Session:

- runs in the Parent Session's Repo, for the Parent Session's Creator. The Hub checks that the Creator can still use the Repo before it creates one.
- starts from the Repo's default branch, unless Claude names a base branch. Without the GitHub App, it starts from the Parent Session's base branch.
- runs on the Parent Session's Runner when that Runner can take it, and on another online Runner otherwise.
- gets the brief as its first prompt, shown in its transcript as from the Parent Session.
- can't create Child Sessions of its own. There is no limit to how many a Parent Session creates.

A Child Session is listed in the sidebar under its Repo, like any Session.

## Follow their Reports

When a Child Session's Turn ends, whoever prompted it, its final message goes to its Parent Session as a Report: a prompt in the Parent Session's Prompt queue. A Report wakes an Asleep Parent Session.

In the Parent Session's transcript, a Report shows the Child Session's name, linked to it, with **Report from Child Session** beside it. Claude reads the Report and tells you what matters; it's told that you don't see Reports yourself.

While a Report waits in the Prompt queue, it shows there with the Child Session's name, and anyone can cancel it, as any queued prompt.

From the 20th Turn in a row that the Parent Session prompted, with no person's prompt to either Session in between, each Report reminds Claude to check that the work is still making progress. Nothing is stopped.

## Prompt a Child Session yourself

Open a Child Session from the sidebar, or from its name on a Report. It's a full Session: prompt it, open its terminal, or put it to sleep, as in [Work in a Session](/how-to/work-in-a-session/). The Parent Session's messages show there with **Parent Session** beside its name.

The Turns your prompts start report to the Parent Session too, so the Parent Session hears about what you asked.

## Delete them

When you delete a Parent Session with **Delete Session**, the Hub archives its Child Sessions with it. So you see what goes, the web UI asks first, listing them with their states. **Undo** in the toast restores only the Parent Session. To restore a Child Session, use **Archived Sessions** in the sidebar; once restored, it's the Parent Session's child again.

Claude can archive one of its own Child Sessions with its `archive_child` tool once the work is done. A Child Session's Reports stop reaching a Parent Session that's Archived.

## Next

- [Protocol](/reference/protocol/#child-session-tools): each tool, and how the mod asks the Hub.
- [Session lifecycle](/explanation/session-lifecycle/): what deleting and restoring keep.
