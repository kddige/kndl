# Could Docker Sandboxes be kndl's Sandbox backend?

Research on whether [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) (the `sbx` CLI) could replace microsandbox, or sit beside it, as a `SandboxBackend` ([SandboxBackend.ts](../../packages/runner/src/sandbox/SandboxBackend.ts)), against ADRs 0004, 0006, 0007, 0009, 0016 and 0026.

**Sources.** I used primary sources only:

- every page under `docs.docker.com/ai/sandboxes/` and `/ai/sandboxes-api/`, as of 2026-10-13;
- the [`sbx` CLI reference](https://docs.docker.com/reference/cli/sbx/);
- Docker's [`docker/sbx-releases`](https://github.com/docker/sbx-releases) repository and its [v0.48.0 release](https://github.com/docker/sbx-releases/releases/tag/v0.48.0), published today;
- the files inside that release's `DockerSandboxes-linux-arm64.tar.gz` and `DockerSandboxes-darwin.tar.gz`, which I listed and read but didn't run: `install.sh`, `LICENSE`, `THIRD-PARTY-NOTICES`, `apparmor-profile`, and the strings in `libsailor.dylib`;
- [`containerd/nerdbox`](https://github.com/containerd/nerdbox), the open-source shim the release bundles.

`sbx` isn't installed here. This host is an aarch64 Linux container with no `docker` and no KVM, so **nothing was run**. Claims marked **(inferred)** are my reading, not something a source says outright. Docs pages are linked by path below. For example, [install](https://docs.docker.com/ai/sandboxes/install/) is `https://docs.docker.com/ai/sandboxes/install/`.

## Short answer

**Docker Sandboxes shouldn't replace microsandbox, and isn't worth adding as a second backend yet.**

**What it gets right:**

- **Isolation.** It's a real microVM per Sandbox, with its own kernel. It runs on Docker's own VMM: Apple Hypervisor.framework on macOS and KVM on Linux **(inferred from the release binaries)**.
- **Hosting.** It needs neither Docker Desktop nor Docker Engine, runs on headless Linux, and local use is free, commercial use included.
- **Docker inside.** Every Sandbox gets a private Docker Engine on its own disk.

**Where it doesn't fit kndl:**

1. **No local API.** You drive local sandboxes only through the `sbx` CLI. The TypeScript SDK and REST API are for Docker's paid cloud sandboxes only.
2. **No reusable volumes.** Named volumes are cloud-only. A local kit volume belongs to one sandbox and dies with it ("A replacement sandbox gets its own volume"). So kndl's "recreate the Sandbox from a new Build on the same disks" (ADR 0006, ADR 0009) and "Archive keeps the claude volume" can't be built.
3. **Mounts at the host path.** The workspace mounts at the same absolute path as on the host, not at `/workspace`, and mounts have no quota.
4. **Deny-by-default network.** It's deny-by-default behind a host proxy that intercepts TLS for credential injection. "Open" is one host-wide setting. UDP is off by default and local UDP is never allowed, and ICMP is always blocked.
5. **Forwarding.** Published ports only reach servers bound to `0.0.0.0`. There's no way to connect to a guest's loopback.
6. **Fork.** There's no local snapshot or fork beyond `sbx template save`, which saves only the container filesystem.
7. **Product terms.** It's closed source, under Docker's Subscription Service Agreement. Each Runner needs a Docker account sign-in, and telemetry is on by default. It's at v0.48 with breaking CLI changes as recently as today's release. Linux support is Ubuntu 24.04 or later only.

**Revisit if Docker:**

- documents a local daemon API or SDK;
- ships local volumes that outlive a sandbox and can be attached to a new one;
- allows arbitrary guest mount paths.

## 1. Isolation

**It's a microVM.** "Every sandbox runs inside a lightweight microVM with its own Linux kernel." The hypervisor boundary is the control: "The agent runs as a non-root user with sudo privileges inside the VM. The hypervisor boundary is the isolation control, not in-VM privilege separation" ([security/isolation](https://docs.docker.com/ai/sandboxes/security/isolation/)). Five layers are listed: hypervisor, network, Docker Engine, workspace and credential ([security](https://docs.docker.com/ai/sandboxes/security/)). That meets ADR 0004's bar: root in the guest, with a year-long token in its environment (ADR 0026).

**Which hypervisor.** The docs never name it. The release artifacts show the stack:

- **The shim.** The Linux tarball ships `containerd-shim-nerdbox-v1`, `nerdbox-kernel-arm64_4k`, `nerdbox-rootfs-arm64.erofs` and `libsailor.so` (`install.sh` in [`DockerSandboxes-linux-arm64.tar.gz`](https://github.com/docker/sbx-releases/releases/tag/v0.48.0)). nerdbox is "a containerd runtime shim which isolates container processes using a virtual machine", marked "(Experimental)" upstream ([containerd/nerdbox README](https://github.com/containerd/nerdbox)).
- **The VMM.** Upstream nerdbox loads `libkrun` ([internal/vm/libkrun/instance.go](https://github.com/containerd/nerdbox/blob/main/internal/vm/libkrun/instance.go)). Docker's build ships `libsailor` instead: a Rust library whose `THIRD-PARTY-NOTICES` list `kvm-ioctls 0.24.0`, `kvm-bindings`, `vm-memory` and `vmm-sys-util`.
- **macOS.** `libsailor.dylib` calls Hypervisor.framework directly: `hv_vm_create`, `hv_vcpu_run`, "Apple Hypervisor.framework is not available. Ensure you are running on Apple Silicon and that the com.apple.security.hypervisor entitlement is present". Its strings also name virtio-blk, virtio-fs (with DAX), virtio-net, virtio-vsock, virtio-balloon and virtio-pmem devices.

  **So (inferred):** Docker's own closed-source VMM, "sailor", runs on Hypervisor.framework on Apple Silicon and on KVM on Linux. It's not libkrun, not Apple's Virtualization.framework, and not Firecracker.
- **A container inside the VM.** The docs speak of the "container filesystem", the "in-container clone" and "the sandbox container" ([usage](https://docs.docker.com/ai/sandboxes/usage/), [`sbx create`](https://docs.docker.com/reference/cli/sbx/create/)). nerdbox bundles `crun` in its rootfs (`THIRD-PARTY-NOTICES`). **So (inferred):** the agent runs in a container inside the VM, and the VM is the boundary.

**Hosts.** From [install](https://docs.docker.com/ai/sandboxes/install/):

- macOS 14 or later on Apple silicon.
- Windows 11 x64 with Windows Hypervisor Platform.
- Linux: "Ubuntu 24.04 or later", x86-64 or arm64, with KVM and the user in the `kvm` group. Nested virtualization is needed to run it inside a VM.
- "Docker does not test or support Docker Sandboxes on Ubuntu derivatives". Release artifacts also exist for Rocky Linux 8 ([sbx-releases README](https://github.com/docker/sbx-releases)), but "The availability of a Linux release artifact does not indicate that Docker tests or supports the corresponding distribution" ([install](https://docs.docker.com/ai/sandboxes/install/)).
- On Ubuntu 23.10 and later, the shim needs an AppArmor profile to create user namespaces (`apparmor-profile` in the tarball).

**No Docker Desktop.** "You don't need Docker Desktop or Docker Engine to use `sbx`" ([install](https://docs.docker.com/ai/sandboxes/install/)). Headless Linux works, and secrets fall back to a 0700 file under `~/.config/com.docker.sandboxes` when there's no Secret Service ([FAQ](https://docs.docker.com/ai/sandboxes/faq/)).

**Licence and cost:**

- **Free locally.** "The `sbx` CLI and local sandbox compute are free to use, including for commercial and professional work" ([FAQ](https://docs.docker.com/ai/sandboxes/faq/)).
- **Paid extras.** Cloud compute is pay-as-you-go ([billing](https://docs.docker.com/agentic-platform/signup/#billing)). Organization governance is "a separate paid subscription" ([overview](https://docs.docker.com/ai/sandboxes/)).
- **Not Docker Desktop's terms.** Docker Desktop's own paid-licence threshold (free only below 250 employees and $10M revenue, [Desktop license](https://docs.docker.com/subscription/desktop-license/)) doesn't apply, since Desktop isn't needed.
- **Proprietary.** "Proprietary — Docker Inc." ([README](https://github.com/docker/sbx-releases)). The bundled `LICENSE` says "Use is subject to the Docker Subscription Service Agreement" ([DSSA](https://www.docker.com/legal/docker-subscription-service-agreement)). I didn't review the DSSA's terms for this use.
- **Sign-in and telemetry.**
  - Signing in to a Docker account is required. Headless hosts use `sbx login --username … --password-stdin` with a PAT ([FAQ](https://docs.docker.com/ai/sandboxes/faq/), [automation](https://docs.docker.com/ai/sandboxes/workflows/automation/)).
  - `sbx logout` "Stop[s] running local sandboxes" ([CLI](https://docs.docker.com/reference/cli/sbx/)).
  - CLI telemetry is on unless `SBX_NO_TELEMETRY=1` ([FAQ](https://docs.docker.com/ai/sandboxes/faq/)).

## 2. Programmatic control

**Locally, the CLI is the only documented interface.**

- **The SDK and API are cloud-only.** The TypeScript SDK `@docker/sandboxes` is "to create and manage cloud sandboxes", and needs a Docker Agentic Platform subscription ([SDK install](https://docs.docker.com/ai/sandboxes-api/install/), [API](https://docs.docker.com/ai/sandboxes-api/)). Its endpoints are `https://connect.docker.com/sandboxes` plus a per-sandbox endpoint ([API concepts](https://docs.docker.com/ai/sandboxes-api/concepts/)).
- **There is a daemon API, but it isn't documented.** Local sandboxes are run by a daemon, `sandboxd` ([`sbx daemon`](https://docs.docker.com/reference/cli/sbx/daemon/)). The release notes mention "the daemon API" and "the runtime API" ([release notes](https://docs.docker.com/ai/sandboxes/release-notes/), 0.45.0 and 0.46.0), and the 0.48.0 notes do too ([v0.48.0](https://github.com/docker/sbx-releases/releases/tag/v0.48.0)). I found no reference for it.
- **(inferred)** So a kndl backend would shell out to `sbx` for every operation and parse `--format json`. The CLI says scripts must use structured output, because "Human-readable tables and messages can change between releases" ([automation](https://docs.docker.com/ai/sandboxes/workflows/automation/)).

**How `SandboxBackendShape` would map onto the CLI:**

| kndl operation | `sbx` equivalent | Notes |
|---|---|---|
| `create` | `sbx create shell --name … -t <image> --cpus N -m <mem> [hostpath] [hostpath:ro]` | [`sbx create`](https://docs.docker.com/reference/cli/sbx/create/), [`shell`](https://docs.docker.com/ai/sandboxes/agents/shell/). A created sandbox "stops automatically when no sessions keep it running". `sbx run -d --name` keeps it up, and switches it to detached "permanently" ([usage](https://docs.docker.com/ai/sandboxes/usage/)) |
| `start` | `sbx exec` starts a stopped sandbox first ([`sbx exec`](https://docs.docker.com/reference/cli/sbx/exec/)). `sbx start` appears in [troubleshooting](https://docs.docker.com/ai/sandboxes/troubleshooting/) but not in the CLI reference | |
| `stop` | [`sbx stop`](https://docs.docker.com/reference/cli/sbx/stop/) | State is kept. Since 0.46.0, `SIGTERM` is forwarded on shutdown ([release notes](https://docs.docker.com/ai/sandboxes/release-notes/)) |
| `destroy` (with `keepVolumes`) | [`sbx rm --force`](https://docs.docker.com/reference/cli/sbx/rm/) | No way to keep volumes (§3) |
| `state`, `list` | [`sbx ls --format json`](https://docs.docker.com/reference/cli/sbx/ls/) | **No labels.** The Session id and Runner mark would have to be encoded in the name: letters, digits, `-` and `.` ([`sbx create`](https://docs.docker.com/reference/cli/sbx/create/)) |
| `execStream`, `spawn` | `sbx exec -i [-u root] [-w dir] [-e KEY] NAME cmd…` | "Flags match the behavior of `docker exec`", without `-d` ([`sbx exec`](https://docs.docker.com/reference/cli/sbx/exec/)). So `tmux -C` over a long-lived `sbx exec -i` child should work, with separate stdout and stderr when there's no `-t` **(inferred)** |
| `exec` with a secret env | `sbx exec -e KEY`, with the value in the `sbx` child's own environment | A bare `KEY` takes the value from the caller's environment ([`sbx create`](https://docs.docker.com/reference/cli/sbx/create/) states it; [`exec`](https://docs.docker.com/reference/cli/sbx/exec/) follows `docker exec`). This keeps tokens out of argv **(inferred)** |
| `readFile`, `writeFile` | [`sbx cp`](https://docs.docker.com/reference/cli/sbx/cp/), or `sbx exec cat` | No file API. Every read is a CLI process plus a guest exec. ADR 0016 measured about 5 ms for an SDK file read against about 46 ms for a microsandbox exec, so polling `/proc/net/tcp` every 2 s gets dearer **(inferred)** |
| `connectTcp` | None. [`sbx ports --publish`](https://docs.docker.com/reference/cli/sbx/ports/) or `sbx exec -i tcpcat` | See §6 |
| `metrics` | `sbx ls --json` reports "recorded CPU and memory limits" ([release notes](https://docs.docker.com/ai/sandboxes/release-notes/) 0.45.0). The TUI shows live CPU and memory ([usage](https://docs.docker.com/ai/sandboxes/usage/)) | No documented usage figures |
| `snapshots` | [`sbx template save`](https://docs.docker.com/reference/cli/sbx/template/save/), `template ls`, `template rm`, `create -t TAG --pull never` | See §4 |

## 3. Storage

**The host workspace mount:**

- **Mounted at the host's path.** A workspace path is mounted read-write through virtio-fs "at the same absolute path as on your host" ([architecture](https://docs.docker.com/ai/sandboxes/architecture/), [usage](https://docs.docker.com/ai/sandboxes/usage/)). The guest path can't be chosen, so kndl's `/workspace` would become the Runner's sessions-root path. Every guest path kndl uses would change, or `/workspace` would be a symlink **(inferred)**.
- **Fixed at creation.** "A sandbox's workspace configuration is fixed when the sandbox is created" ([troubleshooting](https://docs.docker.com/ai/sandboxes/troubleshooting/)).
- **Read-only extras.** Extra paths take `:ro`, and "a read-only argument may name a single file" ([`sbx run`](https://docs.docker.com/reference/cli/sbx/run/)).
- **Caching.** Virtio-fs caching is on by default. There's a kill switch, `DOCKER_SANDBOXES_ENABLE_VIRTIOFS_CACHE=0`, if "Git index corruption" appears ([troubleshooting](https://docs.docker.com/ai/sandboxes/troubleshooting/)).
- **No quota or permission controls.** None are documented, unlike microsandbox's `quota()` and `hostPermissions("mirror")` ([MicrosandboxBackend.ts:279-283](../../packages/runner/src/sandbox/MicrosandboxBackend.ts#L279-L283)).

**Persistent disks:**

- **The root and the Docker disk.** Everything in the sandbox persists across stop and start, until `sbx rm` ([architecture](https://docs.docker.com/ai/sandboxes/architecture/)). The root filesystem defaults to 20 GB (`DOCKER_SANDBOXES_ROOT_SIZE`). "The Docker data disk at `/var/lib/docker` is independent and defaults to 10 GB" (`DOCKER_SANDBOXES_DOCKER_SIZE`, at least 512 MiB, set at creation) ([troubleshooting](https://docs.docker.com/ai/sandboxes/troubleshooting/)).
- **Extra disks are per-sandbox.** Extra block or tmpfs disks come only from a kit's `volume@1` capability, at creation, with a size (default `512m`) ([capabilities](https://docs.docker.com/ai/sandboxes/customize/author/capabilities/), [patterns](https://docs.docker.com/ai/sandboxes/customize/author/patterns/), [kits v2](https://docs.docker.com/ai/sandboxes/customize/kits-v2/)). But "The volume keeps the tool's data across sandbox restarts. A replacement sandbox gets its own volume" ([patterns](https://docs.docker.com/ai/sandboxes/customize/author/patterns/)).
- **Named volumes are cloud-only.** "Volumes are a cloud-only feature; every subcommand requires --cloud" ([`sbx volume`](https://docs.docker.com/reference/cli/sbx/volume/)). Cloud volumes are snapshotted at exit, and "the last sandbox to exit wins".

**What that breaks in kndl (inferred):**

- **Volumes don't outlive the Sandbox.** kndl's `VolumeMount` contract is "kept across stop, start and a destroy that keeps it" ([SandboxBackend.ts](../../packages/runner/src/sandbox/SandboxBackend.ts)). kndl uses that in three places:
  - moving to a new Environment version by recreating the Sandbox on the same disks (ADR 0006, #46);
  - recreating a destroyed Sandbox;
  - keeping only the claude volume on Archive.
- **What's left.** With `sbx`, a Session's deps, cache, claude and docker data live and die with that one sandbox. The only way to carry them over is to copy their contents through `exec` or `cp`, or to move them onto the host mount. ADR 0006 measured the host mount as too slow for `node_modules`.

## 4. Images and builds

**Templates:**

- **Any OCI image.** `-t, --template` takes "Container image to use for the sandbox". Locally built images are loaded with `docker image save` and then `sbx template load` ([usage](https://docs.docker.com/ai/sandboxes/usage/)).
- **Images not on Docker Hub need a stored credential.** Pulls from other registries use `sbx secret set --registry`, and are anonymous otherwise ([usage](https://docs.docker.com/ai/sandboxes/usage/)).
- **Docker's templates.** Docker's own are Ubuntu-based, run as a non-root `agent` user, and are published as `docker/sandbox-templates:<variant>` ([base images](https://docs.docker.com/ai/sandboxes/customize/author/base-images/)).
- **Requirements for your own image.** Your own Linux image must provide:
  - `curl`, `git` and CA certificates;
  - `/bin/sh` and `/bin/bash`;
  - "a non-root `agent` account with UID 1000 and home directory `/home/agent`";
  - an `ENTRYPOINT` or `CMD`.

  ([base images](https://docs.docker.com/ai/sandboxes/customize/author/base-images/)). SSH-agent forwarding also needs `socat` ([troubleshooting](https://docs.docker.com/ai/sandboxes/troubleshooting/)).
- **Consequence (inferred).** kndl's default `buildpack-deps:bookworm` has no `agent` user. The Runner would have to derive an image first, which is the "Runner needs an image builder" cost ADR 0009 avoided. `sbx` can build a v3 kit's Dockerfile itself ("`sbx` can build this directory when you create a sandbox", [base images](https://docs.docker.com/ai/sandboxes/customize/author/base-images/)), so it would need no separate builder.

**Saving a root filesystem.** `sbx template save SANDBOX TAG` saves "a snapshot of the sandbox as a template" into the runtime's image store, and `--output` exports a tar ([`template save`](https://docs.docker.com/reference/cli/sbx/template/save/)).

- **What it saves.** It works on a stopped sandbox: "Stop the sandbox (or let the CLI prompt you)". It captures the container filesystem only: "Mounted filesystems, including host workspaces and the Docker store at `/var/lib/docker`, aren't included" ([usage](https://docs.docker.com/ai/sandboxes/usage/)).
- **Booting from it.** `sbx run --pull never -t TAG` boots from it, and since 0.48.0 that skips registry requests ([v0.48.0](https://github.com/docker/sbx-releases/releases/tag/v0.48.0)). That covers an Environment Build: run the Bootstrap in a sandbox, stop it, save it, and boot Sessions from the tag **(inferred)**.
- **Unknown cost.** How much disk a second sandbox on the same template costs is not documented. microsandbox measured 0.5 MB (ADR 0006).
- **Agent config isn't kept.** "Agent configuration files are always recreated when a sandbox is created" ([usage](https://docs.docker.com/ai/sandboxes/usage/)).

## 5. Fork, snapshot and clone

**Local:**

- **No fork, pause or memory snapshot.** `sbx cp` refuses copies "between two sandboxes" ([`sbx cp`](https://docs.docker.com/reference/cli/sbx/cp/)).
- **The closest is `template save` plus `create -t`.** It needs the source stopped, and copies only the container filesystem, so it carries no memory and no running processes. That suits ADR 0026, since the source Creator's token isn't copied **(inferred)**.

**Cloud.** Snapshots there have `captureMode: 'disk'` or `'all'` (memory, disk and the microVM checkpoint), and restore "creates a new sandbox with its own identity" ([snapshot and fork](https://docs.docker.com/ai/sandboxes-api/cookbook/snapshot-and-fork-a-sandbox/), [`template save`](https://docs.docker.com/reference/cli/sbx/template/save/)). That's close to microsandbox's `Sandbox.fork()`, but it's hosted and has no host mounts ([local vs cloud](https://docs.docker.com/ai/sandboxes/cloud/local-vs-cloud/)).

**Against the "from parts" plan** in [microsandbox-fork.md §7](microsandbox-fork.md#7-recommendation-for-kndl) **(inferred throughout):**

1. **Workspace:** copied on the host, as with microsandbox.
2. **Volumes (deps, cache, claude, docker):** no equivalent. A new sandbox can't be created on copies of the source's disks, because volumes are per-sandbox (§3) and the Docker store isn't in templates. Contents would have to be streamed through `sbx exec -i tar`, which is slow for a multi-GB Docker disk and gives crash-consistent Docker state at best.
3. **Root disk:**
   - **Asleep:** `template save` works, since the source is already stopped.
   - **Active:** has to be stopped first. There's no `pause({ guestFlush })`.
   - **Archived:** boots fresh from the Environment, as in the microsandbox plan.
4. **Lineage and token:** unchanged.

So steps 1, 3 and 4 work, and step 2 regresses from a reflink copy of each `disk.raw` to a file-level copy through the guest.

## 6. Networking

**Outbound is deny-by-default:**

- **The rules.** "All outbound TCP traffic, including HTTP, HTTPS, and SSH, is blocked unless an explicit rule allows the destination. Outbound UDP is disabled by default … ICMP is blocked" ([security/defaults](https://docs.docker.com/ai/sandboxes/security/defaults/)).
- **Presets.** `sbx policy init allow-all` ("Open": "All outbound TCP traffic is allowed", the same as allowing `"**"`) sets the global preset non-interactively ([local policy](https://docs.docker.com/ai/sandboxes/governance/access-controls/local/)). It's a host-wide policy for every sandbox on the machine. Under the other presets, unmatched requests become approval prompts.
- **Organization rules win.** If a Docker organization's governance applies, "only organization allow rules grant access" ([FAQ](https://docs.docker.com/ai/sandboxes/faq/)).

**Limits even when open:**

- **UDP** needs an experimental flag plus rules, and "UDP to local-network destinations is blocked before any policy is evaluated", so mDNS and SSDP don't work ([local policy](https://docs.docker.com/ai/sandboxes/governance/access-controls/local/)).
- **ICMP** "can't be unblocked with policy rules" ([troubleshooting](https://docs.docker.com/ai/sandboxes/troubleshooting/)).
- **The host proxy.** All TCP goes through a host-side proxy: a forward proxy for HTTP(S) and a transparent proxy for the rest ([architecture](https://docs.docker.com/ai/sandboxes/architecture/)).
  - On the `forward` path, "the credential proxy terminates TLS and presents its own certificate, which the sandbox already trusts" ([troubleshooting](https://docs.docker.com/ai/sandboxes/troubleshooting/)).
  - Containers built inside need the proxy CA and `HTTP_PROXY` build args ([troubleshooting](https://docs.docker.com/ai/sandboxes/troubleshooting/)).
- **Gap with ADR 0004.** ADR 0004's "unrestricted network, including the LAN and the host" is only partly reachable this way. The docs say the agent "cannot access … your host network directly" ([security](https://docs.docker.com/ai/sandboxes/security/)). Whether `"**"` covers LAN IPs over TCP isn't stated.

**Reaching the host's loopback (kndl's mod relay):**

- **How.** Services on the host are reachable at `host.docker.internal`. The proxy "translates `host.docker.internal` to `localhost`", and needs `sbx policy allow network localhost:<port>` ([development](https://docs.docker.com/ai/sandboxes/workflows/development/)).
- **kndl changes.** `hostFromGuest` ([SessionLayout.ts:22](../../packages/runner/src/sandbox/SessionLayout.ts#L22)) would become `host.docker.internal`, with an allow rule for `RUNNER_RELAY_PORT`. The relay only accepts the per-Session token, so allowing the port is safe **(inferred)**.
- **Isolation between sandboxes.** "Sandboxes cannot communicate directly over the network" ([security](https://docs.docker.com/ai/sandboxes/security/)). They can all reach that host port, though.

**Docker inside:**

- **A private engine.** Each sandbox has its own Docker Engine, "with no path to the host daemon", on its own `/var/lib/docker` disk ([security/isolation](https://docs.docker.com/ai/sandboxes/security/isolation/), [troubleshooting](https://docs.docker.com/ai/sandboxes/troubleshooting/)).
- **Privileged containers.** Docker-in-Docker privileged containers inside the VM came with v0.48.0's `privileged@1` ([capabilities](https://docs.docker.com/ai/sandboxes/customize/author/capabilities/)).
- **No toggle (inferred).** The engine is part of every sandbox, so kndl's Docker toggle couldn't turn the disk off. kndl's `docker stop` before sleep would still be its own `exec`.

**Ports and Forwards (ADR 0016):**

- **Publishing.** `sbx ports --publish` binds `127.0.0.1` (or `::1`) on the host. "For a service to be reachable, it must listen on all interfaces inside the sandbox, not only `127.0.0.1`" ([development](https://docs.docker.com/ai/sandboxes/workflows/development/), [`sbx ports`](https://docs.docker.com/reference/cli/sbx/ports/)). Vite's loopback default is exactly what ADR 0016 rejected microsandbox's `-p` for.
- **No loopback connect.** There's no equivalent of agentd's `core.tcp.connect`. kndl would fall back to its `tcpcat` over `sbx exec -i`, one CLI process per connection **(inferred)**.
- **Port detection.** Reading `/proc/net/tcp` works through `exec` (§2). Nothing in `sbx` reports guest listeners.

## 7. Resources

- **CPU and memory.**
  - `--cpus` defaults to all host CPUs, at most 16 on Linux arm64.
  - `-m` has a minimum of 512 MiB. The default is "50% of host memory, clamped to 512 MiB–32 GiB", and the maximum is "max(75% of host memory, 512 MiB)" ([`sbx create`](https://docs.docker.com/reference/cli/sbx/create/)).
  - Both are fixed at creation: `resources@1` "require[s] sandbox creation" ([capabilities](https://docs.docker.com/ai/sandboxes/customize/author/capabilities/)).
- **Density.** No local limits are documented. The cloud's default quota is 10 concurrent sandboxes ([limits](https://docs.docker.com/ai/sandboxes-api/limits/)).
- **Memory return.** `libsailor` contains a virtio-balloon device and "remapped memory for reclaim" strings. It may give memory back to the host, which microsandbox doesn't on macOS (ADR 0016) **(inferred, unverified)**.
- **Boot time.** Not documented. The only figure is a fixed bug: `VM did not connect within 15s` when many started at once ([release notes](https://docs.docker.com/ai/sandboxes/release-notes/), 0.46.0).

## 8. Maturity and fit

- **Version and churn.**
  - v0.48.0 came out on 2026-10-13. Stable releases ship about weekly, with release candidates and nightlies in between ([releases](https://github.com/docker/sbx-releases/releases)).
  - 0.48.0 renamed flags and reshaped every `--json` output ([v0.48.0](https://github.com/docker/sbx-releases/releases/tag/v0.48.0), [automation](https://docs.docker.com/ai/sandboxes/workflows/automation/)).
  - The docs carry no Beta badge on the product itself. Parts are marked experimental, among them `sbx env`, kits, custom secrets, upstream proxy, UDP, GPU and shared skills ([CLI](https://docs.docker.com/reference/cli/sbx/), [credentials](https://docs.docker.com/ai/sandboxes/configuration/credentials/)).
  - Its VM shim, nerdbox, is "(Experimental)" upstream ([nerdbox](https://github.com/containerd/nerdbox)).
  - The source isn't open, so kndl can't read or pin behaviour as it does for microsandbox (ADR 0016).
- **Built around its own agents.**
  - **Agents.** `claude` runs `docker/sandbox-templates:claude-code` with `claude --dangerously-skip-permissions` ([Claude Code](https://docs.docker.com/ai/sandboxes/agents/claude-code/)).
  - **Credentials.** They're injected by the host proxy against sentinels. Claude subscription sign-in is `/login` inside the sandbox ([credentials](https://docs.docker.com/ai/sandboxes/configuration/credentials/)). The proxy masks Anthropic OAuth token responses: 0.47.0 fixed "preventing real tokens from reaching the sandbox instead of the proxy's placeholders" ([release notes](https://docs.docker.com/ai/sandboxes/release-notes/)).
  - **For kndl.** kndl would use the `shell` agent, which runs `bash -l` ([shell](https://docs.docker.com/ai/sandboxes/agents/shell/)), and start Claude Code itself under `tmux`.
- **Restrictions on what runs inside.**
  - Kit installs are limited to Docker Hub sources by default ([security](https://docs.docker.com/ai/sandboxes/security/)).
  - Host clipboard writes are allowed. Reads are opt-in ([security/isolation](https://docs.docker.com/ai/sandboxes/security/isolation/)).
  - SSH-agent forwarding is on by default ([security/isolation](https://docs.docker.com/ai/sandboxes/security/isolation/)). kndl would have to turn it off with `ssh.agentForwardingEnabled` ([troubleshooting](https://docs.docker.com/ai/sandboxes/troubleshooting/)), so the Runner host's SSH keys stay out of reach, in line with ADR 0004's "No GitHub or Claude credentials are placed in a Sandbox" **(inferred)**.
  - Nothing restricts what runs once inside.

## Comparison

| Need | microsandbox 0.7.6 (today) | Docker Sandboxes `sbx` 0.48.0 (local) |
|---|---|---|
| Boundary | libkrun microVM (ADR 0007) | microVM on Docker's closed "sailor" VMM via nerdbox; a container inside the VM ([isolation](https://docs.docker.com/ai/sandboxes/security/isolation/); release binaries, **inferred**) |
| macOS hypervisor | Hypervisor.framework via libkrun **(inferred)** | Hypervisor.framework, called directly by `libsailor.dylib` (strings, **inferred**) |
| Linux | KVM | KVM, `kvm` group; "Ubuntu 24.04 or later" supported ([install](https://docs.docker.com/ai/sandboxes/install/)) |
| Docker Desktop or Engine needed | No | No ([install](https://docs.docker.com/ai/sandboxes/install/)) |
| Licence and cost | Apache-2.0 (npm `package.json`), free | Proprietary, under the DSSA; local use free, commercial included ([FAQ](https://docs.docker.com/ai/sandboxes/faq/), `LICENSE`) |
| Account and telemetry | None | Docker sign-in required; CLI telemetry on by default ([FAQ](https://docs.docker.com/ai/sandboxes/faq/)) |
| Control from Bun | TypeScript SDK in-process | CLI only; SDK and API are cloud-only ([SDK](https://docs.docker.com/ai/sandboxes-api/install/)) |
| Exec with streaming stdin and stdout | SDK exec stream | `sbx exec -i` child process ([exec](https://docs.docker.com/reference/cli/sbx/exec/)) |
| File read and write | SDK fs, about 5 ms (ADR 0016) | `sbx cp` or exec ([cp](https://docs.docker.com/reference/cli/sbx/cp/)) |
| Names and labels | Names and labels (Naming.ts) | Names only ([create](https://docs.docker.com/reference/cli/sbx/create/)) |
| Host mount at `/workspace` | Any guest path, quota, `mirror` permissions | Same absolute path as on the host only; no quota ([usage](https://docs.docker.com/ai/sandboxes/usage/)) |
| Read-only mounts | Yes | `:ro`, a single file too ([run](https://docs.docker.com/reference/cli/sbx/run/)) |
| Named volumes that outlive the Sandbox | Yes, sized, reattachable | Cloud only ([volume](https://docs.docker.com/reference/cli/sbx/volume/)); local kit volumes are per-sandbox ([patterns](https://docs.docker.com/ai/sandboxes/customize/author/patterns/)) |
| Root and Docker disk size | `rootDisk`, Docker volume size | `DOCKER_SANDBOXES_ROOT_SIZE` (20 GB) and `DOCKER_SANDBOXES_DOCKER_SIZE` (10 GB) at creation ([troubleshooting](https://docs.docker.com/ai/sandboxes/troubleshooting/)) |
| Boot from an OCI image | Yes, any (`buildpack-deps:bookworm`) | Yes, but needs `agent` UID 1000, bash, curl and git ([base images](https://docs.docker.com/ai/sandboxes/customize/author/base-images/)) |
| Snapshot of the root filesystem | Disk snapshot, about 0.25 s boot, about 0.5 MB per Session (ADR 0006) | `template save` of a stopped sandbox, container filesystem only ([usage](https://docs.docker.com/ai/sandboxes/usage/)); cost unknown |
| Fork or clone | `fork()` (running only, with memory; unusable from Node) or "from parts" ([microsandbox-fork.md](microsandbox-fork.md)) | Locally only `template save` plus a new sandbox, no volumes; cloud has disk or memory snapshots ([cookbook](https://docs.docker.com/ai/sandboxes-api/cookbook/snapshot-and-fork-a-sandbox/)) |
| Default outbound | `allowAll()` set per Sandbox ([MicrosandboxBackend.ts](../../packages/runner/src/sandbox/MicrosandboxBackend.ts)) | Deny by default; `allow-all` is a host-wide preset; UDP off and local UDP never; ICMP blocked ([local policy](https://docs.docker.com/ai/sandboxes/governance/access-controls/local/)) |
| TLS | Untouched | Host proxy terminates TLS on the forward path ([troubleshooting](https://docs.docker.com/ai/sandboxes/troubleshooting/)) |
| Host loopback | `host.microsandbox.internal` | `host.docker.internal`, after `policy allow network localhost:PORT` ([development](https://docs.docker.com/ai/sandboxes/workflows/development/)) |
| Docker inside | Toggle; `dockerd` on its own volume | Always; private engine on its own disk ([isolation](https://docs.docker.com/ai/sandboxes/security/isolation/)) |
| Open-port detection | `/proc/net/tcp` through the SDK fs | `/proc/net/tcp` through exec **(inferred)** |
| Reaching a loopback-bound port | agentd `core.tcp.connect` (ADR 0016) | No; `publish` needs `0.0.0.0` ([development](https://docs.docker.com/ai/sandboxes/workflows/development/)); `tcpcat` over exec **(inferred)** |
| CPU and memory limits | Per Sandbox | `--cpus` and `-m` at creation ([create](https://docs.docker.com/reference/cli/sbx/create/)) |
| Memory back to the host | Not on macOS (ADR 0016) | Balloon device present **(inferred)**; unverified |
| Boot time | About 0.25 s from a build, about 1 s wake (ADR 0006) | Undocumented |
| Env storage | VM env stored in plaintext; kndl passes secrets per exec (ADR 0009) | `-e` on create is "stored with the sandbox"; per-command `exec -e` ([usage](https://docs.docker.com/ai/sandboxes/usage/)) |
| Maturity | Pre-1.0, advisories, pinned and read in source (ADR 0007) | Pre-1.0, weekly releases, breaking CLI changes in 0.48.0, closed source ([v0.48.0](https://github.com/docker/sbx-releases/releases/tag/v0.48.0)) |
| Agent assumptions | None | Built-in agent kits, a credential proxy, Docker's templates ([Claude Code](https://docs.docker.com/ai/sandboxes/agents/claude-code/)) |

## Recommendation for kndl

**Don't replace microsandbox, and don't add `sbx` as a second backend now.**

**The isolation is fine.** The problem is the control surface and the storage model:

- **The CLI only.** Every operation is a CLI process, behind a JSON format that changed in today's release, and no local API is documented.
- **Storage that dies with the sandbox.** Volumes are per-sandbox, so kndl's Sandbox lifecycle can't be built as it is. That lifecycle is disposable VMs on long-lived disks: the version upgrade, recreate and Archive. A backend would have to emulate it by copying data through the guest.
- **Mounts and ports.** Fixed mount paths and no loopback port connect break `/workspace` and Forwards. Both have workarounds (a symlink, `tcpcat` over exec), but they're slower.
- **Network.** Deny-by-default with TLS interception runs against ADR 0004 unless it's opened host-wide, and even then it isn't fully open.
- **Product terms.** The proprietary licence, a Docker account and telemetry on every Runner, and Ubuntu-only Linux support are new burdens. microsandbox carries none of them.

**Revisit if Docker:**

1. documents a local daemon API or SDK;
2. ships local volumes that outlive a sandbox and attach to a new one;
3. lets a mount choose its guest path;
4. offers a way to connect to a guest's loopback.

Until then, a second backend is better looked for along the lines ADR 0007 already names: Gondolin, or Firecracker or Cloud Hypervisor for a hardened Linux backend.

**One idea worth noting, not adopting.** Custom secrets are experimental. They set an environment variable to a placeholder and have the host proxy swap in the real value on requests to named hosts ([credentials](https://docs.docker.com/ai/sandboxes/configuration/credentials/#custom-secrets)). Pointed at `api.anthropic.com` with `CLAUDE_CODE_OAUTH_TOKEN`, that would keep the Creator's token out of the VM **(inferred)**. But it's a proxy rewriting Claude Code's credential, the very shape ADR 0026 moved away from. Anthropic's terms would need checking before anything like it.

## Open questions that need a real host

1. **Boot and wake times.** How long `sbx create -t <saved template>` plus the first `exec`, and `stop` then `exec`, take. Compare with microsandbox's 0.25 s and 1 s.
2. **Disk per Session.** Whether sandboxes created from one saved template share its layers, and what a second one costs on disk.
3. **Exec fidelity.** Whether `sbx exec -i` without `-t` keeps stdout and stderr apart, passes the exit code, and passes binary stdin cleanly for `tmux -C`. Its overhead per call, for 2 s `/proc/net/tcp` polling.
4. **Session lifetime.** Whether a long-lived `sbx exec -i` counts as a "session" that keeps a non-detached sandbox running. What a `sbx daemon restart`, an expired Docker login, or a Runner restart does to running sandboxes.
5. **Mounts.**
   - Ownership and executable bits on the virtio-fs workspace as seen by host `git`, which microsandbox needed `mirror` for.
   - Whether writes are capped, as microsandbox's 4 GiB default was.
   - Whether paths under a mount can hold other mounts, as kndl's dependency folders do.
6. **Network under `allow-all`.**
   - Whether LAN IPs and arbitrary TCP ports are reachable.
   - Whether Claude Code's traffic to `api.anthropic.com` passes TLS interception with a setup token in `CLAUDE_CODE_OAUTH_TOKEN` and no stored `anthropic` secret, or is rewritten by the built-in credential handling.
7. **Root and images.**
   - Whether `sbx exec -u root` and an image without the `agent` user work with the `shell` agent and `-t`.
   - Whether `dockerd` in the sandbox starts with containers from before a stop.
8. **On-disk output and env.** Where `sbx` and the daemon log exec output and stored env, so the Runner can keep Variable values off disk (ADR 0009).
9. **Memory.** Whether a stopped or idle sandbox gives memory back to the host on macOS and Linux, and how many 4 GiB Sandboxes a 32 GB Runner holds.
