import { Result, Schema, SchemaIssue } from "effect"
import { PluginId } from "./Ids.ts"
import {
  type HeaderSecret,
  headerSecretsOf,
  MaxPluginNameLength,
  type PackagedPlugin,
  type Plugin,
  type PluginAuth,
  pluginAuthProblem,
  type PluginSource,
  pluginUrlProblem,
  ValuePlaceholder,
} from "./Plugin.ts"

// A packaged Plugin (#220, ADR 0020): a folder with a `package.json` and, beside it, a kndl
// manifest, `kndl.json`, added from a git repo or an upload. The Hub reads only those two files
// and runs nothing: a Plugin is so far only an MCP server's URL and the auth it needs.
//
//   package.json  name     the Plugin's id: an npm package name, so unique wherever npm's are
//                 version  what it is pinned to, with the commit from git
//   kndl.json     { "displayName": "Linear", "description": "…",
//                   "mcp": { "url": "https://mcp.linear.app/mcp" },
//                   "auth": { "type": "none" } }
//
// `auth` is optional and none by default; its other form is header secrets,
// `{ "type": "headers", "headers": [{ "key", "title", "header", "template"? }] }`, which maps 1:1
// onto the Plugin's `Headers` auth, the template `{value}` by default.

/** The kndl manifest's file name, beside `package.json`. */
export const PluginManifestFile = "kndl.json"

/** A manifest's description, at most this long. */
export const MaxPluginDescriptionLength = 500

// oxlint-disable-next-line no-control-regex
const controlCharacters = /[\u0000-\u001f\u007f]/

const oneLineOf = (max: number) =>
  Schema.makeFilter(
    (text: string) =>
      (text.trim() !== "" && text.length <= max && !controlCharacters.test(text)) ||
      `must be one line of 1 to ${max} characters`,
  )

/** The manifest's fields but its auth, which {@link readAuth} reads for clearer errors. */
const Manifest = Schema.Struct({
  /** For editors that validate it. */
  $schema: Schema.optionalKey(Schema.String),
  displayName: Schema.String.check(oneLineOf(MaxPluginNameLength)),
  description: Schema.optionalKey(Schema.String.check(oneLineOf(MaxPluginDescriptionLength))),
  mcp: Schema.Struct({
    url: Schema.String.check(
      Schema.makeFilter((url: string) => {
        const problem = pluginUrlProblem(url)
        return problem === undefined ? true : problem.replace(/^The URL /, "").replace(/\.$/, "")
      }),
    ),
  }),
  auth: Schema.optionalKey(Schema.Unknown),
})

const AuthType = Schema.Struct({ type: Schema.Literals(["none", "headers"]) })

const NoAuth = Schema.Struct({ type: Schema.Literal("none") })

const HeadersAuth = Schema.Struct({
  type: Schema.Literal("headers"),
  headers: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      title: Schema.String,
      header: Schema.String,
      template: Schema.optionalKey(Schema.String),
    }),
  ),
})

const strict = { errors: "all", onExcessProperty: "error" } as const

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1()

/** A field's path as JSON shows it, such as `auth.headers[0].key`. */
const pathText = (path: ReadonlyArray<PropertyKey>, prefix: string) =>
  path.reduce<string>(
    (text, key) =>
      typeof key === "number"
        ? `${text}[${key}]`
        : text === ""
          ? String(key)
          : `${text}.${String(key)}`,
    prefix,
  )

/** Each problem with a manifest's field, as one line. */
function manifestProblems(issue: SchemaIssue.Issue, prefix = ""): Array<string> {
  return formatIssue(issue).issues.map(({ path, message }) => {
    const field = pathText(
      (path ?? []).map((key) => (typeof key === "object" ? key.key : key)),
      prefix,
    )
    const said =
      message === "Missing key"
        ? "is missing"
        : message === "Expected no excess property"
          ? `isn't a field ${PluginManifestFile} has`
          : message.startsWith("Expected ")
            ? `must be ${message.slice("Expected ".length)}`
            : message
    return field === ""
      ? `${PluginManifestFile} ${said}.`
      : `${PluginManifestFile}: ${field} ${said}.`
  })
}

