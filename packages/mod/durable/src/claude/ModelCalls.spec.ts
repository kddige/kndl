// Where Pi Durable calls a chat model, and what the bridge counts on of how. A behavioural test can
// only probe the calls known already, so this reads Pi Durable's installed code, to hear of a new
// one, or a changed one, when kndl bumps it rather than from a Session.
//
// - Generation streams each request (`streamSimple`) with the generation task's invocation's
//   signal, which the scheduler aborts whenever the invocation ends: after a turn that ends at a
//   tool call too. So the bridge binds a call's signal to its query only while its turn is open.
// - Compaction makes its summary with `completeSimple` and `cacheRetention: "none"`, which the
//   bridge routes to a Claude Code of its own.
// - Both pass the conversation's provider session id, which the bridge keys everything by.
//
// If this fails: read Pi Durable's change, work out what the bridge must do about it, then update
// the inventory below.
//
// After pi-claude-bridge 0.9.3's unit-pi-streamfn-inventory test (MIT, Copyright (c) 2026 Eli
// Dickinson): see THIRD_PARTY_NOTICES.md.

import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

// By path: the package's exports don't reach its harness modules.
const DurableDist = join(import.meta.dir, "../../../node_modules/@earendil-works/pi-durable/dist")

/** A chat model call: `<runtime>.models.<method>(`. */
const ModelCall =
  /\bmodels\.(stream|streamSimple|complete|completeSimple|streamDeferred|fetchDeferred)\(/g

/** The calls accounted for, by file and method, with why each is harmless. */
const Handled: Readonly<
  Record<string, { readonly calls: ReadonlyArray<string>; readonly why: string }>
> = {
  "harness/generation.js": {
    calls: ["fetchDeferred", "streamSimple"],
    why: "each request of a run; the bridge answers no deferred responses, so never polled",
  },
  "harness/compaction.js": {
    calls: ["completeSimple"],
    why: "the summary, with cacheRetention: none: the bridge's isolated summary",
  },
}

function jsFilesUnder(dir: string, prefix = ""): Array<{ rel: string; full: string }> {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return jsFilesUnder(full, `${prefix}${name}/`)
    return name.endsWith(".js") ? [{ rel: `${prefix}${name}`, full }] : []
  })
}

const read = (rel: string) => readFileSync(join(DurableDist, rel), "utf8")

describe("Pi Durable's chat model calls", () => {
  test("are all ones accounted for, in the same places", () => {
    expect(existsSync(DurableDist)).toBe(true)
    const found = new Map(
      jsFilesUnder(DurableDist)
        .map(
          ({ rel, full }) =>
            [
              rel,
              [...readFileSync(full, "utf8").matchAll(ModelCall)]
                .map((match) => match[1] ?? "")
                .toSorted(),
            ] as const,
        )
        .filter(([, calls]) => calls.length > 0),
    )
    expect(Object.fromEntries(found)).toEqual(
      Object.fromEntries(Object.entries(Handled).map(([rel, { calls }]) => [rel, [...calls]])),
    )
  })

  test("pass the conversation's provider session id", () => {
    for (const rel of Object.keys(Handled))
      expect(read(rel)).toContain("sessionId: await ensureProviderSessionId(runtime, context)")
  })

  test("mark the summary's request cacheRetention: none", () => {
    expect(read("harness/compaction.js")).toMatch(/cacheRetention: "none"/)
  })

  // The reason a call's signal stops its query only while its turn is open (QueryState.ts).
  test("hand a request the invocation's signal, which ends with the invocation", () => {
    expect(read("harness/generation.js")).toMatch(/signal: runtime\.signal/)
    expect(read("harness/scheduler.js")).toContain(
      "invocation.controller.abort(endedError(invocation))",
    )
  })
})
