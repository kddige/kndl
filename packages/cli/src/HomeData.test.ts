import { describe, expect, test } from "bun:test"
import {
  asideRenames,
  dateStamp,
  explainOldData,
  findOldData,
  type HomeDataFacts,
} from "./HomeData.ts"

const fresh: HomeDataFacts = { data: [], envFiles: [] }

describe("old data in a home", () => {
  test("a fresh home has none", () => {
    expect(findOldData(fresh)).toBeUndefined()
  })

  test("a checkout's old Session Workspaces, with no env files, are old data", () => {
    const facts = { ...fresh, data: ["sessions", "claude-code"] }

    expect(findOldData(facts)).toEqual({ entries: ["sessions", "claude-code"] })
  })

  test("a role's data is the install's own once its env file exists", () => {
    const facts: HomeDataFacts = {
      data: ["sessions", "claude-code", "hub.db"],
      envFiles: ["hub", "runner"],
    }

    expect(findOldData(facts)).toBeUndefined()
  })

  test("only the roles without an env file have old data", () => {
    const facts: HomeDataFacts = {
      data: ["sessions", "hub.db", "hub.db-wal"],
      envFiles: ["hub"],
    }

    expect(findOldData(facts)?.entries).toEqual(["sessions"])
  })

  test("a Hub database without hub.env is old data too", () => {
    expect(findOldData({ ...fresh, data: ["hub.db", "hub.db-wal"] })?.entries).toEqual([
      "hub.db",
      "hub.db-wal",
    ])
  })
})

describe("explaining old data", () => {
  const renames = [{ from: "sessions", to: "sessions.old-20261004" }]

  test("names the data, the renames, and the other way out", () => {
    const text = explainOldData({ entries: ["sessions"] }, "/home/ada/.claude-hub", renames)

    expect(text).toContain("sessions, with no runner.env")
    expect(text).toContain("sessions → sessions.old-20261004")
    expect(text).toContain("--move-old-data")
    expect(text).toContain("CLAUDE_HUB_HOME")
  })
})

describe("moving old data aside", () => {
  const day = new Date(2026, 9, 4, 12)

  test("renames each entry to <name>.old-<YYYYMMDD>", () => {
    expect(dateStamp(day)).toBe("20261004")
    expect(asideRenames(["sessions", "claude-code"], day, ["sessions", "claude-code"])).toEqual([
      { from: "sessions", to: "sessions.old-20261004" },
      { from: "claude-code", to: "claude-code.old-20261004" },
    ])
  })

  test("never takes a name already in the home", () => {
    expect(
      asideRenames(["sessions"], day, [
        "sessions",
        "sessions.old-20261004",
        "sessions.old-20261004-2",
      ]),
    ).toEqual([{ from: "sessions", to: "sessions.old-20261004-3" }])
  })

  test("a database's side files follow it", () => {
    expect(asideRenames(["hub.db", "hub.db-wal", "hub.db-shm"], day, ["hub.db"])).toEqual([
      { from: "hub.db", to: "hub.db.old-20261004" },
      { from: "hub.db-wal", to: "hub.db.old-20261004-wal" },
      { from: "hub.db-shm", to: "hub.db.old-20261004-shm" },
    ])
  })
})