/** The Plugin's auth from the manifest's `auth`, or each problem with it. */
function readAuth(auth: unknown): Result.Result<PluginAuth, Array<string>> {
  if (auth === undefined) return Result.succeed({ _tag: "None" })
  if (Result.isFailure(Schema.decodeUnknownResult(AuthType)(auth))) {
    return Result.fail([`${PluginManifestFile}: auth.type must be "none" or "headers".`])
  }
  const type = (auth as { readonly type: "none" | "headers" }).type
  if (type === "none") {
    return Schema.decodeUnknownResult(NoAuth)(auth, strict).pipe(
      Result.map((): PluginAuth => ({ _tag: "None" })),
      Result.mapError((error) => manifestProblems(error.issue, "auth")),
    )
  }
  return Schema.decodeUnknownResult(HeadersAuth)(auth, strict).pipe(
    Result.mapError((error) => manifestProblems(error.issue, "auth")),
    Result.flatMap(({ headers }) => {
      const mapped: PluginAuth = {
        _tag: "Headers",
        headers: headers.map((header) => ({
          ...header,
          title: header.title.trim(),
          template: header.template ?? ValuePlaceholder,
        })),
      }
      // The rules for header secrets are a Hub-only Plugin's too: each header's own first, then
      // those across them, such as unique keys.
      const each = mapped.headers.flatMap((header, index) => {
        const problem = pluginAuthProblem({ _tag: "Headers", headers: [header] })
        return problem === undefined
          ? []
          : [`${PluginManifestFile}: auth.headers[${index}]: ${problem}`]
      })
      if (each.length > 0) return Result.fail(each)
      const problem = pluginAuthProblem(mapped)
      return problem === undefined
        ? Result.succeed(mapped)
        : Result.fail([`${PluginManifestFile}: auth.headers: ${problem}`])
    }),
  )
}

/**
 * An npm package name, as npm accepts a new one: lowercase, URL-safe, with an optional scope. No
 * colon, so never a Hub-only Plugin's `hub:` id.
 */
const npmName = /^(?:@[a-z0-9-][a-z0-9-._]*\/)?[a-z0-9-][a-z0-9-._]*$/

/** Why a `package.json` name can't be a Plugin's id, if it can't. */
export function npmNameProblem(name: string): string | undefined {
  if (name.length > 214 || !npmName.test(name) || name === "node_modules") {
    return `package.json's "name" ${name} isn't a valid npm package name: lowercase letters, digits, - . and _, with an optional @scope/.`
  }
  return undefined
}

/** A semantic version, as semver.org writes it. */
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

function parseJson(text: string): Result.Result<unknown, undefined> {
  try {
    return Result.succeed(JSON.parse(text))
  } catch {
    return Result.fail(undefined)
  }
}

/** The package.json's name and version, or each problem with them. */
function readPackageJson(
  text: string,
): Result.Result<{ readonly name: string; readonly version: string }, Array<string>> {
  const parsed = parseJson(text)
  if (Result.isFailure(parsed)) return Result.fail(["package.json isn't JSON."])
  const json = parsed.success
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return Result.fail(["package.json must be a JSON object."])
  }
  const { name, version } = json as { readonly name?: unknown; readonly version?: unknown }
  const problems: Array<string> = []
  if (typeof name !== "string" || name === "") {
    problems.push(`package.json needs a "name": the Plugin's id.`)
  } else {
    const problem = npmNameProblem(name)
    if (problem !== undefined) problems.push(problem)
  }
  if (typeof version !== "string" || version === "") {
    problems.push(`package.json needs a "version", such as 1.0.0.`)
  } else if (version.length > 256 || !semver.test(version)) {
    problems.push(`package.json's "version" ${version} isn't a semantic version, such as 1.0.0.`)
  }
  return problems.length > 0
    ? Result.fail(problems)
    : Result.succeed({ name: name as string, version: version as string })
}

/**
 * The Plugin a package's `package.json` and manifest make, read from `source` (at `commit`, from
 * git), or every problem with them, one per line.
 */
export function readPluginPackage(
  files: { readonly packageJson: string; readonly manifest: string },
  source: PluginSource,
  commit?: string,
): Result.Result<PackagedPlugin, string> {
  const packageJson = readPackageJson(files.packageJson)
  const problems = Result.isFailure(packageJson) ? [...packageJson.failure] : []
  const parsed = parseJson(files.manifest)
  if (Result.isFailure(parsed)) {
    problems.push(`${PluginManifestFile} isn't JSON.`)
    return Result.fail(problems.join("\n"))
  }
  const manifest = Schema.decodeUnknownResult(Manifest)(parsed.success, strict)
  if (Result.isFailure(manifest)) problems.push(...manifestProblems(manifest.failure.issue))
  const auth = readAuth(
    typeof parsed.success === "object" && parsed.success !== null
      ? (parsed.success as { readonly auth?: unknown }).auth
      : undefined,
  )
  if (Result.isFailure(auth)) problems.push(...auth.failure)
  if (Result.isFailure(packageJson) || Result.isFailure(manifest) || Result.isFailure(auth)) {
    return Result.fail(problems.join("\n"))
  }
  const { displayName, description, mcp } = manifest.success
  return Result.succeed({
    id: PluginId.make(packageJson.success.name),
    name: displayName.trim(),
    ...(description !== undefined && { description: description.trim() }),
    url: mcp.url,
    auth: auth.success,
    package: {
      version: packageJson.success.version,
      ...(commit !== undefined && { commit }),
      source,
    },
  })
}

// ── Git sources ────────────────────────────────────────────────────────────

