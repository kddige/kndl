import { describe, expect, test } from "bun:test"
import { RepoMap, uniqueRepos } from "./RepoMap.ts"

describe("RepoMap (#197)", () => {
  test("finds an entry by any spelling of the Repo's name, and keeps the first", () => {
    const map = new RepoMap<boolean>()
    map.set("Entria-io/PEP", true)
    map.set("entria-io/pep", false)
    expect(map.get("ENTRIA-IO/Pep")).toBe(false)
    expect(map.has("entria-io/PEP")).toBe(true)
    expect([...map]).toEqual([["Entria-io/PEP", false]])
    expect(map.delete("entria-io/pep")).toBe(true)
    expect(map.size).toBe(0)
  })

  test("uniqueRepos keeps each Repo once, by its first spelling", () => {
    expect(uniqueRepos(["Entria-io/PEP", "octo/widgets", "entria-io/pep"])).toEqual([
      "Entria-io/PEP",
      "octo/widgets",
    ])
  })
})
