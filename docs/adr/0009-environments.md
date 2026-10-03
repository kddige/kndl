---
status: accepted
---

# Sandboxes are built from the Repo's Environment

Each Repo has exactly one Environment: the recipe its Sandboxes are built from. It is versioned on the Hub and built on each Runner. A Repo needs an Environment before its first Session. Environments replace the Repo secrets of #14.

An Environment holds:

- **Image:** any OCI image. Debian is the default.
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
- **Who manages them:** any signed-in user can, since there are no roles yet. This is a known gap.

A Runner keeps values in memory only. It fetches them from the Hub and passes them in the environment of each process it starts in the Sandbox: the tool bridge, the start script, and the bootstrap. It never sets them on the VM, because microsandbox stores VM-level env in plaintext in its database and keeps it after the Sandbox is removed (#46). microsandbox also writes every exec's output to the Sandbox's `logs/exec.log`. The Runner links that file to `/dev/null` before the first exec, so command output that prints a value never lands on its disk.

A value the bootstrap writes to a file ends up in the build's snapshot on the Runner's disk, and a value written inside a Sandbox stays in its disks. Both are up to the Environment's author.

## Versions and builds

Applying a change creates a new Environment version. It records who applied it and when, never the values.

- **Test build:** a change that affects the build needs a passing Test build of exactly that draft, on a Runner the user picks, before it can be applied. The image, scripts, Docker toggle, dependency folders, and Variables available at build all affect the build. The Test build runs the bootstrap, then the start script against a fresh clone of the default branch. Other changes apply straight away.
- **Lazy builds:** other Runners build a version the first time a Session needs it, showing the log in that Session. A failed build fails the Session's start, with the log and a Retry.
- **Pruning:** each Runner keeps its last few builds per Environment. A build's disk is freed once no Sandbox still runs on it.
- **Picking up a new version:** a Session moves to it on its next wake, or straight away through Restart, by recreating its Sandbox from the new build on the same Workspace and disks.
- **Claude Code binary:** the Runner picks the Linux build matching the image's libc during the build. The musl build doesn't start on Debian.

## Considered options

- **Repo secrets (#14):** named values given to every Session. They had no build step, no sharing between Repos, and nothing to say which values the bootstrap could see.
- **Bootstrap on every boot:** no snapshots to manage, but installing Docker alone took about 33 s, against a 0.25 s boot from a build (#46).
- **Dockerfiles:** the Runner would need an image builder. A script against a chosen image gives most of the flexibility with what microsandbox already provides.
- **Several Environments per Repo:** more flexible, but makes every Session ask which one to use. One per Repo matches "Sessions belong to the Repo" (ADR 0003).
