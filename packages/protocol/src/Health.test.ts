import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { HubHealth } from "./Health.ts"

describe("HubHealth", () => {
  test("decodes a healthy Hub's answer", () => {
    expect(Schema.decodeUnknownSync(HubHealth)({ status: "ok" })).toEqual({ status: "ok" })
  })

  test("rejects any other status", () => {
    expect(() => Schema.decodeUnknownSync(HubHealth)({ status: "down" })).toThrow()
  })
})
