import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionId } from "./Ids.ts"
import {
  BranchChoice,
  branchesFor,
  branchNameProblem,
  MaxBranchNameLength,
  newBranchProblem,
  workBranchFor,
  isDockerPort,
  joinAnswers,
  MaxSessionNameLength,
  OpenPort,
  Participant,
  repoKey,
  sameRepo,
  SessionName,
  SessionSummary,
  sessionNameFrom,
  sessionTitle,
} from "./Session.ts"
import { alice, expectRejected, expectRoundTrips, sessionSummary } from "./testSupport.ts"

const avatarUrl = "https://avatars.githubusercontent.com/u/583231?v=4"

describe("Participant", () => {
  test("has an optional avatar, which isn't empty", () => {
    expectRoundTrips(Participant, [alice, { ...alice, avatarUrl }])
    expect("avatarUrl" in Schema.decodeUnknownSync(Participant)(alice)).toBe(false)
    expectRejected(Participant, { ...alice, avatarUrl: "" })
    expectRejected(Participant, { ...alice, avatarUrl: 7 })
  })
})

describe("SessionSummary", () => {
  test("round-trips with and without each optional field", () => {
    expectRoundTrips(SessionSummary, [
      sessionSummary,
      { ...sessionSummary, creator: { ...alice, avatarUrl } },
      // The last output of a Claude Code that exited on its own.
      {
        ...sessionSummary,
        state: "Asleep",
        lastOutput: "error: The current working directory was deleted",
      },
      {
        ...sessionSummary,
        openPorts: [
          { port: 3000, addresses: ["0.0.0.0", "::"], process: "node server" },
          { port: 5173, addresses: ["::1"] },
        ],
      },
      { ...sessionSummary, name: "Health check" },
    ])
  })
})

describe("Open ports", () => {
  test("a port is between 1 and 65535 and has its addresses", () => {
    expectRoundTrips(OpenPort, [
      { port: 1, addresses: ["127.0.0.1"] },
      { port: 65535, addresses: [] },
    ])
    expectRejected(OpenPort, { port: 0, addresses: [] })
    expectRejected(OpenPort, { port: 65536, addresses: [] })
    expectRejected(OpenPort, { port: 80.5, addresses: [] })
    expectRejected(OpenPort, { port: 80 })
  })

  test("a port Docker publishes is one docker-proxy listens on", () => {
    expect(isDockerPort({ port: 8080, addresses: ["0.0.0.0"], process: "docker-proxy" })).toBe(true)
    expect(isDockerPort({ port: 3000, addresses: ["0.0.0.0"], process: "node server" })).toBe(false)
    expect(isDockerPort({ port: 3000, addresses: ["0.0.0.0"] })).toBe(false)
  })
})

describe("Session names", () => {
  test("a summary with a name is shown by it", () => {
    const named = { ...sessionSummary, name: "Health check" }
    expect(sessionTitle(Schema.decodeUnknownSync(SessionSummary)(named))).toBe("Health check")
  })

  test("a summary without one is shown by its Work branch", () => {
    expect(sessionTitle(Schema.decodeUnknownSync(SessionSummary)(sessionSummary))).toBe(
      "claude/s-1",
    )
  })

  test("a summary on its base branch is shown by it and its short id (ADR 0023)", () => {
    const direct = { ...sessionSummary, id: "3f9668393285", workBranch: "main" }
    expect(sessionTitle(Schema.decodeUnknownSync(SessionSummary)(direct))).toBe("main · 3f96")
    const named = { ...direct, name: "Health check" }
    expect(sessionTitle(Schema.decodeUnknownSync(SessionSummary)(named))).toBe("Health check")
  })

  test("a name is trimmed, not empty and at most the maximum length", () => {
    expectRoundTrips(SessionName, ["a", "x".repeat(MaxSessionNameLength)])
    expectRejected(SessionName, "")
    expectRejected(SessionName, " padded ")
    expectRejected(SessionName, "x".repeat(MaxSessionNameLength + 1))
  })

  test("a rename is trimmed, clears the name when nothing is left, and says why one is too long", () => {
    expect(sessionNameFrom("  Health check ")).toEqual({ name: "Health check" })
    expect(sessionNameFrom("   ")).toEqual({ name: null })
    expect(sessionNameFrom(` ${"x".repeat(MaxSessionNameLength)} `)).toEqual({
      name: "x".repeat(MaxSessionNameLength),
    })
    expect(sessionNameFrom("x".repeat(MaxSessionNameLength + 1))).toBe(
      `A Session name can be at most ${MaxSessionNameLength} characters; this one is ${MaxSessionNameLength + 1}.`,
    )
  })
})

describe("Repo names (#197)", () => {
  test("spellings that differ only in case are one Repo", () => {
    expect(sameRepo("Entria-io/PEP", "entria-io/pep")).toBe(true)
    expect(sameRepo("entria-io/pep", "entria-io/pep2")).toBe(false)
    expect(repoKey("Entria-io/PEP")).toBe(repoKey("ENTRIA-IO/pep"))
  })
})

