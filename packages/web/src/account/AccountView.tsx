// The signed-in person's own settings: their Providers (Providers.tsx), first among them their
// Claude credential, a setup token (ADR 0015, ADR 0026), the Connected provider for Anthropic, which
// the Sessions they start run Claude on and which only they drive. It is pasted once and checked
// with Anthropic as it is saved; after that it is write-only, so the page shows only its last 4
// characters and when it was added. And their CLI tokens (issue #179): a machine each that
// `kndl login` signed in, to revoke.

import {
  type ClaudeCredentialInfo,
  claudeCredentialProblem,
  type CliTokenInfo,
  type Harness,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { type FormEvent, useState } from "react"
import { copyCommand } from "../app/copy.ts"
import { day, timeAgo } from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import {
  Banner,
  Button,
  CopyIcon,
  Dialog,
  DialogClose,
  Field,
  IconButton,
  Input,
  KeyIcon,
  PageHeader,
  SegmentedControl,
  ServerIcon,
  Spinner,
  toast,
  WarningIcon,
} from "../ui/index.ts"
import { color, font, leading, radius, space, text, weight } from "../ui/tokens.stylex.ts"
import { Fact } from "./Fact.tsx"
import { ProvidersSection } from "./Providers.tsx"

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
  actions: { display: "flex", flexWrap: "wrap", gap: space.s2 },
  // Which Harness runs Claude's Models (ADR 0030), set apart from the token above it.
  choice: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    paddingTop: space.s4,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  choiceLabel: { fontSize: text.base, fontWeight: weight.medium },
  error: { margin: 0, color: color.dangerSubtleText, fontSize: text.sm, lineHeight: leading.snug },
  loading: { display: "grid", placeItems: "center", paddingBlock: space.s8 },
  tokens: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    listStyle: "none",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.md,
  },
  token: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    paddingBlock: space.s2_5,
    paddingInline: space.s3,
    borderTopWidth: { default: "1px", ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  tokenIcon: { flexShrink: 0, display: "flex", color: color.textMuted },
  tokenText: { display: "flex", flexDirection: "column", gap: space.s0_5, flex: 1, minWidth: 0 },
  machine: {
    fontFamily: font.mono,
    fontSize: text.base,
    fontWeight: weight.medium,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  tokenMeta: { color: color.textMuted, fontSize: text.sm, lineHeight: leading.snug },
  tokenAction: { flexShrink: 0 },
  commandRow: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    paddingBlock: space.s1,
    paddingInlineStart: space.s3,
    paddingInlineEnd: space.s1,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.md,
    backgroundColor: color.surfaceMuted,
  },
  commandText: {
    flex: 1,
    minWidth: 0,
    fontFamily: font.mono,
    fontSize: text.sm,
    lineHeight: leading.snug,
    overflowWrap: "anywhere",
    userSelect: "all",
  },
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
          <ProvidersSection claude={<ClaudeSection />} />
          <CliTokensSection />
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
        <h3 id="claude-credential" {...stylex.props(styles.sectionTitle)}>
          Anthropic
        </h3>
        <p {...stylex.props(styles.note)}>
          Your Claude subscription, through a setup token. The Sessions you start run Claude's
          Models on it, on any Runner. Without one, Claude's Models aren't yours to pick, and Claude
          Code Sessions can't start.
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
        <>
          <SavedCredential
            credential={credential}
            warning={warning}
            onReplace={() => setReplacing(true)}
            onRemove={() => setRemoving(true)}
          />
          <ClaudeHarnessChoice />
        </>
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
        <Fact term="Kind">Setup token</Fact>
        <Fact term="Ends in">
          <span {...stylex.props(styles.mono)}>…{credential.last4}</span>
        </Fact>
        <Fact term="Connected">{day(credential.addedAt)}</Fact>
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

/**
 * Which Harness runs Claude's Models in the person's new Sessions (ADR 0030): Claude Code, the
 * default, or pi. Set as it is chosen; the Model picker can still choose the other.
 */
function ClaudeHarnessChoice() {
  const hub = useHub()
  const saved = useHubState((state) => state.providers?.claudeHarness)
  // Shown as chosen until the Hub answers; a refusal shows what is saved again.
  const [choosing, setChoosing] = useState<Harness | null>(null)
  if (saved === undefined) return null
  const choose = (harness: Harness) => {
    setChoosing(harness)
    hub.setClaudeHarness(harness).then(
      () => setChoosing(null),
      (cause: unknown) => {
        setChoosing(null)
        toast.show({
          title: "Couldn't change what runs Claude's Models",
          description: cause instanceof Error ? cause.message : String(cause),
          intent: "warning",
        })
      },
    )
  }
  return (
    <div {...stylex.props(styles.choice)}>
      {/* Shown, and the control's own name. */}
      <span aria-hidden="true" {...stylex.props(styles.choiceLabel)}>
        Run Claude's Models with
      </span>
      <SegmentedControl
        label="Run Claude's Models with"
        options={[
          { value: "ClaudeCode", label: "Claude Code" },
          { value: "Pi", label: "pi" },
        ]}
        value={choosing ?? saved}
        onValueChange={choose}
      />
      <p {...stylex.props(styles.note)}>
        Claude Code: Claude's own tools, on your plan's limits. pi: the same tools and Subagents as
        your other Providers. New Sessions start on it; the Model picker can switch.
      </p>
    </div>
  )
}

/** Pastes a setup token; the Hub checks it with Anthropic. API keys aren't taken for now (#334). */
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
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const problem = claudeCredentialProblem(secret)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (problem !== undefined) return
    setBusy(true)
    setError(null)
    try {
      const answer = await hub.setClaudeCredential(secret.trim())
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
          <code {...stylex.props(styles.code)}>sk-ant-oat</code>. It lasts a year.
        </li>
      </ol>
      <Field
        label="Setup token"
        description={
          replacing
            ? "Checked with Anthropic as it is saved, stored encrypted and never shown again. Your Sessions that are awake go to sleep, and wake on the new one."
            : "Checked with Anthropic as it is saved. It is stored encrypted and never shown again."
        }
        invalid={touched && problem !== undefined}
        error={touched ? problem : undefined}
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
      description="Your Sessions that are awake go to sleep, and none of them can start or wake until you add a setup token again."
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

/** The machines `kndl login` signed in as this person, newest first, to revoke. */
function CliTokensSection() {
  const tokens = useHubState((state) => state.cliTokens)
  const [revoking, setRevoking] = useState<CliTokenInfo | null>(null)
  const command = `kndl login ${window.location.origin}`

  return (
    <section aria-labelledby="cli-tokens" {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionHead)}>
        <h2 id="cli-tokens" {...stylex.props(styles.sectionTitle)}>
          CLI tokens
        </h2>
        <p {...stylex.props(styles.note)}>
          Each machine where you signed the kndl CLI in to this Hub, to act as you. Revoking one
          signs that machine out at once.
        </p>
      </div>
      {tokens === null ? (
        <div {...stylex.props(styles.loading)}>
          <Spinner label="Loading your CLI tokens" />
        </div>
      ) : tokens.length === 0 ? (
        <p {...stylex.props(styles.note)}>
          None yet. To sign the CLI in on a machine, run this there and approve it in the browser:
        </p>
      ) : (
        <ul aria-label="Your CLI tokens" {...stylex.props(styles.tokens)}>
          {tokens.map((token) => (
            <li key={token.id} {...stylex.props(styles.token)}>
              <span aria-hidden {...stylex.props(styles.tokenIcon)}>
                <ServerIcon />
              </span>
              <div {...stylex.props(styles.tokenText)}>
                <span title={token.machine} {...stylex.props(styles.machine)}>
                  {token.machine}
                </span>
                <span {...stylex.props(styles.tokenMeta)}>
                  Signed in {day(token.createdAt)} ·{" "}
                  {token.lastUsedAt === undefined
                    ? "never used"
                    : `last used ${timeAgo(token.lastUsedAt)}`}
                </span>
              </div>
              <Button
                size="sm"
                intent="ghost"
                onClick={() => setRevoking(token)}
                sx={styles.tokenAction}
                aria-label={`Revoke ${token.machine}`}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      {tokens !== null && tokens.length === 0 && (
        <div {...stylex.props(styles.commandRow)}>
          <code aria-label="Sign-in command" {...stylex.props(styles.commandText)}>
            {command}
          </code>
          <IconButton label="Copy command" size="sm" onClick={() => void copyCommand(command)}>
            <CopyIcon />
          </IconButton>
        </div>
      )}
      <RevokeCliTokenDialog token={revoking} onClose={() => setRevoking(null)} />
    </section>
  )
}

function RevokeCliTokenDialog({
  token,
  onClose,
}: {
  token: CliTokenInfo | null
  onClose: () => void
}) {
  const hub = useHub()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Kept while the dialog closes, so its text doesn't empty as it fades.
  const [shown, setShown] = useState<CliTokenInfo | null>(token)
  if (token !== null && token !== shown) setShown(token)

  const revoke = async () => {
    if (token === null) return
    setBusy(true)
    setError(null)
    try {
      await hub.revokeCliToken(token.id)
      toast.show({ title: `Revoked the CLI token for ${token.machine}` })
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
      open={token !== null}
      onOpenChange={(next) => {
        if (!next) {
          setError(null)
          onClose()
        }
      }}
      title={`Revoke the CLI token for ${shown?.machine ?? "this machine"}?`}
      description="kndl there is signed out at once: its next request is refused, a forwarded port's next connection too. Run kndl login there to sign it in again."
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button intent="danger" loading={busy} onClick={() => void revoke()}>
            Revoke
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
