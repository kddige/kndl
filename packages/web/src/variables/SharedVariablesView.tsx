// The Hub-wide shared variables (ADR 0009): one value, such as an API key, that many Environments
// link under a name of their own. Listed with who links each; added, edited and deleted here.
// Saved Sensitive values are never sent to the browser, so they can only be replaced. One whose
// value `secrets-reset` cleared (#57) needs a value, said at the top and on its row.

import {
  MaxVariableValueLength,
  type SharedVariable,
  type SharedVariableInput,
  sensitiveValueProblem,
  valuesNeededText,
  variableNameProblem,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link } from "@tanstack/react-router"
import { Redacted } from "effect"
import { type FormEvent, useEffect, useState } from "react"
import { repoParams } from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import { needsValue } from "../environment/draft.ts"
import {
  Badge,
  Banner,
  Button,
  Dialog,
  DialogClose,
  Field,
  Input,
  LockIcon,
  MenuItem,
  MenuSeparator,
  PlusIcon,
  Select,
  SettingsEmpty,
  SettingsList,
  SettingsLoading,
  SettingsPage,
  SettingsRow,
  toast,
  WarningIcon,
} from "../ui/index.ts"
import { focus, textLink } from "../ui/shared.ts"
import { color, font, leading, radius, space, text, weight } from "../ui/tokens.stylex.ts"

const styles = stylex.create({
  name: { fontFamily: font.mono, fontSize: text.sm, fontWeight: weight.semibold },
  value: {
    display: "inline-block",
    maxWidth: "100%",
    verticalAlign: "bottom",
    fontFamily: font.mono,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  link: {
    color: color.accentText,
    borderRadius: radius.sm,
  },
  mono: { fontFamily: font.mono },
  form: { display: "flex", flexDirection: "column", gap: space.s4 },
  error: { color: color.dangerText, fontSize: text.sm, lineHeight: leading.snug },
})

export function SharedVariablesView() {
  const hub = useHub()
  const variables = useHubState((state) => state.sharedVariables)
  const online = useHubState((state) => state.connection.status === "online")
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState<SharedVariable | "new" | null>(null)
  const [deleting, setDeleting] = useState<SharedVariable | null>(null)

  // Bumped by Try again, after a failed load.
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!online) return
    hub.getSharedVariables().then(
      () => setLoadError(null),
      (error: unknown) => setLoadError(messageOf(error)),
    )
  }, [hub, online, attempt])
  const retry = () => {
    setLoadError(null)
    setAttempt((n) => n + 1)
  }

  const sorted = variables?.toSorted((a, b) => a.name.localeCompare(b.name)) ?? null
  const needed = (sorted ?? []).filter(needsValue)
  return (
    <SettingsPage
      title="Shared variables"
      description="Values any Environment can link."
      action={
        <Button intent="primary" size="sm" icon={<PlusIcon />} onClick={() => setEditing("new")}>
          Add shared variable
        </Button>
      }
    >
      {needed.length > 0 && (
        <Banner
          intent="danger"
          icon={<WarningIcon />}
          title={valuesNeededText(
            needed.map((variable) => ({ name: variable.name, availableAtBuild: false })),
          )}
        >
          The Hub's secrets key was replaced, and the values it encrypted were cleared. The Sessions
          of each Repo that links {needed.length === 1 ? "it" : "one"} don't start until{" "}
          {needed.length === 1 ? "it gets" : "each gets"} a value again: enter{" "}
          {needed.length === 1 ? "it" : "each"} below.
        </Banner>
      )}
      {sorted === null ? (
        loadError ? (
          <Banner
            intent="danger"
            icon={<WarningIcon />}
            title="Couldn't load the shared variables"
            action={
              <Button size="sm" onClick={retry}>
                Try again
              </Button>
            }
          >
            {loadError}
          </Banner>
        ) : (
          <SettingsLoading label="Loading shared variables" />
        )
      ) : sorted.length === 0 ? (
        <SettingsEmpty
          title="No shared variables yet"
          description="Add one here, then link it from each Environment that needs it."
          action={
            <Button size="sm" icon={<PlusIcon />} onClick={() => setEditing("new")}>
              Add shared variable
            </Button>
          }
        />
      ) : (
        <SettingsList label="Shared variables">
          {sorted.map((variable) => (
            <VariableRow
              key={variable.name}
              variable={variable}
              onEdit={() => setEditing(variable)}
              onDelete={() => setDeleting(variable)}
            />
          ))}
        </SettingsList>
      )}
      <EditDialog editing={editing} existing={variables ?? []} onClose={() => setEditing(null)} />
      <DeleteDialog variable={deleting} onClose={() => setDeleting(null)} />
    </SettingsPage>
  )
}

