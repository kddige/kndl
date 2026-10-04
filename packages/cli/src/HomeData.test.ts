import { describe, expect, test } from "bun:test"
import {
  asideRenames,
  canMoveAside,
  dateStamp,
  explainOldData,
  findOldData,
  type HomeDataFacts,
} from "./HomeData.ts"

const fresh: HomeDataFacts = { data: [], envFiles: [], tmuxSessions: 0 }

describe("old data in a home", () => {
  test("a fresh home has none", () => {
    expect(findOldData(fresh, ["hub", "runner"])).toBeUndefined()
  })

  test("a checkout's old Session Workspaces, with no env files, are old data", () => {
    const facts = { ...fresh, data: ["sessions", "claude-code"] }

    expect(findOldData(facts, ["hub", "runner"])).toEqual({
      entries: ["sessions", "claude-code"],
      tmuxSessions: 0,
    })
    // Whatever is being set up: a Hub alone doesn't use them, but a Runner added later would.
    expect(findOldData(facts, ["hub"])?.entries).toEqual(["sessions", "claude-code"])
  })

  test("a role's data is the install's own once its env file exists", () => {
    const facts: HomeDataFacts = {
      data: ["sessions", "claude-code", "hub.db"],
      envFiles: ["hub", "runner"],
      tmuxSessions: 3,
    }

    expect(findOldData(facts, ["hub", "runner"])).toBeUndefined()
  })

  test("only the roles without an env file have old data", () => {
    const facts: HomeDataFacts = {
      data: ["sessions", "hub.db", "hub.db-wal"],
      envFiles: ["hub"],
      tmuxSessions: 0,
    }

    expect(findOldData(facts, ["hub", "runner"])?.entries).toEqual(["sessions"])
  })

  test("a Hub database without hub.env is old data too", () => {
    expect(findOldData({ ...fresh, data: ["hub.db", "hub.db-wal"] }, ["hub"])?.entries).toEqual([
      "hub.db",
      "hub.db-wal",
    ])
  })

  test("live tmux sessions count only when a Runner is set up for the first time", () => {
    const facts = { ...fresh, tmuxSessions: 2 }

    expect(findOldData(facts, ["runner"])).toEqual({ entries: [], tmuxSessions: 2 })
    expect(findOldData(facts, ["hub"])).toBeUndefined()
    expect(findOldData({ ...facts, envFiles: ["runner"] }, ["runner"])).toBeUndefined()
  })

  test("can be moved aside unless tmux sessions would still be re-adopted", () => {
    expect(canMoveAside({ entries: ["sessions"], tmuxSessions: 0 })).toBe(true)
    expect(canMoveAside({ entries: ["sessions"], tmuxSessions: 1 })).toBe(false)
    expect(canMoveAside({ entries: [], tmuxSessions: 1 })).toBe(false)
  })
})

describe("explaining old data", () => {
  const renames = [{ from: "sessions", to: "sessions.old-20261004" }]

  test("names the data, the renames, and the other way out", () => {
    const text = explainOldData(
      { entries: ["sessions"], tmuxSessions: 0 },
      "/home/ada/.claude-hub",
      renames,
    )

    expect(text).toContain("sessions, with no runner.env")
    expect(text).toContain("sessions → sessions.old-20261004")
    expect(text).toContain("--move-old-data")
    expect(text).toContain("CLAUDE_HUB_HOME")
  })

  test("with live tmux sessions, doesn't offer to move it", () => {
    const text = explainOldData(
      { entries: ["sessions"], tmuxSessions: 2 },
      "/home/ada/.claude-hub",
      renames,
    )

    expect(text).toContain("has 2 sessions")
    expect(text).not.toContain("--move-old-data")
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
