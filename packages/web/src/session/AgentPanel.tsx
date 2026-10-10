import type { AgentId, SessionSummary } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { useHub } from "../app/hub.tsx"
import type { AgentView } from "../hub/transcript.ts"
import { AgentStatus, ArrowLeftIcon, Button, BranchIcon, EmptyState, toast } from "../ui/index.ts"
import { color, font, space, text, weight } from "../ui/tokens.stylex.ts"
import { Composer, type ComposerCopy } from "./Composer.tsx"
import { useStickToBottom } from "./stickToBottom.ts"
import { AgentMeta, Blocks } from "./Transcript.tsx"

const styles = stylex.create({
  scroll: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    overscrollBehavior: "contain",
  },
  column: {
    width: "100%",
    maxWidth: "48rem",
    marginInline: "auto",
    paddingInline: space.s4,
  },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
    paddingBlock: space.s4,
  },
  back: { alignSelf: "flex-start" },
  heading: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: space.s2,
    margin: 0,
    fontSize: text.md,
    fontWeight: weight.semibold,
  },
  branch: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    fontFamily: font.mono,
    fontSize: text.sm,
    color: color.textMuted,
  },
  dock: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    paddingBottom: space.s4,
    paddingTop: space.s2,
  },
  centered: { display: "grid", placeItems: "center", flex: 1, padding: space.s4 },
})

/** Whether a command went to the Hub; says so if not. */
function sent(ok: boolean): boolean {
  if (!ok) toast.show({ title: "Not connected to the Hub", intent: "warning" })
  return ok
}

/**
 * A subagent's view (ADR 0014): its card full height, and where people message it, which resumes
 * it once it has stopped, or stop it while it runs.
 */
export function AgentPanel({
  session,
  agentId,
  agent,
  onClose,
}: {
  session: SessionSummary
  agentId: AgentId
  /** Undefined if the Session has no such agent. */
  agent: AgentView | undefined
  onClose: () => void
}) {
  const hub = useHub()
  const scroller = useStickToBottom(agent)
  const back = (
    <Button size="sm" intent="ghost" icon={<ArrowLeftIcon />} onClick={onClose} sx={styles.back}>
      Back to the chat
    </Button>
  )
  if (!agent) {
    return (
      <div {...stylex.props(styles.centered)}>
        <EmptyState
          title="No such agent"
          description={`The Session has no agent ${agentId}.`}
          action={back}
        />
      </div>
    )
  }
  const running = agent.status === "Running"
  const copy: ComposerCopy = {
    field: "Message",
    placeholder: running
      ? `Message ${agent.description}`
      : `Message ${agent.description} to resume it`,
    send: running ? "Send message" : "Resume",
    stop: "Stop agent",
  }
  const disabledReason =
    session.state === "Archived"
      ? "Archived: restore it to message agents"
      : session.state === "Frozen"
        ? "Frozen: message the agent once its Runner is back"
        : undefined
  const hint = running
    ? "It reads your message at its next tool call."
    : session.state === "Asleep"
      ? "Asleep: a message wakes the Session and resumes the agent."
      : "A message resumes it where it left off."
  return (
    <>
      <div ref={scroller.ref} onScroll={scroller.onScroll} {...stylex.props(styles.scroll)}>
        <section aria-label="Agent" {...stylex.props(styles.column, styles.body)}>
          {back}
          <h2 {...stylex.props(styles.heading)}>
            {agent.description || agent.agentId}
            <AgentStatus status={agent.status} />
          </h2>
          {agent.worktree && (
            <span {...stylex.props(styles.branch)} title={agent.worktree.path}>
              <BranchIcon />
              {agent.worktree.branch}
            </span>
          )}
          <AgentMeta agent={agent} />
          <Blocks blocks={agent.blocks} ended={agent.status !== "Running"} />
        </section>
      </div>
      <div {...stylex.props(styles.column, styles.dock)}>
        <Composer
          copy={copy}
          running={running}
          onSend={(message) => sent(hub.messageAgent(session.id, agent.agentId, message))}
          onStop={() => sent(hub.stopAgent(session.id, agent.agentId))}
          disabledReason={disabledReason}
          hint={hint}
          cantAttach="Images can't go to a subagent yet: attach them to a prompt."
        />
      </div>
    </>
  )
}