describe("Open questions (#193)", () => {
  test("several picks join as Claude Code's dialog joins them", () => {
    expect(joinAnswers(["Fast"])).toBe("Fast")
    expect(joinAnswers(["Fast", "Cheap"])).toBe("Fast, Cheap")
    expect(joinAnswers(["Red, green", 'Say "hi"', "Blue"])).toBe(
      '"Red, green", "Say \\"hi\\"", Blue',
    )
    expect(joinAnswers([])).toBe("")
  })
})

describe("BranchChoice", () => {
  test("is an existing branch, directly or on a new Work branch, or a branch to create", () => {
    expectRoundTrips(BranchChoice, [
      { _tag: "Existing", name: "main", newWorkBranch: true },
      { _tag: "Existing", name: "release/1.2", newWorkBranch: false },
      { _tag: "Create", name: "feature/health-check", from: "main" },
    ])
  })

  test("a branch to create has a name git accepts", () => {
    for (const name of ["a b", "a..b", "-x", "x.lock", "a/.b", "x/", "/x", "a//b", "a@{b", "@"]) {
      expectRejected(BranchChoice, { _tag: "Create", name, from: "main" })
    }
    expectRejected(BranchChoice, { _tag: "Create", name: "ok", from: "" })
    expectRejected(BranchChoice, { _tag: "Existing", name: "main" })
  })

  test("an existing branch, and the one a new branch is made from, have names git accepts", () => {
    expectRejected(BranchChoice, { _tag: "Existing", name: "a..b", newWorkBranch: true })
    expectRejected(BranchChoice, { _tag: "Create", name: "ok", from: "-x" })
    expectRejected(BranchChoice, { _tag: "Existing", name: "x".repeat(256), newWorkBranch: true })
    expectRoundTrips(BranchChoice, [
      { _tag: "Existing", name: "x".repeat(MaxBranchNameLength), newWorkBranch: false },
    ])
  })

  test("a new branch isn't under claude/, which is for Work branches, nor its own base", () => {
    expectRejected(BranchChoice, { _tag: "Create", name: "claude/s-1", from: "main" })
    expectRejected(BranchChoice, { _tag: "Create", name: "main", from: "main" })
    expect(newBranchProblem("claude/x")).toBe(
      "Names under claude/ are for the Work branches kndl makes.",
    )
    expect(newBranchProblem("main", "main")).toBe(
      "A new branch can't be made from a branch of the same name.",
    )
    expect(newBranchProblem("feature/x", "main")).toBeUndefined()
  })

  test("a Session keeps a branch name of any length, though one entered is capped", () => {
    const long = "x".repeat(MaxBranchNameLength + 45)
    const kept = { ...sessionSummary, baseBranch: long, workBranch: long }
    expect(Schema.decodeUnknownSync(SessionSummary)(kept).workBranch).toBe(long)
    expectRejected(BranchChoice, { _tag: "Existing", name: long, newWorkBranch: true })
  })

  test("comes to the base and Work branches a Session has", () => {
    const id = Schema.decodeUnknownSync(SessionId)("s-1")
    expect(workBranchFor(id)).toBe("claude/s-1")
    expect(
      branchesFor({ _tag: "Existing", name: "dev", newWorkBranch: true } as never, id),
    ).toEqual({
      baseBranch: "dev",
      workBranch: "claude/s-1",
    })
    expect(
      branchesFor({ _tag: "Existing", name: "dev", newWorkBranch: false } as never, id),
    ).toEqual({
      baseBranch: "dev",
      workBranch: "dev",
    })
    expect(branchesFor({ _tag: "Create", name: "feat", from: "dev" } as never, id)).toEqual({
      baseBranch: "dev",
      workBranch: "feat",
    })
  })
})

describe("branchNameProblem", () => {
  test("is none for a name git accepts", () => {
    for (const name of ["main", "feature/health-check", "v1.2.3", "a@b", "ünï", "x.lockfile"]) {
      expect(branchNameProblem(name)).toBeUndefined()
    }
  })

  test("says what is wrong with one it refuses", () => {
    expect(branchNameProblem("")).toBe("A branch name can't be empty.")
    expect(branchNameProblem("a b")).toBe("A branch name can't have spaces or control characters.")
    expect(branchNameProblem("a\tb")).toBe("A branch name can't have spaces or control characters.")
    expect(branchNameProblem("a..b")).toBe("A branch name can't have two dots in a row.")
    expect(branchNameProblem("a~b")).toBe("A branch name can't have ~ in it.")
    expect(branchNameProblem("a\\b")).toBe("A branch name can't have \\ in it.")
    expect(branchNameProblem("feat.lock/x")).toBe("A branch name's parts can't end with .lock.")
    expect(branchNameProblem("a/.b")).toBe("A branch name's parts can't start with a dot.")
    expect(branchNameProblem("-x")).toBe("A branch name can't start with -.")
    expect(branchNameProblem("x.")).toBe("A branch name can't end with a dot.")
  })
})
