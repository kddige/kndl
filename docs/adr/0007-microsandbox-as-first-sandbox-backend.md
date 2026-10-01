---
status: accepted
---

# microsandbox is the first Sandbox backend, behind our own interface

Sandboxes are libkrun microVMs managed through microsandbox. It runs with the same TypeScript SDK on macOS (Apple Silicon) and on Linux/KVM, mounts host directories, can run Docker inside the VM (so agents can start databases and services to test their work), and offers snapshots for later. It is pre-1.0 and has had security advisories, so it is wrapped behind our own Sandbox backend interface, and is run with extra hardening on Linux.

## Considered options

- **Gondolin**: the best programmable network and secret layer, but Alpine-only images, undocumented Docker support, a FUSE-backed workspace and stalled releases. A strong second backend.
- **Firecracker / Cloud Hypervisor**: production-grade, but Linux/KVM only, so they can't run on the development Macs. Candidates for a hardened Linux backend later.
- **Apple `container`**: macOS-only with a Swift/XPC API, which doesn't fit a swappable TypeScript backend.
- **Hosted (E2B, Daytona, Modal, Fly)**: rejected for v1 to stay self-hosted.
