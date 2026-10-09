import { describe, expect, test } from "bun:test"
import { InviteLifetimeMs, type PendingInvite } from "@kndl/protocol"
import { inviteTimeLeft, readLogin, ticketFrom, usableInvites } from "../src/people/people.ts"
import { alice } from "./fixtures.ts"

const invite = (id: string, expiresAt: number) =>
  ({ id, createdBy: alice, createdAt: 0, expiresAt }) as unknown as PendingInvite

describe("the People page's Invites (#209)", () => {
  test("an Invite that expired since the Hub listed it is dropped", () => {
    const listed = [invite("a", 1_000), invite("b", 3_000)]
    expect(usableInvites(listed, 2_000).map((i) => i.id as string)).toEqual(["b"])
    expect(usableInvites(null, 2_000)).toEqual([])
  })

  test("says how long an Invite has left, a new one its whole week", () => {
    expect(inviteTimeLeft(InviteLifetimeMs - 50, 0)).toBe("7 days")
    expect(inviteTimeLeft(30 * 3_600_000, 0)).toBe("30 hours")
    expect(inviteTimeLeft(3_600_000, 0)).toBe("1 hour")
    expect(inviteTimeLeft(59 * 60_000, 0)).toBe("under an hour")
  })

  test("reads the login typed for an Invite", () => {
    expect(readLogin("  ")).toEqual({ login: undefined })
    expect(readLogin(" @Octo-Cat ")).toEqual({ login: "Octo-Cat" })
    expect(readLogin("octo--cat")).toHaveProperty("error")
    expect(readLogin("-octocat")).toHaveProperty("error")
    expect(readLogin("a".repeat(40))).toHaveProperty("error")
  })
})

test("a Setup link's or Invite's secret is the address's fragment", () => {
  expect(ticketFrom("#chi_abc.def")).toBe("chi_abc.def")
  expect(ticketFrom("#")).toBeUndefined()
  expect(ticketFrom("")).toBeUndefined()
})
