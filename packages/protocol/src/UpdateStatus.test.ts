import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import {
  decodeUpdateLock,
  decodeUpdateStatus,
  type UpdateStatus,
  updateLockHeld,
  updateRunningText,
} from "./UpdateStatus.ts"

const lock = { pid: 4242, startedAt: Date.UTC(2026, 9, 17, 14, 3, 12), source: "hub" as const }

const bootedAt = Date.UTC(2026, 9, 17)
const running = (pid: number) => pid === 4242

describe("the update lock", () => {
  test("is held while its process runs", () => {
    expect(updateLockHeld(lock, { running, bootedAt })).toBe(true)
  })

  test("is stale once its process is gone, or the machine booted since it was taken", () => {
    expect(updateLockHeld(lock, { running: () => false, bootedAt })).toBe(false)
    // The pid may belong to another process since the boot.
    expect(updateLockHeld(lock, { running, bootedAt: lock.startedAt + 1 })).toBe(false)
  })

  test("refuses a second update, saying who holds it", () => {
    expect(updateRunningText(lock)).toBe(
      "An update is already running (pid 4242, started 2026-10-17T14:03:12.000Z).",
    )
  })

  test("decodes from its file, and nothing else does", () => {
    expect(Option.getOrUndefined(decodeUpdateLock(JSON.stringify(lock)))).toEqual(lock)
    for (const text of ["", "{}", "not json", JSON.stringify({ ...lock, source: "web" })]) {
      expect(Option.isNone(decodeUpdateLock(text))).toBe(true)
    }
  })
})

describe("the update status", () => {
  const status: UpdateStatus = {
    id: "3f1c",
    source: "cli",
    startedAt: 1,
    finishedAt: 2,
    from: { commit: "a".repeat(40), version: "2026.10.3" },
    target: { ref: "v2026.10.4", commit: "b".repeat(40) },
    step: "Checking the Hub's health",
    state: "RolledBack",
    error: "The Hub wasn't healthy 30 seconds after it restarted: no answer",
  }

  test("decodes from its file, with or without what a run hasn't reached yet", () => {
    expect(Option.getOrUndefined(decodeUpdateStatus(JSON.stringify(status)))).toEqual(status)
    const { finishedAt: _, target: __, error: ___, ...unfinished } = status
    const started = { ...unfinished, state: "Running", from: { commit: "a".repeat(40) } }
    expect(Option.isSome(decodeUpdateStatus(JSON.stringify(started)))).toBe(true)
  })

  test("refuses a state or commit it doesn't know", () => {
    expect(Option.isNone(decodeUpdateStatus(JSON.stringify({ ...status, state: "Done" })))).toBe(
      true,
    )
    const unknown = { ...status, from: { commit: "unknown" } }
    expect(Option.isNone(decodeUpdateStatus(JSON.stringify(unknown)))).toBe(true)
  })
})
