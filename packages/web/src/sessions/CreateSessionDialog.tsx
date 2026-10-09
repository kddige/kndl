import {
  type BranchChoice,
  branchNameProblem,
  repoKey,
  type RunnerId,
  sameRepo,
  type SessionSummary,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link, useNavigate } from "@tanstack/react-router"
import { type FormEvent, type ReactElement, useEffect, useState } from "react"
import { repoParams, runnerLabel } from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import { isRefused, RepoRefusal, repoPattern, useRepoCheck } from "../app/repoAccess.tsx"
import { ModelPicker } from "../session/ModelPicker.tsx"
import { fitSetting, type ModelSetting, sharedModels } from "../session/models.ts"
import {
  Banner,
  Button,
  Checkbox,
  Combobox,
  type ComboboxOption,
  Dialog,
  DialogClose,
  Field,
  KeyIcon,
  PlusIcon,
  Select,
} from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, radius, space, text, weight } from "../ui/tokens.stylex.ts"
import { branchSearch } from "./branches.ts"

const styles = stylex.create({
  form: { display: "flex", flexDirection: "column", gap: space.s4 },
  error: { color: color.dangerSubtleText, fontSize: text.sm },
  link: { color: "inherit", fontWeight: weight.semibold, borderRadius: radius.sm },
  note: { display: "inline-flex", alignItems: "center", flexWrap: "wrap", gap: space.s1_5 },
})

const anyRunner = "any"

/** How many of the person's own Repos the "Recent" group lists. */
const recentRepos = 5

/** The branch to start from when the Repo's can't be listed and no Session says. */
const fallbackBranch = "main"

/** What the Hub said of a Repo's branches, for the Repo it was asked about. */
type Branches =
  | { readonly status: "Loading" }
  | { readonly status: "Loaded"; readonly names: ReadonlyArray<string>; readonly default: string }
  | { readonly status: "Failed"; readonly message: string }

/** What the Hub said of the Repos to pick from. */
type Repos =
  | { readonly status: "Loading" }
  | { readonly status: "Loaded"; readonly names: ReadonlyArray<string> }
  | { readonly status: "Failed"; readonly message: string }

