import { describe, expect, test } from "bun:test"
import type { SessionSummary } from "@kndl/protocol"
import {
  bindAddresses,
  localUrl,
  parsePort,
  parsePorts,
  parseTarget,
  resolveTarget,
  sessionLine,
  shortId,
} from "./ForwardArgs.ts"

/** A Session as the Hub lists it, with only what these read. */
const summary = (fields: Partial<Omit<SessionSummary, "id">> & { readonly id: string }) =>
  ({
    repo: "kddige/kndl",
    workBranch: "claude/fix-login",
    state: "Active",
    ...fields,
  }) as SessionSummary

describe("ports", () => {
  test("a port is forwarded to the same one here, or to another with remote:local", () => {
    expect(parsePort("3000")).toEqual({ remote: 3000, local: 3000 })
    expect(parsePort("3000:3100")).toEqual({ remote: 3000, local: 3100 })
    expect(parsePorts(["5173", "3000:3100"])).toEqual([
      { remote: 5173, local: 5173 },
      { remote: 3000, local: 3100 },
    ])
  })

  test("what isn't a port says how to give one", () => {
    for (const text of ["0", "65536", "web", "3000:", ":3000", "1:2:3", "-1", "3000.5"]) {
      expect(parsePort(text)).toBe(
        `${text} isn't a port: give one as 3000, or as 3000:3100 to forward the Session's port 3000 to port 3100 here.`,
      )
    }
  })

  test("a port named twice, or two to one port here, is refused", () => {
    expect(parsePorts(["3000", "3000:3100"])).toBe("Port 3000 is named twice.")
    expect(parsePorts(["3000:4000", "4000"])).toBe(
      "Two ports would be forwarded to port 4000 here.",
    )
  })
})

describe("where it listens", () => {
  test("127.0.0.1 and ::1 by default, so localhost reaches it either way", () => {
    expect(bindAddresses(undefined)).toEqual(["127.0.0.1", "::1"])
    expect(bindAddresses("localhost")).toEqual(["127.0.0.1", "::1"])
    expect(bindAddresses("0.0.0.0")).toEqual(["0.0.0.0"])
    expect(bindAddresses("[::1]")).toEqual(["::1"])
    expect(bindAddresses("my-laptop")).toBe(
      "--bind takes an IP address, such as 127.0.0.1 or ::1; not my-laptop.",
    )
  })

  test("a forwarded port's URL", () => {
    expect(localUrl(["127.0.0.1", "::1"], 5173)).toBe("http://localhost:5173")
    expect(localUrl(["0.0.0.0"], 3000)).toBe("http://localhost:3000")
    expect(localUrl(["192.168.1.20"], 3000)).toBe("http://192.168.1.20:3000")
    expect(localUrl(["::1"], 3000)).toBe("http://[::1]:3000")
  })
})

describe("which Session", () => {
  const login = summary({ id: "0b9256b9c0609f5a73defb11" })
  const docs = summary({ id: "0b92aa00c0609f5a73defb22", name: "Docs" })
  const other = summary({ id: "77ab12ffc0609f5a73defb33" })
  const sessions = [login, docs, other]

  test("an id, the start of one, or a Session's URL", () => {
    expect(parseTarget("0b9256")).toEqual({ _tag: "Id", id: "0b9256" })
    expect(parseTarget("https://hub.example.com/sessions/0b9256b9c0609f5a73defb11?tab=1")).toEqual({
      _tag: "Url",
      id: "0b9256b9c0609f5a73defb11",
      origin: "https://hub.example.com",
    })
    expect(parseTarget("https://hub.example.com/runners")).toBe(
      "https://hub.example.com/runners isn't a Session's URL: one ends in /sessions/<id>.",
    )
    expect(parseTarget("a/b")).toBe(
      "a/b isn't a Session: give its id, the start of it, or its URL.",
    )
  })

  test("a whole id, or the start of only one, finds it; the start of more is ambiguous", () => {
    expect(resolveTarget("0b9256b9c0609f5a73defb11", sessions)).toEqual({
      _tag: "Found",
      session: login,
    })
    expect(resolveTarget("0b9256", sessions)).toEqual({ _tag: "Found", session: login })
    expect(resolveTarget("77", sessions)).toEqual({ _tag: "Found", session: other })
    expect(resolveTarget("0b92", sessions)).toEqual({
      _tag: "Ambiguous",
      matches: [login, docs],
    })
    expect(resolveTarget("ffff", sessions)).toEqual({ _tag: "None" })
  })

  test("a Session's line: short id, name, Repo, its state unless Active, and its ports", () => {
    expect(shortId(login)).toBe("0b9256")
    expect(
      sessionLine(
        summary({
          id: "0b9256b9c0609f5a73defb11",
          openPorts: [
            { port: 3000, addresses: ["127.0.0.1"] },
            { port: 5173, addresses: ["::1"] },
          ],
        }),
      ),
    ).toBe("0b9256  claude/fix-login  kddige/kndl  3000, 5173")
    expect(sessionLine(summary({ id: "77ab12ffc0", name: "Docs", state: "Asleep" }))).toBe(
      "77ab12  Docs  kddige/kndl  Asleep  no open ports",
    )
  })

  test("a Session on its base branch is not given its id twice", () => {
    const line = sessionLine(
      summary({ id: "3f9668393285", baseBranch: "main", workBranch: "main" } as never),
    )
    expect(line).toBe("3f9668  main  kddige/kndl  no open ports")
  })
})
