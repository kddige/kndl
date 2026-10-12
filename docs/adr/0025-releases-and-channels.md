---
status: accepted
---

# Releases and Channels

Until now an install followed `main`, and kndl had no version: a Hub and its Runners were identified by a commit (ADR 0011). That's fine while the only users are the people building it. Once kndl is open source, people need a version to install, to report a bug against, and to read the changes of. So kndl gets Releases: tags on `main`, named by date, with notes built from PR titles. An install picks a Channel to follow.

## How it works

- **A Release is a tag on `main`, named by date.** The version is `year.month.n`, like `2026.10.1`, with no zero-padding. `n` counts the Releases within the month, starting at 1, and isn't a day of the month. The git tag adds a `v`: `v2026.10.1`. A Release is never re-tagged or moved, and a fix always gets a new version. There are no maintenance branches: every Release is cut from `main`.
- **Releases are cut by hand, when `main` is worth one.** Someone pushes the tag (an agent can, following `docs/agents/releasing.md`). A workflow then runs CI on the tagged commit and creates the GitHub Release. Nothing is released on a schedule.
- **An install follows a Channel:** `stable` (the latest Release) or `dev` (`main`). `install.sh` defaults to `stable`. Installs from before this follow `main`, and stay on `dev` until someone moves them, for example with `kndl update --channel stable`. Nobody's Hub changes what it runs without being asked. `--ref` still pins a branch, tag or commit, as it does today.
- **Runners don't have a Channel.** A Runner still follows the Hub's commit, and still only a commit reachable from `origin/main` (ADR 0011). A Release is a tag on `main`, so that rule already accepts every Release, and doesn't change. The Hub's install decides the Channel for all its Runners.
- **The version is shown where the commit is.** A Hub or Runner on a Release reports its version, like `2026.10.1`. One on `dev` reports its commit, as now. The protocol version (`packages/protocol/src/Version.ts`) stays separate: it says which Hubs and Runners can talk to each other, not what was released.
- **Release notes are built from PR titles.** Every PR is squash-merged with its title as the commit title, so `main`'s history is the list of changes. A title is `<areas>: <change> (#<issue>)`. `<areas>` is one or more of `hub`, `runner`, `web`, `cli`, `mod`, `protocol`, `docs`, `brand`, `ci` and `repo`, separated by commas, with the main area first. The notes list a Release's PRs under their first area, below a few highlights written by hand. A feature built over several PRs names itself after the colon: `web, hub: attachments 3, in steered prompts`.
- **Titles are checked before they reach `main`.** A `pr-title` check validates every PR title, and a ruleset on `main` requires a PR and that check, and allows squash merges only. Commits inside a PR have no convention, since squashing drops them.

## Considered options

- **Semantic versions (`0.y.z`, then `1.0.0`).** kndl has no API that others build on, so a major or minor bump would be a judgement call with nothing behind it, and `0.x` would say nothing while v1 is being built. Date versions say how old an install is, which is what a bug report needs. openclaw uses the same scheme.
- **A beta Channel.** openclaw ships `-beta.N` prereleases and promotes them. For one maintainer, that's a second release per release. It can be added later without changing the versions: a `-beta.N` tag sorts before its final version.
- **A changelog file every PR adds to** (openclaw's `CHANGELOG/Unreleased.md`). It gives the best-written notes, but agents open many PRs in parallel, and they'd all conflict on the one file. PR titles are already written for every change.
- **GitHub's generated notes, grouped by label.** That needs a type label on every PR, and that habit is easier to forget than a title the check enforces.
- **Moving existing installs to `stable` on their next update.** It's simpler afterwards, but the people running kndl today chose `main`, and an update shouldn't take them back to an older Release.
- **Signed tags.** openclaw refuses unsigned tags. It's worth doing once someone other than the maintainer can push tags. Until then it's a step that can be skipped.

## Consequences

- **`main` should always be releasable.** Anything merged goes out in the next Release, so work that isn't finished stays behind a flag or on a branch.
- **A Hub on `stable` can be months behind `main`,** and its Runners with it. So a bug report needs the version.
- **Existing titles don't match.** The check only applies to new PRs. Release notes start at the first Release, so history before it is never grouped.
