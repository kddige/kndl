import { describe, expect, test } from "bun:test"
import { brokenLinks } from "./check-links.ts"

const page = (body: string) => `<html><body id="_top">${body}</body></html>`

describe("brokenLinks", () => {
  const pages = new Map([
    ["index.html", page('<a href="/kndl/how-to/install/#install">Install</a>')],
    [
      "how-to/install/index.html",
      page('<h2 id="install">Install</h2><a href="#install">here</a><a href="#_top">top</a>'),
    ],
  ])

  test("passes links to pages and anchors that exist", () => {
    expect(brokenLinks(pages)).toEqual([])
  })

  test("reports a missing page, a missing anchor, and links outside the base", () => {
    const withBad = new Map(pages).set(
      "about/index.html",
      page(
        [
          '<a href="/kndl/how-to/gone/">gone</a>',
          '<a href="/kndl/how-to/install/#nowhere">nowhere</a>',
          '<a href="#missing">missing</a>',
          '<a href="/how-to/install/">no base</a>',
          '<a href="how-to/install/">relative</a>',
        ].join(""),
      ),
    )
    expect(brokenLinks(withBad).map((b) => [b.href, b.reason])).toEqual([
      ["/kndl/how-to/gone/", "no such page"],
      ["/kndl/how-to/install/#nowhere", "no #nowhere on how-to/install/index.html"],
      ["#missing", "no #missing on about/index.html"],
      ["/how-to/install/", "outside the site's base path /kndl/"],
      ["how-to/install/", "relative; link root-relative instead"],
    ])
  })

  test("skips external links, and resolves files the site has", () => {
    const linked = new Map([
      [
        "index.html",
        page(
          '<a href="https://diataxis.fr">x</a><a href="mailto:a@b.c">m</a><a href="/kndl/og.png">og</a>',
        ),
      ],
    ])
    expect(brokenLinks(linked, new Set(["og.png"]))).toEqual([])
    expect(brokenLinks(linked).map((b) => b.reason)).toEqual(["no such file"])
  })
})
