---
status: superseded by 0026
---

> Superseded by [ADR 0026](0026-a-session-runs-on-and-is-driven-by-its-creator.md): a Session still belongs to its Repo, so Repo access decides who sees it. But only its Creator drives it: prompts it, controls it or opens its terminal. Other Participants watch. Delete still means archive, and only the Creator archives and restores.

# Sessions have no owner; they belong to their Repo

A Session is treated like code, not like one person's terminal. Anyone with access to its GitHub Repo can see and join it, and every Participant has equal rights, including deleting it. The Creator is recorded for history only.

The same goes for the Repo's Environment (ADR 0009, amended in #104). Anyone with Repo access can read and change it, and no one else can.

Because anyone can delete a Session, delete means archive. The Sandbox is destroyed, but the history and Workspace are kept, and anyone with Repo access can restore the Session for 30 days before it is purged. An undo toast covers accidents in the moment, and every destructive action is recorded in the Session's history with who did it.

## Considered options

- **Owner plus collaborators**: rejected because it ties a shared artifact to one person.
- **Viewer / prompter / approver roles**: more control than v1 needs.
- **A short scheduled-delete window**: replaced by the longer archive window.
