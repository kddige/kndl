// The signed-in person's own settings: their Claude credential (ADR 0015), which the Sessions they
// start run on. It is pasted once and checked with Anthropic as it is saved; after that it is
// write-only, so the page shows only its kind, its last 4 characters and its plan.

import {
  type ClaudeCredentialInfo,
  type ClaudePlanChoice,
  claudeCredentialKindOf,
  claudeCredentialProblem,
  claudePlanChoices,
  claudePlanLabel,
} from "@claude-hub/protocol"
import * as stylex from "@stylexjs/stylex"
import { type FormEvent, type ReactNode, useState } from "react"
import { useHub, useHubState } from "../app/hub.tsx"
import {
  Banner,
  Button,
  Dialog,
  DialogClose,
  Field,
  Input,
  KeyIcon,
  PageHeader,
  Select,
  Spinner,
  toast,
  WarningIcon,
} from "../ui/index.ts"
import { color, font, leading, radius, space, text, weight } from "../ui/tokens.stylex.ts"

const styles = stylex.create({
  view: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
  scroll: { flex: 1, overflowY: "auto" },
  page: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
    maxWidth: "48rem",
    marginInline: "auto",
    paddingBlock: space.s6,
    paddingInline: space.s4,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
    padding: space.s4,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
  },
  sectionHead: { display: "flex", flexDirection: "column", gap: space.s0_5 },
  sectionTitle: { margin: 0, fontSize: text.md, fontWeight: weight.semibold },
  note: { margin: 0, color: color.textMuted, fontSize: text.sm, lineHeight: leading.snug },
  steps: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    margin: 0,
    paddingInlineStart: space.s5,
    color: color.textMuted,
    fontSize: text.sm,
    lineHeight: leading.snug,
  },
  code: {
    paddingInline: space.s1,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceMuted,
    color: color.text,
    fontFamily: font.mono,
    fontSize: text.sm,
    whiteSpace: "nowrap",
  },
  form: { display: "flex", flexDirection: "column", gap: space.s4 },
  mono: { fontFamily: font.mono },
  facts: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))",
    gap: space.s4,
    margin: 0,
  },
  fact: { display: "flex", flexDirection: "column", gap: space.s0_5, minWidth: 0 },
  term: { color: color.textMuted, fontSize: text.sm },
  detail: { margin: 0, fontSize: text.base, fontWeight: weight.medium },
  actions: { display: "flex", flexWrap: "wrap", gap: space.s2 },
  error: { margin: 0, color: color.dangerSubtleText, fontSize: text.sm, lineHeight: leading.snug },
  loading: { display: "grid", placeItems: "center", paddingBlock: space.s8 },
})

export function AccountView() {
  const you = useHubState((state) => state.you)
  return (
    <main {...stylex.props(styles.view)}>
      <PageHeader
        title="Account"
        description={
          you ? `Signed in as ${you.name} (@${you.login}).` : "Your own settings on this Hub."
        }
      />
      <div {...stylex.props(styles.scroll)}>
        <div {...stylex.props(styles.page)}>
          <ClaudeSection />
        </div>
      </div>
    </main>
  )
}

/** The Claude credential: a form to paste one, or once saved, what it is with Replace and Remove. */
function ClaudeSection() {
  const credential = useHubState((state) => state.claudeCredential)
  const [replacing, setReplacing] = useState(false)
  // Said under a credential saved without Anthropic confirming it, until it is replaced.
  const [warning, setWarning] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)

  return (
    <section aria-labelledby="claude-credential" {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionHead)}>
        <h2 id="claude-credential" {...stylex.props(styles.sectionTitle)}>
          Claude
        </h2>
        <p {...stylex.props(styles.note)}>
          The Sessions you start run on your own Claude account, on whichever Runner they are on.
          Without one, they run on the Runner's own credential, where it has one.
        </p>
      </div>
      {credential === undefined ? (
        <div {...stylex.props(styles.loading)}>
          <Spinner label="Loading your Claude credential" />
        </div>
      ) : credential === null || replacing ? (
        <CredentialForm
          replacing={credential !== null}
          onCancel={() => setReplacing(false)}
          onSaved={(saved) => {
            setWarning(saved ?? null)
            setReplacing(false)
          }}
        />
      ) : (
        <SavedCredential
          credential={credential}
          warning={warning}
          onReplace={() => setReplacing(true)}
          onRemove={() => setRemoving(true)}
        />
      )}
      <RemoveDialog
        open={removing}
        onClose={() => setRemoving(false)}
        onRemoved={() => setWarning(null)}
      />
    </section>
  )
}

