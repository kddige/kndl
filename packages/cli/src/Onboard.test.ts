import { describe, expect, test } from "bun:test"
import {
  checkPublicUrl,
  checkRunnerToken,
  defaultPublicUrl,
  existingRole,
  hubChoicesFrom,
  hubEnvUpdates,
  lanAddress,
  pickAnswer,
  runnerEnvUpdates,
} from "./Onboard.ts"

describe("where an answer comes from", () => {
  const base = { flag: undefined, existing: undefined, reset: false, interactive: true }

  test("a flag, then an existing setting unless --reset, then a question, or off a terminal its default", () => {
    const cases: ReadonlyArray<[Parameters<typeof pickAnswer>[0], ReturnType<typeof pickAnswer>]> =
      [
        [
          { ...base, flag: "lan", existing: "local" },
          { _tag: "Given", value: "lan" },
        ],
        [
          { ...base, existing: "local" },
          { _tag: "Given", value: "local" },
        ],
        [{ ...base, existing: "local", reset: true }, { _tag: "Ask" }],
        [base, { _tag: "Ask" }],
        [
          { ...base, interactive: false, fallback: false },
          { _tag: "Given", value: false },
        ],
        [{ ...base, interactive: false }, { _tag: "Missing" }],
      ]
    for (const [input, answer] of cases) expect(pickAnswer(input)).toEqual(answer)
  })
})

describe("the roles an existing home is set up for", () => {
  test("from which env files exist", () => {
    expect(existingRole(true, true)).toBe("both")
    expect(existingRole(true, false)).toBe("hub")
    expect(existingRole(false, true)).toBe("runner")
    expect(existingRole(false, false)).toBeUndefined()
  })
})

describe("hub.env", () => {
  const key = "a".repeat(43)

  test("only this machine: loopback, with dev login if chosen", () => {
    expect(
      hubEnvUpdates(
        {
          reach: "local",
          port: 7777,
          publicUrl: "http://127.0.0.1:7777",
          insecureCookies: true,
          devLogin: true,
        },
        key,
      ),
    ).toEqual({
      HOST: "127.0.0.1",
      PORT: "7777",
      HUB_PUBLIC_URL: "http://127.0.0.1:7777",
      HUB_INSECURE_COOKIES: undefined,
      KNDL_DEV_LOGIN: "1",
      HUB_SECRETS_KEY: key,
    })
  })

  test("the LAN: all addresses, insecure cookies if chosen, never dev login", () => {
    expect(
      hubEnvUpdates(
        {
          reach: "lan",
          port: 8080,
          publicUrl: "http://192.168.1.20:8080/",
          insecureCookies: true,
          devLogin: true,
        },
        key,
      ),
    ).toMatchObject({
      HOST: "0.0.0.0",
      PORT: "8080",
      HUB_PUBLIC_URL: "http://192.168.1.20:8080",
      HUB_INSECURE_COOKIES: "1",
      KNDL_DEV_LOGIN: undefined,
    })
  })

  test("behind HTTPS: loopback, with the public URL, and Secure cookies", () => {
    expect(
      hubEnvUpdates(
        {
          reach: "https",
          port: 7777,
          publicUrl: "https://hub.example.com",
          insecureCookies: true,
          devLogin: false,
        },
        key,
      ),
    ).toMatchObject({
      HOST: "127.0.0.1",
      HUB_PUBLIC_URL: "https://hub.example.com",
      HUB_INSECURE_COOKIES: undefined,
    })
  })

  test("is read back into the answers it came from", () => {
    expect(
      hubChoicesFrom({
        HOST: "0.0.0.0",
        PORT: "8080",
        HUB_PUBLIC_URL: "http://192.168.1.20:8080",
        HUB_INSECURE_COOKIES: "1",
      }),
    ).toEqual({
      reach: "lan",
      port: 8080,
      publicUrl: "http://192.168.1.20:8080",
      insecureCookies: true,
      devLogin: false,
    })
    expect(hubChoicesFrom({ HUB_PUBLIC_URL: "https://hub.example.com" })?.reach).toBe("https")
    expect(hubChoicesFrom({ HUB_PUBLIC_URL: "http://127.0.0.1:7777" })?.reach).toBe("local")
    expect(hubChoicesFrom({})).toBeUndefined()
  })
})

describe("the Hub's public URL", () => {
  test("defaults to loopback or the LAN address, and is an https origin behind HTTPS", () => {
    expect(defaultPublicUrl("local", 7777, "192.168.1.20")).toBe("http://127.0.0.1:7777")
    expect(defaultPublicUrl("lan", 7777, "192.168.1.20")).toBe("http://192.168.1.20:7777")
    expect(defaultPublicUrl("lan", 7777, undefined)).toBeUndefined()
    expect(defaultPublicUrl("https", 7777, "192.168.1.20")).toBeUndefined()

    expect(checkPublicUrl("https", "http://hub.example.com")).toContain("https://")
    expect(checkPublicUrl("https", "https://hub.example.com")).toBeUndefined()
    expect(checkPublicUrl("https", "https://example.com/hub")).toContain("no path")
    expect(checkPublicUrl("lan", "not a url")).toContain("isn't an http")
  })
})

test("the LAN address is the first private IPv4 address, preferring 192.168, never public or loopback", () => {
  expect(
    lanAddress({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      utun0: [{ address: "fe80::1", family: "IPv6", internal: false }],
      en1: [{ address: "10.0.0.5", family: "IPv4", internal: false }],
      en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
    }),
  ).toBe("192.168.1.20")
  expect(
    lanAddress({
      eth0: [{ address: "203.0.113.4", family: "IPv4", internal: false }],
      docker0: [{ address: "172.17.0.1", family: 4, internal: false }],
    }),
  ).toBe("172.17.0.1")
  expect(lanAddress({ lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }] })).toBe(
    undefined,
  )
})

test("runner.env names the Hub and carries the token, which starts with chr_", () => {
  expect(
    runnerEnvUpdates({ hubUrl: "http://127.0.0.1:7777/", token: "chr_abc", name: "mac" }),
  ).toEqual({ HUB_URL: "http://127.0.0.1:7777", RUNNER_TOKEN: "chr_abc", RUNNER_NAME: "mac" })
  expect(checkRunnerToken("chr_abc")).toBeUndefined()
  expect(checkRunnerToken("abc")).toContain("chr_")
})
