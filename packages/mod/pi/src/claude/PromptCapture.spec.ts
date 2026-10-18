// What pi assembled into each system prompt, and what of it Claude Code gets: the captures, their
// inheritance, the projection, and the guard against sending pi's harness (Extra Usage billing).
// Ported from pi-claude-bridge 0.9.3's tests (unit-prompt-capture, unit-prompt-guard,
// unit-agents-md, unit-skills).

import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Skill } from "@earendil-works/pi-coding-agent"
import {
  collectPromptSkills,
  formatProjectContext,
  PiPreamble,
  projectPromptCapture,
  PromptCaptures,
  renderSkillsBlock,
} from "./PromptCapture.ts"
import type { PromptCapture, PromptCaptureDiagnostic, PromptCaptureInput } from "./PromptCapture.ts"

/** pi's own prompt builder, which isn't among the package's exports. */
const piSystemPrompt = join(
  import.meta.dir,
  "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js",
)
interface PiSystemPromptModule {
  readonly buildSystemPrompt: (options: Record<string, unknown>) => string
  readonly buildSystemPromptSections: (
    options: Record<string, unknown>,
  ) => Readonly<Record<string, string>>
}
const loadPiSystemPrompt = async () => {
  expect(existsSync(piSystemPrompt)).toBe(true)
  return (await import(piSystemPrompt)) as PiSystemPromptModule
}

const PiHarness =
  "You are an expert coding assistant operating inside pi. Pi documentation: pi packages (docs/packages.md)."
const ParentKey = `${PiHarness}\n\n<project_context>raw parent context</project_context>\nCurrent working directory: /parent`
const ChildSuffix = `\n\n<sub_agent_context>child rules</sub_agent_context>\n\n<active_agent name="Plan"/>\n\n# Environment\nWorking directory: /child\n\n<agent_instructions>plan carefully</agent_instructions>`
const ChildKey = `${ParentKey}${ChildSuffix}\nCurrent working directory: /child`

const skill = (name: string, disabled = false): Skill =>
  ({
    name,
    description: `${name} description`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    sourceInfo: { source: "test", scope: "temporary", origin: "top-level" },
    disableModelInvocation: disabled,
  }) as unknown as Skill

const capture = (overrides: Partial<PromptCaptureInput> = {}): PromptCaptureInput => ({
  contextFiles: [],
  skills: [],
  ...overrides,
})

const resolved = (captures: PromptCaptures, key: string): PromptCapture => {
  const found = captures.resolve(key)
  if (found === undefined) throw new Error(`missing capture for ${key.slice(0, 30)}`)
  return found
}

const project = (captures: PromptCaptures, key: string) =>
  projectPromptCapture(resolved(captures, key), { skillReadTool: "mcp" }) ?? ""

const occurrences = (text: string, needle: string) => text.split(needle).length - 1

const thrown = (fn: () => unknown): Error => {
  try {
    fn()
  } catch (error) {
    return error as Error
  }
  throw new Error("it didn't throw")
}

