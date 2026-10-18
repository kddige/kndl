// What pi assembled into each system prompt, kept so Claude Code gets only its portable parts
// (the project context, skills, custom prompt, appended instructions and custom sections, kndl's
// own among them), appended to Claude Code's own preset. pi's own harness text never goes: a
// request carrying it reads to Anthropic as a third-party app, refused or billed as Extra Usage.
//
// Ported from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent"
import type { Skill } from "@earendil-works/pi-coding-agent"
import { McpServerName } from "./Names.ts"

export interface ContextFile {
  readonly path: string
  readonly content: string
}

/** pi's context files, as pi lists them for the model, in its order. */
export function formatProjectContext(contextFiles: ReadonlyArray<ContextFile>): string | undefined {
  if (contextFiles.length === 0) return undefined
  let prompt = "<project_context>\n\nProject-specific instructions and guidelines:\n\n"
  for (const { path, content } of contextFiles) {
    prompt += `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`
  }
  return `${prompt}</project_context>`
}

/** How the model reads a skill's file: pi's read tool over MCP, or not at all. */
export type SkillReadTool = "mcp" | "none"

export function renderSkillsBlock(
  skills: ReadonlyArray<Skill>,
  readTool: SkillReadTool,
): string | undefined {
  if (readTool === "none" || skills.length === 0) return undefined
  const block = formatSkillsForPrompt([...skills]).trim()
  if (!block) return undefined
  return rewriteSkillsBlock(block)
}

/** The skills block, naming pi's read tool as Claude Code knows it. */
export function rewriteSkillsBlock(skillsBlock: string): string {
  return skillsBlock.replace(
    "Use the read tool to load a skill's file",
    `Use the read tool (mcp__${McpServerName}__read) to load a skill's file`,
  )
}

export interface PromptCaptureInput {
  readonly custom?: string | undefined
  readonly append?: string | undefined
  readonly contextFiles: ReadonlyArray<ContextFile>
  readonly skills: ReadonlyArray<Skill>
  /**
   * Custom sections from `systemPromptOptions.sections`, by name: pi renders each as
   * `<name>\ncontent\n</name>` after the built-in ones, and so does the projection.
   */
  readonly sections?: Readonly<Record<string, string>> | undefined
}

interface InheritedPrompt {
  readonly start: number
  readonly end: number
  readonly parent: PromptCapture
}

export interface PromptCapture {
  custom?: string | undefined
  append?: string | undefined
  contextFiles: Array<ContextFile>
  skills: Array<Skill>
  sections?: Record<string, string> | undefined
  readonly assembledPrompt: string
  /** Which boundary last recorded it (before_agent_start, agent_start, turn_start). */
  source?: string | undefined
  /** Prompts captured before, embedded whole in `custom`. */
  inherited: Array<InheritedPrompt>
}

/** A prompt that matched nothing, for the debug log. */
export interface PromptCaptureDiagnostic {
  readonly systemPrompt: string
  readonly matches: ReadonlyArray<{
    readonly key: string
    readonly firstDivergent: number
    readonly source?: string | undefined
  }>
}

/**
 * Captures, keyed by the whole prompt pi sends a provider. A subagent's prompt override embeds its
 * parent's assembled prompt whole; linking exact earlier keys recovers that inheritance.
 */
export class PromptCaptures {
  private readonly captures = new Map<string, PromptCapture>()

  /**
   * Keeps only recent keys (pi rebuilds the prompt when tools change), far more than any working
   * set: a capture is tens of KB, and evicting a live one fails its turn.
   */
  constructor(
    private readonly limit = 256,
    private readonly onDiagnose: (diagnostic: PromptCaptureDiagnostic) => void = () => {},
  ) {}

  record(systemPrompt: string, input: PromptCaptureInput, source?: string): void {
    const existing = this.captures.get(systemPrompt)
    const customChanged = existing?.custom !== input.custom
    const capture: PromptCapture = existing ?? {
      assembledPrompt: systemPrompt,
      contextFiles: [],
      skills: [],
      inherited: [],
    }