function VariableRow({
  variable,
  onEdit,
  onDelete,
}: {
  variable: SharedVariable
  onEdit: () => void
  onDelete: () => void
}) {
  const needed = needsValue(variable)
  return (
    <SettingsRow
      label={variable.name}
      name={<span {...stylex.props(styles.name)}>{variable.name}</span>}
      meta={[
        variable._tag === "Plain" && (
          <span key="value" title={variable.value} {...stylex.props(styles.value)}>
            {variable.value === "" ? "(empty)" : variable.value}
          </span>
        ),
        variable.linkedBy.length === 0 ? (
          "No Environment links it."
        ) : (
          <span key="links">
            Linked by{" "}
            {variable.linkedBy.map((use, index) => (
              <span key={`${use.repo}:${use.name}`}>
                <Link
                  to="/repos/$owner/$repo/environment"
                  params={repoParams(use.repo)}
                  {...stylex.props(textLink.underline, styles.link, focus.ring)}
                >
                  {use.repo}
                </Link>
                {use.name !== variable.name && (
                  <>
                    {" as "}
                    <span {...stylex.props(styles.mono)}>{use.name}</span>
                  </>
                )}
                {use.availableAtBuild && " (at build)"}
                {index < variable.linkedBy.length - 1 && ", "}
              </span>
            ))}
          </span>
        ),
      ]}
      badges={
        <>
          {/* What kind it is, in no colour: only what needs attention gets one. */}
          {variable._tag === "Sensitive" ? (
            <Badge icon={<LockIcon width={12} height={12} />}>Sensitive</Badge>
          ) : (
            <Badge>Plain</Badge>
          )}
          {needed && <Badge intent="danger">needs a value</Badge>}
        </>
      }
      action={
        needed && (
          <Button size="sm" aria-label={`Enter value for ${variable.name}`} onClick={onEdit}>
            Enter value
          </Button>
        )
      }
      menu={
        <>
          <MenuItem onClick={onEdit}>Edit {variable.name}</MenuItem>
          <MenuSeparator />
          <MenuItem intent="danger" onClick={onDelete}>
            Delete {variable.name}
          </MenuItem>
        </>
      }
    />
  )
}

type Kind = "Plain" | "Sensitive"