describe("PromptCaptures", () => {
  test("keeps parent and child captures apart", () => {
    const captures = new PromptCaptures()
    captures.record(
      ParentKey,
      capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }),
    )
    captures.record(ChildKey, capture({ custom: `${ParentKey}${ChildSuffix}` }))

    expect(resolved(captures, ParentKey).contextFiles.length).toBe(1)
    expect(resolved(captures, ChildKey).contextFiles.length).toBe(0)
    expect(captures.resolve("unknown")).toBeUndefined()
    expect(captures.resolve(undefined)).toBeUndefined()
  })

  test("derives a passing capture for a prompt a later extension wrapped, keeping the wrapper", () => {
    const captures = new PromptCaptures()
    captures.record(
      ParentKey,
      capture({
        contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }],
        skills: [skill("browser")],
      }),
    )
    const wrapped = `PREFIX FROM ANOTHER EXTENSION\n\n${ParentKey}\n\nSUFFIX`
    const derived = captures.resolveOrDerive(wrapped)
    if (derived === undefined) throw new Error("nothing derived")
    const projected = projectPromptCapture(derived, { skillReadTool: "mcp" }) ?? ""

    expect(projected).toMatch(/parent rules/)
    expect(projected).toMatch(/browser/)
    expect(projected).toMatch(/PREFIX FROM ANOTHER EXTENSION/)
    expect(projected).toMatch(/SUFFIX/)
    // Never pi's harness, which the projection replaces.
    expect(projected).not.toMatch(/Pi documentation/)
    expect(captures.resolve(wrapped)).toBeUndefined()
  })

  test("revives an exact capture whose key was evicted, within the bound", () => {
    const captures = new PromptCaptures(2)
    captures.record(
      ParentKey,
      capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }),
    )
    captures.record(ChildKey, capture({ custom: `${ParentKey}${ChildSuffix}` }))
    captures.record("unrelated", capture())
    expect(captures.resolve(ParentKey)).toBeUndefined()

    expect(captures.resolveOrDerive(ParentKey)?.contextFiles[0]?.content).toBe("parent rules")
    expect(captures.size).toBe(2)
  })

  test("keeps a parent that is only ever resolved alive through its subagents' records", () => {
    const captures = new PromptCaptures(4)
    captures.record(
      ParentKey,
      capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }),
    )
    for (let i = 0; i < 8; i++) {
      expect(captures.resolve(ParentKey)).toBeDefined()
      captures.record(`sub-agent prompt ${i}`, capture())
    }
    expect(resolved(captures, ParentKey).contextFiles.length).toBe(1)
  })

  test("throws rather than dropping instructions it can't account for", () => {
    const captures = new PromptCaptures()
    captures.record(
      ParentKey,
      capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }),
    )
    expect(() =>
      captures.resolveOrDerive("a prompt sharing nothing with what we recorded"),
    ).toThrow(/no capture for this .* system prompt/)
    // No prompt is no loss: there's nothing to forward.
    expect(captures.resolveOrDerive(undefined)).toBeUndefined()
  })

  test("reports the closest known capture when a prompt matches nothing", () => {
    const diagnostics: Array<PromptCaptureDiagnostic> = []
    const captures = new PromptCaptures(64, (d) => diagnostics.push(d))
    captures.record("prefix-common-THE-REST", capture())

    const error = thrown(() => captures.resolveOrDerive("prefix-common-WHO-ARE-YOU"))
    expect(error.message).toMatch(/diverges at offset 14 \(22-char key\)/)
    expect(diagnostics.length).toBe(1)
    expect(diagnostics[0]?.matches[0]?.key).toBe("prefix-common-THE-REST")
    expect(diagnostics[0]?.matches[0]?.firstDivergent).toBe(14)
  })

  test("names pi#5581 when a prompt is a recorded key with its tail missing", () => {
    const captures = new PromptCaptures()
    captures.record(`${ParentKey}\n\n<skills>extension additions</skills>`, capture(), "turn_start")
    expect(() => captures.resolveOrDerive(ParentKey)).toThrow(/pi#5581/)
  })

  test("projects an inherited prompt, recursively, without pi's harness", () => {
    const browser = skill("browser")
    const captures = new PromptCaptures()
    captures.record(
      ParentKey,
      capture({
        contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }],
        skills: [browser],
      }),
    )
    captures.record(ChildKey, capture({ custom: `${ParentKey}${ChildSuffix}`, skills: [browser] }))

    const parent = project(captures, ParentKey)
    const child = project(captures, ChildKey)
    // The child keeps the parent's projected prefix, for the cache.
    expect(child.startsWith(parent)).toBe(true)
    expect(child).not.toMatch(/operating inside pi|pi packages/)
    expect(child).toMatch(/parent rules/)
    expect(child).toMatch(/<sub_agent_context>child rules<\/sub_agent_context>/)
    expect(child).toMatch(/<active_agent name="Plan"\/>/)
    expect(child).toMatch(/<agent_instructions>plan carefully<\/agent_instructions>/)
    expect(occurrences(child, "/skills/browser/SKILL.md")).toBe(1)
  })

  test("leaves direct custom and replacing prompts byte for byte", () => {
    const captures = new PromptCaptures()
    captures.record("direct assembled", capture({ custom: "  direct user instructions\n" }))
    captures.record(
      "replace assembled",
      capture({ custom: '<active_agent name="review"/>\nreplace instructions' }),
    )
    expect(project(captures, "direct assembled")).toBe("  direct user instructions\n")
    expect(project(captures, "replace assembled")).toBe(
      '<active_agent name="review"/>\nreplace instructions',
    )
  })

  test("takes the longest inherited key for nested agents", () => {
    const captures = new PromptCaptures()
    captures.record(
      ParentKey,
      capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }),
    )
    captures.record(ChildKey, capture({ custom: `${ParentKey}${ChildSuffix}` }))
    const grandSuffix = "\n\n<sub_agent_context>grandchild rules</sub_agent_context>"
    const grandKey = `${ChildKey}${grandSuffix}\nCurrent working directory: /grandchild`
    captures.record(grandKey, capture({ custom: `${ChildKey}${grandSuffix}` }))

    const grandchild = project(captures, grandKey)
    expect(grandchild).not.toMatch(
      /operating inside pi|Current working directory: \/parent|Current working directory: \/child/,
    )
    expect(occurrences(grandchild, "parent rules")).toBe(1)
    expect(grandchild).toMatch(/child rules/)
    expect(grandchild).toMatch(/grandchild rules/)
  })

  test("keeps inherited captures after their keys are evicted", () => {
    const captures = new PromptCaptures(2)
    captures.record(
      ParentKey,
      capture({ contextFiles: [{ path: "/AGENTS.md", content: "survives eviction" }] }),
    )
    captures.record(ChildKey, capture({ custom: `${ParentKey}${ChildSuffix}` }))
    captures.record("unrelated", capture())

    expect(captures.resolve(ParentKey)).toBeUndefined()
    expect(project(captures, ChildKey)).toMatch(/survives eviction/)
  })

  test("links a new prompt to an evicted ancestor still reachable through the graph", () => {
    const captures = new PromptCaptures(2)
    captures.record(
      ParentKey,
      capture({ contextFiles: [{ path: "/AGENTS.md", content: "reachable ancestor" }] }),
    )
    captures.record(ChildKey, capture({ custom: `${ParentKey}${ChildSuffix}` }))
    captures.record("unrelated", capture())
    const changedKey = "changed child assembled prompt"
    captures.record(changedKey, capture({ custom: `${ParentKey}\n\nchanged child rules` }))

    const changed = project(captures, changedKey)
    expect(changed).not.toMatch(/operating inside pi/)
    expect(changed).toMatch(/reachable ancestor/)
    expect(changed).toMatch(/changed child rules/)
  })

  test("updates descendants through a parent recorded again", () => {
    const captures = new PromptCaptures()
    captures.record(
      ParentKey,
      capture({ contextFiles: [{ path: "/AGENTS.md", content: "rules v1" }] }),
    )
    captures.record(ChildKey, capture({ custom: `${ParentKey}${ChildSuffix}` }))
    captures.record(
      ParentKey,
      capture({ contextFiles: [{ path: "/AGENTS.md", content: "rules v2" }] }),
    )
    captures.record(
      ChildKey,
      capture({ custom: `${ParentKey}${ChildSuffix}`, append: "child append" }),
    )

    const child = project(captures, ChildKey)
    expect(child).not.toMatch(/rules v1|operating inside pi/)
    expect(child).toMatch(/rules v2/)
    expect(child).toMatch(/child append$/)
  })

  test("projects every non-overlapping occurrence of an inherited prompt", () => {
    const captures = new PromptCaptures()
    captures.record(
      ParentKey,
      capture({ contextFiles: [{ path: "/AGENTS.md", content: "repeated rules" }] }),
    )
    captures.record("repeated child", capture({ custom: `${ParentKey}\nseparator\n${ParentKey}` }))

    const result = project(captures, "repeated child")
    expect(result).not.toMatch(/operating inside pi/)
    expect(occurrences(result, "repeated rules")).toBe(2)
  })

  test("lists inherited skills once, and keeps the child's own", () => {
    const browser = skill("browser")
    const review = skill("review")
    const captures = new PromptCaptures()
    captures.record(ParentKey, capture({ skills: [browser] }))
    captures.record(
      ChildKey,
      capture({ custom: `${ParentKey}${ChildSuffix}`, skills: [browser, review] }),
    )

    const child = resolved(captures, ChildKey)
    expect(collectPromptSkills(child).map(({ name }) => name)).toEqual(["browser", "review"])
    const result = projectPromptCapture(child, { skillReadTool: "mcp" }) ?? ""
    expect(occurrences(result, "/skills/browser/SKILL.md")).toBe(1)
    expect(occurrences(result, "/skills/review/SKILL.md")).toBe(1)
  })

  test("lists a child's skill when the inherited copy is hidden", () => {
    const captures = new PromptCaptures()
    captures.record(ParentKey, capture({ skills: [skill("browser", true)] }))
    captures.record(
      ChildKey,
      capture({ custom: `${ParentKey}${ChildSuffix}`, skills: [skill("browser")] }),
    )
    expect(occurrences(project(captures, ChildKey), "/skills/browser/SKILL.md")).toBe(1)
  })

  test("is bounded, and evicts the key least recently recorded", () => {
    const captures = new PromptCaptures(3)
    captures.record("a", capture())
    captures.record("b", capture())
    captures.record("c", capture())
    captures.record("a", capture({ custom: "refreshed" }))
    captures.record("d", capture())

    expect(captures.size).toBe(3)
    expect(captures.resolve("b")).toBeUndefined()
    expect(resolved(captures, "a").custom).toBe("refreshed")
    expect(captures.resolve("c")).toBeDefined()
    expect(captures.resolve("d")).toBeDefined()
  })
})