function SavedCredential({
  credential,
  warning,
  onReplace,
  onRemove,
}: {
  credential: ClaudeCredentialInfo
  warning: string | null
  onReplace: () => void
  onRemove: () => void
}) {
  return (
    <>
      {warning !== null && (
        <Banner intent="warning" icon={<WarningIcon />} title="Anthropic didn't confirm it">
          {warning}
        </Banner>
      )}
      <dl aria-label="Your Claude credential" {...stylex.props(styles.facts)}>
        <Fact term="Kind">
          {credential.kind === "OAuthToken" ? "Subscription token" : "API key"}
        </Fact>
        <Fact term="Ends in">
          <span {...stylex.props(styles.mono)}>…{credential.last4}</span>
        </Fact>
        <Fact term="Plan">
          {credential.plan !== undefined
            ? claudePlanLabel(credential.plan)
            : credential.kind === "ApiKey"
              ? "Billed per token"
              : "Not given"}
        </Fact>
        <Fact term="Added">{new Date(credential.addedAt).toLocaleDateString()}</Fact>
      </dl>
      <div {...stylex.props(styles.actions)}>
        <Button size="sm" onClick={onReplace}>
          Replace
        </Button>
        <Button size="sm" intent="ghost" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </>
  )
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div {...stylex.props(styles.fact)}>
      <dt {...stylex.props(styles.term)}>{term}</dt>
      <dd {...stylex.props(styles.detail)}>{children}</dd>
    </div>
  )
}

/** Pastes a token or API key, with the plan for a token; the Hub checks it with Anthropic. */
function CredentialForm({
  replacing,
  onCancel,
  onSaved,
}: {
  replacing: boolean
  onCancel: () => void
  /** With the warning when it was saved without Anthropic confirming it. */
  onSaved: (warning: string | undefined) => void
}) {
  const hub = useHub()
  const [secret, setSecret] = useState("")
  const [plan, setPlan] = useState<ClaudePlanChoice | null>(null)
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const kind = claudeCredentialKindOf(secret)
  const chosenPlan = kind === "OAuthToken" ? (plan ?? undefined) : undefined
  const problem = claudeCredentialProblem(secret, chosenPlan)
  const secretProblem = problem !== undefined && !problem.startsWith("Pick") ? problem : undefined
  const planProblem = problem?.startsWith("Pick") ? problem : undefined

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (problem !== undefined) return
    setBusy(true)
    setError(null)
    try {
      const answer = await hub.setClaudeCredential(secret.trim(), chosenPlan)
      setSecret("")
      toast.show({
        title: "Saved your Claude credential",
        ...(answer.warning !== undefined && { intent: "warning" as const }),
      })
      onSaved(answer.warning)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate {...stylex.props(styles.form)}>
      <ol aria-label="How to get a token" {...stylex.props(styles.steps)}>
        <li>
          In a terminal where Claude Code is installed, run{" "}
          <code {...stylex.props(styles.code)}>claude setup-token</code> and sign in with your
          Claude account.
        </li>
        <li>
          Paste the token it prints, which starts with{" "}
          <code {...stylex.props(styles.code)}>sk-ant-oat</code>, and pick your plan. Or paste an
          Anthropic API key, <code {...stylex.props(styles.code)}>sk-ant-api…</code>, billed per
          token.
        </li>
      </ol>
      <Field
        label="Token or API key"
        description="Checked with Anthropic as it is saved. It is stored encrypted and never shown again."
        invalid={touched && secretProblem !== undefined}
        error={touched ? secretProblem : undefined}
      >
        <Input
          type="password"
          value={secret}
          autoComplete="off"
          onValueChange={(next: string) => setSecret(next)}
          placeholder="sk-ant-oat01-…"
          spellCheck={false}
          autoCapitalize="off"
          autoFocus={replacing}
          sx={styles.mono}
        />
      </Field>
      {kind === "OAuthToken" && (
        <Field
          label="Plan"
          description="The plan your Claude account is on, which Claude Code is told."
          invalid={touched && planProblem !== undefined}
          error={touched ? planProblem : undefined}
        >
          <Select
            value={plan}
            placeholder="Pick a plan"
            onValueChange={(next) => setPlan(next)}
            options={claudePlanChoices.map(({ choice, label }) => ({ value: choice, label }))}
          />
        </Field>
      )}
      {error && (
        <p role="alert" {...stylex.props(styles.error)}>
          {error}
        </p>
      )}
      <div {...stylex.props(styles.actions)}>
        <Button intent="primary" type="submit" icon={<KeyIcon />} loading={busy}>
          Save
        </Button>
        {replacing && (
          <Button intent="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}

function RemoveDialog({
  open,
  onClose,
  onRemoved,
}: {
  open: boolean
  onClose: () => void
  onRemoved: () => void
}) {
  const hub = useHub()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await hub.removeClaudeCredential()
      toast.show({ title: "Removed your Claude credential" })
      onRemoved()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      size="sm"
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setError(null)
          onClose()
        }
      }}
      title="Remove your Claude credential?"
      description="Sessions you start from now on run on their Runner's own credential, and don't start on a Runner without one. Sessions already running keep theirs until they next start."
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button intent="danger" loading={busy} onClick={() => void remove()}>
            Remove
          </Button>
        </>
      }
    >
      {error && (
        <p role="alert" {...stylex.props(styles.error)}>
          {error}
        </p>
      )}
    </Dialog>
  )
}
