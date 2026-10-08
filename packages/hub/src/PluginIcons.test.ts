// Finding a Plugin's icon (#230, ADR 0021): the manifest's icon, else a favicon of the Plugin's
// URL, else none. The Hub's fetches are faked by a site map, so nothing reaches the internet.

import { describe, expect, test } from "bun:test"
import { type Icon, type IconFetch, findIcon, sniffIcon } from "./PluginIcons.ts"

const png = (size = 8) => {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return bytes
}
const ico = new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16, 0, 0])
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])
const webp = new Uint8Array([
  ...new TextEncoder().encode("RIFF"),
  1,
  0,
  0,
  0,
  ...new TextEncoder().encode("WEBP"),
])
const svg = new TextEncoder().encode(
  `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>`,
)
const html = (head: string) => `<!doctype html><html><head>${head}</head><body></body></html>`

type Page =
  | Uint8Array
  | string
  | { status: number; headers?: Record<string, string>; body?: Uint8Array | string }

/** A fake internet: the pages at each URL, and every URL asked for, in order. */
function site(pages: Record<string, Page>) {
  const asked: Array<string> = []
  const fetcher: IconFetch = async (url, init) => {
    asked.push(url)
    expect(init.redirect).toBe("manual")
    const page = pages[url]
    if (page === undefined) return new Response("not found", { status: 404 })
    if (page instanceof Uint8Array || typeof page === "string") return new Response(page)
    return new Response(page.body ?? null, { status: page.status, headers: page.headers })
  }
  return { fetcher, asked }
}

const found = async (pages: Record<string, Page>, url: string, manifestIcon?: string) => {
  const fake = site(pages)
  const icon = await findIcon(
    { url, ...(manifestIcon !== undefined && { manifestIcon }) },
    { fetch: fake.fetcher },
  )
  return { icon, asked: fake.asked }
}

const typeOf = (icon: Icon | undefined) => icon?.contentType

describe("sniffing an icon's bytes", () => {
  test("names PNG, ICO, WebP, JPEG and SVG by what the bytes are", () => {
    expect(sniffIcon(png())).toBe("image/png")
    expect(sniffIcon(ico)).toBe("image/x-icon")
    expect(sniffIcon(webp)).toBe("image/webp")
    expect(sniffIcon(jpeg)).toBe("image/jpeg")
    expect(sniffIcon(svg)).toBe("image/svg+xml")
    expect(sniffIcon(new TextEncoder().encode("\n <svg viewBox='0 0 1 1'></svg>"))).toBe(
      "image/svg+xml",
    )
  })

  test("refuses HTML, scripts, GIF and empty bytes", () => {
    for (const text of ["<!doctype html><html></html>", "alert(1)", "GIF89a....", ""]) {
      expect(sniffIcon(new TextEncoder().encode(text))).toBeUndefined()
    }
  })
})