describe("prompt sections", () => {
  const mcpContent = "- mcp__github (codemode): GitHub tools"
  const mcpSection = `<mcp_servers>\n${mcpContent}\n</mcp_servers>`

  test("projects a section after the appended instructions, as pi's builder renders it", async () => {
    const captures = new PromptCaptures()
    captures.record(
      "sectioned prompt",
      capture({ append: "be careful", sections: { mcp_servers: mcpContent } }),
    )
    expect(project(captures, "sectioned prompt")).toBe(`be careful\n\n${mcpSection}`)

    const { buildSystemPromptSections } = await loadPiSystemPrompt()
    expect(
      buildSystemPromptSections({ cwd: "/w", sections: { mcp_servers: mcpContent } }).mcp_servers,
    ).toBe(mcpSection)
  })

  test("skips an empty section, as pi's builder does", () => {
    const captures = new PromptCaptures()
    captures.record("one empty section", capture({ sections: { mcp_servers: "", other: "kept" } }))
    expect(project(captures, "one empty section")).toBe("<other>\nkept\n</other>")
  })

  test("keeps the sections recorded when the caller changes its own map", () => {
    // systemPromptOptions is live: later before_agent_start handlers edit it.
    const sections: Record<string, string> = { mcp_servers: mcpContent }
    const captures = new PromptCaptures()
    captures.record("live options", capture({ sections }))
    sections.mcp_servers = "mutated"
    expect(project(captures, "live options")).toBe(mcpSection)
  })

  test("drops a section a later record no longer has", () => {
    const captures = new PromptCaptures()
    captures.record("sectioned prompt", capture({ sections: { mcp_servers: mcpContent } }))
    expect(project(captures, "sectioned prompt")).toBe(mcpSection)
    captures.record("sectioned prompt", capture({ sections: {} }))
    expect(
      projectPromptCapture(resolved(captures, "sectioned prompt"), { skillReadTool: "mcp" }),
    ).toBeUndefined()
  })

  test("projects an inherited prompt's section through a child, once", () => {
    const captures = new PromptCaptures()
    captures.record(
      ParentKey,
      capture({
        contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }],
        sections: { mcp_servers: mcpContent },
      }),
    )
    captures.record(ChildKey, capture({ custom: `${ParentKey}${ChildSuffix}` }))

    const child = project(captures, ChildKey)
    expect(occurrences(child, mcpSection)).toBe(1)
    expect(child).not.toMatch(/operating inside pi/)
  })

  test("refuses a section carrying pi's preamble or Anthropic's trigger pair", () => {
    const offending = {
      leaked_harness: `${PiPreamble}, a coding agent harness.`,
      triggers: "see docs/custom-provider.md and docs/packages.md",
    }
    for (const [name, content] of Object.entries(offending)) {
      const captures = new PromptCaptures()
      captures.record(
        "guarded prompt",
        capture({ sections: { [name]: content } }),
        "before_agent_start",
      )
      const error = thrown(() =>
        projectPromptCapture(resolved(captures, "guarded prompt"), { skillReadTool: "none" }),
      )
      expect(error.message).toContain(`in the ${name} section`)
    }
  })
})

