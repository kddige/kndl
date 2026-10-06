import { expect, test } from "bun:test"
import type { SessionSummary } from "@claude-hub/protocol"
import { groupByRepo, knownRepos } from "../src/sessions/groups.ts"

function session(id: string, repo: string, createdAt: number): SessionSummary {
  return { id, repo, createdAt } as unknown as SessionSummary
}

const sessions = [
  session("c", "kddige/zeta", 3),
  session("b", "kddige/alpha", 2),
  session("a", "kddige/zeta", 1),
  session("e", "kddige/alpha", 5),
  session("d", "Acme/beta", 4),
]

test("groups Sessions by Repo, the Repos in alphabetical order and each one's oldest first", () => {
  expect(
    groupByRepo(sessions).map((group) => [group.repo, group.sessions.map((s) => String(s.id))]),
  ).toEqual([
    ["Acme/beta", ["d"]],
    ["kddige/alpha", ["b", "e"]],
    ["kddige/zeta", ["a", "c"]],
  ])
})

const newestFirst = (a: SessionSummary, b: SessionSummary) => b.createdAt - a.createdAt

test("a group's order can be given, and a Repo's place doesn't follow its activity", () => {
  const groups = groupByRepo([...sessions, session("f", "kddige/zeta", 9)], newestFirst)
  expect(groups.map((group) => group.repo)).toEqual(["Acme/beta", "kddige/alpha", "kddige/zeta"])
  expect(groups[2]?.sessions.map((s) => String(s.id))).toEqual(["f", "c", "a"])
})

test("no Sessions, no groups", () => {
  expect(groupByRepo([])).toEqual([])
})

test("every Repo with a Session is known once, in alphabetical order", () => {
  expect(knownRepos(sessions)).toEqual(["Acme/beta", "kddige/alpha", "kddige/zeta"])
})

test("spellings of a Repo's name that differ only in case are one Repo (#197)", () => {
  const spelled = [...sessions, session("f", "KDDIGE/Zeta", 6), session("g", "acme/BETA", 7)]
  expect(
    groupByRepo(spelled).map((group) => [group.repo, group.sessions.map((s) => String(s.id))]),
  ).toEqual([
    ["Acme/beta", ["d", "g"]],
    ["kddige/alpha", ["b", "e"]],
    ["kddige/zeta", ["a", "c", "f"]],
  ])
  expect(knownRepos(spelled)).toEqual(["Acme/beta", "kddige/alpha", "kddige/zeta"])
})