    capture.custom = input.custom
    capture.append = input.append
    capture.contextFiles = input.contextFiles.map((file) => ({ ...file }))
    capture.skills = [...input.skills]
    // Copied: the caller's systemPromptOptions is live, and later handlers change it.
    capture.sections = { ...input.sections }
    capture.source = source
    if (!existing || customChanged) {
      capture.inherited = this.findInheritedPrompts(systemPrompt, input.custom)
    }
    // In place, so descendants keep a live reference, and re-keyed so the map's order is recency.
    this.touch(systemPrompt, capture)
  }

  /** Exact lookup only; a query wants `resolveOrDerive`. */
  resolve(systemPrompt?: string): PromptCapture | undefined {
    if (!systemPrompt) return undefined
    const capture = this.captures.get(systemPrompt)
    if (capture) this.touch(systemPrompt, capture)
    return capture
  }

  /** Recency by use too: a parent records its prompt once and then only resolves it. */
  private touch(systemPrompt: string, capture: PromptCapture): void {
    this.captures.delete(systemPrompt)
    this.captures.set(systemPrompt, capture)
    for (const key of this.captures.keys()) {
      if (this.captures.size <= this.limit) break
      this.captures.delete(key)
    }
  }

  /**
   * The capture to project for a query. An exact key is the usual case. A prompt that embeds known
   * prompts (something wrapped what pi assembled after it was recorded) resolves to a transient
   * capture over the whole prompt, so each embedded one is swapped for its portable parts and the
   * text around them carried as it is.
   *
   * Throws when neither accounts for the prompt: Claude Code would otherwise get a turn with none
   * of the context files, skills or instructions. A failed turn is recoverable; one that quietly
   * ignored its instructions isn't.
   */
  resolveOrDerive(systemPrompt?: string): PromptCapture | undefined {
    if (!systemPrompt) return undefined
    const exact = this.captures.get(systemPrompt)
    if (exact) {
      this.touch(systemPrompt, exact)
      return exact
    }

    // A capture outlives its key: inheritance edges keep an evicted one alive.
    const revived = this.reachableCaptures().find((node) => node.assembledPrompt === systemPrompt)
    if (revived) {
      this.touch(systemPrompt, revived)
      return revived
    }

    // Inheritance comes before any looser match: one that adopts a capture whose parts all
    // appear here would take the parent's for a subagent's, dropping the subagent's own text.
    const embedded = this.findInheritedPrompts(systemPrompt, systemPrompt)
    if (embedded.length === 0) {
      const matches = this.closestKnown(systemPrompt)
      this.onDiagnose({ systemPrompt, matches })
      // A recorded key less its tail: an extension-triggered idle turn (sendMessage with
      // triggerTurn) skips before_agent_start, so the prompt lacks that turn's additions (pi#5581).
      const truncated = matches.find(
        (m) => m.firstDivergent === systemPrompt.length && m.key.length > systemPrompt.length,
      )
      if (truncated) {
        throw new Error(
          `prompt-capture: this ${systemPrompt.length}-char prompt is the ${truncated.key.length}-char capture recorded at ` +
            `${truncated.source ?? "an unknown boundary"} with its final ${truncated.key.length - systemPrompt.length} chars missing. ` +
            `That shape matches pi#5581: an extension-triggered idle turn (sendMessage with triggerTurn) skips before_agent_start, ` +
            `so the prompt lacks that turn's extension additions. The turn fails; the next user-typed turn resolves normally.`,
        )
      }
      const closest = matches[0]
      throw new Error(
        `prompt-capture: no capture for this ${systemPrompt.length}-char system prompt, and it embeds none of the ${this.captures.size} known. ` +
          `Closest known match diverges at offset ${closest?.firstDivergent ?? "?"} ` +
          `(${closest ? closest.key.length : 0}-char key${closest?.source ? `, last recorded at ${closest.source}` : ""}). ` +
          `Claude Code would receive none of this turn's context files, skills or custom instructions. ` +
          `An extension rewrote the system prompt from before_agent_start, or pi rebuilt the prompt outside it.`,
      )
    }

    // `custom` is the prompt itself, and the edges keep their offsets, so projectCustom swaps the
    // embedded captures in place and keeps every byte around them.
    return {
      assembledPrompt: systemPrompt,
      custom: systemPrompt,
      contextFiles: [],
      skills: [],
      inherited: embedded,
    }
  }

  get size(): number {
    return this.captures.size
  }