describe("a favicon of the Plugin's URL", () => {
  test("is an SVG link icon before a larger PNG", async () => {
    const { icon } = await found(
      {
        "https://mcp.acme.test/": html(
          `<link rel="icon" href="/big.png" sizes="256x256"><link rel="icon" type="image/svg+xml" href="/logo.svg">`,
        ),
        "https://mcp.acme.test/big.png": png(),
        "https://mcp.acme.test/logo.svg": svg,
        "https://mcp.acme.test/favicon.ico": ico,
      },
      "https://mcp.acme.test/mcp",
    )
    expect(typeOf(icon)).toBe("image/svg+xml")
  })

  test("is the largest PNG of the link icons and apple-touch-icons when there is no SVG", async () => {
    const small = png(20)
    const large = png(40)
    const { icon } = await found(
      {
        "https://mcp.acme.test/": html(
          `<link rel="shortcut icon" href="/16.png" sizes="16x16">` +
            `<link rel="apple-touch-icon" href="/180.png" sizes="180x180">` +
            `<link rel="icon" href="/32.png" sizes="32x32">`,
        ),
        "https://mcp.acme.test/16.png": small,
        "https://mcp.acme.test/32.png": small,
        "https://mcp.acme.test/180.png": large,
      },
      "https://mcp.acme.test/mcp",
    )
    expect(icon?.bytes.length).toBe(40)
  })

  test("takes a web manifest's icons among the PNGs, the largest first", async () => {
    const { icon } = await found(
      {
        "https://mcp.acme.test/": html(
          `<link rel="icon" href="/32.png" sizes="32x32"><link rel="manifest" href="/app.webmanifest">`,
        ),
        "https://mcp.acme.test/32.png": png(20),
        "https://mcp.acme.test/app.webmanifest": JSON.stringify({
          icons: [
            { src: "/icons/192.png", sizes: "192x192" },
            { src: "icons/512.png", sizes: "512x512" },
          ],
        }),
        "https://mcp.acme.test/icons/512.png": png(60),
        "https://mcp.acme.test/icons/192.png": png(40),
      },
      "https://mcp.acme.test/mcp",
    )
    expect(icon?.bytes.length).toBe(60)
  })

  test("is /favicon.ico when the page links no icon, or none that works", async () => {
    const { icon } = await found(
      {
        "https://mcp.acme.test/": html(
          `<link rel="icon" href="/gone.png"><meta property="og:image" content="/og.png">`,
        ),
        "https://mcp.acme.test/og.png": png(),
        "https://mcp.acme.test/favicon.ico": ico,
      },
      "https://mcp.acme.test/mcp",
    )
    expect(typeOf(icon)).toBe("image/x-icon")
  })

  test("never takes an og:image", async () => {
    const { icon, asked } = await found(
      {
        "https://mcp.acme.test/": html(`<meta property="og:image" content="/og.png">`),
        "https://mcp.acme.test/og.png": png(),
      },
      "https://mcp.acme.test/mcp",
    )
    expect(icon).toBeUndefined()
    expect(asked).not.toContain("https://mcp.acme.test/og.png")
  })

  test("is judged by its bytes, not its Content-Type", async () => {
    const { icon } = await found(
      {
        "https://mcp.acme.test/": html(
          `<link rel="icon" href="/a.png"><link rel="icon" href="/b.png" sizes="64x64">`,
        ),
        "https://mcp.acme.test/b.png": {
          status: 200,
          headers: { "content-type": "image/png" },
          body: "<html>not an image</html>",
        },
        "https://mcp.acme.test/a.png": {
          status: 200,
          headers: { "content-type": "text/html" },
          body: webp,
        },
      },
      "https://mcp.acme.test/mcp",
    )
    expect(typeOf(icon)).toBe("image/webp")
  })

  test("resolves a link against the page it was read from, after a redirect", async () => {
    const { icon } = await found(
      {
        "https://acme.test/": { status: 301, headers: { location: "https://www.acme.test/home/" } },
        "https://www.acme.test/home/": html(`<link rel="icon" href="logo.png">`),
        "https://www.acme.test/home/logo.png": png(),
      },
      "https://acme.test/mcp",
    )
    expect(typeOf(icon)).toBe("image/png")
  })

  test("falls back to the registrable apex domain when the origin has none", async () => {
    const { icon, asked } = await found(
      {
        "https://linear.app/": html(`<link rel="icon" href="/i.jpg">`),
        "https://linear.app/i.jpg": jpeg,
      },
      "https://mcp.linear.app/mcp",
    )
    expect(typeOf(icon)).toBe("image/jpeg")
    expect(asked.indexOf("https://mcp.linear.app/favicon.ico")).toBeLessThan(
      asked.indexOf("https://linear.app/"),
    )
  })

  test("knows a public suffix: example.co.uk's apex is not co.uk", async () => {
    const { icon, asked } = await found({}, "https://mcp.example.co.uk/mcp")
    expect(icon).toBeUndefined()
    expect(asked.some((url) => url.startsWith("https://example.co.uk/"))).toBe(true)
    expect(asked.some((url) => url.startsWith("https://co.uk/"))).toBe(false)
  })

  test("tries no apex for an origin that is its own, or for an address", async () => {
    const own = await found({}, "https://acme.test/mcp")
    expect(own.asked.every((url) => url.startsWith("https://acme.test/"))).toBe(true)
    const loopback = await found({}, "http://127.0.0.1:9000/mcp")
    expect(loopback.asked.every((url) => url.startsWith("http://127.0.0.1:9000/"))).toBe(true)
  })

  test("is none when nothing at either origin is an icon", async () => {
    const { icon } = await found({}, "https://mcp.acme.test/mcp")
    expect(icon).toBeUndefined()
  })
})

