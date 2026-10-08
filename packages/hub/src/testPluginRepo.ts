// Git repos of Plugin packages for tests, on disk and reached by `file://` URLs, so the Hub's git
// fetching is tested offline (PluginSources.layerWith({ protocols: ["https", "file"] })).

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const dirs: Array<string> = []

/** Removes every repo made so far. */
export function removePluginRepos() {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** Runs git in `cwd` as a person would, without their config. */
function git(cwd: string, ...args: Array<string>): string {
  const run = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Octocat",
      GIT_AUTHOR_EMAIL: "octocat@example.com",
      GIT_COMMITTER_NAME: "Octocat",
      GIT_COMMITTER_EMAIL: "octocat@example.com",
    },
  })
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`)
  return run.stdout.toString().trim()
}

export type RepoFiles = Record<string, string | { readonly symlink: string }>

/** A package's `package.json`, named `name` at `version`. */
export const packageJson = (version: string, name = "@acme/linear-mcp") =>
  JSON.stringify({ name, version })

/** A package's `kndl.json`, with no auth unless given. */
export const manifest = (url = "https://mcp.linear.app/mcp", more: object = {}) =>
  JSON.stringify({ displayName: "Linear", mcp: { url }, ...more })

/** A repo with a commit of the files on its default branch, `main`. */
export function pluginRepo(files: RepoFiles) {
  const dir = mkdtempSync(join(tmpdir(), "kndl-plugin-repo-"))
  dirs.push(dir)
  git(dir, "init", "--quiet", "--initial-branch=main")
  /** Commits the files, and returns the commit. */
  const commit = (next: RepoFiles, message = "Change") => {
    for (const [path, content] of Object.entries(next)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      if (typeof content === "string") writeFileSync(join(dir, path), content)
      else symlinkSync(content.symlink, join(dir, path))
    }
    git(dir, "add", "--all")
    git(dir, "commit", "--quiet", "-m", message)
    return git(dir, "rev-parse", "HEAD")
  }
  const first = commit(files, "First")
  return { url: `file://${dir}`, first, commit, tag: (name: string) => git(dir, "tag", name) }
}