/** Adds a shared variable, or edits one: its kind and value, not its name. */
function EditDialog({
  editing,
  existing,
  onClose,
}: {
  editing: SharedVariable | "new" | null
  existing: ReadonlyArray<SharedVariable>
  onClose: () => void
}) {
  const hub = useHub()
  // While the dialog closes, it keeps showing what it was opened for.
  const shown = useLastOpened(editing)
  const adding = shown === "new"
  const saved = shown === "new" ? null : shown
  const [name, setName] = useState("")
  const [kind, setKind] = useState<Kind>("Plain")
  const [value, setValue] = useState("")
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fill the form for whatever is opened.
  useEffect(() => {
    if (editing === null) return
    setName(saved?.name ?? "")
    setKind(saved?._tag ?? "Plain")
    setValue(saved?._tag === "Plain" ? saved.value : "")
    setTouched(false)
    setBusy(false)
    setError(null)
  }, [editing, saved])

  const trimmed = name.trim()
  // A Sensitive value saved before can be kept: it's left blank. One that was cleared can't.
  const savedValue = saved?._tag === "Sensitive" && kind === "Sensitive"
  const cleared = savedValue && needsValue(saved)
  const keepsSensitive = savedValue && !cleared && value === ""
  const nameProblem = !adding
    ? undefined
    : trimmed === ""
      ? "Give it a name."
      : (variableNameProblem(trimmed) ??
        (existing.some((variable) => variable.name === trimmed)
          ? `There's already a shared variable named ${trimmed}: edit that one instead.`
          : undefined))
  const valueProblem =
    kind === "Sensitive"
      ? keepsSensitive
        ? undefined
        : sensitiveValueProblem(trimmed || "the variable", value)
      : value.length > MaxVariableValueLength
        ? `The value is over ${MaxVariableValueLength} characters.`
        : undefined

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (nameProblem !== undefined || valueProblem !== undefined) return
    const variable: SharedVariableInput =
      kind === "Plain"
        ? { _tag: "Plain", name: trimmed, value }
        : {
            _tag: "Sensitive",
            name: trimmed,
            ...(!keepsSensitive && { value: Redacted.make(value) }),
          }
    setBusy(true)
    setError(null)
    try {
      await hub.setSharedVariable(variable)
      toast.show({ title: adding ? `Added ${trimmed}` : `Saved ${trimmed}` })
      onClose()
    } catch (cause) {
      setError(messageOf(cause))
      setBusy(false)
    }
  }

  const linkCount = saved?.linkedBy.length ?? 0
  return (
    <Dialog
      open={editing !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={adding ? "Add shared variable" : `Edit ${saved?.name}`}
      description={
        adding
          ? "Environments link it under a name of their own."
          : linkCount > 0
            ? `${linkCount} ${linkCount === 1 ? "Environment links" : "Environments link"} it: their Sessions get the new value as they next start.`
            : "No Environment links it yet."
      }
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button intent="primary" type="submit" form="shared-variable" loading={busy}>
            {adding ? "Add" : "Save"}
          </Button>
        </>
      }
    >
      <form id="shared-variable" onSubmit={submit} noValidate {...stylex.props(styles.form)}>
        <Field
          label="Name"
          description={adding ? "Letters, digits and underscores." : "A name can't be changed."}
          invalid={touched && nameProblem !== undefined}
          error={touched ? nameProblem : undefined}
        >
          <Input
            value={name}
            disabled={!adding}
            onValueChange={(next: string) => setName(next)}
            placeholder="GITHUB_TOKEN"
            autoFocus={adding}
            spellCheck={false}
            autoCapitalize="off"
            sx={styles.mono}
          />
        </Field>
        <Field
          label="Kind"
          description={
            kind === "Sensitive"
              ? "Never shown again once saved, only replaced, and masked in what the Hub stores."
              : "Anyone signed in can read it."
          }
        >
          <Select
            value={kind}
            onValueChange={(next) => {
              setKind(next)
              // A saved Sensitive value never reaches the browser, so it can't seed a Plain one.
              if (next !== kind) setValue("")
            }}
            options={[
              { value: "Plain", label: "Plain" },
              { value: "Sensitive", label: "Sensitive" },
            ]}
          />
        </Field>
        <Field
          label={<span>Value {cleared && <Badge intent="danger">needs a value</Badge>}</span>}
          invalid={touched && valueProblem !== undefined}
          error={touched ? valueProblem : undefined}
        >
          <Input
            type={kind === "Sensitive" ? "password" : "text"}
            value={value}
            autoComplete="off"
            onValueChange={(next: string) => setValue(next)}
            placeholder={
              cleared ? "Cleared: enter it again" : savedValue ? "Saved: type to replace it" : ""
            }
            spellCheck={false}
            autoCapitalize="off"
            autoFocus={!adding}
            sx={styles.mono}
          />
        </Field>
        {error && (
          <p role="alert" {...stylex.props(styles.error)}>
            {error}
          </p>
        )}
      </form>
    </Dialog>
  )
}

/** Deletes a shared variable; the Hub refuses while an Environment links it, and says why. */
function DeleteDialog({
  variable,
  onClose,
}: {
  variable: SharedVariable | null
  onClose: () => void
}) {
  const hub = useHub()
  const shown = useLastOpened(variable)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setBusy(false)
    setError(null)
  }, [variable])

  const remove = async () => {
    if (!variable) return
    setBusy(true)
    setError(null)
    try {
      await hub.deleteSharedVariable(variable.name)
      toast.show({ title: `Deleted ${variable.name}` })
      onClose()
    } catch (cause) {
      setError(messageOf(cause))
      setBusy(false)
    }
  }

  const links = shown?.linkedBy ?? []
  return (
    <Dialog
      size="sm"
      open={variable !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={`Delete ${shown?.name ?? ""}?`}
      description={
        links.length > 0
          ? `Linked by ${links.map((use) => use.repo).join(", ")}. The Hub refuses to delete it until no Environment links it.`
          : "No Environment links it. It can't be brought back."
      }
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button intent="danger" loading={busy} onClick={() => void remove()}>
            Delete
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

/** `value`, or while it is null (a dialog closing), the last value it wasn't. */
function useLastOpened<T>(value: T | null): T | null {
  const [last, setLast] = useState(value)
  if (value !== null && value !== last) setLast(value)
  return value ?? last
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