/** The branches the Repo's Sessions were started on, the newest Session's first. */
const branchesOfSessions = (sessions: ReadonlyArray<SessionSummary>, repo: string) => [
  ...new Set(
    sessions
      .filter((session) => sameRepo(session.repo, repo))
      .toSorted((a, b) => b.createdAt - a.createdAt)
      .map((session) => session.baseBranch),
  ),
]

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** Each of `names` once, by Repo (GitHub's names ignore case), in order. */
const distinctRepos = (names: ReadonlyArray<string>) => [
  ...new Map(names.map((name) => [repoKey(name), name] as const)).values(),
]

/**
 * "New Session": pick a Repo, a branch (an existing one, directly or on a new Work branch, or a
 * new one made from another; ADR 0023) and, if it matters, the Runner to run it on. Opened by
 * `trigger`, a primary "New Session" Button unless given.
 */
export function CreateSessionDialog({ trigger }: { trigger?: ReactElement }) {
  const hub = useHub()
  const runners = useHubState((state) => state.runners)
  // Null once the Hub says they have stored none; undefined until it says.
  const claudeCredential = useHubState((state) => state.claudeCredential)
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const sessions = useHubState((state) => state.sessions) ?? []
  const you = useHubState((state) => state.you)
  const [repo, setRepo] = useState("")
  const [branch, setBranch] = useState("")
  // Set while the branch is a new one, to make from this branch (ADR 0023).
  const [from, setFrom] = useState<string | null>(null)
  const [newWorkBranch, setNewWorkBranch] = useState(true)
  const [repos, setRepos] = useState<Repos>({ status: "Loading" })
  const [reposAsked, setReposAsked] = useState(0)
  const [branches, setBranches] = useState<Branches | null>(null)
  const [branchesAsked, setBranchesAsked] = useState(0)
  const [runner, setRunner] = useState<string>(anyRunner)
  // Claude Code's own default unless one is picked (#128).
  const [modelChoice, setModelChoice] = useState<ModelSetting>({})
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const repoValue = repo.trim()
  const branchValue = branch.trim()
  // Checked as it's entered, so a Repo out of reach is said before the setup (#104).
  const { check: repoCheck, recheck } = useRepoCheck(repoValue)
  const repoMalformed = touched && !repoPattern.test(repoValue)
  const repoRefused = isRefused(repoCheck)
  const repoInvalid = repoMalformed || repoRefused
  // The branch is picked once the Repo is: one that looks right and that GitHub hasn't refused.
  const repoPicked = repoPattern.test(repoValue) && !repoRefused && repoCheck?.status !== "Checking"
  const creating = from !== null
  const newBranchProblem = creating ? branchNameProblem(branchValue) : undefined
  const fromListed = branches?.status === "Loaded" && branches.names.includes(from ?? "")
  const branchInvalid =
    (touched && branchValue === "") || (creating && newBranchProblem !== undefined)
  const fromInvalid = creating && !fromListed
  const online = (runners ?? []).filter((candidate) => candidate.isOnline)
  // The models it can run: the chosen Runner's, or for any Runner, what every online one has.
  const models =
    runner === anyRunner
      ? sharedModels(online.map((candidate) => candidate.models))
      : runners?.find((candidate) => candidate.id === runner)?.models
  // A choice the Runner picked since doesn't have is dropped, not sent to be refused.
  const modelSetting = fitSetting(models, modelChoice)
  // Without a credential of their own, a Session runs on its Runner's, if it has one (ADR 0015);
  // with neither, it can't start, and the dialog says so before the form is filled in.
  const chosen = runner === anyRunner ? undefined : online.find((each) => each.id === runner)
  const runsOnRunner = claudeCredential === null
  const needsCredential =
    runsOnRunner &&
    online.length > 0 &&
    !(chosen === undefined ? online : [chosen]).some((each) => each.ownClaudeCredential === true)

  // Recent: the person's own Sessions' Repos, newest first. Without a list from the Hub, the
  // suggestions are those and every other Repo the Sessions are in.
  const mine = sessions.filter((session) => session.creator.id === you?.id)
  const recent = distinctRepos(
    mine.toSorted((a, b) => b.createdAt - a.createdAt).map((session) => session.repo),
  ).slice(0, recentRepos)
  const otherRepos = (repos.status === "Loaded" ? repos.names : sessions.map((s) => s.repo)).filter(
    (name) => !recent.some((each) => sameRepo(each, name)),
  )
  const repoOptions: Array<ComboboxOption> = [
    ...recent.map((value) => ({ value, group: "Recent" })),
    ...distinctRepos(otherRepos)
      .toSorted((a, b) => a.localeCompare(b))
      .map((value) => ({ value, group: "Repositories" })),
  ]
  // The Repo's branches: the Hub's list, or, without one, those its Sessions in the Hub began on.
  const historyBranches = branchesOfSessions(sessions, repoValue)
  const listedBranches = branches?.status === "Loaded" ? branches : null
  const branchNames = listedBranches?.names ?? historyBranches
  const branchOptions: Array<ComboboxOption> = (
    listedBranches === null
      ? branchNames
      : [listedBranches.default, ...branchNames.filter((name) => name !== listedBranches.default)]
  ).map((value) => ({ value }))
  // Sessions already committing to the branch this one would commit to.
  const sharing =
    creating || newWorkBranch || branchValue === ""
      ? 0
      : sessions.filter(
          (session) =>
            session.state === "Active" &&
            sameRepo(session.repo, repoValue) &&
            session.workBranch === branchValue,
        ).length

  // The full list comes when New Session opens, and typing narrows it in the browser.
  useEffect(() => {
    if (!open) return
    let current = true
    setRepos({ status: "Loading" })
    hub.listRepos().then(
      (names) => current && setRepos({ status: "Loaded", names }),
      (cause: unknown) => current && setRepos({ status: "Failed", message: messageOf(cause) }),
    )
    return () => {
      current = false
    }
  }, [hub, open, reposAsked])

  // The Repo's branches, once it is picked; its default branch is filled in if none is yet.
  const pickedRepo = repoPicked ? repoValue : null
  useEffect(() => {
    if (pickedRepo === null) {
      setBranches(null)
      return
    }
    let current = true
    setBranches({ status: "Loading" })
    hub.listBranches(pickedRepo).then(
      (listed) => {
        if (!current) return
        setBranches({ status: "Loaded", names: listed.branches, default: listed.defaultBranch })
        setBranch((typed) => (typed === "" ? listed.defaultBranch : typed))
      },
      (cause: unknown) => {
        if (!current) return
        setBranches({ status: "Failed", message: messageOf(cause) })
        setBranch((typed) =>
          typed === "" ? (branchesOfSessions(sessions, pickedRepo)[0] ?? fallbackBranch) : typed,
        )
      },
    )
    return () => {
      current = false
    }
    // The Sessions only seed the fallback: a new one mustn't ask again.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [hub, pickedRepo, branchesAsked])

  const reset = () => {
    setRepo("")
    setBranch("")
    setFrom(null)
    setNewWorkBranch(true)
    setBranches(null)
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
    if (creating && (newBranchProblem !== undefined || !fromListed)) return
    const choice: BranchChoice =
      from === null
        ? { _tag: "Existing", name: branchValue, newWorkBranch }
        : { _tag: "Create", name: branchValue, from }
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
          search: {
            ...branchSearch(choice),
            ...(runner !== anyRunner && { runner }),
            ...modelSetting,
          },
        })
        return
      }
      const session = await hub.createSession({
        repo: repoValue,
        branch: choice,
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
      description="Claude works on a branch of the Repo, in a Sandbox on a Runner."
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button
            intent="primary"
            type="submit"
            form="create-session"
            loading={busy}
            disabled={needsCredential}
          >
            Start Session
          </Button>
        </>
      }
    >
      <form id="create-session" onSubmit={submit} noValidate {...stylex.props(styles.form)}>
        {runsOnRunner && (
          <Banner
            intent={needsCredential ? "warning" : "accent"}
            icon={<KeyIcon />}
            title={
              needsCredential ? "Add your Claude credential first" : "Add your Claude credential"
            }
          >
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
            page.{" "}
            {needsCredential
              ? chosen === undefined
                ? "No online Runner has a Claude credential of its own to run this one on."
                : `${chosen.name} has no Claude credential of its own to run this one on.`
              : "Until then, this one runs on its Runner's own."}
          </Banner>
        )}
        <Field
          label="Repo"
          description={
            repos.status === "Failed" ? (
              <span {...stylex.props(styles.note)}>
                Couldn't load the Repos: {repos.message} Suggestions are from your Sessions.
                <Button size="sm" onClick={() => setReposAsked((asked) => asked + 1)}>
                  Retry
                </Button>
              </span>
            ) : (
              "The GitHub repository, as owner/name."
            )
          }
          invalid={repoInvalid}
          error={
            repoMalformed ? (
              "Enter the Repo as owner/name."
            ) : repoRefused && repoCheck !== null ? (
              <RepoRefusal repo={repoValue} check={repoCheck} onRecheck={recheck} />
            ) : undefined
          }
        >
          <Combobox
            value={repo}
            onValueChange={(value) => {
              setRepo(value)
              // Another Repo has other branches: the branch is chosen again.
              setBranch("")
              setFrom(null)
            }}
            options={repoOptions}
            placeholder="kddige/kndl"
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
          />
        </Field>
        <Field
          label="Branch"
          description={
            branches?.status === "Failed" ? (
              <span {...stylex.props(styles.note)}>
                Couldn't load the branches: {branches.message} Suggestions are from your Sessions.
                <Button size="sm" onClick={() => setBranchesAsked((asked) => asked + 1)}>
                  Retry
                </Button>
              </span>
            ) : creating ? (
              "A new branch, made from the one below."
            ) : (
              "The branch Claude starts from."
            )
          }
          disabled={!repoPicked}
          invalid={branchInvalid}
          error={
            creating && newBranchProblem !== undefined
              ? newBranchProblem
              : branchInvalid
                ? "Enter a branch."
                : undefined
          }
        >
          <Combobox
            value={branch}
            onValueChange={(value) => {
              setBranch(value)
              setFrom(null)
            }}
            options={branchOptions}
            // Only where the Repo's branches are known is a name known to be new.
            {...(listedBranches !== null && {
              create: {
                label: (name: string) => `Create branch '${name}'`,
                onCreate: () => setFrom(listedBranches.default),
              },
            })}
            disabled={!repoPicked}
            spellCheck={false}
            autoCapitalize="off"
          />
        </Field>
        {from !== null && (
          <Field
            label="From"
            description="The branch the new one is made from."
            invalid={fromInvalid}
            error={fromInvalid ? "Pick one of the Repo's branches." : undefined}
          >
            <Combobox
              value={from}
              onValueChange={setFrom}
              options={branchOptions}
              spellCheck={false}
              autoCapitalize="off"
            />
          </Field>
        )}
        {from === null && (
          <Checkbox
            label="Work on a new branch"
            description={
              newWorkBranch
                ? `Claude commits to a new branch made from ${branchValue === "" ? "it" : branchValue}.`
                : `Claude commits directly to ${branchValue === "" ? "it" : branchValue}.`
            }
            checked={newWorkBranch}
            onCheckedChange={setNewWorkBranch}
            disabled={!repoPicked}
          />
        )}
        {sharing > 0 && (
          <Banner intent="warning" title={`${branchValue} is in use`}>
            {sharing === 1
              ? `1 active Session is already on ${branchValue}.`
              : `${sharing} active Sessions are already on ${branchValue}.`}
          </Banner>
        )}
        <Field
          label="Runner"
          description={
            online.length === 0
              ? "No Runner is online, so the Session can't start yet."
              : runsOnRunner
                ? "Whose machine it runs on, and on whose Claude credential, until you add yours."
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
