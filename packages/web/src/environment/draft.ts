// A Repo's Environment as the Environment screen edits it (ADR 0009): a draft that lives in the
// browser until it is applied. It is kept in localStorage per Repo, so a reload doesn't lose it,
// without the values of Sensitive variables, which stay in memory only.
//
// The checks are the protocol's, so the screen refuses what the Hub would, with the same words,
// before anything is sent; and a few the Hub makes against what it has saved (a Sensitive value
// to keep, a shared variable to link), against what the screen knows of those.

import {
  DefaultEnvironmentDraft,
  type DependencyFolder,
  type Environment,
  type EnvironmentDraft,
  type EnvironmentVariableInput,
  EnvironmentVersion,
  environmentDraftProblems,
  dependencyFolderProblem,
  sensitiveValueProblem,
  type SharedVariable,
  variableNameProblem,
} from "@claude-hub/protocol"
import { Redacted } from "effect"

export type VariableKind = "Plain" | "Sensitive" | "Link"

/** A variable or link, as one row of the screen edits it. */
export interface DraftVariable {
  /** Identifies the row while its name is edited. */
  readonly key: string
  readonly kind: VariableKind
  readonly name: string
  /** Plain: its value. Sensitive: a new value, or "" to keep the saved one. Link: unused. */
  readonly value: string
  /** Link: the shared variable's own name. */
  readonly sharedVariable: string
  /** Sensitive and Link: whether the bootstrap gets it. Plain variables always do. */
  readonly availableAtBuild: boolean
}

export interface DraftFolder {
  readonly key: string
  readonly pattern: string
  /** "" for none. */
  readonly nextTo: string
}

export interface EnvironmentEdit {
  /** The version the draft was made from; null before the Repo's first. */
  readonly baseVersion: EnvironmentVersion | null
  readonly image: string
  readonly bootstrapScript: string
  /** "" for none. */
  readonly startScript: string
  readonly docker: boolean
  readonly dependencyFolders: ReadonlyArray<DraftFolder>
  /** As typed, so a field can be cleared while typing. */
  readonly cpus: string
  readonly memoryMib: string
  readonly variables: ReadonlyArray<DraftVariable>
}

let keys = 0
export const newKey = (): string => `k${++keys}`

/** A draft of `environment` as it is, or of the protocol's default for a Repo without one. */
export function editFrom(environment: Environment | null): EnvironmentEdit {
  const from = environment ?? DefaultEnvironmentDraft
  return {
    baseVersion: environment?.version ?? null,
    image: from.image,
    bootstrapScript: from.bootstrapScript,
    startScript: from.startScript ?? "",
    docker: from.docker,
    dependencyFolders: from.dependencyFolders.map(folderRow),
    cpus: String(from.resources.cpus),
    memoryMib: String(from.resources.memoryMib),
    variables: (environment?.variables ?? []).map((variable) => {
      const row = { key: newKey(), name: variable.name, value: "", sharedVariable: "" }
      switch (variable._tag) {
        case "Plain":
          return { ...row, kind: "Plain", value: variable.value, availableAtBuild: true }
        case "Sensitive":
          return { ...row, kind: "Sensitive", availableAtBuild: variable.availableAtBuild }
        case "Link":
          return {
            ...row,
            kind: "Link",
            sharedVariable: variable.sharedVariable,
            availableAtBuild: variable.availableAtBuild,
          }
      }
    }),
  }
}

const folderRow = (folder: DependencyFolder): DraftFolder => ({
  key: newKey(),
  pattern: folder.pattern,
  nextTo: folder.nextTo ?? "",
})

export const newVariable = (kind: VariableKind): DraftVariable => ({
  key: newKey(),
  kind,
  name: "",
  value: "",
  sharedVariable: "",
  availableAtBuild: kind === "Plain",
})

export const newFolder = (): DraftFolder => ({ key: newKey(), pattern: "", nextTo: "" })

/** A whole number as typed, or NaN. */
const whole = (typed: string): number => (/^\s*\d+\s*$/.test(typed) ? Number(typed) : Number.NaN)

