// The fake Hub's Environments (ADR 0009): each Repo's versions, the Hub-wide shared variables,
// and which drafts passed a Test build. It refuses what the real Hub refuses, with its words, so
// the screens can be tried against it; it keeps Sensitive values only to know they are set. A
// Repo's name is the same Repo however it is spelled (#197), and keeps the spelling it was first
// applied by.

import {
  type EnvironmentDraft,
  environmentDraftProblems,
  repoKey,
  type SharedVariableInput,
  variableNameProblem,
  sensitiveValueProblem,
  type ValueNeeded,
  valuesNeededText,
} from "@kndl/protocol"
import { Redacted } from "effect"
import { bob, you } from "./script.ts"
import type {
  EnvironmentVersionInfoWire,
  EnvironmentWire,
  ParticipantWire,
  SharedVariableWire,
} from "./wire.ts"

interface FakeEnvironment {
  environment: EnvironmentWire
  /** Newest first. */
  versions: Array<EnvironmentVersionInfoWire>
  /** Sensitive values by name, in memory only. */
  sensitive: Map<string, string>
}

interface FakeShared {
  readonly kind: "Plain" | "Sensitive"
  /** Null when a Sensitive one needs a value (#57). */
  readonly value: string | null
}

/** A draft the fake would build: its digest, and whether it changes the build. */
export interface Prepared {
  readonly digest: string
  readonly changesBuild: boolean
}

const minute = 60_000
const day = 24 * 60 * minute

export class FakeEnvironments {
  readonly #environments = new Map<string, FakeEnvironment>()
  readonly #shared = new Map<string, FakeShared>()
  /** Repo and digest of every draft whose Test build passed. */
  readonly #passed = new Set<string>()

