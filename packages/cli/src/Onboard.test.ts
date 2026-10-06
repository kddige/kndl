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

  test("a flag wins over everything", () => {
    expect(pickAnswer({ ...base, flag: "lan", existing: "local" })).toEqual({
      _tag: "Given",
      value: "lan",
    })
  })

  test("an existing setting is kept", () => {
    expect(pickAnswer({ ...base, existing: "local" })).toEqual({ _tag: "Given", value: "local" })
  })

  test("--reset asks again instead of keeping it", () => {
    expect(pickAnswer({ ...base, existing: "local", reset: true })).toEqual({ _tag: "Ask" })
  })

  test("with nothing to go on, it asks", () => {
    expect(pickAnswer(base)).toEqual({ _tag: "Ask" })
  })

  test("non-interactive: a default is taken, and no default is missing", () => {
    expect(pickAnswer({ ...base, interactive: false, fallback: false })).toEqual({
      _tag: "Given",
      value: false,
    })
    expect(pickAnswer({ ...base, interactive: false })).toEqual({ _tag: "Missing" })
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
  test("defaults to loopback, or the LAN address", () => {
    expect(defaultPublicUrl("local", 7777, "192.168.1.20")).toBe("http://127.0.0.1:7777")
    expect(defaultPublicUrl("lan", 7777, "192.168.1.20")).toBe("http://192.168.1.20:7777")
    expect(defaultPublicUrl("lan", 7777, undefined)).toBeUndefined()
    expect(defaultPublicUrl("https", 7777, "192.168.1.20")).toBeUndefined()
  })

  test("behind HTTPS must be https", () => {
    expect(checkPublicUrl("https", "http://hub.example.com")).toContain("https://")
    expect(checkPublicUrl("https", "https://hub.example.com")).toBeUndefined()
  })

  test("is an origin, with no path", () => {
    expect(checkPublicUrl("https", "https://example.com/hub")).toContain("no path")
    expect(checkPublicUrl("lan", "not a url")).toContain("isn't an http")
  })
})

describe("the LAN address", () => {
  test("is the first private IPv4 address, preferring 192.168", () => {
    expect(
      lanAddress({
        lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        utun0: [{ address: "fe80::1", family: "IPv6", internal: false }],
        en1: [{ address: "10.0.0.5", family: "IPv4", internal: false }],
        en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
      }),
    ).toBe("192.168.1.20")
  })

  test("skips public and loopback addresses", () => {
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
})

describe("runner.env", () => {
  test("names the Hub and carries the token", () => {
    expect(
      runnerEnvUpdates({ hubUrl: "http://127.0.0.1:7777/", token: "chr_abc", name: "mac" }),
    ).toEqual({ HUB_URL: "http://127.0.0.1:7777", RUNNER_TOKEN: "chr_abc", RUNNER_NAME: "mac" })
  })

  test("a token starts with chr_", () => {
    expect(checkRunnerToken("chr_abc")).toBeUndefined()
    expect(checkRunnerToken("abc")).toContain("chr_")
  })
})
