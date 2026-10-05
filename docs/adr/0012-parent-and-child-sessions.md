---
status: accepted
---

# Sessions delegate work to Child Sessions

Any Session can create **Child Sessions** and coordinate them: give each a task, message it, read its work, and archive it when its work is merged. This is the operator loop people already run with Claude Code's subagents, moved onto the Hub so it keeps running when no one is watching and everyone with access can follow it. "Coordinator" is a way of using a Session, not a kind of Session: there is one mechanism, and a pinned Session with a coordinating prompt serves as a Repo's "main" Session.

**A Child Session is a full Session.** It has its own Sandbox, clone, Work branch and tmux, shows in the web UI, and people can open it and prompt it like any other. Work runs in parallel and in isolation, and stays reviewable and steerable. Claude Code's in-process Agent tool stays off in Sessions: it would share the parent's files and branch, invisible and unreachable.

**The tree is one level deep.** A Child Session can't create children of its own, so a coordinator can't fan out without bound. There is no limit on how many children one Session has.

**A child acts with its parent's authority, in its parent's Repo.** Its Creator is the parent's Creator, so a coordinator can never start work its Creator couldn't start by hand, and the Repo access check, the clone token and the git identity (#110) all keep meaning what they mean. Children are in the parent's Repo only: every check is per Repo, and coordinating across Repos is rarer than the permission surface it would add. The Hub places a child on a Runner by the same rules as New Session, preferring the parent's Runner, and a child starts from the Repo's default branch unless the parent names another branch or commit.

**What a parent can do** (tools the mod gives every Session): create a child (a task prompt, an optional name, an optional base), message a child (queued as a prompt), list its children with status and last report, read a child's recent conversation, and archive a child. A parent reads a child's code by fetching its branch with git in its own Sandbox; merging stays `gh` in the Sandbox, as before. A child gets one tool: message its parent mid-Turn.

**Reports.** Every time a child ends a Turn, whoever prompted it, its final message is delivered to the parent as a **Report**: queued as a prompt, wrapped in a short note saying which child sent it, that it is a Report and not a person's prompt, and that more may follow. A Report wakes an Asleep parent. In the child's transcript, the parent's prompts show as coming from the Parent Session.

**How Claude Code learns the system.** As with Claude Code's own subagents, the mechanics live where the model meets them: in the tools' descriptions (when to delegate, that children report on their own, never to state a result that hasn't arrived, that people don't see a Report so the parent relays what matters), in each Report's note, and, for a Child Session, one paragraph appended to its system prompt saying whose child it is and how it reports. There is no skill to trigger.

**Lifecycle.** A finished child goes Asleep like any idle Session. Archiving a parent archives its children; the confirmation lists them. Restoring a parent restores only the parent; its children are restored one by one and nest under it again. People can't create a child from the web UI: the tree means "what this Session delegated".

**Session names.** Every Session gets an editable name, defaulting to its Work branch. New Session never asks for one; anyone with access, and a Session's parent, can rename it. The web UI's sidebar groups Sessions under their Repo, nests children under their parent (folded only with the chevron, expanded by default), and orders everything by creation.

## Considered options

- **A dedicated "main" Session per Repo**, a distinct kind with its own powers. Clearer who is in charge, but two kinds of Session to build, explain and secure, and "one per Repo" breaks as soon as two efforts run in parallel.
- **Children as Claude Code subagents inside the parent's Sandbox.** Cheap, but shared files and branch, invisible in the UI, and no way for a person to step in.
- **Children in any Repo the Creator can access.** Cross-Repo coordination, at the cost of a much larger permission surface.
- **The child acts as whoever's prompt led to it, or as a bot.** Either breaks "a coordinator can't do what its Creator couldn't".
- **An explicit report tool, or polling.** A child that forgets to report goes silent; polling wastes Turns. Reporting every Turn end matches Claude Code's subagents.
- **A skill describing the system.** Loaded only when triggered, whereas tool descriptions and Report notes are always where the model needs them.
