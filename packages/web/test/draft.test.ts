import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  DefaultEnvironmentDraft,
  type Environment,
  environmentDraftProblems,
  EnvironmentVersion,
  RepoName,
  type SharedVariable,
  valuesNeededText,
} from "@kndl/protocol"
import { Redacted } from "effect"
import {
  draftIdentity,
  draftProblems,
  editFrom,
  type EnvironmentEdit,
  forgetEdit,
  isUnchanged,
  loadEdit,
  newVariable,
  parseEdit,
  storeEdit,
  toDraft,
  valuesNeeded,
} from "../src/environment/draft.ts"

// A made-up secret, never a real one.
const secret = "made-up-secret-value"

const saved: Environment = {
  repo: RepoName.make("acme/app"),
  version: EnvironmentVersion.make(3),
  image: "debian:bookworm-slim",
  bootstrapScript: "apt-get install -y git",
  startScript: "bun install",
  docker: true,
  dependencyFolders: [{ pattern: "**/node_modules", nextTo: "package.json" }],
  resources: { cpus: 2, memoryMib: 4096 },
  variables: [
    { _tag: "Plain", name: "NODE_ENV", value: "development" },
    { _tag: "Sensitive", name: "NPM_TOKEN", availableAtBuild: true, needsValue: false },
    { _tag: "Link", name: "GITHUB_TOKEN", sharedVariable: "GH_TOKEN", availableAtBuild: false },
  ],
}

const shared: ReadonlyArray<SharedVariable> = [
  { _tag: "Sensitive", name: "GH_TOKEN", linkedBy: [], needsValue: false },
]

const withVariable = (edit: EnvironmentEdit, change: Partial<EnvironmentEdit["variables"][0]>) => ({
  ...edit,
  variables: [...edit.variables, { ...newVariable("Plain"), ...change }],
})

describe("a draft", () => {
  test("of a Repo without an Environment starts from the protocol's default", () => {
    const edit = editFrom(null)
    expect(edit.baseVersion).toBeNull()
    expect(toDraft(edit)).toEqual(DefaultEnvironmentDraft)
    expect(environmentDraftProblems(toDraft(edit))).toEqual([])
  })

  test("of an Environment keeps everything but Sensitive values, which it never had", () => {
    const edit = editFrom(saved)
    expect(edit.baseVersion).toBe(EnvironmentVersion.make(3))
    const draft = toDraft(edit)
    expect(draft.variables).toEqual([
      { _tag: "Plain", name: "NODE_ENV", value: "development" },
      // No value: the Hub keeps the saved one.
      { _tag: "Sensitive", name: "NPM_TOKEN", availableAtBuild: true },
      { _tag: "Link", name: "GITHUB_TOKEN", sharedVariable: "GH_TOKEN", availableAtBuild: false },
    ])
    expect(draft.startScript).toBe("bun install")
    expect(isUnchanged(edit, saved)).toBe(true)
  })

  test("a new Sensitive value is sent redacted, and makes the draft a different one", () => {
    const edit = editFrom(saved)
    const replaced = {
      ...edit,
      variables: edit.variables.map((variable) =>
        variable.kind === "Sensitive" ? { ...variable, value: secret } : variable,
      ),
    }
    const sent = toDraft(replaced).variables.find((variable) => variable._tag === "Sensitive")
    expect(sent?._tag === "Sensitive" && sent.value && Redacted.value(sent.value)).toBe(secret)
    // Redacted, it prints as nothing.
    expect(JSON.stringify(toDraft(replaced))).not.toContain(secret)
    expect(draftIdentity(toDraft(replaced))).not.toBe(draftIdentity(toDraft(edit)))
    expect(isUnchanged(replaced, saved)).toBe(false)
  })

  test("a blank start script or next-to file is left out, and numbers as typed are checked", () => {
    const edit = { ...editFrom(saved), startScript: "  ", cpus: "two" }
    const draft = toDraft({
      ...edit,
      dependencyFolders: [{ key: "f", pattern: " **/target ", nextTo: " " }],
    })
    expect(draft.startScript).toBeUndefined()
    expect(draft.dependencyFolders).toEqual([{ pattern: "**/target" }])
    expect(draftProblems(edit, { environment: saved, sharedVariables: shared }).cpus).toBe(
      "Enter a whole number of CPUs.",
    )
  })
})

const problemsOf = (edit: EnvironmentEdit) =>
  draftProblems(edit, { environment: saved, sharedVariables: shared })

