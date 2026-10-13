# Can microsandbox's `Sandbox.fork()` fork a kndl Session?

Research for [#332](https://github.com/kddige/kndl/issues/332) (Fork a Session). Sources: the microsandbox Node SDK 0.7.6 as installed (`node_modules/.bun/microsandbox@0.7.6/node_modules/microsandbox/`, written `SDK/` below), and the microsandbox source at tag [`v0.7.6`](https://github.com/superradcompany/microsandbox/tree/v0.7.6) (commit `09df3d4`). That repository is the one the SDK's `package.json` points to (`git+https://github.com/superradcompany/microsandbox.git`, directory `sdk/node-ts`). Its `sdk/node-ts/package.json` says `"version": "0.7.6"`. Links of the form `msb:path#L1-L2` below are to `https://github.com/superradcompany/microsandbox/blob/v0.7.6/path#L1-L2`.

Claims marked **(inferred)** are my reading of the code, not something it states outright. Nothing here was run on a real host.

## Short answer

**No: `Sandbox.fork()` can't fork a kndl Session, in any of the three source states.**

- **It forks only a running or paused VM.** An Asleep Session's VM is stopped, and an Archived one has no VM at all.
- **The Node SDK's `fork()` takes only a name.** It has no way to bind the child's mounts. The child gets the parent's env and labels, and loses the parent's host-directory mounts and named volumes. The Workspace, the mod and the builds cache don't come with it. The deps, cache, claude and docker volumes are captured, but the child gets error-returning devices in their place.
- **Memory is copied too.** The child carries the parent's running processes, and so the source Creator's setup token and Session token **(inferred)**. ADR 0026 rules that out.

**The best way to copy one is to build the fork from parts:**

1. Take a disk snapshot of the source's root disk: `Snapshot.builder(...).fromSandbox(src)`, as kndl already does for Environments.
2. Create new `kndl-<newId>.<key>` disk volumes at the source's capacity.
3. Copy each source `disk.raw` over the new volume's `disk.raw` with a reflink-or-sparse copy.
4. Copy the Workspace directory.
5. Restore the snapshot under the new name with kndl's own mounts, labels and env: `Sandbox.restore(ref).name(...).volume(...)`, which is kndl's existing `restore` path.

How each state is copied:
- **Asleep:** copied as it is (stopped).
- **Active:** paused with `guestFlush: "required"` for the copy, then resumed.
- **Archived:** only the claude volume and the Workspace can be copied. The root disk and the deps, cache and docker volumes are gone, so the fork boots fresh from its Environment.

## 1. What `fork(name)` copies

| State | Copied to the child? | Source |
|---|---|---|
| Root disk | Yes. Sealed layers are hard-linked and each side gets its own new qcow2 head (see §3) | [msb:sdk/rust/lib/sandbox/branch.rs#L587-L634](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L587-L634) |
| Memory and execution state | Yes, copy-on-write ("Memory uses copy-on-write automatically"). The child resumes the parent's processes | `SDK/README.md:114`; [msb:docs/sandboxes/snapshots.mdx#L476](https://github.com/superradcompany/microsandbox/blob/v0.7.6/docs/sandboxes/snapshots.mdx#L476); [branch.rs#L654-L669](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L654-L669) |
| Owned volumes (`MountBuilder.owned()`) | Yes, a private copy | [msb:docs/sandboxes/volumes.mdx#L183](https://github.com/superradcompany/microsandbox/blob/v0.7.6/docs/sandboxes/volumes.mdx#L183); [branch.rs#L392-L397](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L392-L397), [#L635-L641](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L635-L641) |
| **Named disk volumes** (what kndl uses) | **Captured, but not given to the child unless the caller selects them, which Node can't do** | below |
| Host-directory (bind) mounts | No. External, never copied; the child needs explicit bindings | [snapshots.mdx#L591-L601](https://github.com/superradcompany/microsandbox/blob/v0.7.6/docs/sandboxes/snapshots.mdx#L591-L601), [#L510](https://github.com/superradcompany/microsandbox/blob/v0.7.6/docs/sandboxes/snapshots.mdx#L510) |
| Published ports, vsock routes, default user | Cleared | [branch.rs#L227-L231](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L227-L231), [#L399-L409](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L399-L409) |
| Everything else in the config: image, env, labels, workdir, network policy | Inherited. The child's config is a clone of the source's active config | [branch.rs#L378-L381](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L378-L381), [#L435-L437](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L435-L437) |

**How named disk volumes are handled.** kndl mounts its volumes as `m.named("kndl-<id>.<key>")` ([MicrosandboxBackend.ts:279-280](../../packages/runner/src/sandbox/MicrosandboxBackend.ts#L279-L280)).

1. At launch, a named *disk* volume is attached as a `snapshot-owned` virtio-blk device ([msb:sdk/rust/lib/runtime/spawn.rs#L3110-L3141](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/runtime/spawn.rs#L3110-L3141): the literal `true` passed to `push_disk_mount_arg`, whose meaning is at [#L2617-L2633](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/runtime/spawn.rs#L2617-L2633)).
2. The checkpoint runtime therefore captures it during a fork. It copies the volume's file into the capture with `fast_copy` while the VM is quiesced ([msb:crates/runtime/lib/checkpoint/additional_disk.rs#L23-L24](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/runtime/lib/checkpoint/additional_disk.rs#L23-L24), [#L176-L186](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/runtime/lib/checkpoint/additional_disk.rs#L176-L186), [#L261-L267](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/runtime/lib/checkpoint/additional_disk.rs#L261-L267); the full-capture inventory loop at [msb:crates/runtime/lib/checkpoint/coordinator.rs#L1420-L1446](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/runtime/lib/checkpoint/coordinator.rs#L1420-L1446)).
3. In the child's config, all non-owned mounts, named ones included, are dropped. Only the caller's explicit mounts are added ([branch.rs#L392-L398](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L392-L398)).
4. A captured named disk is only materialised for the child if its guest path was selected as `captured`, or resources are inherited. It then becomes a **private disk image** at `<sandboxes>/<child>/additional-disks/<device>.raw`, not a named volume. Otherwise: "A missing choice grants no host storage access. Full restore constructs an error-serving device from the captured state, not a dummy disk file." ([msb:sdk/rust/lib/backend/local/snapshot/restore/additional_disks.rs#L113-L149](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/backend/local/snapshot/restore/additional_disks.rs#L113-L149))
5. Direct forks don't require complete resources, so a missing disk or filesystem becomes an unavailable device rather than an error ([msb:sdk/rust/lib/sandbox/restore_resources.rs#L11-L13](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/restore_resources.rs#L11-L13); [msb:sdk/rust/lib/sandbox/external_mounts.rs#L108-L123](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/external_mounts.rs#L108-L123), [#L206-L209](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/external_mounts.rs#L206-L209)).

**The Rust and Node SDKs differ here.** Selection happens on `ForkBuilder`. The Rust `ForkBuilder` has `.volume(guest, |m| m.captured() / m.bind(..) / m.named(..))`, `.dangerously_inherit_resources()`, `.port(..)` and `.user(..)` ([msb:sdk/rust/lib/sandbox/restore_builder.rs#L245-L360](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/restore_builder.rs#L245-L360)). **The Node SDK doesn't expose any of it:**
- The Node signature is `fork(name, { recordIntegrity?, guestFlush? })` (`SDK/dist/sandbox.d.ts:234-243`, `SDK/native/index.d.ts:1126`).
- The JS glue passes just those three values (`SDK/dist/sandbox.js:374-377`; [msb:sdk/node-ts/src/sandbox.ts#L600-L603](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/node-ts/src/sandbox.ts#L600-L603)).
- The native binding builds the Rust fork with only `guest_flush` and `record_integrity` ([msb:sdk/node-ts/native/sandbox.rs#L589-L607](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/node-ts/native/sandbox.rs#L589-L607)).

**So, from Node, a fork of a kndl Session would boot without its Workspace, mod and builds-cache mounts, and with error-returning devices at its deps, cache, claude and docker paths (inferred from the code above).** Named volumes are never *shared* with the child. The child never gets new *named* volumes either. Even from Rust, `captured()` gives the child private, unnamed disk images, owned by the child's directory.

## 2. Source states, and what `pause(guestFlush)` guarantees

**Running or paused only.** `prepare_branch` rejects anything else: `"branch requires a running or user-paused source"` ([branch.rs#L370-L377](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L370-L377)). The docs agree: "Create a child directly from a running or paused sandbox" ([snapshots.mdx#L476](https://github.com/superradcompany/microsandbox/blob/v0.7.6/docs/sandboxes/snapshots.mdx#L476)). The source returns to its previous running or paused state ([snapshots.mdx#L510](https://github.com/superradcompany/microsandbox/blob/v0.7.6/docs/sandboxes/snapshots.mdx#L510)). An Asleep Session is stopped, and an Archived one has no Sandbox, so neither can be forked.

A fork is also refused if the source uses host-backed proxy, TLS or secret resources, unless resources are inherited, which Node can't ask for ([branch.rs#L382-L391](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L382-L391)). kndl uses `NetworkPolicy.allowAll()` and no secrets ([MicrosandboxBackend.ts:247-264](../../packages/runner/src/sandbox/MicrosandboxBackend.ts#L247-L264)), so this check would pass **(inferred)**.

**`pause({ guestFlush })`** suspends the VM in place, without a snapshot or releasing RAM ([msb:sdk/rust/lib/sandbox/pause.rs#L18-L20](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/pause.rs#L18-L20), [#L53](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/pause.rs#L53); `SDK/dist/sandbox.d.ts:244-247`). The flush policies ([snapshots.mdx#L437-L445](https://github.com/superradcompany/microsandbox/blob/v0.7.6/docs/sandboxes/snapshots.mdx#L437-L445)):
- `auto` (default): no extra flush for forking or pausing.
- `required`: a successful flush is required before the pause.
- `skip`: no flush at all.
- "Flushing covers the root and captured block disks, including owned disks."

In code, `pause_user` with `required` works like this ([coordinator.rs#L171-L199](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/runtime/lib/checkpoint/coordinator.rs#L171-L199)):
1. It freezes the guest workload.
2. It requires the flush to have covered `path:/`, every named or additional disk's guest path, and every virtiofs mount ([coordinator.rs#L1124-L1153](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/runtime/lib/checkpoint/coordinator.rs#L1124-L1153), [#L2323-L2332](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/runtime/lib/checkpoint/coordinator.rs#L2323-L2332)).
3. If the flush fails, it thaws and doesn't pause: `"required guest filesystem flush failed; pause was not established"`.

Inside the guest, agentd calls `syncfs` on each selected mountpoint "while application tasks and external input are frozen". It "never unmounts a filesystem or discards dirty pages" ([msb:crates/agentd/lib/mount_checkpoint.rs#L47-L70](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/agentd/lib/mount_checkpoint.rs#L47-L70)).

**What that gives you:** after `pause({ guestFlush: "required" })`, every disk image on the host is synced and frozen, and stays that way until `resume()`. It is crash-consistent, but its ext4 filesystems are still marked mounted, so a later mount may replay the journal **(inferred)**. It isn't application-consistent: "Flushing does not save data still buffered by your application or commit database transactions" ([snapshots.mdx#L433](https://github.com/superradcompany/microsandbox/blob/v0.7.6/docs/sandboxes/snapshots.mdx#L433)). That matters for dockerd's and containerd's state on the docker volume.

## 3. How it copies, and what it costs

**Root disk: hard links plus copy-on-write overlays, not a data copy.** At capture, `rollover` seals the source's current head and publishes the layer chain into the capture. For a local capture that uses `link_exact`, a hard link ([msb:crates/runtime/lib/checkpoint/disk.rs#L1144-L1161](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/runtime/lib/checkpoint/disk.rs#L1144-L1161)). It then switches the paused source onto a fresh qcow2 overlay over the sealed head ([disk.rs#L473-L593](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/runtime/lib/checkpoint/disk.rs#L473-L593), the `create_qcow2_overlay` call at [#L570-L578](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/runtime/lib/checkpoint/disk.rs#L570-L578)).

The child adopts the chain "using independent directory entries, without duplicating disk bytes": `hard_link` for each layer, then a private writable head ([msb:sdk/rust/lib/backend/local/snapshot/restore.rs#L217-L290](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/backend/local/snapshot/restore.rs#L217-L290)). Batch siblings are staged with "only local hardlinks and small directory metadata" ([branch.rs#L458-L462](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L458-L462)). A layer is copied only when an old or imported chain's names conflict ([restore.rs#L270-L281](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/backend/local/snapshot/restore.rs#L270-L281), [#L473-L481](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/backend/local/snapshot/restore.rs#L473-L481)).

So, for a mostly empty 16 GiB root disk, the cost doesn't depend on its size or on the host filesystem: a few hard links and two small qcow2 headers. The same holds on APFS, ext4, btrfs and XFS, since hard links work on all of them **(inferred)**.

**Named or additional disks: `fast_copy`, while the source is paused.** `microsandbox_utils::copy::fast_copy` ([msb:crates/utils/lib/copy.rs#L1-L23](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/utils/lib/copy.rs#L1-L23), [#L122-L146](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/utils/lib/copy.rs#L122-L146)) works in two tiers:
1. **Reflink**: `clonefile(2)` on macOS, `ioctl(FICLONE)` on Linux. The file says it "Succeeds instantly on APFS, btrfs, XFS (with `reflink=1`), and bcachefs. Returns `EOPNOTSUPP` (or similar) on ext4".
2. **Sparse-aware copy**: `SEEK_DATA`/`SEEK_HOLE`, copying only the allocated extents into a destination truncated to full size ([copy.rs#L191-L242](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/utils/lib/copy.rs#L191-L242)). It "Never falls back to a naive byte-for-byte copy".

This copy happens at capture ([additional_disk.rs#L261-L267](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/runtime/lib/checkpoint/additional_disk.rs#L261-L267)). A second `fast_copy` happens when a `captured()` disk is given to a child ([additional_disks.rs#L166-L179](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/backend/local/snapshot/restore/additional_disks.rs#L166-L179)).

The cost:
- **APFS, btrfs, XFS:** near-instant, with no extra disk until either side writes.
- **ext4:** time and disk grow with the *allocated* bytes. A freshly formatted, mostly empty 16 GiB image has only its ext4 metadata allocated, so it copies quickly **(inferred)**. A docker volume holding several GB would copy several GB while the source is **paused** **(inferred: the copy runs inside the capture's pause window)**.
- **Either way:** Node's `fork()` pays this capture copy for every named volume, and then throws the copies away, because the child isn't given them **(inferred)**.

**Memory:**
- Linux needs a memfd handoff capability ([branch.rs#L431-L434](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L431-L434), [#L493-L520](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L493-L520)).
- Elsewhere, a file in the backend's memory cache is used ([branch.rs#L477-L492](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L477-L492)).
- Building the RAM backing happens before the workload freeze ([coordinator.rs#L824-L876](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/runtime/lib/checkpoint/coordinator.rs#L824-L876)).
- "fork RAM is not hashed" ([snapshots.mdx#L1542](https://github.com/superradcompany/microsandbox/blob/v0.7.6/docs/sandboxes/snapshots.mdx#L1542)).

## 4. What can be set at fork time, and what's fixed

**From Node:**
- **Set at fork time:** only the child's **name** (`SDK/dist/sandbox.d.ts:234-238`). The name must be unused ([snapshots.mdx#L510](https://github.com/superradcompany/microsandbox/blob/v0.7.6/docs/sandboxes/snapshots.mdx#L510)).
- **Copied from the parent:** labels, env, image and workdir ([branch.rs#L378-L381](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L378-L381)).
- **Copied from the capture:** CPU and memory geometry, and the network address ([branch.rs#L579-L586](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L579-L586)).

For kndl, that means the child would carry the source Session's `sessionLabel` and Runner mark. Reconcile would then see two Sandboxes claiming one Session **(inferred)**.

**From Rust:** you can also choose mounts, ports, vsock and the default user, but not env or labels ([restore_builder.rs#L245-L360](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/restore_builder.rs#L245-L360): "Destination boot controls belong only to RestoreBuilder, not the live branch builders").

**The child boots straight away.** It does so with the captured execution state, through `create_detached` ([branch.rs#L321-L333](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L321-L333), [#L654-L670](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L654-L670)). You can't create it stopped. It can be stopped right afterwards (README: `const child = await sandbox.fork("experiment"); await child.stop();`, `SDK/README.md:116-119`).

**A later start can't take kndl's config:**
- `Sandbox.startDetached(name)` takes only a name (`SDK/dist/sandbox.d.ts:144`). It boots the persisted config, which `clone_for_persistence` strips of the one-off restore state ([msb:sdk/rust/lib/sandbox/config.rs#L601-L630](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/config.rs#L601-L630)).
- `modify()` can change env, labels, workdir, CPUs, memory, root disk size and secrets, but **not mounts** (`SDK/dist/modify.d.ts:19-51`).
- So a stopped fork child can't be given its `/workspace` bind or named volumes back. kndl would have to recreate it, which loses the point of forking.

## 5. Limits

- **Same host, same backend:**
  - "direct forking requires a local backend" ([branch.rs#L298-L310](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L298-L310), [#L348-L355](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L348-L355)).
  - The runtime refuses a handoff cache that differs from the source's ([coordinator.rs#L690-L703](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/runtime/lib/checkpoint/coordinator.rs#L690-L703)).
  - The child's directory must be a sibling of the source's under the same sandboxes root ([coordinator.rs#L706-L722](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/runtime/lib/checkpoint/coordinator.rs#L706-L722)).
  - The docs badge it as local-only ([snapshots.mdx#L472](https://github.com/superradcompany/microsandbox/blob/v0.7.6/docs/sandboxes/snapshots.mdx#L472)).
- **Neither side is stopped.** The source must be running or paused (§2), and the child starts running.
- **Concurrency:**
  - A fork holds the source's transition guard. It also serialises with durable captures of the same source, "so a child's ancestry describes its actual cut" ([branch.rs#L356-L361](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L356-L361), [#L468-L476](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L468-L476)).
  - Both guards are dropped once the capture is retained ([branch.rs#L556-L559](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L556-L559)).
  - `forkMany` captures once for several children. Each child gets its own outcome, and a failed child doesn't remove its siblings ([snapshots.mdx#L585](https://github.com/superradcompany/microsandbox/blob/v0.7.6/docs/sandboxes/snapshots.mdx#L585); [branch.rs#L179-L199](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L179-L199)).
- **Lineage isn't kept in `msb.db`:**
  - The child's config records only `snapshot_parent`, the source's last *durable snapshot* if there is one ([branch.rs#L475-L476](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L475-L476); [config.rs#L256-L258](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/config.rs#L256-L258)).
  - The source sandbox's name is held in `branch_source`, which is `#[serde(skip)]` ([config.rs#L270-L273](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/config.rs#L270-L273)).
  - The `sandbox` table has no parent column: its fields are `id, name, config, active_config, status, network_slot, ephemeral, created_at, updated_at` ([msb:crates/db/lib/entity/sandbox.rs](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/db/lib/entity/sandbox.rs)).
  - kndl has to record the fork's lineage itself, which #332 needs anyway.
- **Destroying the parent doesn't affect the child.** "Deleting the source or a sibling does not invalidate other children" ([snapshots.mdx#L585](https://github.com/superradcompany/microsandbox/blob/v0.7.6/docs/sandboxes/snapshots.mdx#L585)). The child holds its own hard links to the layers, and its RAM is pinned: "The captured files and RAM are now independently retained" ([branch.rs#L537](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L537), [#L556-L557](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/branch.rs#L556-L557)).

## 6. Alternatives

### (a) Snapshots: `Snapshot.builder()`, disk or `.full()`, and `createArchive`

- **A disk snapshot (the default) holds "Files and owned volumes"** ([snapshots.mdx#L15-L18](https://github.com/superradcompany/microsandbox/blob/v0.7.6/docs/sandboxes/snapshots.mdx#L15-L18)), **not named volumes**: "Disk-only capture does not include independent named disks" ([coordinator.rs#L1145-L1146](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/runtime/lib/checkpoint/coordinator.rs#L1145-L1146)). It works from a stopped source with `auto` or `skip`; `required` fails there because no guest is running ([msb:sdk/rust/lib/backend/local/snapshot/create.rs#L1349-L1355](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/backend/local/snapshot/create.rs#L1349-L1355); [snapshots.mdx#L443-L444](https://github.com/superradcompany/microsandbox/blob/v0.7.6/docs/sandboxes/snapshots.mdx#L443-L444)). It also works from a running or paused one.
- **Disk snapshots copy the root layers twice:** with `fast_copy` on capture ([create.rs#L1088-L1097](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/backend/local/snapshot/create.rs#L1088-L1097)) and again on restore ([restore.rs#L178-L199](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/backend/local/snapshot/restore.rs#L178-L199), [#L473-L481](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/backend/local/snapshot/restore.rs#L473-L481)). Each copy is a reflink or a sparse copy, as in §3.
- **Restore can rename and rebind.** It takes a new `.name()`, `.volume(guest, m => m.bind(...) | m.named(...) | m.captured())`, CPUs, memory and network policy (`SDK/native/index.d.ts:753-833`). kndl already restores Environment snapshots this way, with its own named volumes and binds ([MicrosandboxBackend.ts:267-277](../../packages/runner/src/sandbox/MicrosandboxBackend.ts#L267-L277), [:677-707](../../packages/runner/src/sandbox/MicrosandboxBackend.ts#L677-L707)). Mapping a host directory to a new path is supported: `.volume("/work", v => v.bind("/host/copy"))` ([snapshots.mdx#L603-L610](https://github.com/superradcompany/microsandbox/blob/v0.7.6/docs/sandboxes/snapshots.mdx#L603-L610)).
- **A full snapshot captures named disks.** It does so the same way a fork does, as additional disks. It needs a running or paused source ([snapshots.mdx#L175](https://github.com/superradcompany/microsandbox/blob/v0.7.6/docs/sandboxes/snapshots.mdx#L175)). On restore, a captured disk can become:
  - a private copy (`captured()`: "Restore a private copy of a named disk volume", [snapshots.mdx#L651](https://github.com/superradcompany/microsandbox/blob/v0.7.6/docs/sandboxes/snapshots.mdx#L651)), but only as an unnamed disk image in the child's directory ([additional_disks.rs#L119-L149](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/backend/local/snapshot/restore/additional_disks.rs#L119-L149));
  - or a mapping to an *existing* named disk volume, whose current bytes are used. That's checked against `volume_path(name)/disk.raw` ([external_mounts.rs#L88-L101](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/external_mounts.rs#L88-L101)).
- **No snapshot option fills a *new named* volume from a captured disk.** Also, a full restore resumes the source's processes, which again carry the source's tokens (§7).
- **`createArchive(out)`** captures straight to a `.msb` file, disk by default or full with `.full()` ([snapshots.mdx#L1374-L1384](https://github.com/superradcompany/microsandbox/blob/v0.7.6/docs/sandboxes/snapshots.mdx#L1374-L1384); `SDK/dist/snapshot.d.ts:99-112`). "The archive keeps its type" ([snapshots.mdx#L1180](https://github.com/superradcompany/microsandbox/blob/v0.7.6/docs/sandboxes/snapshots.mdx#L1180)), so it covers volumes exactly as above. Archives are for moving between machines. On one host, all they add over an installed snapshot is a tar to write and read.

### (b) New volumes, with `disk.raw` copied in

**Where a disk volume's image lives:** `$MSB_HOME/volumes/<name>/disk.raw`, confirmed.
- `volume_path(name) = volumes_dir().join(name)` ([msb:sdk/rust/lib/backend/local/mod.rs#L214-L221](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/backend/local/mod.rs#L214-L221)).
- `volumes_dir()` is `paths.volumes` from the config if that's set, otherwise `<home>/volumes` ([msb:sdk/rust/lib/config/mod.rs#L481-L487](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/config/mod.rs#L481-L487)).
- Home is `$MSB_HOME`, falling back to `~/.microsandbox` ([msb:crates/utils/lib/lib.rs#L169-L176](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/utils/lib/lib.rs#L169-L176)).
- Creating a disk volume formats ext4 into `<dir>/disk.raw`, in a temporary sibling directory renamed into place ([msb:sdk/rust/lib/volume/mod.rs#L729-L782](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/volume/mod.rs#L729-L782)).
- Launch attaches `volume_path(name).join("disk.raw")` ([spawn.rs#L1832-L1857](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/runtime/spawn.rs#L1832-L1857)). Rust's `disk_path()` is the same path ([volume/mod.rs#L248-L255](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/volume/mod.rs#L248-L255)), and the docs say so: "Disk-backed local volumes store guest data inside `disk.raw`" ([volumes.mdx#L323](https://github.com/superradcompany/microsandbox/blob/v0.7.6/docs/sandboxes/volumes.mdx#L323)).

From Node, the `Volume` that `Volume.builder(..).create()` returns has a `path` getter, the volume directory (`SDK/dist/volume.d.ts:30`). `VolumeHandle` from `get` or `list` has no path (`SDK/dist/volume-handle.d.ts`). So the source's path has to be built, as kndl's `msbHome()` already does ([MicrosandboxBackend.ts:199](../../packages/runner/src/sandbox/MicrosandboxBackend.ts#L199)). That's wrong if `paths.volumes` is overridden.

**Why overwriting `disk.raw` is safe with the catalog:**
- The `volume` row holds `name, kind, quota_mib, size_bytes, capacity_bytes, disk_format, disk_fstype, labels` and timestamps. There's no checksum or inode ([msb:crates/db/lib/entity/volume.rs#L12-L26](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/db/lib/entity/volume.rs#L12-L26)). `size_bytes` is `None` at creation ([volume/mod.rs#L619](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/volume/mod.rs#L619)).
- Launch looks the volume up by name, then opens the path ([spawn.rs#L1785-L1863](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/runtime/spawn.rs#L1785-L1863)).
- So a same-capacity, same-format (raw ext4) image put in place of `disk.raw` matches what the catalog says **(inferred)**.

**Conditions:**
1. **The target's capacity must match the source file's size.** Create each target with the source's `VolumeHandle.capacityBytes`, not the spec's `sizeMib`, in case the spec has changed since. The runtime checks the file's capacity against the device state at capture ([additional_disk.rs#L244-L260](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/runtime/lib/checkpoint/additional_disk.rs#L244-L260)). I found no check at launch against `capacity_bytes` **(inferred)**.
2. **Nobody may be writing the source, and nobody may have the target attached.** A running VM holds `flock(LOCK_EX)` on each attached `disk.raw` ([spawn.rs#L2061-L2092](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/runtime/spawn.rs#L2061-L2092)). `cp` doesn't take that lock, so kndl must keep this rule itself:
   - The source is either stopped, or paused with `guestFlush: "required"` (§2).
   - The target is new and not yet mounted.
   - To check, kndl can try a non-blocking `flock` on the file, as `Volume.remove` does ([volume/mod.rs#L811-L850](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/volume/mod.rs#L811-L850)).
3. **The copy commands work as wanted:**
   - **GNU cp:** `cp --reflink=auto --sparse=always` tries `FICLONE` on the destination fd whatever the sparse mode, and falls back to a sparse copy ([coreutils v9.5 `src/copy.c` L1507-L1520](https://github.com/coreutils/coreutils/blob/v9.5/src/copy.c#L1507-L1520)). Only `--reflink=always` is limited to `--sparse=auto` ([`src/cp.c` L1244-L1248](https://github.com/coreutils/coreutils/blob/v9.5/src/cp.c#L1244-L1248)).
   - **macOS `cp -c`:** it unlinks an existing destination, then calls `clonefileat`. On `EXDEV` or `ENOTSUP` it falls back to an ordinary copy ([apple-oss-distributions/file_cmds `cp/utils.c` L263-L294](https://github.com/apple-oss-distributions/file_cmds/blob/659a8a301e2acf0343f8b8673a154a2ca4d07084/cp/utils.c#L263-L294), at `main`, which may be newer than a given macOS).
   - Either way, copying to a temporary name in the same directory and then `rename`-ing it over `disk.raw` keeps a failed copy from leaving a half-written image. Volume creation itself uses the same rename pattern.
4. **Reflinks need source and target on the same filesystem.** They are, since both are under `volumes_dir`. Otherwise the copy is sparse (allocated bytes only). APFS, btrfs and XFS with reflink are near-instant. ext4 copies the allocated bytes (§3).
5. **Both images keep the same ext4 UUID.** The guest mounts block devices by path, and the two are never attached to one VM, so this should be harmless **(inferred)**.

## 7. Recommendation for kndl

**Don't use `Sandbox.fork()`.** Besides §1-§5, a live fork copies the source's memory. That includes the tmux server and Claude Code process, whose environment holds the source Creator's setup token and Session token ([Tmux.ts:55-63](../../packages/runner/src/Tmux.ts#L55-L63)). A fork must run on the forker's token alone (ADR 0026, #332), so resuming the source's processes is the wrong thing even where it works **(inferred)**. A fork should cold-boot.

**Build a fork from parts, in the Runner:**

1. **Workspace:** the Runner copies `<sessions root>/<src>/workspace` to `<sessions root>/<new>/workspace`. Use a reflink copy where the host filesystem has one (`cp -c` / `cp --reflink=auto`), or a git-aware copy.
2. **Volumes:** for each key the source has (deps, cache, claude, docker; only claude once Archived):
   - `Volume.builder("kndl-<new>.<key>").disk().size(<source capacityBytes / MiB>).label(...).create()`;
   - copy the source's `disk.raw` over the new volume's, as in §6(b).
3. **Root disk:**
   - **Asleep (stopped):** `Snapshot.builder(tmp).fromSandbox(src).group(<fork group>).create()`, a disk snapshot. It's allowed on a stopped source with the default `auto` flush. Then run the existing `restore` path under the new Session id, with kndl's binds and the new volumes, relabelled through `modify` ([MicrosandboxBackend.ts:677-707](../../packages/runner/src/sandbox/MicrosandboxBackend.ts#L677-L707)). Remove the temporary snapshot afterwards, with `force`, since a group's head can't otherwise be removed (kndl already handles heads: [MicrosandboxBackend.ts:735](../../packages/runner/src/sandbox/MicrosandboxBackend.ts#L735)).
   - **Active (running, between Turns):**
     1. `pause({ guestFlush: "required" })`, which fails safe if the flush doesn't happen.
     2. Take the disk snapshot from the paused source. Allowed: "Pause with `required` before taking a disk snapshot" ([snapshots.mdx#L443](https://github.com/superradcompany/microsandbox/blob/v0.7.6/docs/sandboxes/snapshots.mdx#L443)). kndl's own `snapshot` currently refuses a running Sandbox ([MicrosandboxBackend.ts:666-667](../../packages/runner/src/sandbox/MicrosandboxBackend.ts#L666-L667)); a fork would need a path that accepts a paused one.
     3. Copy the volumes' `disk.raw` and the Workspace while the source is still paused.
     4. `resume()`.

     The source is untouched apart from the pause, whose length is the copy time: near zero with reflinks, the allocated bytes on ext4. An alternative that's simpler, but touches the source more, is to stop the source (as going Asleep does) and fork it as Asleep.
   - **Archived:** the root disk and the deps, cache and docker volumes are gone. Create the fork as a new Session from its Environment (`create`), with the copied claude volume and Workspace. Deps get reinstalled, as in #332's "Workspace and conversation only" alternative.
4. **Lineage and the token:** record the source Session and the fork point in kndl's own data (§5). The fork's Claude Code starts fresh on the forker's setup token. Its conversation carries on from the claude volume's copy, for example with `--resume`, which is outside this research.

The steps are the same in all three states, only the root disk differs. They use only public Node SDK calls plus a file copy. They give the fork kndl's own names, labels, env and mounts. They leave nothing linked between the two Sessions: snapshots and volumes are full copies or reflinks, and the source can be destroyed freely.

## Open questions that need a real host

1. **What a Node `fork()` child of a kndl Session actually does:** whether it starts with unavailable devices at the volume paths, or fails outright. The external-mount writeback check at [external_mounts.rs#L277-L291](https://github.com/superradcompany/microsandbox/blob/v0.7.6/sdk/rust/lib/sandbox/external_mounts.rs#L277-L291) might refuse it. This only matters to confirm "don't use it".
2. **Capacity:** whether a launch checks a named disk volume's file size against the catalog's `capacity_bytes`. I found no check; confirm before relying on matching the source's capacity.
3. **Pause timings:** how long `pause({ guestFlush: "required" })` takes on a busy Session, with dockerd and containers running, and whether containers come back cleanly after the resume. Also whether the docker volume's state, copied while paused (crash-consistent, not application-consistent), boots containers cleanly in the fork. kndl stops containers before a VM stops ([MicrosandboxBackend.ts:155-171](../../packages/runner/src/sandbox/MicrosandboxBackend.ts#L155-L171)) because crash-consistent isn't enough for them. The fork might need the same `stopDocker` first, which does touch the source's containers.
4. **Disk snapshot of a paused source:** confirm it works with kndl's root disk layout and leaves the source resumable. It rolls the source onto a new overlay head ([coordinator.rs#L572-L585](https://github.com/superradcompany/microsandbox/blob/v0.7.6/crates/runtime/lib/checkpoint/coordinator.rs#L572-L585)).
5. **Filesystems on real Runners:** which ones `$MSB_HOME` and the sessions root are on, whether they're the same one, and so whether reflinks apply (APFS on macOS; ext4, btrfs or XFS on Linux). Measure the time and disk used for copying each volume and the Workspace on ext4.
6. **Disk-snapshot restore cost:** how long and how much disk a disk-snapshot capture plus restore of a typical Session root disk takes on ext4. That's two sparse copies of the allocated root layers (§6(a)).
7. **The extra reboot:** a restored Sandbox comes back without labels or workdir. kndl sets them again with `modify`, which costs one reboot, and never sets env on a restored VM ([MicrosandboxBackend.ts:28-31](../../packages/runner/src/sandbox/MicrosandboxBackend.ts#L28-L31)). Measure how much that reboot adds to a fork's time to first prompt.
8. **Leftover disk after a Node `fork()`:** if `fork()` is ever tried, check whether the named-disk copies it captures but doesn't use are removed with the child's `.branch-restore` closure, or left behind.
