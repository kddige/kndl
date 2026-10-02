import type { RunnerId, RunnerSummary } from "@claude-hub/protocol"
import * as stylex from "@stylexjs/stylex"
import { useNavigate } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { useHub, useHubState } from "../app/hub.tsx"
import { Button, Dialog, DialogClose, Field, Input, PlusIcon, Select } from "../ui/index.ts"
import { color, space, text } from "../ui/tokens.stylex.ts"

const styles = stylex.create({
  form: { display: "flex", flexDirection: "column", gap: space.s4 },
  error: { color: color.dangerSubtleText, fontSize: text.sm },
})

/** `owner/name`, as the protocol's RepoName takes it. */
const repoPattern = /^[^/\s]+\/[^/\s]+$/

const anyRunner = "any"

/** "New Session": pick a Repo, a base branch and, if it matters, the Runner to run it on. */
export function CreateSessionDialog() {
  const hub = useHub()
  const runners = useHubState((state) => state.runners)
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [repo, setRepo] = useState("")
  const [baseBranch, setBaseBranch] = useState("main")
  const [runner, setRunner] = useState<string>(anyRunner)
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const repoValue = repo.trim()
  const branchValue = baseBranch.trim()
  const repoInvalid = touched && !repoPattern.test(repoValue)
  const branchInvalid = touched && branchValue === ""
  const online = (runners ?? []).filter((candidate) => candidate.isOnline)

  const reset = () => {
    setRepo("")
    setBaseBranch("main")
    setRunner(anyRunner)
    setTouched(false)
    setBusy(false)
    setError(null)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (!repoPattern.test(repoValue) || branchValue === "") return
    setBusy(true)
    setError(null)
    try {
      const session = await hub.createSession({
        repo: repoValue,
        baseBranch: branchValue,
        ...(runner !== anyRunner && { runnerId: runner as RunnerId }),
      })
      setOpen(false)
      reset()
      void navigate({ to: "/sessions/$sessionId", params: { sessionId: session.id } })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
      trigger={
        <Button intent="primary" icon={<PlusIcon />}>
          New Session
        </Button>
      }
      title="New Session"
      description="Claude works on a new branch off the base branch, in a Sandbox on a Runner."
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button intent="primary" type="submit" form="create-session" loading={busy}>
            Start Session
          </Button>
        </>
      }
    >
      <form id="create-session" onSubmit={submit} noValidate {...stylex.props(styles.form)}>
        <Field
          label="Repo"
          description="The GitHub repository, as owner/name."
          invalid={repoInvalid}
          error={repoInvalid ? "Enter the Repo as owner/name." : undefined}
        >
          <Input
            value={repo}
            onValueChange={(value: string) => setRepo(value)}
            placeholder="kddige/claude-hub"
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
          />
        </Field>
        <Field
          label="Base branch"
          invalid={branchInvalid}
          error={branchInvalid ? "Enter a branch." : undefined}
        >
          <Input
            value={baseBranch}
            onValueChange={(value: string) => setBaseBranch(value)}
            spellCheck={false}
            autoCapitalize="off"
          />
        </Field>
        <Field
          label="Runner"
          description={
            online.length === 0
              ? "No Runner is online, so the Session can't start yet."
              : "Whose machine and Claude login it runs on."
          }
        >
          <Select
            value={runner}
            onValueChange={(value) => setRunner(value)}
            options={[
              { value: anyRunner, label: "Any online Runner" },
              ...(runners ?? []).map((candidate) => ({
                value: candidate.id as string,
                label: runnerLabel(candidate),
                disabled: !candidate.isOnline,
              })),
            ]}
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

function runnerLabel(runner: RunnerSummary): string {
  return `${runner.name} · ${runner.login.account}${runner.isOnline ? "" : " (offline)"}`
}
