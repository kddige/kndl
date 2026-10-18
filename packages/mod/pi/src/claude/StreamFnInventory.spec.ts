// Which of pi's modules can route a model call through the provider. Anything pi hands a
// `streamFn` can reach the bridge with a system prompt no before_agent_start recorded, which fails
// the turn (PromptCapture.ts) unless it's a one-off summary call (`cacheRetention: "none"`), which
// the bridge runs on its own. A behavioural test can only probe the entry points known already, so
// this reads pi's installed code, to hear of a new one when kndl bumps pi rather than from a
// Session.
//
// If this fails: a pi upgrade added or moved a streamFn consumer. Work out whether it can reach a
// Claude Model, and route it through the isolated summary path, or add it below with why it's
// harmless.
//
// Ported from pi-claude-bridge 0.9.3's unit-pi-streamfn-inventory test (MIT, Copyright (c) 2026
// Eli Dickinson): see THIRD_PARTY_NOTICES.md.

import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

// By path: the package's exports don't reach its dist/core.
const PiDist = join(
  import.meta.dir,
  "../../../node_modules/@earendil-works/pi-coding-agent/dist/core",
)

/**
 * The consumers accounted for, with how many times each mentions `streamFn`: a new call site inside
 * a file already listed is the shape of the reference's branch-summary miss.
 */
const Handled: Readonly<Record<string, { readonly mentions: number; readonly why: string }>> = {
  "agent-session.js": {
    mentions: 2,
    why: "hands branch summaries and /bug to their summarizers, through agent.streamFunction",
  },
  "sdk.js": { mentions: 2, why: "makes the agent; summarizes nothing" },
  "bug-report.js": {
    mentions: 1,
    why: "/bug's summary, through completeSummarization (cacheRetention: none): the isolated path",
  },
  "compaction/compaction.js": {
    mentions: 13,
    why: "completeSummarization (cacheRetention: none): the isolated path",
  },
  "compaction/branch-summarization.js": {
    mentions: 2,
    why: "completeSummarization (cacheRetention: none): the isolated path",
  },
}

const mentionsOf = (text: string) => (text.match(/streamFn/g) ?? []).length

function jsFilesUnder(dir: string, prefix = ""): Array<{ rel: string; full: string }> {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return jsFilesUnder(full, `${prefix}${name}/`)
    return name.endsWith(".js") ? [{ rel: `${prefix}${name}`, full }] : []
  })
}

describe("pi's streamFn consumers", () => {
  test("are all ones accounted for, in the same places", () => {
    expect(existsSync(PiDist)).toBe(true)
    const found = new Map(
      jsFilesUnder(PiDist)
        .map(({ rel, full }) => [rel, mentionsOf(readFileSync(full, "utf8"))] as const)
        .filter(([, n]) => n > 0),
    )
    expect(found.size).toBeGreaterThan(0)

    // Consumers never considered: each can reach the provider with an unrecorded system prompt.
    expect([...found.keys()].filter((rel) => !(rel in Handled))).toEqual([])
    // Ones that no longer consume it: the inventory is out of date.
    expect(Object.keys(Handled).filter((rel) => !found.has(rel))).toEqual([])
    // A changed count: read the diff, then update it.
    expect(
      [...found]
        .filter(([rel, n]) => Handled[rel]?.mentions !== n)
        .map(([rel, n]) => `${rel}: ${Handled[rel]?.mentions} -> ${n}`),
    ).toEqual([])
  })
})