/** Why a git URL is refused, if it is: only `https://`, so git reaches nothing local. */
export function gitUrlProblem(url: string): string | undefined {
  if (url.length > 2048) return "The git URL is longer than 2048 characters."
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return "The git URL isn't a URL, such as https://github.com/acme/linear-mcp.git."
  }
  if (parsed.protocol !== "https:" || controlCharacters.test(url) || /\s/.test(url)) {
    return "The git URL must start with https://."
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "The git URL can't hold a user name or password: the repo must be public."
  }
  if (parsed.hash !== "") return "The git URL can't have a #fragment."
  return undefined
}

/**
 * Why a git ref is refused, if it is: a branch, tag or full commit, which git can't take for an
 * option or a refspec.
 */
export function gitRefProblem(ref: string): string | undefined {
  const ok =
    /^[A-Za-z0-9._/-]{1,200}$/.test(ref) &&
    !/^[-./]/.test(ref) &&
    !/[./]$/.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("//") &&
    !/\.lock(?:\/|$)/.test(ref)
  return ok ? undefined : `${ref === "" ? "The ref" : ref} isn't a branch, tag or commit.`
}

/** A subfolder as the Hub keeps it: no `./` before, no `/` after; empty for the repo's root. */
export const packagePath = (path: string) => path.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "")

/** Why a subfolder is refused, if it is: it must be a relative path inside the repo. */
export function packagePathProblem(path: string): string | undefined {
  const normalized = packagePath(path)
  if (normalized === "") return undefined
  if (
    normalized.length > 500 ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    controlCharacters.test(normalized) ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return `${path} isn't a folder inside the repo, such as packages/linear.`
  }
  return undefined
}

/** A git URL as compared: its host in lowercase, without a trailing `/` or `.git`. */
const gitUrlKey = (url: string) => {
  try {
    const parsed = new URL(url)
    return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "").replace(/\.git$/, "")}`
  } catch {
    return url
  }
}

/**
 * Whether two packages came from the same source, so one may upgrade the other: the same git
 * repo and subfolder, at any ref, or both uploads.
 */
export function sameSource(a: PluginSource, b: PluginSource): boolean {
  if (a._tag === "Upload" || b._tag === "Upload") return a._tag === b._tag
  return (
    gitUrlKey(a.url) === gitUrlKey(b.url) && packagePath(a.path ?? "") === packagePath(b.path ?? "")
  )
}

// ── Showing packages ───────────────────────────────────────────────────────

/** Where a package came from, as the web UI says it. */
export function sourceText(source: PluginSource): string {
  if (source._tag === "Upload") return `Uploaded ${source.fileName}`
  const path = packagePath(source.path ?? "")
  return `${source.url}${source.ref !== undefined ? ` at ${source.ref}` : ""}${path !== "" ? ` in ${path}/` : ""}`
}

/** A Plugin's auth, as the web UI says it. */
export function authText(auth: PluginAuth): string {
  if (auth._tag === "None") return "None"
  return `Header secrets: ${auth.headers
    .map(({ title, header, template }) => `${title} (${header}: ${template})`)
    .join(", ")}`
}

/** A commit, short. */
export const shortCommit = (commit: string) => commit.slice(0, 7)

/** What a packaged Plugin is pinned to, as Sessions and the log say it: `1.2.0 (abc1234)` from git. */
export const packageVersion = (pinned: { readonly version: string; readonly commit?: string }) =>
  pinned.commit === undefined ? pinned.version : `${pinned.version} (${shortCommit(pinned.commit)})`

/** One thing an Upgrade changes. */
export interface PackageChange {
  readonly what: string
  readonly before: string
  readonly after: string
}

/** What upgrading the Plugin to the package changes; none when it is the same. */
export function packageChanges(plugin: Plugin, next: PackagedPlugin): Array<PackageChange> {
  const fields: Array<[string, string, string]> = [
    ["Version", plugin.package?.version ?? "", next.package.version],
    ["Commit", shortCommit(plugin.package?.commit ?? ""), shortCommit(next.package.commit ?? "")],
    [
      "Source",
      plugin.package === undefined ? "" : sourceText(plugin.package.source),
      sourceText(next.package.source),
    ],
    ["Display name", plugin.name, next.name],
    ["Description", plugin.description ?? "", next.description ?? ""],
    ["MCP server URL", plugin.url, next.url],
    ["Auth", authText(plugin.auth), authText(next.auth)],
  ]
  return fields
    .filter(([, before, after]) => before !== after)
    .map(([what, before, after]) => ({ what, before, after }))
}

/**
 * The header secrets an Upgrade adds, by key: each Installation needs a value for each before its
 * Sessions start again.
 */
export function addedHeaderSecrets(
  before: PluginAuth,
  after: PluginAuth,
): ReadonlyArray<HeaderSecret> {
  const had = new Set(headerSecretsOf(before).map(({ key }) => key))
  return headerSecretsOf(after).filter(({ key }) => !had.has(key))
}
