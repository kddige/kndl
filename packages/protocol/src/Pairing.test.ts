import { describe, expect, test } from "bun:test"
import {
  checkRunnerName,
  formatPairingCode,
  normalizePairingCode,
  pairingCommand,
  pairingLink,
  parsePairing,
} from "./Pairing.ts"

const code = "7K3QHWM2PA9XC4RTBV0E"

describe("pairing codes", () => {
  test("are shown in groups of five", () => {
    expect(formatPairingCode(code)).toBe("7K3QH-WM2PA-9XC4R-TBV0E")
  })

  test("read back whatever their case, dashes and spaces, with look-alike letters as digits", () => {
    expect(normalizePairingCode("7k3qh-wm2pa 9xc4r-tbvOe")).toBe(code)
    expect(normalizePairingCode("IL000-00000-00000-00000")).toBe("11000000000000000000")
  })

  test("are refused when short, long, or holding letters Crockford base32 leaves out", () => {
    expect(normalizePairingCode("7K3QH-WM2PA")).toBeUndefined()
    expect(normalizePairingCode(`${code}0`)).toBeUndefined()
    expect(normalizePairingCode("UUUUU-UUUUU-UUUUU-UUUUU")).toBeUndefined()
  })
})

describe("pairing links", () => {
  test("carry the Hub's origin and the code, and paste as one command", () => {
    const link = pairingLink("https://hub.example.com/some/page", code)
    expect(link).toBe("https://hub.example.com#7K3QH-WM2PA-9XC4R-TBV0E")
    expect(pairingCommand(link)).toBe(
      "claude-hub runner join 'https://hub.example.com#7K3QH-WM2PA-9XC4R-TBV0E'",
    )
  })

  test("parse back into the Hub and the code, quotes and a trailing path or not", () => {
    for (const text of [
      "https://hub.example.com#7K3QH-WM2PA-9XC4R-TBV0E",
      "'https://hub.example.com#7K3QH-WM2PA-9XC4R-TBV0E'",
      "  https://hub.example.com/#7k3qh-wm2pa-9xc4r-tbv0e\n",
    ]) {
      expect(parsePairing(text)).toEqual({
        _tag: "Parsed",
        target: { hubUrl: "https://hub.example.com", code },
      })
    }
    expect(parsePairing("http://192.168.1.20:7777#7K3QH-WM2PA-9XC4R-TBV0E")).toEqual({
      _tag: "Parsed",
      target: { hubUrl: "http://192.168.1.20:7777", code },
    })
  })

  test("a code alone needs the Hub's URL beside it", () => {
    expect(parsePairing("7K3QH-WM2PA-9XC4R-TBV0E")).toMatchObject({ _tag: "Invalid" })
    expect(parsePairing("7K3QH-WM2PA-9XC4R-TBV0E", "https://hub.example.com/")).toEqual({
      _tag: "Parsed",
      target: { hubUrl: "https://hub.example.com", code },
    })
  })

  test("say what's wrong with anything else", () => {
    const invalid = (text: string) => {
      const parsed = parsePairing(text)
      if (parsed._tag !== "Invalid") throw new Error(`parsed ${text}`)
      return parsed.message
    }
    expect(invalid("ftp://hub.example.com#7K3QH-WM2PA-9XC4R-TBV0E")).toContain("isn't an http")
    expect(invalid("https://hub.example.com#7K3QH")).toContain("isn't a whole pairing code")
    expect(invalid("hello")).toContain("isn't a pairing link")
    expect(invalid("#7K3QH-WM2PA-9XC4R-TBV0E")).toContain("(nothing)")
  })
})

describe("Runner names", () => {
  test("are hostname-like", () => {
    expect(checkRunnerName("mac-mini.local")).toBeUndefined()
    expect(checkRunnerName("build_2")).toBeUndefined()
    expect(checkRunnerName("")).toContain("can't be a Runner's name")
    expect(checkRunnerName("-x")).toContain("can't be a Runner's name")
    expect(checkRunnerName("a b")).toContain("can't be a Runner's name")
    expect(checkRunnerName("x".repeat(64))).toContain("can't be a Runner's name")
  })
})