  /** The longest shared-prefix matches, best first. */
  private closestKnown(
    systemPrompt: string,
  ): Array<{ key: string; firstDivergent: number; source?: string | undefined }> {
    let shared = 0
    const matches: Array<{ key: string; firstDivergent: number; source?: string | undefined }> = []
    for (const [key, capture] of this.captures.entries()) {
      const limit = Math.min(key.length, systemPrompt.length)
      let i = 0
      while (i < limit && key.charCodeAt(i) === systemPrompt.charCodeAt(i)) i++
      if (i >= shared) {
        if (i > shared) {
          shared = i
          matches.length = 0
        }
        matches.push({ key, firstDivergent: i, source: capture.source })
      }
    }
    return matches
  }

  private findInheritedPrompts(systemPrompt: string, custom?: string): Array<InheritedPrompt> {
    if (!custom) return []

    const candidates: Array<InheritedPrompt & { length: number }> = []
    for (const parent of this.reachableCaptures()) {
      const key = parent.assembledPrompt
      if (key === systemPrompt || key.length === 0) continue
      for (
        let start = custom.indexOf(key);
        start !== -1;
        start = custom.indexOf(key, start + key.length)
      ) {
        candidates.push({ start, end: start + key.length, length: key.length, parent })
      }
    }

    // A grandchild holds its parent's key and its grandparent's inside it: keep the longest
    // non-overlapping matches.
    const selected: Array<InheritedPrompt> = []
    for (const candidate of candidates.toSorted(
      (a, b) => b.length - a.length || a.start - b.start,
    )) {
      if (selected.some((edge) => candidate.start < edge.end && candidate.end > edge.start))
        continue
      selected.push({ start: candidate.start, end: candidate.end, parent: candidate.parent })
    }
    return selected.toSorted((a, b) => a.start - b.start)
  }

  private reachableCaptures(): Array<PromptCapture> {
    const result: Array<PromptCapture> = []
    const seen = new Set<PromptCapture>()
    const visit = (capture: PromptCapture): void => {
      if (seen.has(capture)) return
      seen.add(capture)
      result.push(capture)
      for (const edge of capture.inherited) visit(edge.parent)
    }
    for (const capture of this.captures.values()) visit(capture)
    return result
  }
}

/**
 * pi's own preamble, the first section of every prompt pi renders without a custom prompt.
 * Forwarding it makes Claude Code's subscription path read the request as a third-party app.
 */
export const PiPreamble = "You are an expert coding assistant operating inside pi"

/** Both doc paths of pi's documentation line: Anthropic's subscription gate refuses the pair. */
const ThirdPartyTriggers = ["docs/custom-provider.md", "docs/packages.md"]

/** One piece of the append, named so a refusal can say where it found the text. */
interface PromptPart {
  readonly label: string
  readonly text: string
}

let sharedCaptures: PromptCaptures | undefined

/**
 * The process's captures: one, which every pi session's prompts reach, a subagent's too, as the
 * bridge follows its session through this module (followClaudeSession). The first caller's
 * onDiagnose wins.
 */
export function sharedPromptCaptures(
  onDiagnose?: (diagnostic: PromptCaptureDiagnostic) => void,
): PromptCaptures {
  sharedCaptures ??= new PromptCaptures(256, onDiagnose)
  return sharedCaptures
}

export function projectPromptCapture(
  capture: PromptCapture,
  options: { readonly skillReadTool: SkillReadTool },
): string | undefined {
  return projectCapture(capture, options, new Set())
}

/** The skills visible through inherited prompts, ancestors first, each file once. */
export function collectPromptSkills(capture: PromptCapture): Array<Skill> {
  const result: Array<Skill> = []
  const seenPaths = new Set<string>()
  const visited = new Set<PromptCapture>()
  const visiting = new Set<PromptCapture>()

  const visit = (node: PromptCapture): void => {
    if (visited.has(node)) return
    if (visiting.has(node)) throw new Error("Cyclic prompt inheritance")
    visiting.add(node)
    for (const edge of node.inherited) visit(edge.parent)
    for (const skill of node.skills) {
      if (skill.disableModelInvocation || seenPaths.has(skill.filePath)) continue
      seenPaths.add(skill.filePath)
      result.push(skill)
    }
    visiting.delete(node)
    visited.add(node)
  }

  visit(capture)
  return result
}

