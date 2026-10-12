# Releasing

How to cut a Release of kndl (ADR 0025). A Release is a tag on `main` named by date, like `v2026.10.1`. Pushing the tag runs `.github/workflows/release.yml`, which checks the tag, runs CI on its commit and creates the GitHub Release.

## Cut a Release

1. **Pick the version.** `bun scripts/release.ts next` prints it from today's date (UTC) and the existing tags. `n` counts the Releases within the month, starting at 1, and isn't a day of the month. Never zero-pad: `v2026.1.3`, not `v2026.01.03`.
2. **Check `main` is green.** `gh run list --branch main --workflow ci.yml --limit 1` must show success for the commit you'll tag.
3. **Preview the notes.** `git switch main && git pull`, then `bun scripts/release.ts notes <tag>`. That prints the notes for `HEAD` until the tag exists. Commits listed under **Other** didn't follow the PR title convention. They're released anyway; just read them.
4. **Tag and push.**

   ```sh
   git tag -a v2026.10.1 -m v2026.10.1
   git push origin v2026.10.1
   ```

5. **Watch the workflow.** Run `gh run watch` on the Release run. If the tag fails its check or CI fails, no Release is made. See "When it goes wrong".
6. **Write the highlights.** In the GitHub Release, replace the Highlights placeholder with a few lines on what matters most to someone running kndl: `gh release edit v2026.10.1 --notes-file <file>`, or edit it on the web.

## When it goes wrong

- **Never move or re-push a tag.** Installs may already have checked it out. A fix to a bad Release is a new Release with the next `n`.
- **If the workflow failed before creating the Release**, the tag points at a commit that never became a Release. Leave the tag. Fix `main`, then cut the next version.
- **If the Release is broken**, mark it with a line at the top of its notes, and cut the next version with the fix.

## PR titles

The notes come from the squash-merged PR titles on `main`: `<areas>: <change> (#<issue>)`, where `<areas>` comes from `hub`, `runner`, `web`, `cli`, `mod`, `protocol`, `docs`, `brand`, `ci` and `repo`, main area first. Each one is listed under its first area.
