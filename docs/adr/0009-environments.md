---
status: accepted
---

# Sandboxes are built from the Repo's Environment

Each Repo has exactly one Environment: the recipe its Sandboxes are built from. It is versioned on the Hub and built on each Runner. A Repo needs an Environment before its first Session. Environments replace the Repo secrets of #14.

An Environment holds:

- **Image:** any OCI image. Debian with the usual build tools (`buildpack-deps:bookworm`) is the default.
- **Bootstrap script:** installs tools without the Workspace. It runs once per version on each Runner, and the disk is snapshotted, so Sessions boot from the snapshot instead of installing on every boot.
- **Start script (optional):** runs in each new Sandbox with the Workspace present.
- **Docker toggle:** the Runner installs Docker into the build, starts it on its own disk in each Sandbox, and stops its containers before sleep.
- **CPU and memory:** capped by the Runner's limits.
- **Dependency-folder patterns:** advanced. See ADR 0006.
- **Variables.**

## Variables

A Variable is Plain or Sensitive.

- **Sensitive values** are encrypted at rest on the Hub with a key from its config. They are write-only once saved, never sent to the web, and redacted from everything the Hub stores or relays.
- **Shared variables** are Hub-wide. A Link puts one into an Environment under a chosen name, and a name that clashes with another Variable in that Environment is refused.
- **Bootstrap access:** plain Variables always reach the bootstrap. A Sensitive one, or a Link, reaches it only when ticked "available at build".
- **A lost key (amended in #57):** the values it encrypted are lost with it. `secrets-reset` clears them and keeps each Sensitive Variable, its "available at build" and its Links; the Variable then needs a value. A Repo's Sessions don't start, and its Test builds are refused, until each Variable it has or links gets one. A value entered in place of a cleared one applies without a Test build, even at build. The reset is refused while a Hub runs on the database, which a running Hub shows by holding a lock beside it.
- **Who manages them:** see "Who can use an Environment" below. Shared variables belong to no Repo, so anyone signed in can manage them. An Environment's own Variables and Links follow its Repo.

A Runner keeps values in memory only. It fetches them from the Hub and passes them in the environment of each process it starts in the Sandbox: the tool bridge, the start script, and the bootstrap. It never sets them on the VM, because microsandbox stores VM-level env in plaintext in its database and keeps it after the Sandbox is removed (#46). microsandbox also writes every exec's output to the Sandbox's `logs/exec.log`. The Runner links that file to `/dev/null` before the first exec, so command output that prints a value never lands on its disk.

## The login environment

Every process the Runner starts in a Sandbox gets the environment a login shell there ends with, as a terminal on the person's own machine would (#67). Tool installers such as mise, rustup and nvm put themselves on `PATH` through `~/.bashrc` and `~/.profile`, and nothing the Runner starts reads those on its own. Claude Code's Bash tool does source `~/.bashrc`, for functions and aliases, but sets `PATH` back to its own process's.

So the build runs one interactive login shell (`bash -lic`, else `sh -lc`) after the bootstrap, the way VS Code dev containers' `userEnvProbe` does, and keeps its final environment in the build. Each new Sandbox probes again in the Workspace after its start script. The start script and the tool bridge get that environment with the Variables over it. The probe runs with no Variable in its environment and drops any entry named as one, so it holds no value.

A value the bootstrap writes to a file ends up in the build's snapshot on the Runner's disk, and a value written inside a Sandbox stays in its disks. Both are up to the Environment's author.

## Versions and builds

Applying a change creates a new Environment version. It records who applied it and when, never the values.

- **Test build:** a change that affects the build needs a passing Test build of exactly that draft, on a Runner the user picks, before it can be applied. The image, scripts, Docker toggle, dependency folders, and Variables available at build all affect the build. The Test build runs the bootstrap, then the start script against a fresh clone of the default branch. Other changes apply straight away.
- **Lazy builds:** other Runners build a version the first time a Session needs it, showing the log in that Session. A failed build fails the Session's start, with the log and a Retry.
- **Pruning:** each Runner keeps its last few builds per Environment. A build's disk is freed once no Sandbox still runs on it.
- **Picking up a new version:** a Session moves to it on its next wake, or straight away through Restart, by recreating its Sandbox from the new build on the same Workspace and disks.
- **Claude Code binary:** the Runner picks the Linux build matching the image's libc during the build. The musl build doesn't start on Debian.

## Who can use an Environment (amended in #104)

An Environment follows its Repo's access, as Sessions do (ADR 0003). Anyone with access to the Repo on GitHub can read its Environment, check and Test-build drafts, and apply versions. No one else can. "No roles" now means everyone with Repo access has the same rights over the Environment, not everyone signed in.

- **Checks:** each command is checked against the Hub's cached answer from GitHub, the same check Sessions use. A refusal reads the same whether the Repo exists or not, so it doesn't reveal which Repos exist or have an Environment.
- **Revocation:** someone who loses access loses the Repo's Environment screens at the Hub's next check, as their Sessions drop out.
- **Dev login** has access to every Repo while it is on.
- **Shared variables** are Hub-wide and belong to no Repo, so anyone signed in can still manage them. Their values are write-only, and a Link only puts one into the Sandboxes of a Repo whose Environment the person can already edit.
- **Checking up front:** a Repo is checked as it is entered for a new Session or Environment. The web says when the GitHub App isn't installed on it, with where to install it, or when the person has no access, before any setup.

A Test build clones its Repo the way a Session's Workspace is cloned (ADR 0005). The Hub mints a GitHub App installation token for that Repo, with `contents:read` only, and the Runner asks for it just before cloning. The Runner passes the token to git for that one clone and never stores it. Only a Hub with no GitHub App at all (dev mode) has the Runner clone with its host's own git credentials. If the App isn't installed on the Repo, the Test build fails before cloning and says so. A Runner from before this change doesn't ask for a token, so a Hub with the GitHub App won't run Test builds on it and says to update it.

## Considered options

- **Repo secrets (#14):** named values given to every Session. They had no build step, no sharing between Repos, and nothing to say which values the bootstrap could see.
- **Bootstrap on every boot:** no snapshots to manage, but installing Docker alone took about 33 s, against a 0.25 s boot from a build (#46).
- **Dockerfiles:** the Runner would need an image builder. A script against a chosen image gives most of the flexibility with what microsandbox already provides.
- **Test builds with the host's credentials (before #104):** simplest, but a Test build could clone any Repo the Runner's host can reach, whatever the person starting it could see.
- **Several Environments per Repo:** more flexible, but makes every Session ask which one to use. One per Repo matches "Sessions belong to the Repo" (ADR 0003).
