---
status: accepted
---

# Anyone who sees an Archived Session can purge it

An Archived Session is purged 30 days after it was archived. A Runner low on disk can't wait that long, so a Session can also be purged by hand, at once (#351). Anyone who can see the Archived Session may purge it: any Member with access to its Repo, not just its Creator. This is the one exception to ADR 0026's rule that only the Creator controls a Session.

Purging is about the Runner, not the Session. It frees the Runner's disk, and it makes no request on anyone's Claude credential, so it isn't driving. The Creator may be away, or no longer a Member, while the disk fills. Waiting on them would leave nobody able to free it, and a Session whose Creator is gone can't be driven anyway. Restoring stays the Creator's alone, since a restored Session runs on their token.

Only an Archived Session can be purged, so purging always comes after the Creator chose to delete it. Repo access still applies: to someone without it, the Session doesn't exist.

## Considered options

- **The Creator alone, as for archive and restore.** It's consistent with ADR 0026, but a disk that's filling up would wait on one person, who may be gone.
- **The Runner's owner or the Hub's Owner alone.** kndl has no Runner owners, and the Owner has no rights the other Members lack (ADR 0019).

## Consequences

- **Unpushed work can be lost sooner, by someone else.** The Creator has 30 days to restore a Session they deleted by mistake, unless another Participant purges it first. The confirmation names each Session and warns that work it never pushed goes with it.
- **There's no record of who purged a Session.** Its history goes with it.
