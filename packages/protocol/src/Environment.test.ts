import { describe, expect, test } from "bun:test"
import { Redacted, Schema } from "effect"
import {
  DefaultEnvironmentDraft,
  dependencyFolderProblem,
  EnvironmentDraft,
  EnvironmentState,
  environmentDraftProblems,
  variableNameProblem,
} from "./Environment.ts"
import { environmentDraft, expectRoundTrips } from "./testSupport.ts"

const decodeDraft = Schema.decodeUnknownSync(EnvironmentDraft)

describe("EnvironmentDraft", () => {
  test("round-trips, with a Sensitive value redacted once decoded", () => {
    expectRoundTrips(EnvironmentDraft, [environmentDraft])
    const draft = decodeDraft(environmentDraft)
    expect(String(JSON.stringify(draft))).not.toContain("npm_secret")
    const sensitive = draft.variables.find((variable) => variable.name === "NPM_TOKEN")
    expect(
      sensitive?._tag === "Sensitive" && sensitive.value && Redacted.value(sensitive.value),
    ).toBe("npm_secret")
  })

  test("the default is a valid draft", () => {
    expect(environmentDraftProblems(DefaultEnvironmentDraft)).toEqual([])
    expect(DefaultEnvironmentDraft.dependencyFolders).toEqual([
      { pattern: "**/node_modules", nextTo: "package.json" },
      { pattern: "**/.venv", nextTo: "pyproject.toml" },
      { pattern: "**/target", nextTo: "Cargo.toml" },
    ])
  })
})

describe("EnvironmentState", () => {
  test("never carries a Sensitive value to the web", () => {
    const encoded = Schema.encodeSync(EnvironmentState)({
      _tag: "EnvironmentState",
      repo: "kddige/kndl",
      environment: {
        repo: "kddige/kndl",
        version: 1 as never,
        ...DefaultEnvironmentDraft,
        // A value that slipped into a view is not part of the schema, so it is not sent.
        variables: [
          {
            _tag: "Sensitive",
            name: "TOKEN",
            availableAtBuild: false,
            needsValue: false,
            value: "x1",
          },
        ],
      } as never,
      versions: [],
    })
    expect(JSON.stringify(encoded)).not.toContain("x1")
  })
})

describe("variableNameProblem", () => {
  test("accepts environment-variable names", () => {
    for (const name of ["NODE_ENV", "_private", "a1", "Api_Key"]) {
      expect(variableNameProblem(name)).toBeUndefined()
    }
  })

  test("refuses names a shell can't export, and the Runner's own", () => {
    for (const name of ["", "1PASSWORD", "MY-VAR", "A B", "PATH=x", "x".repeat(129)]) {
      expect(variableNameProblem(name)).toBeString()
    }
    expect(variableNameProblem("KNDL_URL")).toContain("reserved")
    expect(variableNameProblem("kndl_token")).toContain("reserved")
  })
})

describe("dependencyFolderProblem", () => {
  test("accepts relative patterns ending in a folder, with a file to sit next to", () => {
    expect(dependencyFolderProblem({ pattern: "**/node_modules", nextTo: "package.json" })).toBe(
      undefined,
    )
    expect(dependencyFolderProblem({ pattern: "apps/*/target" })).toBeUndefined()
  })

  test("refuses patterns that leave the Workspace or match no folder name", () => {
    for (const pattern of ["", "/abs", "../up", "a/../b", "a//b", "**", "**/*", "a b"]) {
      expect(dependencyFolderProblem({ pattern })).toBeString()
    }
    expect(
      dependencyFolderProblem({ pattern: "**/.venv", nextTo: "sub/pyproject.toml" }),
    ).toBeString()
    expect(dependencyFolderProblem({ pattern: "**/.venv", nextTo: "../x" })).toBeString()
    expect(dependencyFolderProblem({ pattern: "**/.venv", nextTo: ".." })).toBeString()
  })
})

describe("environmentDraftProblems", () => {
  test("accepts a sound draft", () => {
    expect(environmentDraftProblems(decodeDraft(environmentDraft))).toEqual([])
  })

  test("refuses two variables of one name, local or linked", () => {
    const draft = decodeDraft({
      ...environmentDraft,
      variables: [
        { _tag: "Plain", name: "TOKEN", value: "a" },
        { _tag: "Link", name: "TOKEN", sharedVariable: "GITHUB_TOKEN", availableAtBuild: false },
      ],
    })
    expect(environmentDraftProblems(draft)).toEqual([
      "TOKEN is there twice: each variable and link needs its own name.",
    ])
  })

  test("refuses a bad image, resources out of range and a repeated pattern", () => {
    const problems = environmentDraftProblems(
      decodeDraft({
        ...environmentDraft,
        image: "not an image",
        resources: { cpus: 0, memoryMib: 100 },
        dependencyFolders: [{ pattern: "**/target" }, { pattern: "**/target" }],
      }),
    )
    expect(problems).toHaveLength(4)
  })
})
