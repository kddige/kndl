import { describe, expect, test } from "bun:test"
import { SessionSummary } from "@kndl/protocol"
import { Schema } from "effect"
import { environmentChanged, mcpServersChanged, terminalText } from "../src/app/format.ts"
import { alice, sessionSummary } from "./fixtures.ts"

const summary = (fields: Partial<typeof SessionSummary.Encoded>): SessionSummary =>
  Schema.decodeUnknownSync(SessionSummary)({ ...sessionSummary, ...fields })

describe("environmentChanged", () => {
  test("an Active Session on an older version than the latest has a changed Environment", () => {
    expect(environmentChanged(summary({ environment: { version: 1, latestVersion: 2 } }))).toBe(
      true,
    )
    expect(environmentChanged(summary({ environment: { version: 2, latestVersion: 2 } }))).toBe(
      false,
    )
    const asleep = summary({ state: "Asleep", environment: { version: 1, latestVersion: 2 } })
    expect(environmentChanged(asleep)).toBe(false)
  })

  test("a Session being started counts the version it is started on (#70)", () => {
    // A new Session on a fresh Environment: on no version until its Runner says it started.
    const fresh = { environment: { version: null, latestVersion: 1 } }
    expect(environmentChanged(summary(fresh))).toBe(true)
    expect(
      environmentChanged(summary({ ...fresh, starting: { since: 1, environmentVersion: 1 } })),
    ).toBe(false)
    // Being started on version 1 while version 2 was applied: changed already.
    const overtaken = { environment: { version: null, latestVersion: 2 } }
    expect(
      environmentChanged(summary({ ...overtaken, starting: { since: 1, environmentVersion: 1 } })),
    ).toBe(true)
  })

  test("a Session being restarted is getting the latest version already", () => {
    const restarting = summary({
      environment: { version: 1, latestVersion: 2 },
      restarting: { by: alice, since: 1 },
    })
    expect(environmentChanged(restarting)).toBe(false)
  })
})

describe("mcpServersChanged", () => {
  test("an Active Session whose Repo's Installations changed since it started, not one starting (ADR 0020)", () => {
    expect(mcpServersChanged(summary({ mcpServersChanged: true }))).toBe(true)
    expect(mcpServersChanged(summary({}))).toBe(false)
    // Other states pick the change up as they next wake.
    expect(mcpServersChanged(summary({ state: "Asleep", mcpServersChanged: true }))).toBe(false)
    // A Session being started or restarted is getting its Repo's Installations already.
    const restarting = summary({ mcpServersChanged: true, restarting: { by: alice, since: 1 } })
    expect(mcpServersChanged(restarting)).toBe(false)
    const starting = summary({ mcpServersChanged: true, starting: { since: 1 } })
    expect(mcpServersChanged(starting)).toBe(false)
  })
})

describe("terminalText", () => {
  test("drops escapes, ends lines with LF, and shows a redrawn line as last drawn", () => {
    expect(terminalText("#2 \u001b[34mDONE 3.1s\u001b[0m\r\n\u001b]0;title\u0007ok\r\n")).toBe(
      "#2 DONE 3.1s\nok\n",
    )
    // A line a progress bar redrew shows as it was last drawn.
    expect(terminalText("Pulling 10%\rPulling 50%\rPulling 100%\r\nnext\r")).toBe(
      "Pulling 100%\nnext",
    )
  })
})