describe("problems", () => {
  test("none for the saved Environment", () => {
    expect(problemsOf(editFrom(saved)).all).toEqual([])
  })

  test("the protocol's, in its words", () => {
    const problems = problemsOf({ ...editFrom(saved), image: "not an image", memoryMib: "64" })
    expect(problems.image).toBe(
      '"not an image" is not an image reference, such as buildpack-deps:bookworm.',
    )
    expect(problems.memoryMib).toContain("Memory must be from 256")
    expect(problems.all).toEqual(
      environmentDraftProblems(
        toDraft({ ...editFrom(saved), image: "not an image", memoryMib: "64" }),
      ),
    )
  })

  test("a name clash between a variable and a link shows on the row, before applying", () => {
    const edit = withVariable(editFrom(saved), { name: "GITHUB_TOKEN", value: "x" })
    const problems = problemsOf(edit)
    const clash = edit.variables.at(-1)?.key ?? ""
    expect(problems.variables[clash]).toBe(
      "Another variable or link is named GITHUB_TOKEN: each needs its own name.",
    )
    expect(problems.all).toContain(
      "GITHUB_TOKEN is there twice: each variable and link needs its own name.",
    )
  })

  test("a Sensitive variable needs a value unless one is saved, and one long enough", () => {
    const missing = withVariable(editFrom(saved), { kind: "Sensitive", name: "API_KEY" })
    expect(problemsOf(missing).all).toContain("API_KEY has no saved Sensitive value: enter one.")
    const short = withVariable(editFrom(saved), {
      kind: "Sensitive",
      name: "API_KEY",
      value: "abc",
    })
    expect(problemsOf(short).all.join(" ")).toContain("API_KEY is under 4 characters")
  })

  test("a link needs a shared variable that exists", () => {
    const unpicked = withVariable(editFrom(saved), { kind: "Link", name: "DSN" })
    expect(problemsOf(unpicked).all).toContain("DSN links no shared variable: pick one.")
    const gone = withVariable(editFrom(saved), {
      kind: "Link",
      name: "DSN",
      sharedVariable: "SENTRY_DSN",
    })
    expect(problemsOf(gone).all).toContain("There is no shared variable SENTRY_DSN to link as DSN.")
  })

  test("a value that needs entering again, after secrets-reset, in the Hub's words", () => {
    const reset: Environment = {
      ...saved,
      variables: saved.variables.map((variable) =>
        variable._tag === "Sensitive" ? { ...variable, needsValue: true } : variable,
      ),
    }
    const resetShared: ReadonlyArray<SharedVariable> = [
      { _tag: "Sensitive", name: "GH_TOKEN", linkedBy: [], needsValue: true },
    ]
    const after = { environment: reset, sharedVariables: resetShared }
    expect(valuesNeededText(valuesNeeded(after))).toBe(
      "NPM_TOKEN and GITHUB_TOKEN (the shared variable GH_TOKEN) need values",
    )
    const edit = editFrom(reset)
    const [, npm, link] = edit.variables
    const problems = draftProblems(edit, after)
    expect(problems.variables[npm?.key ?? ""]).toBe("NPM_TOKEN needs a value: enter one.")
    expect(problems.variables[link?.key ?? ""]).toBe(
      "GITHUB_TOKEN (the shared variable GH_TOKEN) needs a value: set it on the Shared variables screen.",
    )
    // Entering one clears it.
    const entered = {
      ...edit,
      variables: edit.variables.map((variable) =>
        variable.kind === "Sensitive" ? { ...variable, value: secret } : variable,
      ),
    }
    expect(draftProblems(entered, after).variables[npm?.key ?? ""]).toBeUndefined()
    expect(valuesNeeded({ environment: saved, sharedVariables: shared })).toEqual([])
  })

  test("a reserved or unnamed variable", () => {
    const reserved = withVariable(editFrom(saved), { name: "KNDL_X" })
    expect(problemsOf(reserved).all.join(" ")).toContain("KNDL_X is reserved")
    expect(problemsOf(withVariable(editFrom(saved), {})).all).toContain("A variable has no name.")
  })
})

describe("kept across reloads", () => {
  const store = new Map<string, string>()
  const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  beforeAll(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    })
  })
  afterAll(() => {
    if (had) Object.defineProperty(globalThis, "localStorage", had)
    else Reflect.deleteProperty(globalThis, "localStorage")
  })

  test("per Repo, without Sensitive values", () => {
    const edit = withVariable(
      { ...editFrom(saved), image: "ubuntu:24.04" },
      { kind: "Sensitive", name: "API_KEY", value: secret },
    )
    storeEdit("acme/app", edit)
    expect([...store.values()].join()).not.toContain(secret)
    const loaded = loadEdit("acme/app")
    expect(loaded?.image).toBe("ubuntu:24.04")
    expect(loaded?.baseVersion).toBe(EnvironmentVersion.make(3))
    expect(loaded?.variables.map((variable) => [variable.name, variable.value])).toEqual([
      ["NODE_ENV", "development"],
      ["NPM_TOKEN", ""],
      ["GITHUB_TOKEN", ""],
      ["API_KEY", ""],
    ])
    expect(loadEdit("acme/other")).toBeNull()
    forgetEdit("acme/app")
    expect(loadEdit("acme/app")).toBeNull()
  })

  test("what's stored is checked, and a Sensitive value in it is dropped", () => {
    expect(parseEdit(null)).toBeNull()
    expect(parseEdit({ ...JSON.parse(JSON.stringify(editFrom(saved))), cpus: 2 })).toBeNull()
    const planted = JSON.parse(JSON.stringify(editFrom(saved)))
    planted.variables[1].value = secret
    expect(parseEdit(planted)?.variables[1]?.value).toBe("")
    store.set("kndl:environment-draft:acme/app", "{not json")
    expect(loadEdit("acme/app")).toBeNull()
  })

  test("without storage, a draft lasts as long as the page", () => {
    const working = globalThis.localStorage
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("storage is off")
      },
    })
    try {
      expect(() => storeEdit("acme/app", editFrom(saved))).not.toThrow()
      expect(loadEdit("acme/app")).toBeNull()
      expect(() => forgetEdit("acme/app")).not.toThrow()
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: working })
    }
  })
})
