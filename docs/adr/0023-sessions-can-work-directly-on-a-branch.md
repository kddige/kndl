---
status: accepted
---

# Sessions can work directly on a branch

A Session always worked on a Work branch of its own, `claude/<id>`, made from a base branch chosen in New Session. That is the safe default, but it is also the only choice: a person who wants Claude to commit to `main`, or to carry on a branch that already exists, has to ask for it after the Session starts (#234).

## How it works

- **A Session works on a branch the form picks.** New Session's Branch field is a combo box of the Repo's branches, and a "Work on a new branch" checkbox, on by default, says whether Claude commits to a new branch made from it or to the branch itself. The Repo field is a combo box of the Repos the GitHub App is installed on and the person has access to, with their own recent ones on top.
- **A new branch can be named in the same form.** A name that matches no branch offers "+ Create branch 'X'", which shows a "From" combo box that takes listed branches only. X is then the Work branch and the "From" branch is the base branch, so the checkbox is hidden.
- **`CreateSession.branch` is `Existing{name, newWorkBranch}` or `Create{name, from}`.** The Hub resolves it to the base and Work branches that a Session has always had:
  - `Existing` with `newWorkBranch`: base is `name`, work is `claude/<id>`.
  - `Existing` without: base and work are `name`.
  - `Create`: base is `from`, work is `name`.
- **`StartSession` is unchanged.** The Runner clones the base branch and runs `git switch --create` only when the Work branch is not the base branch.
- **The Hub checks no branch.** It trusts the form: a base branch that doesn't exist fails the clone, as it always did, and a new branch that already exists fails the `switch --create`. The protocol schema checks a new branch's name against git's ref rules (`git check-ref-format`), so the form can say why a name is refused before anything is sent.
- **The branch lists come from the GitHub App.** `ListRepos` and `ListBranches` read the App's installations and a Repo's branches with installation tokens, as the Hub already does for Repo access. The Repo list is filtered by `RepoAccess`, and kept for a few minutes per person. Without the App, or when GitHub can't answer, the form falls back to suggestions from the person's Sessions, says so, and lets them submit what they typed as an existing branch.
- **Several Sessions may share a branch.** The form warns ("1 active Session is already on main"), but does not refuse: the Sessions are separate Sandboxes with separate Workspaces, and git settles the rest when they push.
- **A Session on its base branch is titled by it and its short id**, `main · 3f96`, since the branch alone names nothing in particular. Its header says "on main" instead of "main from main".

## Considered options

- **Keep the Work branch always, and let Claude merge it.** The merge is what the person wanted to skip, and it leaves a `claude/<id>` branch behind for every small change.
- **A separate "Session on a branch" kind of Session.** The Runner and the Hub would have two start paths for what differs in one `git switch`.
- **Check branches in the Hub before starting.** It would turn a failed clone into a refusal with a better message, at the price of a GitHub call on every start and a second source of truth that goes stale between the form and the clone. The form already listed the branches.
- **Refuse a second Session on a branch.** Two Sessions on `main` are no more dangerous than two people pushing to it, and a refusal would have to be undone by archiving the first.

## Consequences

- **A Session on `main` can push to `main`.** The GitHub ruleset on the default branch is still the guardrail (ADR 0010); the Sandbox token has the same permissions it had.
- **A Session's Work branch may be a branch other people use,** so its commits are not its own: "ask Claude to commit and push the Work branch" now means pushing to that branch.
- **The Hub reads more from GitHub.** The Repos list asks once per installation and once per Repo's collaborator check, cached for a few minutes; it reads a Repo's branches, up to 2,000, whenever New Session picks one.