describe("capture provenance", () => {
  test("records which boundary last wrote a key", () => {
    const captures = new PromptCaptures()
    captures.record("key", capture(), "agent_start")
    expect(resolved(captures, "key").source).toBe("agent_start")
    captures.record("key", capture(), "turn_start")
    expect(resolved(captures, "key").source).toBe("turn_start")
  })

  test("names the closest match's boundary when it throws", () => {
    const captures = new PromptCaptures()
    captures.record("prefix-common-THE-REST", capture(), "agent_start")
    expect(() => captures.resolveOrDerive("prefix-common-WHO-ARE-YOU")).toThrow(
      /recorded at agent_start/,
    )
  })
})

describe("the guard against sending pi's harness", () => {
  test("refuses a custom prompt with pi's preamble at a line's start", () => {
    const captures = new PromptCaptures()
    captures.record(
      "leaking prompt",
      capture({
        custom: `${PiPreamble}, a coding agent harness.\n\n<tools>\n- read: Read a file\n</tools>`,
      }),
      "before_agent_start",
    )
    const error = thrown(() =>
      projectPromptCapture(resolved(captures, "leaking prompt"), { skillReadTool: "none" }),
    )
    expect(error.message).toContain(PiPreamble)
    expect(error.message).toMatch(/offset 0 of \d+ chars/)
    expect(error.message).toMatch(/Capture: before_agent_start/)
    expect(error.message).toMatch(/KNDL_CLAUDE_DEBUG=1/)
  })

  test("checks the custom text once an inherited prompt is swapped out of it", () => {
    const captures = new PromptCaptures()
    const parentPrompt = `${PiPreamble}, a coding agent harness.\n\n<tools>\n- read: Read a file\n</tools>`
    captures.record(
      parentPrompt,
      capture({ contextFiles: [{ path: "/parent/AGENTS.md", content: "parent rules" }] }),
      "agent_start",
    )
    captures.record(
      "child assembled prompt",
      capture({ custom: `child wrapper\n\n${parentPrompt}\n\nchild instructions` }),
      "agent_start",
    )
    const child = resolved(captures, "child assembled prompt")
    expect(child.inherited.length).toBe(1)

    const projected = projectPromptCapture(child, { skillReadTool: "none" }) ?? ""
    expect(projected).not.toContain(PiPreamble)
    expect(projected).toMatch(/child wrapper/)
    expect(projected).toMatch(/parent rules/)
  })

  test("refuses a context file carrying the trigger pair", () => {
    const captures = new PromptCaptures()
    captures.record(
      "context-only prompt",
      capture({
        contextFiles: [
          { path: "/AGENTS.md", content: "see docs/custom-provider.md and docs/packages.md" },
        ],
      }),
      "before_agent_start",
    )
    expect(() =>
      projectPromptCapture(resolved(captures, "context-only prompt"), { skillReadTool: "none" }),
    ).toThrow(/docs\/custom-provider\.md and docs\/packages\.md in the project context block/)
  })

  test("lets either trigger path alone through", () => {
    for (const path of ["docs/custom-provider.md", "docs/packages.md"]) {
      const captures = new PromptCaptures()
      const custom = `see ${path}`
      captures.record("one path", capture({ custom }), "before_agent_start")
      expect(projectPromptCapture(resolved(captures, "one path"), { skillReadTool: "none" })).toBe(
        custom,
      )
    }
  })

  test("lets a mention of pi's preamble mid-line through", () => {
    const captures = new PromptCaptures()
    const custom = `note: ${PiPreamble}, allegedly`
    captures.record("mid-line prompt", capture({ custom }), "before_agent_start")
    expect(
      projectPromptCapture(resolved(captures, "mid-line prompt"), { skillReadTool: "none" }),
    ).toBe(custom)
  })

  test("pins its markers to pi's own rendered system prompt", async () => {
    const { buildSystemPrompt } = await loadPiSystemPrompt()
    const harness = buildSystemPrompt({ cwd: "/tmp" })
    // pi reworded its preamble, or moved the doc paths: update PiPreamble or ThirdPartyTriggers.
    expect(harness).toContain(PiPreamble)
    for (const trigger of ["docs/custom-provider.md", "docs/packages.md"])
      expect(harness).toContain(trigger)
    // A custom prompt replaces the harness whole, which is what makes these strings a leak.
    const custom = buildSystemPrompt({ cwd: "/tmp", customPrompt: "custom" })
    expect(custom).not.toContain(PiPreamble)
    expect(custom).not.toContain("docs/packages.md")
  })
})

