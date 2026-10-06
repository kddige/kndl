import type { RunnerId } from "@claude-hub/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link, useNavigate } from "@tanstack/react-router"
import { type FormEvent, type ReactElement, useState } from "react"
import { repoParams, runnerLabel } from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import { isRefused, RepoRefusal, repoPattern, useRepoCheck } from "../app/repoAccess.tsx"
import { ModelPicker } from "../session/ModelPicker.tsx"
import { fitSetting, type ModelSetting, sharedModels } from "../session/models.ts"
import {
  Banner,
  Button,
  Dialog,
  DialogClose,
  Field,
  Input,
  KeyIcon,
  PlusIcon,
  Select,
} from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, radius, space, text, weight } from "../ui/tokens.stylex.ts"

const styles = stylex.create({
  form: { display: "flex", flexDirection: "column", gap: space.s4 },
  error: { color: color.dangerSubtleText, fontSize: text.sm },
  link: { color: "inherit", fontWeight: weight.semibold, borderRadius: radius.sm },
})

const anyRunner = "any"

/**
 * "New Session": pick a Repo, a base branch and, if it matters, the Runner to run it on. Opened by
 * `trigger`, a primary "New Session" Button unless given.
 */
export function CreateSessionDialog({ trigger }: { trigger?: ReactElement }) {
  const hub = useHub()
  const runners = useHubState((state) => state.runners)
  // Null once the Hub says they have stored none; undefined until it says.
  const claudeCredential = useHubState((state) => state.claudeCredential)
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [repo, setRepo] = useState("")
  const [baseBranch, setBaseBranch] = useState("main")
  const [runner, setRunner] = useState<string>(anyRunner)
  // Claude Code's own default unless one is picked (#128).
  const [modelChoice, setModelChoice] = useState<ModelSetting>({})
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const repoValue = repo.trim()
  const branchValue = baseBranch.trim()
  // Checked as it's entered, so a Repo out of reach is said before the setup (#104).
  const { check: repoCheck, recheck } = useRepoCheck(repoValue)
  const repoMalformed = touched && !repoPattern.test(repoValue)
  const repoRefused = isRefused(repoCheck)
  const repoInvalid = repoMalformed || repoRefused
  const branchInvalid = touched && branchValue === ""
  const online = (runners ?? []).filter((candidate) => candidate.isOnline)
  // The models it can run: the chosen Runner's, or for any Runner, what every online one has.
  const models =
    runner === anyRunner
      ? sharedModels(online.map((candidate) => candidate.models))
      : runners?.find((candidate) => candidate.id === runner)?.models
  // A choice the Runner picked since doesn't have is dropped, not sent to be refused.
  const modelSetting = fitSetting(models, modelChoice)

  const reset = () => {
    setRepo("")
    setBaseBranch("main")
    setRunner(anyRunner)
    setModelChoice({})
    setTouched(false)
    setBusy(false)
    setError(null)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (!repoPattern.test(repoValue) || repoRefused || branchValue === "") return
    setBusy(true)
    setError(null)
    try {
      // A Repo needs an Environment before its first Session (ADR 0009): set it up first, and
      // the setup screen starts this Session once it's applied.
      const { environment } = await hub.getEnvironment(repoValue)
      if (environment === null) {
        setOpen(false)
        reset()
        void navigate({
          to: "/repos/$owner/$repo/environment",
          params: repoParams(repoValue),
          search: { branch: branchValue, ...(runner !== anyRunner && { runner }), ...modelSetting },
        })
        return
      }
      const session = await hub.createSession({
        repo: repoValue,
        baseBranch: branchValue,
        ...(runner !== anyRunner && { runnerId: runner as RunnerId }),
        ...modelSetting,
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
        trigger ?? (
          <Button intent="primary" icon={<PlusIcon />}>
            New Session
          </Button>
        )
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
        {claudeCredential === null && (
          // Not a refusal: the Runner may have its own login to run it on (ADR 0015).
          <Banner intent="accent" icon={<KeyIcon />} title="Add your Claude credential">
            Sessions you start run on your own Claude account once you add a token or API key on
            your{" "}
            <Link
              to="/account"
              onClick={() => {
                setOpen(false)
                reset()
              }}
              {...stylex.props(styles.link, focus.ring)}
            >
              Account
            </Link>{" "}
            page. Until then, this one runs on its Runner's own, if it has one.
          </Banner>
        )}
        <Field
          label="Repo"
          description="The GitHub repository, as owner/name."
          invalid={repoInvalid}
          error={
            repoMalformed ? (
              "Enter the Repo as owner/name."
            ) : repoRefused && repoCheck !== null ? (
              <RepoRefusal repo={repoValue} check={repoCheck} onRecheck={recheck} />
            ) : undefined
          }
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
              : claudeCredential === null
                ? "Whose machine and Claude login it runs on."
                : "Whose machine it runs on: on your own Claude account."
          }
        >
          <Select
            value={runner}
            onValueChange={(value) => setRunner(value)}
            options={[
              { value: anyRunner, label: "Any online Runner" },
              ...(runners ?? []).map((candidate) => ({
                value: candidate.id as string,
                label: `${runnerLabel(candidate)}${candidate.isOnline ? "" : " (offline)"}`,
                disabled: !candidate.isOnline,
              })),
            ]}
          />
        </Field>
        <Field
          label="Model"
          description="Claude Code's default unless you pick one. Anyone in the Session can change it later."
        >
          <ModelPicker
            models={models}
            value={modelSetting}
            onChange={setModelChoice}
            appearance="field"
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
