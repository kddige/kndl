import { expect, test } from "bun:test"
import type { SessionSummary } from "@claude-hub/protocol"
import { gitHubUrl, groupByRepo, knownRepos } from "../src/sessions/groups.ts"

function session(id: string, repo: string, createdAt: number): SessionSummary {
  return { id, repo, createdAt } as unknown as SessionSummary
}

const sessions = [
  session("a", "kddige/zeta", 1),
  session("b", "kddige/alpha", 2),
  session("c", "kddige/zeta", 3),
  session("d", "Acme/beta", 4),
  session("e", "kddige/alpha", 5),
]

test("groups Sessions by Repo, the Repos in alphabetical order and each one's newest first", () => {
  expect(
    groupByRepo(sessions).map((group) => [group.repo, group.sessions.map((s) => String(s.id))]),
  ).toEqual([
    ["Acme/beta", ["d"]],
    ["kddige/alpha", ["e", "b"]],
    ["kddige/zeta", ["c", "a"]],
  ])
})

const oldestFirst = (a: SessionSummary, b: SessionSummary) => a.createdAt - b.createdAt

test("a group's order can be given, and a Repo's place doesn't follow its activity", () => {
  const groups = groupByRepo([...sessions, session("f", "kddige/zeta", 9)], oldestFirst)
  expect(groups.map((group) => group.repo)).toEqual(["Acme/beta", "kddige/alpha", "kddige/zeta"])
  expect(groups[2]?.sessions.map((s) => String(s.id))).toEqual(["a", "c", "f"])
})

test("no Sessions, no groups", () => {
  expect(groupByRepo([])).toEqual([])
})

test("every Repo with a Session is known once, in alphabetical order", () => {
  expect(knownRepos(sessions)).toEqual(["Acme/beta", "kddige/alpha", "kddige/zeta"])
})

test("a Repo's page on GitHub", () => {
  expect(gitHubUrl("kddige/claude-hub")).toBe("https://github.com/kddige/claude-hub")
})
