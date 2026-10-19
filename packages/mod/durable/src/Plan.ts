// The Plan (docs/design/durable-harness.md): a checklist the agent keeps with `update_plan`, in
// each conversation's `kndl.plan` document, which everyone sees live (PlanChanged). It is
// rewindable and forked as of the fork's entry, so a thread starts with the Plan the main loop had
// where it was forked, and goes on with its own.
//
// The Plan is in the system prompt, as a section, rather than only in the tool's result: a
// section's change is sent as an appended update, which keeps the prompt cache, and it outlives
// compaction and the agent's handoff to itself, where an old tool result would be summarized away.
// So the tool's result only confirms.

import { Type } from "@earendil-works/pi-ai"
import { defineTool, section } from "@earendil-works/pi-durable"
import type { ConversationId, PromptSection } from "@earendil-works/pi-durable"
import { PlanDoc } from "./Docs.ts"
import type { PlanState } from "./Docs.ts"
import { loopFields } from "./Loops.ts"
import type { Runtime } from "./Runtime.ts"

export const planTool = "update_plan"

const marks = { pending: "[ ]", in_progress: "[~]", done: "[x]" } as const

/** The Plan as the model reads it; undefined for an empty one. */
export const planText = (plan: Readonly<PlanState> | undefined): string | undefined => {
  if (plan === undefined || plan.steps.length === 0) return undefined
  return [
    `Your plan, as everyone in the session sees it. Keep it current with ${planTool} as you work: mark a step in progress when you start it and done when it is.`,
    ...plan.steps.map((step) => `${marks[step.status]} ${step.text}`),
    ...(plan.explanation === undefined ? [] : [`(${plan.explanation})`]),
  ].join("\n")
}

/** The Plan, in the system prompt while it has steps. */
export const planSection = (): PromptSection =>
  section("plan", async (input, context) =>
    planText(await input.read.snapshot(PlanDoc, input.conversationId, context)),
  )

/** The Plan as the Hub carries it. */
export const planEvent = (plan: Readonly<PlanState>) => ({
  steps: plan.steps.map((step) => ({ text: step.text, status: step.status })),
  ...(plan.explanation === undefined ? {} : { explanation: plan.explanation }),
})

/** Tells the Hub of a conversation's Plan. */
export const reportPlan = (runtime: Runtime, conversationId: ConversationId, plan: Readonly<PlanState>) => {
  const loop = runtime.loops.loopOf(conversationId)
  if (loop === undefined || (loop.kind === "agent" && !loop.reported)) return
  runtime.report({ _tag: "PlanChanged", ...loopFields(loop), plan: planEvent(plan) })
}

const stepStatus = Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done")])

/** The tool: the whole Plan each time, as it is now. Replay-safe: it writes the same Plan again. */
export const planToolDefinition = (runtime: Runtime) =>
  defineTool({
    name: planTool,
    description: [
      "Sets your plan for the task: its steps, each pending, in_progress or done. Everyone in the session sees it live, and it stays in your context, also after it is summarized.",
      "Use it for work of three or more steps: write the plan before you start, keep exactly one step in_progress while you work, and mark each done as soon as it is. Send the whole plan each time; an empty list clears it. Skip it for quick, single-step requests.",
    ].join(" "),
    parameters: Type.Object({
      steps: Type.Array(
        Type.Object({
          text: Type.String({ description: "What the step is, in a few words." }),
          status: stepStatus,
        }),
        { description: "Every step, in order." },
      ),
      explanation: Type.Optional(
        Type.String({ description: "What changed, or why, in a sentence; optional." }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const plan: PlanState = {
        steps: args.steps.map((step) => ({ text: step.text.trim(), status: step.status })),
        ...(args.explanation === undefined || args.explanation.trim() === ""
          ? {}
          : { explanation: args.explanation.trim() }),
      }
      await api.commit(async (tx) => {
        const doc = await tx.doc(PlanDoc, api.conversationId)
        doc.steps = plan.steps
        if (plan.explanation === undefined) delete doc.explanation
        else doc.explanation = plan.explanation
      }, context)
      reportPlan(runtime, api.conversationId, plan)
      const done = plan.steps.filter((step) => step.status === "done").length
      return {
        output: [
          {
            type: "text",
            text:
              plan.steps.length === 0
                ? "Cleared the plan."
                : `Updated the plan: ${plan.steps.length} steps, ${done} done.`,
          },
        ],
      }
    },
  })
