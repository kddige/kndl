---
title: Set up an Environment
description: Give a Repo the image, scripts, tools and resources its Sessions' Sandboxes need, test the build and apply it.
sidebar:
  order: 6
---

Each Repo has one Environment: the recipe its Sessions' Sandboxes are built from. A Repo needs one before its first Session. Anyone with access to the Repo on GitHub can change it.

Open it from **Environments** in the sidebar, or at `/repos/<owner>/<name>/environment`. Starting a Session on a Repo without one takes you there too, and starts the Session once you apply.

Before you set anything up, the Hub checks the Repo with GitHub. **New Session** checks it as you type it; the Environment page checks it as it opens. If you can't use the Repo, you are told why at once:

- **The GitHub App isn't installed on owner/name**, with an **Install the App** link. Install it on the Repo, or add the Repo to the App's installation, then press **check again**.
- **You don't have access to owner/name on GitHub.** Have the Repo's owner add you as a collaborator, then press **Check again**.

See [the Environment won't open](/troubleshooting/sessions/#the-environment-wont-open-or-new-session-refuses-the-repo) for more. A Dev login has access to every Repo, but still needs the App on the Repo for a Test build.

## Choose the image

**Image** is the OCI image every Sandbox of the Repo starts from. The default, `buildpack-deps:bookworm`, is Debian with curl, git, a compiler and the usual `-dev` libraries, which is enough for most stacks once the bootstrap adds a language runtime.

The image can be Debian-like (glibc) or Alpine-like (musl): the build checks which, and gives the Sandbox the matching build of Claude Code. It needs tmux 3.2 or later and bash, which the build installs with the image's package manager (apk, apt-get, dnf or yum) when the image lacks them.

## Write the Bootstrap script

**Bootstrap script** runs once per build on each Runner, without the Workspace. Install what every Session needs here: language runtimes, CLIs, system packages. Its result is saved with the build, so Sessions don't pay for it again.

A script without a `#!` line runs with `bash -e` where the image has bash, and `sh -e` otherwise.

After the bootstrap, the build runs one interactive login shell (`bash -lic`) and keeps the environment it ends with. Tools that put themselves on `PATH` through `~/.bashrc` or `~/.profile`, such as mise, rustup, nvm and bun's installer, are then on `PATH` for the Start script and for every tool Claude runs. For example, to give every Session bun through mise:

```sh
# Bootstrap script
curl -fsSL https://mise.run | sh
echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc
~/.local/bin/mise use -g bun@latest
```

To let Sessions use `gh`, install it here. On the default image, from GitHub's apt repository:

```sh
# Bootstrap script
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
apt-get update && apt-get install -y gh
```

Debian's own package (`apt-get install -y gh`) works too, but is older. Commits are by the Session's Creator unless you set another identity here ([why](/explanation/git-from-sessions/#in-the-sandbox)), for example a shared bot:

```sh
git config --global user.name "Claude (kndl)"
git config --global user.email "claude@example.com"
```

## Write the Start script

**Start script** runs in `/workspace` each time a new Sandbox is made for a Session: when the Session first starts, and when its Sandbox is made again from a new version. It doesn't run on an ordinary wake. Use it for what depends on the Repo's own files:

```sh
# Start script: bun is on PATH here, and in Claude's Bash tool.
bun install
```

After it, the Sandbox probes the login shell again, in `/workspace`, so tools set up by the Repo's own files (a `mise.toml`, say) reach Claude's tools too.

## Turn on Docker

Tick **Docker in every Sandbox** if Sessions should run containers, for example for a database in tests. The build installs Docker, and each Sandbox gets its own disk for Docker's data, kept across sleep and wake.

## Set the resources

**CPUs** and **Memory (MiB)** are what each Sandbox gets. A Runner caps them with `RUNNER_SANDBOX_MAX_CPUS` (default: its CPU count) and `RUNNER_SANDBOX_MAX_MEMORY_MIB` (default: half its memory), and notes it in the Session's transcript when it gives less. The defaults are 2 CPUs and 4096 MiB.

## Keep dependency folders on their own disk

**Advanced: dependency folders** lists folders, relative to the Workspace, that each Sandbox keeps on a disk of its own, so installs are fast and survive sleep. A pattern such as `**/node_modules` matches folders anywhere in the Workspace; with **Next to** a file such as `package.json`, only those beside that file. The defaults:

| Pattern | Next to |
|---|---|
| `**/node_modules` | `package.json` |
| `**/.venv` | `pyproject.toml` |
| `**/target` | `Cargo.toml` |

## Add variables

**Variables** reach the Bootstrap script, the Start script and every tool Claude runs, as environment variables. See [Use variables and secrets](/how-to/use-variables-and-secrets/).

## Test and apply

Changes are a draft, kept in your browser until you apply them. The **Apply** section says whether the draft needs a Test build:

- **A change to the build** (the image, either script, Docker, the dependency folders, or a variable available at build, including its value) needs a passing Test build of exactly this draft. Pick a Runner in **Runner to build on**, press **Test build** and watch the **Test build log**. A Test build runs the Bootstrap script, then the Start script on a fresh clone of the Repo's default branch, and leaves nothing behind. The Runner clones with a read-only token for the Repo from the Hub's GitHub App, not with its machine's own git credentials, and keeps nothing of it.
- **Other changes**, such as resources, apply at once.

Press **Apply** once it is enabled. The draft becomes a new version, listed under **Version history** with who applied it. Versions keep no values.

## Move running Sessions to the new version

New Sessions start on the latest version. A Session on an older version shows **Environment changed** with a **Restart** button: Restart puts it to sleep once no Turn is running and wakes it at once, which makes its Sandbox again from the new build. The Workspace and the dependency-folder disks are kept, and the conversation goes on. A Session that is woken anyway, after sleeping, moves to the latest version too.

What a Session changes in its own Login environment, such as a line added to `~/.bashrc`, reaches its tools only when its Sandbox is next made from a build, on a new version.

See [Environments](/explanation/environments/) for how builds and Sandboxes work.
