---
name: do-release
description: "Use whenever you're asked to cut, tag or publish a release of kndl."
---

Cut the Release by following `docs/agents/releasing.md` from step 1 to step 7, in order. It is the single source for the steps: read it in full before you start, and change it, not this skill, when the process changes.

Two of those steps are where a Release goes wrong for good:

- **Step 4:** confirm the version with the person who asked before you push the tag. A pushed tag is public and permanent, and is never moved or pushed again.
- **Step 6:** keep the generated area sections when you write the highlights.

The Release is done when the Release workflow is green, the Highlights placeholder is replaced with real highlights above the generated sections, and `gh release list --limit 1` shows the tag as Latest. If any step fails, follow "When it goes wrong" in the same doc: the fix is always the next version.