describe("what the Hub fetches", () => {
  test("is https, or http to loopback, and never credentials or other schemes", async () => {
    for (const url of [
      "http://mcp.acme.test/mcp",
      "ftp://acme.test/mcp",
      "https://user:pass@acme.test/mcp",
    ]) {
      const { icon, asked } = await found({}, url)
      expect(icon).toBeUndefined()
      expect(asked).toEqual([])
    }
    const { icon } = await found(
      { "http://localhost:3000/favicon.ico": ico },
      "http://localhost:3000/mcp",
    )
    expect(typeOf(icon)).toBe("image/x-icon")
  })

  test("follows up to 3 redirects, then gives up", async () => {
    const hops = {
      "https://acme.test/favicon.ico": { status: 302, headers: { location: "/1" } },
      "https://acme.test/1": { status: 302, headers: { location: "/2" } },
      "https://acme.test/2": { status: 302, headers: { location: "/3" } },
      "https://acme.test/3": ico,
    }
    expect(typeOf((await found(hops, "https://acme.test/mcp")).icon)).toBe("image/x-icon")
    const four = {
      ...hops,
      "https://acme.test/3": { status: 302, headers: { location: "/4" } },
      "https://acme.test/4": ico,
    }
    expect((await found(four, "https://acme.test/mcp")).icon).toBeUndefined()
  })

  test("checks every hop against the same rules", async () => {
    const { icon, asked } = await found(
      {
        "https://acme.test/favicon.ico": {
          status: 302,
          headers: { location: "http://internal.test/favicon.ico" },
        },
        "http://internal.test/favicon.ico": ico,
      },
      "https://acme.test/mcp",
    )
    expect(icon).toBeUndefined()
    expect(asked).not.toContain("http://internal.test/favicon.ico")
  })

  test("takes an icon of at most 512 KB", async () => {
    const limit = 512 * 1024
    expect(
      (await found({ "https://acme.test/favicon.ico": png(limit) }, "https://acme.test/mcp")).icon,
    ).toBeDefined()
    expect(
      (await found({ "https://acme.test/favicon.ico": png(limit + 1) }, "https://acme.test/mcp"))
        .icon,
    ).toBeUndefined()
  })

  test("reads at most 512 KB of the page for its links, then goes on to /favicon.ico", async () => {
    const padding = " ".repeat(512 * 1024)
    const { icon } = await found(
      {
        "https://acme.test/": html(`${padding}<link rel="icon" href="/late.png">`),
        "https://acme.test/late.png": png(),
        "https://acme.test/favicon.ico": ico,
      },
      "https://acme.test/mcp",
    )
    expect(typeOf(icon)).toBe("image/x-icon")
  })

  test("gives each fetch 5 seconds, then goes on", async () => {
    const aborted: Array<string> = []
    const fetcher: IconFetch = (url, init) =>
      url.endsWith("/favicon.ico")
        ? Promise.resolve(new Response(ico))
        : new Promise((_, reject) => {
            init.signal?.addEventListener("abort", () => {
              aborted.push(url)
              reject(new Error("aborted"))
            })
          })
    const icon = await findIcon({ url: "https://acme.test/mcp" }, { fetch: fetcher, timeoutMs: 20 })
    expect(aborted).toEqual(["https://acme.test/"])
    expect(typeOf(icon)).toBe("image/x-icon")
  })

  test("waits 5 seconds by default", async () => {
    let signal: AbortSignal | null | undefined
    await findIcon(
      { url: "https://acme.test/mcp" },
      {
        fetch: async (_url, init) => {
          signal ??= init.signal
          return new Response("no", { status: 404 })
        },
      },
    )
    expect(signal).toBeDefined()
    expect(signal?.aborted).toBe(false)
  })

  test("goes on when a fetch fails outright", async () => {
    const fetcher: IconFetch = async (url) => {
      if (url === "https://acme.test/") throw new Error("connection refused")
      return new Response(ico)
    }
    expect(typeOf(await findIcon({ url: "https://acme.test/mcp" }, { fetch: fetcher }))).toBe(
      "image/x-icon",
    )
  })
})

describe("the manifest's icon", () => {
  test("is an https URL, fetched and sniffed, and wins over the favicon", async () => {
    const { icon } = await found(
      {
        "https://cdn.acme.test/logo.png": png(),
        "https://acme.test/favicon.ico": ico,
      },
      "https://acme.test/mcp",
      "https://cdn.acme.test/logo.png",
    )
    expect(typeOf(icon)).toBe("image/png")
  })

  test("is a file in the package, whose bytes the caller read", async () => {
    const fake = site({ "https://acme.test/favicon.ico": ico })
    const icon = await findIcon(
      { url: "https://acme.test/mcp", manifestIcon: "assets/logo.svg", iconFile: svg },
      { fetch: fake.fetcher },
    )
    expect(typeOf(icon)).toBe("image/svg+xml")
    expect(fake.asked).toEqual([])
  })

  test("falls to the favicon when broken: not found, not an image, or a file the package lacks", async () => {
    const pages = {
      "https://cdn.acme.test/page.png": "<html></html>",
      "https://acme.test/favicon.ico": ico,
    }
    for (const manifestIcon of [
      "https://cdn.acme.test/missing.png",
      "https://cdn.acme.test/page.png",
      "http://cdn.acme.test/plain.png",
      "assets/logo.png",
    ]) {
      expect(typeOf((await found(pages, "https://acme.test/mcp", manifestIcon)).icon)).toBe(
        "image/x-icon",
      )
    }
    const notImage = await findIcon(
      { url: "https://acme.test/mcp", manifestIcon: "a.png", iconFile: new Uint8Array([1, 2, 3]) },
      { fetch: site(pages).fetcher },
    )
    expect(typeOf(notImage)).toBe("image/x-icon")
  })
})