/** The draft to send: what the Hub checks, tests and applies. */
export function toDraft(edit: EnvironmentEdit): EnvironmentDraft {
  return {
    image: edit.image.trim(),
    bootstrapScript: edit.bootstrapScript,
    ...(edit.startScript.trim() !== "" && { startScript: edit.startScript }),
    docker: edit.docker,
    dependencyFolders: edit.dependencyFolders.map(({ pattern, nextTo }) => ({
      pattern: pattern.trim(),
      ...(nextTo.trim() !== "" && { nextTo: nextTo.trim() }),
    })),
    resources: { cpus: whole(edit.cpus), memoryMib: whole(edit.memoryMib) },
    variables: edit.variables.map((variable): EnvironmentVariableInput => {
      const name = variable.name.trim()
      switch (variable.kind) {
        case "Plain":
          return { _tag: "Plain", name, value: variable.value }
        case "Sensitive":
          return {
            _tag: "Sensitive",
            name,
            availableAtBuild: variable.availableAtBuild,
            ...(variable.value !== "" && { value: Redacted.make(variable.value) }),
          }
        case "Link":
          return {
            _tag: "Link",
            name,
            sharedVariable: variable.sharedVariable,
            availableAtBuild: variable.availableAtBuild,
          }
      }
    }),
  }
}

/**
 * Identifies exactly what a draft says, Sensitive values included, so an answer about one draft
 * (a check, a Test build) is never taken for another. In memory only.
 */
export function draftIdentity(draft: EnvironmentDraft): string {
  return JSON.stringify(draft, (_key, value: unknown) =>
    Redacted.isRedacted(value) ? { secret: Redacted.value(value) } : value,
  )
}

/** Whether applying the draft would change nothing: no new values and the same recipe. */
export function isUnchanged(edit: EnvironmentEdit, environment: Environment | null): boolean {
  if (environment === null || edit.baseVersion !== environment.version) return false
  return draftIdentity(toDraft(edit)) === draftIdentity(toDraft(editFrom(environment)))
}

export interface DraftProblems {
  /** Everything the Hub would refuse, in its words, plus what the rows below add. */
  readonly all: ReadonlyArray<string>
  /** The problem with each variable row, by key, shown on the row. */
  readonly variables: Readonly<Record<string, string>>
  readonly folders: Readonly<Record<string, string>>
  readonly image?: string
  readonly cpus?: string
  readonly memoryMib?: string
}

export interface Saved {
  /** The Environment as last applied, for the Sensitive values it keeps. */
  readonly environment: Environment | null
  /** The shared variables, once loaded, for the links. */
  readonly sharedVariables: ReadonlyArray<SharedVariable> | null
}

/**
 * Why the Hub would refuse the draft, as far as the browser can tell: the protocol's rules, a
 * Sensitive variable with neither a new value nor a saved one, a link to no shared variable.
 */
export function draftProblems(edit: EnvironmentEdit, saved: Saved): DraftProblems {
  const draft = toDraft(edit)
  // An unnamed row gets plainer words than the protocol's, below.
  const unnamed = variableNameProblem("")
  const all = environmentDraftProblems(draft).filter((problem) => problem !== unnamed)
  const variables: Record<string, string> = {}
  const folders: Record<string, string> = {}

  const savedSensitive = new Set(
    (saved.environment?.variables ?? [])
      .filter((variable) => variable._tag === "Sensitive")
      .map((variable) => variable.name),
  )
  const shared = saved.sharedVariables && new Set(saved.sharedVariables.map((v) => v.name))
  const seen = new Map<string, number>()
  for (const variable of edit.variables) {
    const name = variable.name.trim()
    seen.set(name, (seen.get(name) ?? 0) + 1)
  }
  for (const variable of edit.variables) {
    const name = variable.name.trim()
    let problem =
      name === ""
        ? "Give it a name."
        : (variableNameProblem(name) ??
          ((seen.get(name) ?? 0) > 1
            ? `Another variable or link is named ${name}: each needs its own name.`
            : undefined))
    if (problem === undefined && variable.kind === "Sensitive") {
      if (variable.value !== "") problem = sensitiveValueProblem(name, variable.value)
      else if (!savedSensitive.has(name)) {
        problem = `${name} has no saved Sensitive value: enter one.`
        all.push(problem)
      }
    }
    if (problem === undefined && variable.kind === "Link") {
      if (variable.sharedVariable === "") {
        problem = "Pick the shared variable to link."
        all.push(`${name} links no shared variable: pick one.`)
      } else if (shared && !shared.has(variable.sharedVariable)) {
        problem = `There is no shared variable ${variable.sharedVariable} to link as ${name}.`
        all.push(problem)
      }
    }
    if (name === "") all.push("A variable has no name.")
    if (problem !== undefined) variables[variable.key] = problem
  }

  const patterns = new Set<string>()
  for (const [index, folder] of draft.dependencyFolders.entries()) {
    const row = edit.dependencyFolders[index]
    if (!row) continue
    const problem =
      dependencyFolderProblem(folder) ??
      (patterns.has(folder.pattern) ? `${folder.pattern} is there twice.` : undefined)
    patterns.add(folder.pattern)
    if (problem !== undefined) folders[row.key] = problem
  }

  const resource = (typed: string, label: string, problem: (text: string) => boolean) => {
    if (Number.isNaN(whole(typed))) return `Enter a whole number of ${label}.`
    return all.find(problem)
  }
  const image = all.find((text) => text.includes("is not an image reference"))
  const cpus = resource(edit.cpus, "CPUs", (text) => text.startsWith("CPUs"))
  const memoryMib = resource(edit.memoryMib, "MiB", (text) => text.startsWith("Memory"))
  return {
    all: [...new Set(all)],
    variables,
    folders,
    ...(image !== undefined && { image }),
    ...(cpus !== undefined && { cpus }),
    ...(memoryMib !== undefined && { memoryMib }),
  }
}

