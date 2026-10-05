// The Child Session tools (ADR 0012): what a Parent Session's model calls to delegate work to full
// Sessions, the one tool a Child Session's model calls to message its parent, and how the mod
// turns a call into a ChildRequest for the Hub and the Hub's ChildReply back into text for the
// model. A Session that isn't itself a Child Session gets `childTools`; a Child Session gets
// `parentTools` instead. The Hub refuses a request from the wrong one as well. hooks/register.ts
// registers and serves them.

import { ChildRequest } from "@claude-hub/protocol"
import type { ChildReply, ChildSummary } from "@claude-hub/protocol"
import { Exit, Schema } from "effect"

/** What `$.tool.register` takes. */
export interface ChildToolSpec {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

/** The prefix Claude Code gives a mod's own tools: `mcp__<plugin>__`. */
export const childToolPrefix = "mcp__hub-link__"

const childId = {
  type: "string",
  description: "The Child Session's id, as create_child or list_children gave it.",
}

const reportsArrive =
  "Its Reports arrive here on their own, as prompts marked as Reports: the final message of each Turn it ends, whoever prompted it."

export const childTools: ReadonlyArray<ChildToolSpec> = [
  {
    name: "create_child",
    description: [
      "Create a Child Session: a full Claude Hub Session, with its own Sandbox, Workspace and Work branch, in this Session's Repo, that works on a task you give it while you go on with yours.",
      "",
      "When to use it: for a piece of work that can run on its own branch and in its own conversation, alongside yours, such as a feature, a fix in another part of the code, or an investigation. Do small or quick work yourself; a Child Session takes a while to start, and coordinating one has a cost.",
      "",
      "- Brief it fully: it starts with none of your conversation. Say what to do, what done looks like, and what you already know (files, branches, decisions, constraints).",
      "- It starts from the Repo's default branch unless you name a base, such as your own Work branch once you have pushed it.",
      `- ${reportsArrive} Don't poll it with list_children or read_child; wait for its Reports. If you have nothing else to do, end your Turn: a Report wakes this Session.`,
      "- Never say or imply what a Child Session found or did before its Report has arrived.",
      "- The people in this Session don't see Reports: relay what matters to them.",
      "- A Child Session can't create Child Sessions of its own.",
      "",
      "Returns the Child Session's id and name. Use the id with message_child, read_child and archive_child.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "The task, a complete brief: it becomes the Child Session's first prompt, marked as from you.",
        },
        name: {
          type: "string",
          description:
            'A short name for it, shown to people in the web UI, such as "API docs". Without one it is shown by its Work branch.',
        },
        base: {
          type: "string",
          description: "The branch it starts from. The Repo's default branch when left out.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: "message_child",
    description: [
      "Send a message to one of your Child Sessions: it is queued there as a prompt, marked as from you, and runs once the child is idle, waking it if it is Asleep.",
      "",
      "Use it to answer a child's question, correct its course, or give it the next piece of work. People may prompt your children too.",
      "",
      `${reportsArrive} Its answer to this message comes the same way, when that Turn ends; don't claim what it will say before it does.`,
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        child_id: childId,
        message: { type: "string", description: "What to tell it." },
      },
      required: ["child_id", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "list_children",
    description: [
      "List your Child Sessions that aren't archived: each one's id, name, state, whether it is working, how many messages wait in its queue, and its last Report.",
      "",
      "Reports come to you on their own, so you rarely need this: use it to recall your children, or to check on one that has gone quiet.",
    ].join("\n"),
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_child",
    description: [
      "Read one of your Child Sessions: its status and its recent conversation (prompts, its text, tool calls by name, and state changes; the latest part when it is long).",
      "",
      "Use it when a Report doesn't tell you enough about what the child did. It shows what has happened so far, not a result still to come.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: { child_id: childId },
      required: ["child_id"],
      additionalProperties: false,
    },
  },
  {
    name: "archive_child",
    description: [
      "Archive one of your Child Sessions once its work is done or no longer wanted: it stops for good and takes no more messages. Its Work branch stays, and a person can restore it from the web UI.",
      "",
      "Only your own Child Sessions. Archiving this Session archives all of them.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: { child_id: childId },
      required: ["child_id"],
      additionalProperties: false,
    },
  },
]

/** The tools a Child Session gets in place of {@link childTools}: one, to message its parent. */
export const parentTools: ReadonlyArray<ChildToolSpec> = [
  {
    name: "message_parent",
    description: [
      "Send your Parent Session a message now, while you keep working: it is queued there as a prompt, marked as a message from you and not a Report, and wakes your Parent Session if it is Asleep.",
      "",
      "When to use it: for something your Parent Session should know before this Turn ends, such as a question it can answer while you go on with another part of the task, a decision that changes its plans, or a progress note on long work. Use it sparingly.",
      "",
      "When not to:",
      "- To say what you did or found once you're done, end your Turn: your final message reaches your Parent Session as a Report on its own. Don't send it twice.",
      "- If you can't go on without an answer, end your Turn with the question instead: its answer comes as your next prompt.",
      "",
      "Any answer reaches you as a prompt marked as from your Parent Session once this Turn ends, not during it.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description:
            "What to tell your Parent Session. It doesn't see your conversation: say enough to be understood on its own.",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
]

const decodeRequest = Schema.decodeUnknownExit(ChildRequest)

const text = (value: unknown) => (typeof value === "string" ? value : undefined)

/**
 * A call to one of the Child Session tools as the Hub's request; `undefined` when `tool` isn't
 * one of them, and `{ invalid }` when its input doesn't make a request.
 */
export const childToolRequest = (
  tool: string,
  input: Readonly<Record<string, unknown>>,
): ChildRequest | { readonly invalid: string } | undefined => {
  if (!tool.startsWith(childToolPrefix)) return undefined
  const name = tool.slice(childToolPrefix.length)
  const request = (() => {
    switch (name) {
      case "create_child":
        return {
          _tag: "CreateChild",
          prompt: text(input["task"]),
          ...(input["name"] === undefined ? {} : { name: text(input["name"])?.trim() }),
          ...(input["base"] === undefined ? {} : { baseBranch: text(input["base"])?.trim() }),
        }
      case "message_child":
        return { _tag: "MessageChild", childId: input["child_id"], text: input["message"] }
      case "list_children":
        return { _tag: "ListChildren" }
      case "read_child":
        return { _tag: "ReadChild", childId: input["child_id"] }
      case "archive_child":
        return { _tag: "ArchiveChild", childId: input["child_id"] }
      case "message_parent":
        return { _tag: "MessageParent", text: input["message"] }
      default:
        return undefined
    }
  })()
  if (request === undefined) return { invalid: `${tool} is not a Child Session tool.` }
  const decoded = decodeRequest(request)
  if (Exit.isFailure(decoded)) {
    return { invalid: `${name} was called with input it can't take: ${String(decoded.cause)}` }
  }
  return decoded.value
}

const summaryLine = (child: ChildSummary) => {
  const doing = child.state === "Archived" ? "" : child.working ? ", working" : ", idle"
  const queued = child.queued === 0 ? "" : `, ${child.queued} queued`
  return `"${child.title}" (id ${child.id}): ${child.state}${doing}${queued}; Work branch ${child.workBranch}, from ${child.baseBranch}`
}

/** The longest last Report list_children shows of each child, in characters. */
export const MaxListedReport = 1_000

const lastReport = (child: ChildSummary) => {
  if (child.lastReport === undefined) return "No Report yet."
  const report = child.lastReport.text
  const shown =
    report.length > MaxListedReport ? `${report.slice(0, MaxListedReport)}… (cut)` : report
  return `Last Report, ${new Date(child.lastReport.at).toISOString()}:\n${shown}`
}

const indent = (block: string) =>
  block
    .split("\n")
    .map((line) => (line === "" ? line : `  ${line}`))
    .join("\n")

/**
 * The Hub's reply, as the model reads it: `{ text }` for a tool result, `{ refused }` for an error
 * result.
 */
export const childReplyText = (
  reply: ChildReply,
): { readonly text: string } | { readonly refused: string } => {
  switch (reply._tag) {
    case "ChildCreated":
      return {
        text: `Created Child Session ${summaryLine(reply.child)}.\nIt is starting, with your task queued as its first prompt. ${reportsArrive}`,
      }
    case "ChildMessaged":
      return {
        text: `Queued your message for Child Session ${summaryLine(reply.child)}.\n${
          reply.child.working
            ? "It reads it once its current Turn ends."
            : "It reads it as soon as it is ready."
        } Its answer arrives here as a Report.`,
      }
    case "ChildList":
      return {
        text:
          reply.children.length === 0
            ? "You have no Child Sessions that aren't archived."
            : reply.children
                .map((child) => `- ${summaryLine(child)}\n${indent(lastReport(child))}`)
                .join("\n\n"),
      }
    case "ChildRead":
      return {
        text: `Child Session ${summaryLine(reply.child)}\n\nIts recent conversation:\n\n${reply.conversation}`,
      }
    case "ChildArchived":
      return { text: `Archived Child Session ${summaryLine(reply.child)}.` }
    case "ParentMessaged":
      return {
        text: `Queued your message for your Parent Session "${reply.parent.title}" (id ${reply.parent.id}). ${
          reply.working
            ? "It reads it once its current Turn ends."
            : "It reads it as soon as it is ready."
        } Any answer reaches you as a prompt after this Turn ends, and your Report still goes to it then.`,
      }
    case "ChildRefused":
      return { refused: reply.message }
  }
}
