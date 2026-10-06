import { describe, expect, test } from "bun:test"
import { entryRemoval, homeRemoval, refuseHome } from "./Guards.ts"

const userHome = "/Users/ada"
const home = "/Users/ada/.claude-hub"
const installed = [
  "app",
  "hub.env",
  "runner.env",
  "hub.db",
  "hub.db.lock",
  "sessions",
  "claude-code",
  "logs",
  "cli",
]

describe("purging the home", () => {
  test("removes exactly the resolved home, when it holds only claude-hub's entries", () => {
    expect(homeRemoval(home, { home, userHome, entries: installed })).toEqual({
      _tag: "Remove",
      path: home,
    })
  })

  test("tolerates the GitHub App's key and Finder's .DS_Store", () => {
    const entries = [...installed, "github-app.pem", ".DS_Store"]

    expect(homeRemoval(home, { home, userHome, entries })._tag).toBe("Remove")
  })

  test("refuses a path that isn't the resolved home", () => {
    const removal = homeRemoval("/Users/ada/.claude-hub/sessions", {
      home,
      userHome,
      entries: installed,
    })

    expect(removal).toMatchObject({ _tag: "Refused" })
    expect(removal._tag === "Refused" && removal.reason).toContain("not the claude-hub home")
  })

  test("refuses the user's home directory", () => {
    const removal = homeRemoval(userHome, {
      home: userHome,
      userHome,
      entries: [...installed, "Documents", ".zshrc"],
    })

    expect(removal._tag === "Refused" && removal.reason).toContain("your home directory")
  })

  test("refuses /, and a directory holding the user's home", () => {
    expect(homeRemoval("/", { home: "/", userHome, entries: installed })._tag).toBe("Refused")
    expect(homeRemoval("/Users", { home: "/Users", userHome, entries: installed })._tag).toBe(
      "Refused",
    )
  })

  test("refuses a top-level directory", () => {
    expect(refuseHome({ home: "/opt", userHome, entries: installed })).toContain("top-level")
  })

  test("refuses a directory that doesn't look like a claude-hub home", () => {
    const removal = homeRemoval("/Users/ada/projects", {
      home: "/Users/ada/projects",
      userHome,
      entries: ["notes.txt", "src"],
    })

    expect(removal._tag === "Refused" && removal.reason).toContain("doesn't look like")
  })

  test("refuses an empty or missing home", () => {
    expect(homeRemoval(home, { home, userHome, entries: [] })._tag).toBe("Refused")
  })

  test("refuses a home that holds files claude-hub didn't put there", () => {
    const removal = homeRemoval(home, { home, userHome, entries: [...installed, "thesis.tex"] })

    expect(removal._tag === "Refused" && removal.reason).toContain("thesis.tex")
  })

  test("refuses a git checkout, as when CLAUDE_HUB_HOME names the repo", () => {
    const removal = homeRemoval("/Users/ada/code/claude-hub", {
      home: "/Users/ada/code/claude-hub",
      userHome,
      entries: [".git", "packages", "logs"],
    })

    expect(removal._tag === "Refused" && removal.reason).toContain("git checkout")
  })

  test("refuses a relative home", () => {
    expect(refuseHome({ home: ".claude-hub", userHome, entries: installed })).toContain("absolute")
  })
})

describe("uninstalling, which keeps the data", () => {
  test("removes the installed checkout in the home", () => {
    expect(entryRemoval("app", { home, userHome, entries: installed })).toEqual({
      _tag: "Remove",
      path: "/Users/ada/.claude-hub/app",
    })
  })

  test("refuses when the home is the user's home directory", () => {
    const removal = entryRemoval("app", {
      home: userHome,
      userHome,
      entries: ["app", "Documents"],
    })

    expect(removal._tag).toBe("Refused")
  })

  test("refuses when the home isn't a claude-hub home", () => {
    expect(entryRemoval("app", { home, userHome, entries: ["Documents"] })._tag).toBe("Refused")
  })
})