// ── Kept across reloads ────────────────────────────────────────────────────

const storageKey = (repo: string) => `claude-hub:environment-draft:${repo}`

/** The draft saved for `repo`, if any; never with Sensitive values. */
export function loadEdit(repo: string): EnvironmentEdit | null {
  try {
    const text = localStorage.getItem(storageKey(repo))
    if (text === null) return null
    return parseEdit(JSON.parse(text))
  } catch {
    return null
  }
}

/** Keeps the draft for `repo`, Sensitive values left out. */
export function storeEdit(repo: string, edit: EnvironmentEdit): void {
  try {
    const stored: EnvironmentEdit = {
      ...edit,
      variables: edit.variables.map((variable) =>
        variable.kind === "Sensitive" ? { ...variable, value: "" } : variable,
      ),
    }
    localStorage.setItem(storageKey(repo), JSON.stringify(stored))
  } catch {
    // Storage is full or off: the draft lasts until the page is closed.
  }
}

export function forgetEdit(repo: string): void {
  try {
    localStorage.removeItem(storageKey(repo))
  } catch {
    // Nothing to forget.
  }
}

/** A draft read back from storage, which anything may have written: checked field by field. */
export function parseEdit(raw: unknown): EnvironmentEdit | null {
  if (!isRecord(raw)) return null
  const { baseVersion, image, bootstrapScript, startScript, docker, cpus, memoryMib } = raw
  if (
    !(baseVersion === null || (Number.isInteger(baseVersion) && Number(baseVersion) >= 1)) ||
    typeof image !== "string" ||
    typeof bootstrapScript !== "string" ||
    typeof startScript !== "string" ||
    typeof docker !== "boolean" ||
    typeof cpus !== "string" ||
    typeof memoryMib !== "string" ||
    !Array.isArray(raw["dependencyFolders"]) ||
    !Array.isArray(raw["variables"])
  ) {
    return null
  }
  const folders: Array<DraftFolder> = []
  for (const folder of raw["dependencyFolders"] as Array<unknown>) {
    if (!isRecord(folder)) return null
    const { pattern, nextTo } = folder
    if (typeof pattern !== "string" || typeof nextTo !== "string") return null
    folders.push({ key: newKey(), pattern, nextTo })
  }
  const variables: Array<DraftVariable> = []
  for (const variable of raw["variables"] as Array<unknown>) {
    if (!isRecord(variable)) return null
    const { kind, name, value, sharedVariable, availableAtBuild } = variable
    if (
      (kind !== "Plain" && kind !== "Sensitive" && kind !== "Link") ||
      typeof name !== "string" ||
      typeof value !== "string" ||
      typeof sharedVariable !== "string" ||
      typeof availableAtBuild !== "boolean"
    ) {
      return null
    }
    variables.push({
      key: newKey(),
      kind,
      name,
      // A Sensitive value never comes back from storage, whatever wrote it.
      value: kind === "Sensitive" ? "" : value,
      sharedVariable,
      availableAtBuild,
    })
  }
  return {
    baseVersion: baseVersion === null ? null : EnvironmentVersion.make(Number(baseVersion)),
    image,
    bootstrapScript,
    startScript,
    docker,
    dependencyFolders: folders,
    cpus,
    memoryMib,
    variables,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
