// kndl's repository on GitHub (ADR 0028), read from a stand-in for GitHub's API on 127.0.0.1:
// what each call asks for, and what the Hub makes of GitHub's answers and failures.

import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { Upstream } from "./Upstream.ts"

const head = "f".repeat(40)
const base = "a".repeat(40)

/** What the stand-in was asked, by path and `Accept`. */
const asked: Array<{ readonly path: string; readonly accept: string | null }> = []
let answer: (path: string) => Response = () => new Response("", { status: 404 })

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    const path = `${url.pathname}${url.search}`
    asked.push({ path, accept: request.headers.get("accept") })
    return answer(path)
  },
})
afterAll(() => server.stop(true))

const run = <A, E>(use: (upstream: Upstream["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Upstream.make(new URL(`http://127.0.0.1:${server.port}/api`)).pipe(
      Effect.flatMap(use),
      Effect.provide(FetchHttpClient.layer),
    ),
  )

describe("kndl's repository on GitHub", () => {
  test("lists its Releases with their notes, drafts left out", async () => {
    answer = () =>
      Response.json([
        {
          tag_name: "v2026.10.3",
          body: null,
          html_url: "https://github.com/kddige/kndl/releases/tag/v2026.10.3",
          published_at: null,
          draft: true,
          prerelease: false,
        },
        {
          tag_name: "v2026.10.2",
          body: "## Highlights\n\n- Faster.",
          html_url: "https://github.com/kddige/kndl/releases/tag/v2026.10.2",
          published_at: "2026-10-12T16:49:38Z",
          draft: false,
          prerelease: false,
        },
      ])
    asked.length = 0
    expect(await run((upstream) => upstream.releases)).toEqual([
      {
        tag: "v2026.10.2",
        notes: "## Highlights\n\n- Faster.",
        url: "https://github.com/kddige/kndl/releases/tag/v2026.10.2",
        publishedAt: Date.parse("2026-10-12T16:49:38Z"),
        prerelease: false,
      },
    ])
    expect(asked).toEqual([
      {
        path: "/api/repos/kddige/kndl/releases?per_page=100",
        accept: "application/vnd.github+json",
      },
    ])
  })

  test("reads a branch's head as the commit id alone", async () => {
    answer = () => new Response(`${head}\n`)
    asked.length = 0
    expect(await run((upstream) => upstream.head("main"))).toBe(head)
    expect(asked).toEqual([
      { path: "/api/repos/kddige/kndl/commits/main", accept: "application/vnd.github.sha" },
    ])
  })

  test("compares two commits, each by its title", async () => {
    answer = () =>
      Response.json({
        status: "ahead",
        ahead_by: 2,
        behind_by: 0,
        commits: [
          { sha: "b".repeat(40), commit: { message: "web: one (#1)\n\nThe body." } },
          { sha: head, commit: { message: "hub: two (#2)" } },
        ],
      })
    asked.length = 0
    expect(await run((upstream) => upstream.compare(base, head))).toEqual({
      status: "ahead",
      aheadBy: 2,
      commits: [
        { commit: "b".repeat(40), title: "web: one (#1)" },
        { commit: head, title: "hub: two (#2)" },
      ],
    })
    expect(asked[0]?.path).toBe(`/api/repos/kddige/kndl/compare/${base}...${head}`)
  })

  test("fails with GitHub's own words, or when its answer isn't one it gives", async () => {
    answer = () => Response.json({ message: "API rate limit exceeded" }, { status: 403 })
    const limited = await run((upstream) => Effect.flip(upstream.releases))
    expect(limited.message).toBe(
      "Could not list kndl's Releases: GitHub answered 403: API rate limit exceeded",
    )

    answer = () => new Response("not a commit")
    const odd = await run((upstream) => Effect.flip(upstream.head("main")))
    expect(odd.message).toBe("Could not look up kndl's main: GitHub sent an unexpected answer")
  })
})
