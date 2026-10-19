// The signed-in person's Claude credential, a setup token (ADR 0015, ADR 0026): the Connected
// provider for Anthropic, which the Sessions they start run Claude's Models on, through the Claude
// bridge (docs/design/durable-harness.md), as `anthropic/<id>` in the Model picker. It is pasted
// once and checked with Anthropic as it is saved; after that it is write-only, so the page shows
// only its last 4 characters and when it was added. Connected, it is the first row of the
// Providers list; not yet, it is the first line under Subscriptions, where its form opens.

import { type ClaudeCredentialInfo, claudeCredentialProblem } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { type FormEvent, useState } from "react"
import { day } from "../app/format.ts"
import { useHub } from "../app/hub.tsx"
import {
  Button,
  Dialog,
  DialogClose,
  Field,
  Input,
  KeyIcon,
  MenuItem,
  MenuSeparator,
  SettingsRow,
  toast,
} from "../ui/index.ts"
import { color, font, leading, radius, space, text } from "../ui/tokens.stylex.ts"

const styles = stylex.create({
  steps: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    margin: 0,
    paddingInlineStart: space.s5,
    color: color.textSecondary,
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
  form: { display: "flex", flexDirection: "column", gap: space.s4, maxWidth: "32rem" },
  mono: { fontFamily: font.mono },
  actions: { display: "flex", flexWrap: "wrap", gap: space.s2 },
  error: { margin: 0, color: color.dangerText, fontSize: text.sm, lineHeight: leading.snug },
  warning: { margin: 0, color: color.warningText, fontSize: text.sm, lineHeight: leading.snug },
})

/**
 * The saved Claude credential, as a row of the Providers list: what it is, and Replace and Remove
 * in its menu. `warning` is said under it when it was saved without Anthropic confirming it, until
 * it is replaced.
 */
export function ClaudeRow({
  credential,
  warning,
  onWarning,
}: {
  credential: ClaudeCredentialInfo
  warning: string | null
  onWarning: (warning: string | null) => void
}) {
  const [replacing, setReplacing] = useState(false)
  const [removing, setRemoving] = useState(false)
  return (
    <>
      <SettingsRow
        label="Anthropic"
        name="Anthropic"
        meta={[
          "Setup token",
          <span key="last4" {...stylex.props(styles.mono)}>
            …{credential.last4}
          </span>,
          `Connected ${day(credential.addedAt)}`,
        ]}
        notes={
          warning !== null && (
            <p role="status" {...stylex.props(styles.warning)}>
              Anthropic didn't confirm it: {warning}
            </p>
          )
        }
        menu={
          <>
            <MenuItem onClick={() => setReplacing(true)}>Replace the setup token</MenuItem>
            <MenuSeparator />
            <MenuItem intent="danger" onClick={() => setRemoving(true)}>
              Remove the setup token
            </MenuItem>
          </>
        }
        detail={
          replacing && (
            <CredentialForm
              replacing
              onCancel={() => setReplacing(false)}
              onSaved={(saved) => {
                onWarning(saved ?? null)
                setReplacing(false)
              }}
            />
          )
        }
      />
      <RemoveDialog
        open={removing}
        onClose={() => setRemoving(false)}
        onRemoved={() => onWarning(null)}
      />
    </>
  )
}

/** Anthropic not connected yet, among the Providers to connect: its form opens under it. */
export function ClaudeLine({ onWarning }: { onWarning: (warning: string | null) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <SettingsRow
      label="Anthropic"
      name="Anthropic"
      meta="Your Claude subscription, through a setup token"
      action={
        !open && (
          <Button size="sm" icon={<KeyIcon />} onClick={() => setOpen(true)}>
            Add setup token
          </Button>
        )
      }
      detail={
        open && (
          <CredentialForm
            replacing={false}
            onCancel={() => setOpen(false)}
            onSaved={(saved) => onWarning(saved ?? null)}
          />
        )
      }
    />
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
        title: "Claude credential saved",
        ...(answer.warning !== undefined && { intent: "warning" as const }),
      })
      onSaved(answer.warning)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Your Claude setup token"
      {...stylex.props(styles.form)}
    >
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
          autoFocus
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
        <Button intent="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
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
      toast.show({ title: "Claude credential removed" })
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
      description="Sessions you started can't run Claude's Models until you add a setup token again. Anyone in them can switch them to another of your Models meanwhile."
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
