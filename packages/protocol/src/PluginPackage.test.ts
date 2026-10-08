import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import type { PackagedPlugin, Plugin, PluginSource } from "./Plugin.ts"
import {
  addedHeaderSecrets,
  gitRefProblem,
  gitUrlProblem,
  packageChanges,
  packageVersion,
  packagePathProblem,
  readPluginPackage,
  sameSource,
} from "./PluginPackage.ts"

const upload: PluginSource = { _tag: "Upload", fileName: "linear-mcp-1.0.0.tgz" }

/** Reads the two files as JSON: the package, or every problem, one per line. */
function read(packageJson: unknown, manifest: unknown, commit?: string) {
  return readPluginPackage(
    {
      packageJson: typeof packageJson === "string" ? packageJson : JSON.stringify(packageJson),
      manifest: typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    },
    upload,
    commit,
  )
}

function problems(packageJson: unknown, manifest: unknown): Array<string> {
  const result = read(packageJson, manifest)
  if (Result.isSuccess(result)) throw new Error("expected a refusal")
  return result.failure.split("\n")
}

const pkg = { name: "@acme/linear-mcp", version: "1.2.0" }
const manifest = { displayName: "Linear", mcp: { url: "https://mcp.linear.app/mcp" } }

describe("a package", () => {
  test("is its package.json name and version, and its manifest's name, URL and auth", () => {
    expect(
      Result.getOrThrow(read(pkg, { ...manifest, description: "Issues" }, "a".repeat(40))),
    ).toEqual({
      id: "@acme/linear-mcp",
      name: "Linear",
      description: "Issues",
      url: "https://mcp.linear.app/mcp",
      auth: { _tag: "None" },
      package: { version: "1.2.0", commit: "a".repeat(40), source: upload },
    } as PackagedPlugin)
  })

  test("maps header secrets 1:1 onto the Plugin's auth, the template {value} by default", () => {
    const headers = Result.getOrThrow(
      readPluginPackage(
        {
          packageJson: JSON.stringify(pkg),
          manifest: JSON.stringify({
            ...manifest,
            auth: {
              type: "headers",
              headers: [
                {
                  key: "apiKey",
                  title: "API key",
                  header: "Authorization",
                  template: "Bearer {value}",
                },
                { key: "team", title: "Team", header: "X-Team" },
              ],
            },
          }),
        },
        upload,
      ),
    )
    expect(headers.auth).toEqual({
      _tag: "Headers",
      headers: [
        { key: "apiKey", title: "API key", header: "Authorization", template: "Bearer {value}" },
        { key: "team", title: "Team", header: "X-Team", template: "{value}" },
      ],
    })
    expect(Result.getOrThrow(read(pkg, { ...manifest, auth: { type: "none" } })).auth).toEqual({
      _tag: "None",
    })
  })

  test("is refused a package.json that isn't an npm package's, saying why", () => {
    expect(problems("{", manifest)).toEqual(["package.json isn't JSON."])
    expect(problems([], manifest)).toEqual(["package.json must be a JSON object."])
    expect(problems({ version: "1.0.0" }, manifest)).toEqual([
      'package.json needs a "name": the Plugin\'s id.',
    ])
    expect(problems({ name: "Linear MCP", version: "1.0.0" }, manifest)).toEqual([
      "package.json's \"name\" Linear MCP isn't a valid npm package name: lowercase letters, digits, - . and _, with an optional @scope/.",
    ])
    expect(problems({ name: "hub:linear", version: "1.0.0" }, manifest)[0]).toContain(
      "isn't a valid npm package name",
    )
    expect(problems({ name: "linear" }, manifest)).toEqual([
      'package.json needs a "version", such as 1.0.0.',
    ])
    expect(problems({ name: "linear", version: "one" }, manifest)).toEqual([
      "package.json's \"version\" one isn't a semantic version, such as 1.0.0.",
    ])
  })

  test("is refused a manifest that breaks the format, naming each field", () => {
    expect(problems(pkg, "{")).toEqual(["kndl.json isn't JSON."])
    expect(problems(pkg, { mcp: { url: "ftp://x" }, extra: true })).toEqual([
      "kndl.json: extra isn't a field kndl.json has.",
      "kndl.json: displayName is missing.",
      "kndl.json: mcp.url must start with https:// (or http://).",
    ])
    expect(problems(pkg, { ...manifest, auth: { type: "oauth" } })).toEqual([
      'kndl.json: auth.type must be "none" or "headers".',
    ])
    expect(
      problems(pkg, {
        ...manifest,
        auth: {
          type: "headers",
          headers: [
            { key: "1key", title: "A", header: "X-A" },
            { key: "b", title: "", header: "X-B" },
            { key: "c", title: "C", header: "Bad Header" },
            { key: "d", title: "D", header: "Host" },
            { key: "e", title: "E", header: "X-E", template: "Bearer" },
            { key: "f", title: "F", header: 7 },
          ],
        },
      }),
    ).toEqual(["kndl.json: auth.headers[5].header must be string."])
    expect(
      problems(pkg, {
        ...manifest,
        auth: {
          type: "headers",
          headers: [
            { key: "1key", title: "A", header: "X-A" },
            { key: "b", title: "", header: "X-B" },
            { key: "c", title: "C", header: "Bad Header" },
            { key: "d", title: "D", header: "Host" },
            { key: "e", title: "E", header: "X-E", template: "Bearer" },
          ],
        },
      }),
    ).toEqual([
      `kndl.json: auth.headers[0]: "1key" isn't a key: use letters, digits and underscores, starting with a letter.`,
      "kndl.json: auth.headers[1]: A header secret needs a title.",
      `kndl.json: auth.headers[2]: "Bad Header" isn't a header name.`,
      "kndl.json: auth.headers[3]: The Gateway sets Host itself: use another header.",
      "kndl.json: auth.headers[4]: E's template must hold {value} exactly once, as in Bearer {value}.",
    ])
    expect(
      problems(pkg, {
        ...manifest,
        auth: {
          type: "headers",
          headers: [
            { key: "a", title: "A", header: "X-A" },
            { key: "a", title: "B", header: "X-B" },
          ],
        },
      }),
    ).toEqual(["kndl.json: auth.headers: The key a is declared twice."])
  })
})

