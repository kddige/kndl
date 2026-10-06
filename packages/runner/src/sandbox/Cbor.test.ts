import { describe, expect, test } from "bun:test"
import { decodeCbor, encodeCbor } from "./Cbor.ts"

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")

describe("CBOR", () => {
  test("encodes as RFC 8949's examples do", () => {
    expect(hex(encodeCbor(0))).toBe("00")
    expect(hex(encodeCbor(23))).toBe("17")
    expect(hex(encodeCbor(24))).toBe("1818")
    expect(hex(encodeCbor(1000))).toBe("1903e8")
    expect(hex(encodeCbor(1000000))).toBe("1a000f4240")
    expect(hex(encodeCbor(1000000000000))).toBe("1b000000e8d4a51000")
    expect(hex(encodeCbor(-1))).toBe("20")
    expect(hex(encodeCbor(-1000))).toBe("3903e7")
    expect(hex(encodeCbor("IETF"))).toBe("6449455446")
    expect(hex(encodeCbor(new Uint8Array([1, 2, 3, 4])))).toBe("4401020304")
    expect(hex(encodeCbor([1, [2, 3], [4, 5]]))).toBe("8301820203820405")
    expect(hex(encodeCbor({ a: 1, b: [2, 3] }))).toBe("a26161016162820203")
    expect(hex(encodeCbor(true))).toBe("f5")
    expect(hex(encodeCbor(null))).toBe("f6")
  })

  test("leaves out keys whose value is undefined", () => {
    expect(hex(encodeCbor({ a: 1, b: undefined }))).toBe("a1616101")
  })

  test("decodes what it encodes, and agentd's envelope", () => {
    const payload = { host: "127.0.0.1", port: 8080, data: new Uint8Array([0, 255, 7]) }
    const envelope = { v: 9, t: "core.tcp.connect", p: encodeCbor(payload) }
    const decoded = decodeCbor(encodeCbor(envelope)) as Record<string, unknown>
    expect(decoded["v"]).toBe(9)
    expect(decoded["t"]).toBe("core.tcp.connect")
    expect(decodeCbor(decoded["p"] as Uint8Array)).toEqual(payload)
  })

  test("reads floats and skips tags", () => {
    expect(decodeCbor(Buffer.from("f93c00", "hex"))).toBe(1)
    expect(decodeCbor(Buffer.from("fa47c35000", "hex"))).toBe(100000)
    expect(decodeCbor(Buffer.from("fb3ff199999999999a", "hex"))).toBe(1.1)
    expect(decodeCbor(Buffer.from("c11a514b67b0", "hex"))).toBe(1363896240)
  })

  test("refuses an item that runs past the end", () => {
    expect(() => decodeCbor(Buffer.from("6449", "hex"))).toThrow()
  })
})