describe("project context", () => {
  test("keeps pi's file order, each file labelled with its path", () => {
    const prompt =
      formatProjectContext([
        { path: "/agent/AGENTS.md", content: "global instructions" },
        { path: "/project/CLAUDE.md", content: "parent instructions" },
        { path: "/project/nested/AGENTS.md", content: "nested instructions" },
      ]) ?? ""
    expect(prompt).toMatch(/^<project_context>\n\nProject-specific instructions and guidelines:/)
    expect(prompt.indexOf("global instructions")).toBeLessThan(
      prompt.indexOf("parent instructions"),
    )
    expect(prompt.indexOf("parent instructions")).toBeLessThan(
      prompt.indexOf("nested instructions"),
    )
    expect(prompt).toMatch(/<project_instructions path="\/project\/CLAUDE\.md">/)
  })

  test("is nothing when pi found no context files", () => {
    expect(formatProjectContext([])).toBeUndefined()
  })
})

describe("the skills block", () => {
  test("lists skills, naming pi's read tool as Claude Code knows it", () => {
    const result = renderSkillsBlock([skill("browser")], "mcp") ?? ""
    expect(result.startsWith("The following skills")).toBe(true)
    expect(result).toMatch(/Use the read tool \(mcp__custom-tools__read\)/)
    expect(result).toMatch(/<location>\/skills\/browser\/SKILL\.md<\/location>/)
  })

  test("is nothing without a read tool or a visible skill", () => {
    expect(renderSkillsBlock([skill("browser")], "none")).toBeUndefined()
    expect(renderSkillsBlock([], "mcp")).toBeUndefined()
    expect(renderSkillsBlock([skill("hidden", true)], "mcp")).toBeUndefined()
  })

  test("escapes XML as pi does", () => {
    const escaped = { ...skill("browser"), description: "read <this> & that" }
    expect(renderSkillsBlock([escaped], "mcp")).toMatch(/read &lt;this&gt; &amp; that/)
  })
})
