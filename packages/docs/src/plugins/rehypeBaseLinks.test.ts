import { expect, test } from "bun:test"
import { rehypeBaseLinks } from "./rehypeBaseLinks.ts"

const link = (href: string) => ({ type: "element", tagName: "a", properties: { href } })

const run = (...hrefs: ReadonlyArray<string>) => {
  const links = hrefs.map(link)
  rehypeBaseLinks({ base: "/claude-hub/" })({ type: "root", children: links })
  return links.map((node) => node.properties.href)
}

test("prefixes the base path to root-relative links", () => {
  expect(run("/how-to/add-a-runner/", "/reference/glossary/#sandbox")).toEqual([
    "/claude-hub/how-to/add-a-runner/",
    "/claude-hub/reference/glossary/#sandbox",
  ])
})

test("leaves other links alone", () => {
  const hrefs = [
    "/claude-hub/about/",
    "https://github.com/kddige/claude-hub",
    "//example.com/x",
    "#anchor",
    "relative/",
  ]
  expect(run(...hrefs)).toEqual(hrefs)
})
