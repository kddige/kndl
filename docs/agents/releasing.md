# Releasing

How to cut a Release of kndl (ADR 0025). A Release is a tag on `main` named by date, like `v2026.10.1`. Pushing the tag runs `.github/workflows/release.yml`, which checks the tag, runs CI on its commit and creates the GitHub Release.

## Cut a Release

1. **Pick the version.** `bun scripts/release.ts next` prints it from today's date (UTC) and the existing tags. `n` counts the Releases within the month, starting at 1, and isn't a day of the month. Never zero-pad: `v2026.1.3`, not `v2026.01.03`.
2. **Check `main` is green.** `gh run list --branch main --workflow ci.yml --limit 1` must show success for the commit you'll tag.
3. **Preview the notes.** `git switch main && git pull`, then `bun scripts/release.ts notes <tag>`. That prints the notes for `HEAD` until the tag exists. Commits listed under **Other** didn't follow the PR title convention. They're released anyway; just read them.
4. **Tag and push.** Confirm the version with whoever asked for the Release first: a pushed tag is public and permanent.

   ```sh
   git tag -a v2026.10.1 -m v2026.10.1
   git push origin v2026.10.1
   ```

5. **Watch the workflow.** Run `gh run watch` on the Release run. If the tag fails its check or CI fails, no Release is made. See "When it goes wrong".
6. **Write the highlights.** `--notes-file` replaces the whole body, so start from the published notes and replace only the `<!-- … -->` placeholder line under **Highlights**, keeping the sections below it:

   ```sh
   gh release view v2026.10.1 --json body --jq .body > notes.md
   # edit notes.md
   gh release edit v2026.10.1 --notes-file notes.md
   ```

   Write a bullet for each change someone running kndl would notice, from the area sections below. Lead with a bold line saying what changed for them, then a sentence or two on what used to happen and what happens now. Quote error messages exactly, so people can search for them. Leave internal changes (tests, CI, refactors) to the generated list. [`v2026.10.2`](https://github.com/kddige/kndl/releases/tag/v2026.10.2) is the model.

7. **Check it's out.** `gh release list --limit 1` shows the new tag as **Latest**, and `git ls-remote --tags origin '<tag>'` finds it. A fresh `curl … | sh` then prints `Installing Release <tag>`, but run that only on a disposable machine: the installer overwrites `~/.local/bin/kndl`, and `kndl uninstall --purge` deletes it, even with `KNDL_HOME` set elsewhere.

## When it goes wrong

- **Never move or re-push a tag.** Installs may already have checked it out. A fix to a bad Release is a new Release with the next `n`.
- **If the workflow failed before creating the Release**, the tag points at a commit that never became a Release. Leave the tag. Fix `main`, then cut the next version.
- **If the Release is broken**, mark it with a line at the top of its notes, and cut the next version with the fix.

## PR titles

The notes come from the squash-merged PR titles on `main`: `<areas>: <change> (#<issue>)`, where `<areas>` comes from `hub`, `runner`, `web`, `cli`, `mod`, `protocol`, `docs`, `brand`, `ci` and `repo`, main area first. Each one is listed under its first area.