  constructor(now = Date.now()) {
    this.#shared.set("GH_READ_TOKEN", { kind: "Sensitive", value: "made-up-gh-token" })
    this.#shared.set("SENTRY_DSN", { kind: "Plain", value: "https://key@sentry.example/1" })
    this.#shared.set("NPM_REGISTRY", { kind: "Plain", value: "https://registry.npmjs.org" })
    const repo = "kddige/kndl"
    this.#environments.set(repo, {
      environment: {
        repo,
        version: 2,
        image: "debian:bookworm-slim",
        bootstrapScript:
          "apt-get update\napt-get install -y curl git unzip\ncurl -fsSL https://bun.sh/install | bash",
        startScript: "bun install",
        docker: true,
        dependencyFolders: [
          { pattern: "**/node_modules", nextTo: "package.json" },
          { pattern: "**/.venv", nextTo: "pyproject.toml" },
          { pattern: "**/target", nextTo: "Cargo.toml" },
        ],
        resources: { cpus: 4, memoryMib: 8192 },
        variables: [
          { _tag: "Plain", name: "NODE_ENV", value: "development" },
          { _tag: "Sensitive", name: "NPM_TOKEN", availableAtBuild: true, needsValue: false },
          {
            _tag: "Link",
            name: "GITHUB_TOKEN",
            sharedVariable: "GH_READ_TOKEN",
            availableAtBuild: false,
          },
        ],
      },
      versions: [
        { version: 2, appliedBy: you, appliedAt: now - 40 * minute, rebuilt: false },
        { version: 1, appliedBy: bob, appliedAt: now - 4 * day, rebuilt: true },
      ],
      sensitive: new Map([["NPM_TOKEN", "made-up-npm-token"]]),
    })
  }

  /** The Repo's Environment, or null before its first, and its versions. */
  state(repo: string) {
    const found = this.#environments.get(repoKey(repo))
    return {
      _tag: "EnvironmentState" as const,
      repo,
      environment: found?.environment ?? null,
      versions: found?.versions ?? [],
    }
  }

  latestVersion(repo: string): number | undefined {
    return this.#environments.get(repoKey(repo))?.environment.version
  }

  /** What building the draft takes, or why the Hub would refuse it. */
  prepare(repo: string, draft: EnvironmentDraft): Prepared | string {
    const problems = environmentDraftProblems(draft)
    if (problems.length > 0) return problems.join(" ")
    const current = this.#environments.get(repoKey(repo))
    const atBuild: Array<[string, string]> = []
    for (const variable of draft.variables) {
      switch (variable._tag) {
        case "Plain":
          atBuild.push([variable.name, variable.value])
          break
        case "Sensitive": {
          const value =
            variable.value === undefined
              ? current?.sensitive.get(variable.name)
              : Redacted.value(variable.value)
          if (value === undefined) {
            return current?.environment.variables.some(
              (saved) => saved._tag === "Sensitive" && saved.name === variable.name,
            )
              ? `${valuesNeededText([variable])}: enter one.`
              : `${variable.name} has no saved Sensitive value: enter one.`
          }
          if (variable.availableAtBuild) atBuild.push([variable.name, value])
          break
        }
        case "Link": {
          const shared = this.#shared.get(variable.sharedVariable)
          if (!shared) {
            return `There is no shared variable ${variable.sharedVariable} to link as ${variable.name}.`
          }
          if (shared.value === null) {
            return `${valuesNeededText([variable])}: set it on the Shared variables screen.`
          }
          if (variable.availableAtBuild) atBuild.push([variable.name, shared.value])
          break
        }
      }
    }
    const digest = buildDigest(draft, atBuild)
    // A value entered for one that needs it restores it, as on the Hub: no Test build for that.
    const changesBuild =
      !current ||
      buildDigest(current.environment, this.#atBuild(current, new Map(atBuild))) !== digest
    return { digest, changesBuild }
  }

  #atBuild(
    current: FakeEnvironment,
    restored: ReadonlyMap<string, string>,
  ): Array<[string, string]> {
    const atBuild: Array<[string, string]> = []
    for (const variable of current.environment.variables) {
      switch (variable._tag) {
        case "Plain":
          atBuild.push([variable.name, variable.value])
          break
        case "Sensitive":
          if (variable.availableAtBuild) {
            const value = variable.needsValue
              ? restored.get(variable.name)
              : current.sensitive.get(variable.name)
            atBuild.push([variable.name, value ?? ""])
          }
          break
        case "Link":
          if (variable.availableAtBuild) {
            atBuild.push([variable.name, this.#shared.get(variable.sharedVariable)?.value ?? ""])
          }
          break
      }
    }
    return atBuild
  }

  /** The variables of the Repo's Environment that need a value, its own or linked (#57). */
  valuesNeeded(repo: string): ReadonlyArray<ValueNeeded> {
    const variables = this.#environments.get(repoKey(repo))?.environment.variables ?? []
    return variables.flatMap((variable): ReadonlyArray<ValueNeeded> => {
      if (variable._tag === "Sensitive" && variable.needsValue) return [variable]
      if (variable._tag === "Link" && this.#shared.get(variable.sharedVariable)?.value === null) {
        return [variable]
      }
      return []
    })
  }

  /**
   * What `secrets-reset` does on the Hub (#57): every Sensitive value, own or shared, is cleared
   * and needs a value again; the variables and links stay.
   */
  resetSecrets(): void {
    for (const found of this.#environments.values()) {
      found.sensitive.clear()
      found.environment = {
        ...found.environment,
        variables: found.environment.variables.map((variable) =>
          variable._tag === "Sensitive" ? { ...variable, needsValue: true } : variable,
        ),
      }
    }
    for (const [name, shared] of this.#shared) {
      if (shared.kind === "Sensitive") this.#shared.set(name, { kind: "Sensitive", value: null })
    }
    this.#passed.clear()
  }

  testBuildPassed(repo: string, digest: string): boolean {
    return this.#passed.has(`${repoKey(repo)} ${digest}`)
  }

  recordPassed(repo: string, digest: string): void {
    this.#passed.add(`${repoKey(repo)} ${digest}`)
  }

  /** Applies the draft as the Repo's next version, or says why not. */
  apply(
    repo: string,
    baseVersion: number | null,
    draft: EnvironmentDraft,
    by: ParticipantWire,
  ): string | undefined {
    const current = this.#environments.get(repoKey(repo))
    const currentVersion = current?.environment.version ?? null
    if (currentVersion !== baseVersion) {
      return currentVersion === null
        ? `${repo} has no Environment to change yet; apply a new one.`
        : `${repo}'s Environment has changed since: version ${currentVersion} is the latest. Reload it, and apply your draft on top.`
    }
    const prepared = this.prepare(repo, draft)
    if (typeof prepared === "string") return prepared
    if (prepared.changesBuild && !this.testBuildPassed(repo, prepared.digest)) {
      return "This change affects the build: run a Test build of exactly this draft, and apply it once it passes."
    }
    const sensitive = new Map<string, string>()
    for (const variable of draft.variables) {
      if (variable._tag !== "Sensitive") continue
      const value =
        variable.value === undefined
          ? current?.sensitive.get(variable.name)
          : Redacted.value(variable.value)
      if (value !== undefined) sensitive.set(variable.name, value)
    }
    const version = (currentVersion ?? 0) + 1
    this.#environments.set(repoKey(repo), {
      environment: {
        repo: current?.environment.repo ?? repo,
        version,
        image: draft.image,
        bootstrapScript: draft.bootstrapScript,
        ...(draft.startScript !== undefined && { startScript: draft.startScript }),
        docker: draft.docker,
        dependencyFolders: draft.dependencyFolders.map((folder) => ({ ...folder })),
        resources: { ...draft.resources },
        variables: draft.variables.map((variable) =>
          variable._tag === "Sensitive"
            ? {
                _tag: "Sensitive" as const,
                name: variable.name,
                availableAtBuild: variable.availableAtBuild,
                needsValue: false,
              }
            : { ...variable },
        ),
      },
      versions: [
        { version, appliedBy: by, appliedAt: Date.now(), rebuilt: prepared.changesBuild },
        ...(current?.versions ?? []),
      ],
      sensitive,
    })
    return undefined
  }

  /** Every shared variable, with the Environments that link it; no Sensitive values. */
  sharedVariables(): Array<SharedVariableWire> {
    return [...this.#shared]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, shared]) => {
        const linkedBy = [...this.#environments.values()].flatMap(({ environment }) =>
          environment.variables
            .filter((variable) => variable._tag === "Link" && variable.sharedVariable === name)
            .map((variable) => ({
              repo: environment.repo,
              name: variable.name,
              availableAtBuild: variable._tag === "Link" && variable.availableAtBuild,
            })),
        )
        return shared.kind === "Plain"
          ? { _tag: "Plain" as const, name, value: shared.value ?? "", linkedBy }
          : { _tag: "Sensitive" as const, name, linkedBy, needsValue: shared.value === null }
      })
  }

  setShared(variable: SharedVariableInput): string | undefined {
    const { name } = variable
    const problem = variableNameProblem(name)
    if (problem !== undefined) return problem
    if (variable._tag === "Plain") {
      this.#shared.set(name, { kind: "Plain", value: variable.value })
      return undefined
    }
    if (variable.value === undefined) {
      const kept = this.#shared.get(name)
      if (kept?.kind !== "Sensitive") return `${name} has no saved Sensitive value: enter one.`
      if (kept.value === null) {
        return `${valuesNeededText([{ name, availableAtBuild: false }])}: enter one.`
      }
      return undefined
    }
    const value = Redacted.value(variable.value)
    const tooShort = sensitiveValueProblem(name, value)
    if (tooShort !== undefined) return tooShort
    this.#shared.set(name, { kind: "Sensitive", value })
    return undefined
  }

  deleteShared(name: string): string | undefined {
    if (!this.#shared.has(name)) return `There is no shared variable ${name}.`
    const repos = [...this.#environments.values()]
      .filter(({ environment }) =>
        environment.variables.some(
          (variable) => variable._tag === "Link" && variable.sharedVariable === name,
        ),
      )
      .map(({ environment }) => environment.repo)
    if (repos.length > 0)
      return `${name} is linked in ${repos.join(", ")}: remove those links first.`
    this.#shared.delete(name)
    return undefined
  }
}

/** What goes into a build, as the Hub digests it: the recipe but its resources. */
function buildDigest(
  recipe: Pick<
    EnvironmentDraft,
    "image" | "bootstrapScript" | "startScript" | "docker" | "dependencyFolders"
  >,
  atBuild: ReadonlyArray<[string, string]>,
): string {
  return JSON.stringify([
    recipe.image,
    recipe.bootstrapScript,
    recipe.startScript ?? null,
    recipe.docker,
    recipe.dependencyFolders.map((folder) => [folder.pattern, folder.nextTo ?? null]),
    atBuild.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ])
}

/** The log a Test build of `draft` streams, line by line, and whether it passes. */
export function testBuildScript(
  repo: string,
  draft: EnvironmentDraft,
): { lines: Array<string>; passes: boolean } {
  const lines = [
    `Building on the Runner: ${draft.image}, ${draft.resources.cpus} CPUs, ${draft.resources.memoryMib} MiB`,
    `Pulling ${draft.image}`,
    `${draft.image}: Pull complete`,
    "Running the bootstrap script",
  ]
  let passes = true
  for (const line of draft.bootstrapScript.split("\n")) {
    if (line.trim() === "") continue
    lines.push(`+ ${line}`)
    if (/\bexit [1-9]/.test(line) || /\bfalse\b/.test(line)) {
      lines.push(`bootstrap: the script exited with status 1`)
      passes = false
      break
    }
    lines.push(`  ok (${Math.max(1, line.length % 7)}s)`)
  }
  if (passes) {
    lines.push("Snapshotting the disk")
    if (draft.docker) lines.push("Docker: its data goes on a disk of its own")
    lines.push(`Cloning ${repo} (default branch) into a fresh Workspace`)
    if (draft.startScript !== undefined) {
      lines.push("Running the start script")
      for (const line of draft.startScript.split("\n")) {
        if (line.trim() !== "") lines.push(`+ ${line}`)
      }
    }
    lines.push("Test build passed")
  }
  return { lines, passes }
}

/**
 * What a Session's start prints before the agent is up, as its Runner sends it (#70): the
 * Environment's build the first time the Session starts on its version, then its start script.
 * Terminal output, as a build's is: colours, and lines ended with CR LF.
 */
export function sessionStartScript(
  environment: EnvironmentWire | null,
  build: boolean,
): Array<string> {
  const lines: Array<string> = []
  if (environment !== null && build) {
    lines.push(
      `Building version ${environment.version} of ${environment.repo}'s Environment`,
      "#1 [internal] load build definition from Dockerfile",
      `#2 [1/3] FROM docker.io/library/${environment.image}`,
      "#2 \u001b[34mDONE 3.1s\u001b[0m",
      "#3 [2/3] RUN the bootstrap script",
    )
    for (const line of environment.bootstrapScript.split("\n")) {
      if (line.trim() !== "") lines.push(`#3 + ${line}`)
    }
    lines.push(
      "#3 \u001b[34mDONE 24.6s\u001b[0m",
      "#4 [3/3] exporting to image",
      "#4 \u001b[34mDONE 2.2s\u001b[0m",
    )
  }
  lines.push("Starting the Sandbox")
  if (environment?.startScript !== undefined) {
    lines.push("Running the start script")
    for (const line of environment.startScript.split("\n")) {
      if (line.trim() !== "") lines.push(`+ ${line}`)
    }
  }
  lines.push("\u001b[32m✓\u001b[0m Starting the agent")
  return lines.map((line) => `${line}\r\n`)
}