function projectCapture(
  capture: PromptCapture,
  options: { readonly skillReadTool: SkillReadTool },
  visiting: Set<PromptCapture>,
): string | undefined {
  if (visiting.has(capture)) throw new Error("Cyclic prompt inheritance")
  visiting.add(capture)
  try {
    const inheritedSkillPaths = new Set(
      capture.inherited.flatMap((edge) =>
        collectPromptSkills(edge.parent).map((skill) => skill.filePath),
      ),
    )
    const ownSkillPaths = new Set<string>()
    const ownSkills = capture.skills.filter((skill) => {
      if (
        skill.disableModelInvocation ||
        inheritedSkillPaths.has(skill.filePath) ||
        ownSkillPaths.has(skill.filePath)
      )
        return false
      ownSkillPaths.add(skill.filePath)
      return true
    })

    const custom = projectCustom(capture, options, visiting)
    const parts: Array<PromptPart> = []
    const context = formatProjectContext(capture.contextFiles)
    if (context) parts.push({ label: "the project context block", text: context })
    const skills = renderSkillsBlock(ownSkills, options.skillReadTool)
    if (skills) parts.push({ label: "the skills block", text: skills })
    if (custom) parts.push({ label: "the custom prompt", text: custom })
    if (capture.append) parts.push({ label: "the appended instructions", text: capture.append })
    // pi renders custom sections last, after `cwd`, which has nothing portable.
    for (const [name, content] of Object.entries(capture.sections ?? {})) {
      if (!content) continue
      parts.push({ label: `the ${name} section`, text: `<${name}>\n${content}\n</${name}>` })
    }
    assertSendablePrompt(parts, capture)
    return parts.length > 0 ? parts.map((part) => part.text).join("\n\n") : undefined
  } finally {
    visiting.delete(capture)
  }
}

/**
 * Refuses an append that carries pi's harness, or the phrase pair Anthropic's subscription gate
 * refuses: Claude Code's request would fail with 400 or bill as Extra Usage.
 */
function assertSendablePrompt(parts: ReadonlyArray<PromptPart>, capture: PromptCapture): void {
  const findings: Array<string> = []
  for (const { label, text } of parts) {
    const offset = preambleAtLineStart(text)
    if (offset !== -1) {
      findings.push(
        `pi's preamble ("${PiPreamble}") in ${label}, at offset ${offset} of ${text.length} chars`,
      )
    }
    // Only a pair in one part is found; split across parts, it isn't.
    if (ThirdPartyTriggers.every((trigger) => text.includes(trigger))) {
      findings.push(`${ThirdPartyTriggers.join(" and ")} in ${label}`)
    }
  }
  if (findings.length === 0) return

  throw new Error(
    [
      "prompt-capture: refusing to send this prompt. Claude Code's Anthropic path reads a request",
      "  carrying pi's harness, or the phrase pair its subscription gate rejects, as a third-party",
      "  app: it fails with 400 or is billed as extra usage.",
      ...findings.map((finding) => `  Found: ${finding}.`),
      `  Capture: ${capture.source ?? "unknown"}, ${capture.inherited.length} inherited capture(s) substituted.`,
      "  If it is your own text, reword or remove it. KNDL_CLAUDE_DEBUG=1 writes the full prompt to",
      "  the bridge's log.",
    ].join("\n"),
  )
}

/** The offset of pi's preamble at the start of a line, or -1: mid-line, it's a mention of it. */
function preambleAtLineStart(text: string): number {
  for (
    let offset = text.indexOf(PiPreamble);
    offset !== -1;
    offset = text.indexOf(PiPreamble, offset + PiPreamble.length)
  ) {
    if (offset === 0 || text[offset - 1] === "\n") return offset
  }
  return -1
}

function projectCustom(
  capture: PromptCapture,
  options: { readonly skillReadTool: SkillReadTool },
  visiting: Set<PromptCapture>,
): string | undefined {
  if (!capture.custom || capture.inherited.length === 0) return capture.custom

  let result = ""
  let cursor = 0
  for (const edge of capture.inherited) {
    result += capture.custom.slice(cursor, edge.start)
    result += projectCapture(edge.parent, options, visiting) ?? ""
    cursor = edge.end
  }
  return result + capture.custom.slice(cursor)
}
