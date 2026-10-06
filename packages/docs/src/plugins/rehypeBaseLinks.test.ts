import { expect, test } from "bun:test"
import { rehypeBaseLinks } from "./rehypeBaseLinks.ts"

const link = (href: string) => ({ type: "element", tagName: "a", properties: { href } })

const run = (...hrefs: ReadonlyArray<string>) => {
  const links = hrefs.map(link)
  rehypeBaseLinks({ base: "/kndl/" })({ type: "root", children: links })
  return links.map((node) => node.properties.href)
}

test("prefixes the base path to root-relative links", () => {
  expect(run("/how-to/add-a-runner/", "/reference/glossary/#sandbox")).toEqual([
    "/kndl/how-to/add-a-runner/",
    "/kndl/reference/glossary/#sandbox",
  ])
})

test("leaves other links alone", () => {
  const hrefs = [
    "/kndl/about/",
    "https://github.com/kddige/kndl",
    "//example.com/x",
    "#anchor",
    "relative/",
  ]
  expect(run(...hrefs)).toEqual(hrefs)
})
