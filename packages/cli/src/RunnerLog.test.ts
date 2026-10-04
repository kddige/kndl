import { describe, expect, test } from "bun:test"
import { runnerConnection } from "./RunnerLog.ts"

const line = (message: string) =>
  `timestamp=2026-10-04T10:00:00.000Z level=INFO fiber=#3 message="${message}"`

describe("the Runner's connection, from its log", () => {
  test("connected, as the last line says", () => {
    const log = [
      line("Hub connection: connection refused"),
      `timestamp=2026-10-04T10:00:01.000Z level=INFO fiber=#3 message="Connected to the Hub as Runner rnr_123"`,
    ].join("\n")

    expect(runnerConnection(log)).toEqual({ _tag: "Connected", runnerId: "rnr_123" })
  })

  test("lost since", () => {
    const log = [
      "level=INFO message=Connected to the Hub as Runner rnr_123",
      "level=WARN message=Hub connection: the Hub closed the connection",
    ].join("\n")

    expect(runnerConnection(log)).toEqual({
      _tag: "Disconnected",
      detail: "the Hub closed the connection",
    })
  })

  test("in Effect's logfmt, without the quotes", () => {
    expect(runnerConnection(line("Hub connection: connection refused"))).toEqual({
      _tag: "Disconnected",
      detail: "connection refused",
    })
  })

  test("nothing about it yet", () => {
    expect(runnerConnection("level=INFO message=Starting\n")).toEqual({ _tag: "Unknown" })
    expect(runnerConnection("")).toEqual({ _tag: "Unknown" })
  })
})
