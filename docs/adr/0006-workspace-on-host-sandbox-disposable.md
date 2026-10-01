---
status: accepted
---

# The Workspace lives on the host; Sandboxes are disposable

Each Session's Workspace (a clone of the Repo on its Work branch) and its Docker data live on host volumes mounted into the Sandbox. The Sandbox itself can be stopped or destroyed at any time without losing work. Asleep means the Sandbox is stopped after 15 minutes idle, and waking boots a fresh one on the same volumes. The WIP ref (ADR 0005) covers losing the host itself.

Memory snapshots were considered for faster wake and full process state. They are deferred, because snapshot files are large and the backend's snapshot support is young. Services started inside a Sandbox restart from their persisted data instead.