const git = (url: string, path?: string, ref?: string): PluginSource => ({
  _tag: "Git",
  url,
  ...(path !== undefined && { path }),
  ...(ref !== undefined && { ref }),
})

describe("a git source", () => {
  test("is an https:// URL, with nothing git could run or reach locally", () => {
    expect(gitUrlProblem("https://github.com/acme/linear-mcp.git")).toBeUndefined()
    for (const url of [
      "http://github.com/acme/x",
      "file:///etc",
      "/srv/repo.git",
      "git@github.com:acme/x.git",
      "ssh://git@github.com/acme/x",
      "ext::sh -c touch% /tmp/x",
      "https://me:token@github.com/acme/x",
    ]) {
      expect(gitUrlProblem(url)).toBeDefined()
    }
  })

  test("is at a branch, tag or commit, which can't be an option or a refspec", () => {
    expect(gitRefProblem("main")).toBeUndefined()
    expect(gitRefProblem("v1.2.0")).toBeUndefined()
    expect(gitRefProblem("release/2026-10")).toBeUndefined()
    expect(gitRefProblem("a".repeat(40))).toBeUndefined()
    for (const ref of [
      "-upload-pack=x",
      "main:refs/heads/x",
      "+main",
      "a..b",
      "a b",
      "x.lock",
      "",
    ]) {
      expect(gitRefProblem(ref)).toBeDefined()
    }
  })

  test("is in a subfolder inside the repo", () => {
    expect(packagePathProblem("packages/linear")).toBeUndefined()
    for (const path of ["../x", "a/../../b", "/etc", "C:\\x", "a\\b", "a//b"]) {
      expect(packagePathProblem(path)).toBeDefined()
    }
  })

  test("is the same source by its URL and subfolder, at any ref", () => {
    expect(
      sameSource(
        git("https://github.com/acme/x"),
        git("https://GitHub.com/acme/x.git/", undefined, "v2"),
      ),
    ).toBe(true)
    expect(
      sameSource(git("https://github.com/acme/x", "a"), git("https://github.com/acme/x", "a/")),
    ).toBe(true)
    expect(
      sameSource(git("https://github.com/acme/x", "a"), git("https://github.com/acme/x")),
    ).toBe(false)
    expect(sameSource(git("https://github.com/acme/x"), git("https://github.com/acme/y"))).toBe(
      false,
    )
    expect(sameSource(upload, { _tag: "Upload", fileName: "other.zip" })).toBe(true)
    expect(sameSource(upload, git("https://github.com/acme/x"))).toBe(false)
  })
})

test("an Upgrade's changes are the manifest's, the version and the commit", () => {
  const plugin: Plugin = {
    id: "@acme/linear-mcp" as Plugin["id"],
    name: "Linear",
    url: "https://mcp.linear.app/mcp",
    auth: { _tag: "None" },
    package: { version: "1.0.0", commit: "a".repeat(40), source: upload },
    createdBy: { id: "github:1" as Plugin["createdBy"]["id"], login: "octocat", name: "octocat" },
    createdAt: 0,
  }
  const next: PackagedPlugin = {
    id: plugin.id,
    name: "Linear (beta)",
    url: "https://mcp.linear.app/v2",
    auth: {
      _tag: "Headers",
      headers: [
        { key: "apiKey", title: "API key", header: "Authorization", template: "Bearer {value}" },
      ],
    },
    package: { version: "2.0.0", commit: "b".repeat(40), source: upload },
  }
  expect(packageChanges(plugin, next)).toEqual([
    { what: "Version", before: "1.0.0", after: "2.0.0" },
    { what: "Commit", before: "aaaaaaa", after: "bbbbbbb" },
    { what: "Display name", before: "Linear", after: "Linear (beta)" },
    {
      what: "MCP server URL",
      before: "https://mcp.linear.app/mcp",
      after: "https://mcp.linear.app/v2",
    },
    {
      what: "Auth",
      before: "None",
      after: "Header secrets: API key (Authorization: Bearer {value})",
    },
  ])
  const same: PackagedPlugin = {
    id: plugin.id,
    name: plugin.name,
    url: plugin.url,
    auth: plugin.auth,
    package: { version: "1.0.0", commit: "a".repeat(40), source: upload },
  }
  expect(packageChanges(plugin, same)).toEqual([])
  expect([packageVersion(same.package), packageVersion({ version: "1.0.0" })]).toEqual([
    "1.0.0 (aaaaaaa)",
    "1.0.0",
  ])
})

const secret = (key: string) => ({ key, title: key, header: `X-${key}`, template: "{value}" })

test("an Upgrade's new header secrets are those whose keys the Plugin didn't have", () => {
  expect(addedHeaderSecrets({ _tag: "None" }, { _tag: "Headers", headers: [secret("a")] })).toEqual(
    [secret("a")],
  )
  expect(
    addedHeaderSecrets(
      { _tag: "Headers", headers: [secret("a")] },
      { _tag: "Headers", headers: [secret("a"), secret("b")] },
    ),
  ).toEqual([secret("b")])
  expect(addedHeaderSecrets({ _tag: "Headers", headers: [secret("a")] }, { _tag: "None" })).toEqual(
    [],
  )
})
