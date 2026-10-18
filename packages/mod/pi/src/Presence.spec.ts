import { expect, test } from "bun:test"
import { presenceLine, watching } from "./Presence.ts"

test("the line says how the link stands, and who watches once it is linked", () => {
  expect(presenceLine({ _tag: "Linking" }, [])).toBe("○ kndl: linking to the Hub")
  expect(presenceLine({ _tag: "Offline" }, ["Ada"])).toBe("○ kndl: Hub offline")
  expect(presenceLine({ _tag: "Rejected", reason: "bad token" }, [])).toBe(
    "○ kndl: the Hub refused the link: bad token",
  )
  expect(presenceLine({ _tag: "Linked" }, [])).toBe("● kndl · nobody watching")
  expect(presenceLine({ _tag: "Linked" }, ["Ada", "Bob"])).toBe("● kndl · Ada, Bob")
})

test("someone forwarding a port says from where", () => {
  expect(
    watching([
      { id: "p1", login: "ada", name: "Ada" },
      { id: "p2", login: "bob", name: "Bob", forwardingFrom: ["laptop"] },
    ] as never),
  ).toEqual(["Ada", "Bob (forwarding from laptop)"])
})
