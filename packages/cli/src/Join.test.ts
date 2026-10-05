import { describe, expect, test } from "bun:test"
import { PairingCodeRefused } from "@claude-hub/protocol"
import {
  connectionSettled,
  describeConnectionCheck,
  readConnectionAnswer,
  readPairAnswer,
  shortHostname,
} from "./Join.ts"

const hub = "https://hub.example.com"

describe("shortHostname", () => {
  test("is the host name up to its first dot", () => {
    expect(shortHostname("studio.local")).toBe("studio")
    expect(shortHostname("build-1")).toBe("build-1")
    expect(shortHostname("")).toBe("runner")
  })
})

describe("readPairAnswer", () => {
  test("a token", () => {
    const body = { runnerId: "r-1", name: "mac", token: "chr_x", repaired: false }
    expect(readPairAnswer(hub, 200, body)).toEqual({ _tag: "Paired", paired: body } as never)
  })

  test("a refused code: the Hub's own words", () => {
    expect(readPairAnswer(hub, 403, { error: PairingCodeRefused })).toEqual({
      _tag: "Refused",
      message: PairingCodeRefused,
    })
  })

  test("a Hub from before Pairing codes: update it, or use a token", () => {
    const outcome = readPairAnswer(hub, 404, undefined)
    expect(outcome._tag).toBe("Refused")
    expect(outcome._tag === "Refused" && outcome.message).toContain("claude-hub runner token")
  })

  test("something that isn't a Hub", () => {
    expect(readPairAnswer(hub, 200, "<html>")).toMatchObject({ _tag: "Refused" })
    expect(readPairAnswer(hub, 502, undefined)).toEqual({
      _tag: "Refused",
      message: `${hub} answered 502 to the pairing request.`,
    })
  })
})

describe("readConnectionAnswer", () => {
  test("online and offline", () => {
    const online = readConnectionAnswer(200, { runnerId: "r-1", name: "mac", online: true })
    expect(online).toEqual({ _tag: "Online", name: "mac", runnerId: "r-1" })
    expect(connectionSettled(online)).toBe(true)
    const offline = readConnectionAnswer(200, { runnerId: "r-1", name: "mac", online: false })
    expect(offline).toEqual({ _tag: "Offline" })
    expect(connectionSettled(offline)).toBe(false)
  })

  test("a refused token is final: the Runner was removed or paired again", () => {
    const refused = readConnectionAnswer(401, { error: "Invalid Runner token" })
    expect(refused).toEqual({ _tag: "TokenRefused" })
    expect(connectionSettled(refused)).toBe(true)
    expect(describeConnectionCheck(refused, 30)).toContain("removed")
  })

  test("an older Hub, and a bad answer", () => {
    expect(readConnectionAnswer(404, undefined)).toEqual({ _tag: "Unsupported" })
    expect(readConnectionAnswer(500, undefined)).toEqual({
      _tag: "Unreachable",
      detail: "it answered 500",
    })
  })
})
