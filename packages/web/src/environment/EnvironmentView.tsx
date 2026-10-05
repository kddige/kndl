// A Repo's Environment screen (ADR 0009): edit a draft of everything that builds its Sandboxes,
// run a Test build of it on a Runner, and apply it as the next version. The draft stays in the
// browser until applied. Also where a Repo without an Environment is set up before its first
// Session.

import {
  type EnvironmentVersionInfo,
  type RunnerId,
  type RunnerSummary,
  type SharedVariable,
  valuesNeededText,
} from "@claude-hub/protocol"
import * as stylex from "@stylexjs/stylex"
import { Link, useNavigate } from "@tanstack/react-router"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { repoParams, runnerLabel, timeAgo } from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import type { RepoEnvironment, TestBuildRun } from "../hub/store.ts"
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Checkbox,
  Disclosure,
  EmptyState,
  Field,
  IconButton,
  InfoIcon,
  Input,
  LogView,
  PageHeader,
  PlusIcon,
  Select,
  Spinner,
  Switch,
  Textarea,
  toast,
  TrashIcon,
  WarningIcon,
} from "../ui/index.ts"
import { focus } from "../ui/shared.ts"
import { color, font, leading, radius, space, text, weight } from "../ui/tokens.stylex.ts"
import {
  type DraftFolder,
  draftIdentity,
  draftProblems,
  type DraftVariable,
  editFrom,
  type EnvironmentEdit,
  forgetEdit,
  isUnchanged,
  loadEdit,
  needsValue,
  newFolder,
  newVariable,
  storeEdit,
  toDraft,
  valuesNeeded,
  type VariableKind,
} from "./draft.ts"

/** A Session to start once the Repo's first Environment is applied. */
export interface PendingSession {
  readonly baseBranch: string
  readonly runnerId?: RunnerId
}

const styles = stylex.create({
  view: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
  scroll: { flex: 1, overflowY: "auto" },
  page: {
    display: "flex",
    flexDirection: "column",
    gap: space.s5,
    maxWidth: "56rem",
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
  sectionTitleRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s2,
    flexWrap: "wrap",
  },
  sectionTitle: { fontSize: text.md, fontWeight: weight.semibold },
  sectionNote: { color: color.textMuted, fontSize: text.sm, lineHeight: leading.snug },
  script: { fontFamily: font.mono, fontSize: text.sm, minHeight: "6rem" },
  mono: { fontFamily: font.mono },
  pair: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
    gap: space.s4,
  },
  rows: { display: "flex", flexDirection: "column", gap: space.s3 },
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: space.s2,
    paddingBottom: space.s3,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: color.border,
  },
  rowName: { flex: "1 1 10rem", minWidth: "8rem" },
  rowKind: { flex: "0 0 8.5rem" },
  rowValue: { flex: "2 1 14rem", minWidth: "10rem" },
  rowBuild: { flex: "0 0 auto", alignSelf: "center" },
  rowError: { flexBasis: "100%", color: color.dangerSubtleText, fontSize: text.sm },
  kindSelect: { minWidth: 0, width: "100%" },
  valueSelect: { minWidth: 0, width: "100%" },
  valueLine: { display: "flex", alignItems: "center", gap: space.s2 },
  grow: { flex: 1, minWidth: 0 },
  actions: { display: "flex", gap: space.s2, flexWrap: "wrap" },
  link: {
    color: color.accentSubtleText,
    textDecoration: { default: "none", ":hover": "underline" },
    borderRadius: radius.sm,
  },
  folderPattern: { flex: "2 1 12rem", minWidth: "10rem" },
  folderNextTo: { flex: "1 1 9rem", minWidth: "8rem" },
  problems: {
    margin: 0,
    paddingInlineStart: space.s5,
    color: color.dangerSubtleText,
    fontSize: text.sm,
    lineHeight: leading.snug,
  },
  status: { display: "flex", alignItems: "center", gap: space.s2, fontSize: text.sm },
  statusText: { color: color.textMuted },
  testBar: { display: "flex", alignItems: "flex-end", gap: space.s2, flexWrap: "wrap" },
  runnerSelect: { minWidth: "14rem" },
  applyBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: space.s2,
    flexWrap: "wrap",
  },
  applyNote: { flex: 1, color: color.textMuted, fontSize: text.sm, minWidth: "12rem" },
  error: { color: color.dangerSubtleText, fontSize: text.sm },
  history: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  version: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    flexWrap: "wrap",
    paddingBlock: space.s2,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: color.border,
    fontSize: text.sm,
  },
  firstVersion: { borderTopWidth: 0 },
  versionNumber: { fontWeight: weight.semibold, minWidth: "4.5rem" },
  muted: { color: color.textMuted },
  loading: { display: "grid", placeItems: "center", paddingBlock: space.s16 },
})

/** Loads the Repo's Environment and the shared variables, then edits them. */
export function EnvironmentView({
  repo,
  pendingSession,
}: {
  repo: string
  pendingSession?: PendingSession | undefined
}) {
  const hub = useHub()
  const saved = useHubState((state) => state.environments[repo])
  const sharedVariables = useHubState((state) => state.sharedVariables)
  const online = useHubState((state) => state.connection.status === "online")
  const [loadError, setLoadError] = useState<string | null>(null)

  // Again after a reconnect: a version may have been applied meanwhile.
  useEffect(() => {
    if (!online) return
    hub.getEnvironment(repo).then(
      () => setLoadError(null),
      (error: unknown) => setLoadError(messageOf(error)),
    )
    hub.getSharedVariables().catch(() => {
      // Links then can't be checked here; the Hub still checks them.
    })
  }, [hub, repo, online])

  const environment = saved?.environment
  return (
    <main {...stylex.props(styles.view)}>
      <PageHeader
        title={repo}
        badge={
          saved &&
          (environment ? (
            <Badge>Version {environment.version}</Badge>
          ) : (
            <Badge intent="warning">Not set up</Badge>
          ))
        }
        description="Environment: what every Sandbox of this Repo is built from. Changes stay in this browser until you apply them."
        actions={
          <Button nativeButton={false} render={<Link to="/variables" />} size="sm">
            Shared variables
          </Button>
        }
      />
      <div {...stylex.props(styles.scroll)}>
        <div {...stylex.props(styles.page)}>
          {saved ? (
            <EnvironmentEditor
              key={repo}
              repo={repo}
              saved={saved}
              sharedVariables={sharedVariables}
              pendingSession={pendingSession}
            />
          ) : loadError ? (
            <EmptyState
              size="page"
              icon={<WarningIcon />}
              title="Can't load the Environment"
              description={loadError}
            />
          ) : (
            <div {...stylex.props(styles.loading)}>
              <Spinner size="lg" label="Loading the Environment" />
            </div>
          )}
        </div>
      </div>
    </main>
  )
}

/** The Hub's answer about the draft it was asked about. */
type Check =
  | { readonly identity: string; readonly needsTestBuild: boolean; readonly passed: boolean }
  | { readonly identity: string; readonly refused: string }

function EnvironmentEditor({
  repo,
  saved,
  sharedVariables,
  pendingSession,
}: {
  repo: string
  saved: RepoEnvironment
  sharedVariables: ReadonlyArray<SharedVariable> | null
  pendingSession: PendingSession | undefined
}) {
  const hub = useHub()
  const navigate = useNavigate()
  const runners = useHubState((state) => state.runners)
  const testBuilds = useHubState((state) => state.testBuilds)
  const online = useHubState((state) => state.connection.status === "online")
  const { environment, versions } = saved

  const [edit, setEditState] = useState<EnvironmentEdit>(
    () => loadEdit(repo) ?? editFrom(environment),
  )
  const setEdit = (update: (edit: EnvironmentEdit) => EnvironmentEdit) =>
    setEditState((current) => {
      const next = update(current)
      storeEdit(repo, next)
      return next
    })
  const startOver = () => {
    forgetEdit(repo)
    setEditState(editFrom(environment))
    setApplyError(null)
    setTestBuildId(null)
  }
  // A draft nobody touched follows the applied version; an edited one is left for its editor.
  const appliedVersion = environment?.version ?? null
  useEffect(() => {
    if (loadEdit(repo) !== null) return
    setEditState((current) =>
      current.baseVersion === appliedVersion ? current : editFrom(environment),
    )
  }, [repo, appliedVersion, environment])

  const draft = useMemo(() => toDraft(edit), [edit])
  const identity = useMemo(() => draftIdentity(draft), [draft])
  const problems = useMemo(
    () => draftProblems(edit, { environment, sharedVariables }),
    [edit, environment, sharedVariables],
  )
  const currentVersion = environment?.version ?? null
  const stale = edit.baseVersion !== currentVersion
  const unchanged = isUnchanged(edit, environment)

  // Whether the draft needs a Test build, and whether one of exactly it passed: asked of the Hub
  // shortly after each change, and again when a Test build ends.
  const [check, setCheck] = useState<Check | null>(null)
  const [testBuildId, setTestBuildId] = useState<string | null>(null)
  const testRun = testBuildId === null ? undefined : testBuilds[testBuildId as never]
  const testEnded = testRun?.result ?? null
  const checkable = problems.all.length === 0 && !stale && online
  useEffect(() => {
    if (!checkable) return
    let current = true
    const timer = setTimeout(() => {
      hub.checkEnvironmentDraft(repo, draft).then(
        (checked) => {
          if (current) {
            setCheck({
              identity,
              needsTestBuild: checked.needsTestBuild,
              passed: checked.testBuildPassed,
            })
          }
        },
        (error: unknown) => {
          if (current) setCheck({ identity, refused: messageOf(error) })
        },
      )
    }, 250)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [hub, repo, draft, identity, checkable, testEnded])
  const checked = check?.identity === identity ? check : null

  const [testedIdentity, setTestedIdentity] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const onlineRunners = (runners ?? []).filter((runner) => runner.isOnline)
  const [runnerId, setRunnerId] = useState<string>("")
  const chosenRunner = onlineRunners.find((runner) => runner.id === runnerId) ?? onlineRunners[0]
  const testing = testRun !== undefined && testRun.result === null
  const startTestBuild = async () => {
    if (!chosenRunner) return
    setStarting(true)
    setTestError(null)
    try {
      const build = await hub.startTestBuild(repo, chosenRunner.id, draft)
      setTestBuildId(build.id)
      setTestedIdentity(identity)
    } catch (error) {
      setTestError(messageOf(error))
    } finally {
      setStarting(false)
    }
  }

  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [startingSession, setStartingSession] = useState(false)

  /** Starts the Session the setup was for, and opens it; or says why not and stays. */
  const startPendingSession = async (pending: PendingSession) => {
    setStartingSession(true)
    try {
      const session = await hub.createSession({
        repo,
        baseBranch: pending.baseBranch,
        ...(pending.runnerId !== undefined && { runnerId: pending.runnerId }),
      })
      void navigate({ to: "/sessions/$sessionId", params: { sessionId: session.id } })
    } catch (error) {
      setStartingSession(false)
      toast.show({
        title: "The Session didn't start",
        description: messageOf(error),
        intent: "danger",
      })
      // Leave setup: the Environment is there now.
      void navigate({
        to: "/repos/$owner/$repo/environment",
        params: repoParams(repo),
        replace: true,
      })
    }
  }
  const needsTestBuild = checked !== null && "needsTestBuild" in checked && checked.needsTestBuild
  const canApply =
    checked !== null &&
    "needsTestBuild" in checked &&
    (!checked.needsTestBuild || checked.passed) &&
    !stale &&
    !unchanged &&
    problems.all.length === 0 &&
    online
  const apply = async () => {
    setApplying(true)
    setApplyError(null)
    try {
      const state = await hub.applyEnvironment(repo, edit.baseVersion, draft)
      forgetEdit(repo)
      setEditState(editFrom(state.environment))
      setTestBuildId(null)
      const version = state.environment?.version
      if (pendingSession) {
        toast.show({
          title: `Applied version ${version}`,
          description: "Starting your Session on it.",
        })
        await startPendingSession(pendingSession)
        return
      }
      toast.show({
        title: `Applied version ${version}`,
        description: "New Sessions start on it. Active ones show a Restart.",
      })
    } catch (error) {
      setApplyError(messageOf(error))
    } finally {
      setApplying(false)
    }
  }

  const latest = versions[0]
  const setVariable = (key: string, change: Partial<DraftVariable>) =>
    setEdit((current) => ({
      ...current,
      variables: current.variables.map((variable) =>
        variable.key === key ? { ...variable, ...change } : variable,
      ),
    }))
  const setFolder = (key: string, change: Partial<DraftFolder>) =>
    setEdit((current) => ({
      ...current,
      dependencyFolders: current.dependencyFolders.map((folder) =>
        folder.key === key ? { ...folder, ...change } : folder,
      ),
    }))
  // Each saved Sensitive variable, and whether it needs a value.
  const savedSensitive = new Map(
    (environment?.variables ?? []).flatMap((variable) =>
      variable._tag === "Sensitive" ? [[variable.name, variable.needsValue] as const] : [],
    ),
  )
  const needed = valuesNeeded({ environment: environment ?? null, sharedVariables })
  const neededShared = needed.some((variable) => variable.sharedVariable !== undefined)

  return (
    <>
      {needed.length > 0 && (
        <Banner
          intent="danger"
          icon={<WarningIcon />}
          title={`${repo}'s Sessions can't start: ${valuesNeededText(needed)}`}
          {...(neededShared && {
            action: (
              <Button nativeButton={false} render={<Link to="/variables" />} size="sm">
                Shared variables
              </Button>
            ),
          })}
        >
          The Hub's secrets key was replaced, and the values it encrypted were cleared.{" "}
          {needed.length === 1 ? "Enter it again" : "Enter them again"}
          {neededShared
            ? ": shared variables on the Shared variables screen, the others below, then apply."
            : " below, and apply. No Test build is needed for that."}
        </Banner>
      )}

      {pendingSession && !environment && (
        <Banner intent="accent" icon={<InfoIcon />} title={`Set up ${repo} to start your Session`}>
          A Repo needs an Environment before its first Session. This one starts from the defaults:
          change what you need, run a Test build, and apply it. Your Session on{" "}
          {pendingSession.baseBranch} starts once it's applied.
        </Banner>
      )}

      {pendingSession && environment && (
        <Banner
          intent="accent"
          icon={<InfoIcon />}
          title={`${repo} has an Environment`}
          action={
            <Button
              size="sm"
              intent="primary"
              loading={startingSession}
              onClick={() => void startPendingSession(pendingSession)}
            >
              Start Session
            </Button>
          }
        >
          Start your Session on {pendingSession.baseBranch} on version {environment.version}, or
          change the Environment first.
        </Banner>
      )}

      {stale && (
        <Banner
          intent="warning"
          icon={<WarningIcon />}
          title={
            currentVersion === null
              ? "This draft is for an Environment that's gone"
              : `${latest?.appliedBy.name ?? "Someone"} applied version ${currentVersion} since you started this draft`
          }
          action={
            <Button size="sm" onClick={startOver}>
              Reload
            </Button>
          }
        >
          The Hub refuses a draft made from an older version. Reload to start again from version{" "}
          {currentVersion ?? "none"}; your changes here are dropped.
        </Banner>
      )}

      <Section
        title="Image and scripts"
        note="The bootstrap runs once per build on each Runner, without the Workspace; the start script runs in each new Sandbox, with it."
      >
        <Field
          label="Image"
          description="Any OCI image, such as buildpack-deps:bookworm."
          invalid={problems.image !== undefined}
          error={problems.image}
        >
          <Input
            value={edit.image}
            onValueChange={(value: string) => setEdit((current) => ({ ...current, image: value }))}
            spellCheck={false}
            autoCapitalize="off"
            sx={styles.mono}
          />
        </Field>
        <Field
          label="Bootstrap script"
          description="Installs the tools. Its result is snapshotted, so it doesn't run per Session."
        >
          <Textarea
            value={edit.bootstrapScript}
            onValueChange={(value) =>
              setEdit((current) => ({ ...current, bootstrapScript: value }))
            }
            rows={5}
            placeholder="apt-get update && apt-get install -y curl git"
            sx={styles.script}
          />
        </Field>
        <Field
          label="Start script"
          description="Runs in each new Sandbox, in the Workspace: install dependencies, pull images. Optional."
        >
          <Textarea
            value={edit.startScript}
            onValueChange={(value) => setEdit((current) => ({ ...current, startScript: value }))}
            rows={3}
            placeholder="bun install"
            sx={styles.script}
          />
        </Field>
        <Switch
          label="Docker in every Sandbox"
          description="Each Session's Docker keeps its data on a disk of its own, so images the bootstrap pulls aren't visible in Sessions. Pull them in the start script instead."
          checked={edit.docker}
          onCheckedChange={(docker) => setEdit((current) => ({ ...current, docker }))}
        />
      </Section>

      <Section
        title="Resources"
        note="What each Sandbox gets, capped by what its Runner allows. A Session notes it in its transcript when it gets less."
      >
        <div {...stylex.props(styles.pair)}>
          <Field label="CPUs" invalid={problems.cpus !== undefined} error={problems.cpus}>
            <Input
              value={edit.cpus}
              inputMode="numeric"
              onValueChange={(value: string) => setEdit((current) => ({ ...current, cpus: value }))}
            />
          </Field>
          <Field
            label="Memory (MiB)"
            description={memoryHint(edit.memoryMib)}
            invalid={problems.memoryMib !== undefined}
            error={problems.memoryMib}
          >
            <Input
              value={edit.memoryMib}
              inputMode="numeric"
              onValueChange={(value: string) =>
                setEdit((current) => ({ ...current, memoryMib: value }))
              }
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Variables"
        note={
          <>
            Set in every Sandbox. Plain values can be read by anyone signed in, and always reach the
            bootstrap. Sensitive ones are never shown again once applied, only replaced. Links put a{" "}
            <Link to="/variables" {...stylex.props(styles.link, focus.ring)}>
              shared variable
            </Link>{" "}
            in under a name of this Environment.
          </>
        }
      >
        {edit.variables.length > 0 && (
          <div {...stylex.props(styles.rows)}>
            {edit.variables.map((variable) => (
              <VariableRow
                key={variable.key}
                variable={variable}
                problem={problems.variables[variable.key]}
                hasSavedValue={savedSensitive.get(variable.name.trim()) === false}
                needsValue={savedSensitive.get(variable.name.trim()) === true}
                sharedVariables={sharedVariables}
                onChange={(change) => setVariable(variable.key, change)}
                onRemove={() =>
                  setEdit((current) => ({
                    ...current,
                    variables: current.variables.filter((other) => other.key !== variable.key),
                  }))
                }
              />
            ))}
          </div>
        )}
        <div {...stylex.props(styles.actions)}>
          <Button
            size="sm"
            icon={<PlusIcon />}
            onClick={() =>
              setEdit((current) => ({
                ...current,
                variables: [...current.variables, newVariable("Plain")],
              }))
            }
          >
            Add variable
          </Button>
          <Button
            size="sm"
            icon={<PlusIcon />}
            onClick={() =>
              setEdit((current) => ({
                ...current,
                variables: [...current.variables, newVariable("Link")],
              }))
            }
          >
            Link shared variable
          </Button>
        </div>
      </Section>

      <Disclosure
        summary={
          <span>
            Advanced: dependency folders{" "}
            <span {...stylex.props(styles.muted)}>({edit.dependencyFolders.length})</span>
          </span>
        }
        defaultOpen={Object.keys(problems.folders).length > 0}
      >
        <div {...stylex.props(styles.section)}>
          <p {...stylex.props(styles.sectionNote)}>
            Folders matching a pattern, relative to the Workspace, are kept on a disk of their own
            that outlives the Sandbox. With a "next to" file, the folder is also made next to every
            such file, so the first install on a fresh clone already lands on that disk.
          </p>
          <div {...stylex.props(styles.rows)}>
            {edit.dependencyFolders.map((folder) => (
              <div key={folder.key} {...stylex.props(styles.row)}>
                <Field label="Pattern" sx={styles.folderPattern}>
                  <Input
                    size="sm"
                    value={folder.pattern}
                    placeholder="**/node_modules"
                    onValueChange={(value: string) => setFolder(folder.key, { pattern: value })}
                    spellCheck={false}
                    autoCapitalize="off"
                    sx={styles.mono}
                  />
                </Field>
                <Field label="Next to (optional)" sx={styles.folderNextTo}>
                  <Input
                    size="sm"
                    value={folder.nextTo}
                    placeholder="package.json"
                    onValueChange={(value: string) => setFolder(folder.key, { nextTo: value })}
                    spellCheck={false}
                    autoCapitalize="off"
                    sx={styles.mono}
                  />
                </Field>
                <IconButton
                  label={`Remove ${folder.pattern || "this folder"}`}
                  size="sm"
                  intent="ghost"
                  sx={styles.rowBuild}
                  onClick={() =>
                    setEdit((current) => ({
                      ...current,
                      dependencyFolders: current.dependencyFolders.filter(
                        (other) => other.key !== folder.key,
                      ),
                    }))
                  }
                >
                  <TrashIcon />
                </IconButton>
                {problems.folders[folder.key] && (
                  <p role="alert" {...stylex.props(styles.rowError)}>
                    {problems.folders[folder.key]}
                  </p>
                )}
              </div>
            ))}
          </div>
          <div {...stylex.props(styles.actions)}>
            <Button
              size="sm"
              icon={<PlusIcon />}
              onClick={() =>
                setEdit((current) => ({
                  ...current,
                  dependencyFolders: [...current.dependencyFolders, newFolder()],
                }))
              }
            >
              Add folder
            </Button>
          </div>
        </div>
      </Disclosure>

      <Section title="Apply">
        {problems.all.length > 0 && (
          <ul aria-label="What to fix before applying" {...stylex.props(styles.problems)}>
            {problems.all.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
        <BuildStatus
          checked={checked}
          checkable={checkable}
          unchanged={unchanged}
          testRun={testRun}
          testedThisDraft={testedIdentity === identity}
        />
        {needsTestBuild && !stale && problems.all.length === 0 && (
          <div {...stylex.props(styles.testBar)}>
            <Field
              label="Runner to build on"
              {...(onlineRunners.length === 0 && {
                description: "No Runner is online to build on.",
              })}
            >
              <Select
                value={chosenRunner?.id ?? null}
                placeholder="No Runner online"
                disabled={onlineRunners.length === 0}
                onValueChange={(value) => setRunnerId(value)}
                options={onlineRunners.map((runner: RunnerSummary) => ({
                  value: runner.id as string,
                  label: runnerLabel(runner),
                }))}
                sx={styles.runnerSelect}
              />
            </Field>
            <Button
              onClick={() => void startTestBuild()}
              loading={starting || testing}
              disabled={!chosenRunner || !online}
            >
              Test build
            </Button>
          </div>
        )}
        {testError && (
          <p role="alert" {...stylex.props(styles.error)}>
            {testError}
          </p>
        )}
        {testRun && (
          <LogView label="Test build log" placeholder="Waiting for the Runner…">
            {testRun.log}
          </LogView>
        )}
        {applyError && (
          <p role="alert" {...stylex.props(styles.error)}>
            {applyError}
          </p>
        )}
        <div {...stylex.props(styles.applyBar)}>
          <p {...stylex.props(styles.applyNote)}>
            {environment
              ? "New Sessions start on the applied version; Active ones offer a Restart."
              : "Applying makes version 1."}
          </p>
          {!unchanged && environment && (
            <Button intent="ghost" onClick={startOver}>
              Discard changes
            </Button>
          )}
          <Button intent="primary" disabled={!canApply} loading={applying} onClick={apply}>
            {pendingSession && !environment ? "Apply and start Session" : "Apply"}
          </Button>
        </div>
      </Section>

      <Section
        title="Version history"
        note="Who applied each version and when. Versions keep no values."
      >
        {versions.length === 0 ? (
          <p {...stylex.props(styles.sectionNote)}>Nothing applied yet.</p>
        ) : (
          <ol aria-label="Versions" {...stylex.props(styles.history)}>
            {versions.map((version, index) => (
              <VersionRow key={version.version} version={version} first={index === 0} />
            ))}
          </ol>
        )}
      </Section>
    </>
  )
}

function Section({
  title,
  note,
  children,
}: {
  title: string
  note?: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-label={title} {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionHead)}>
        <h2 {...stylex.props(styles.sectionTitle)}>{title}</h2>
        {note && <p {...stylex.props(styles.sectionNote)}>{note}</p>}
      </div>
      {children}
    </section>
  )
}

const kinds: ReadonlyArray<{ value: VariableKind; label: string }> = [
  { value: "Plain", label: "Plain" },
  { value: "Sensitive", label: "Sensitive" },
  { value: "Link", label: "Shared" },
]

function VariableRow({
  variable,
  problem,
  hasSavedValue,
  needsValue: savedNeedsValue,
  sharedVariables,
  onChange,
  onRemove,
}: {
  variable: DraftVariable
  problem: string | undefined
  hasSavedValue: boolean
  /** A saved Sensitive variable whose value was cleared (#57). */
  needsValue: boolean
  sharedVariables: ReadonlyArray<SharedVariable> | null
  onChange: (change: Partial<DraftVariable>) => void
  onRemove: () => void
}) {
  const name = variable.name.trim()
  const linked = sharedVariables?.find((shared) => shared.name === variable.sharedVariable)
  return (
    <div {...stylex.props(styles.row)}>
      <Field label="Name" invalid={problem !== undefined} sx={styles.rowName}>
        <Input
          size="sm"
          value={variable.name}
          placeholder="NAME"
          onValueChange={(value: string) => onChange({ name: value })}
          spellCheck={false}
          autoCapitalize="off"
          sx={styles.mono}
        />
      </Field>
      <Field label="Kind" sx={styles.rowKind}>
        <Select
          size="sm"
          value={variable.kind}
          options={kinds}
          onValueChange={(kind) =>
            onChange({
              kind,
              // A saved Sensitive value can't become Plain: it was never sent here.
              ...(kind === "Plain" && { availableAtBuild: true }),
              ...(kind === "Link" && { value: "" }),
              ...(variable.kind === "Link" &&
                kind !== "Link" && { availableAtBuild: kind === "Plain" }),
            })
          }
          sx={styles.kindSelect}
        />
      </Field>
      {variable.kind === "Plain" && (
        <Field label="Value" sx={styles.rowValue}>
          <Input
            size="sm"
            value={variable.value}
            onValueChange={(value: string) => onChange({ value })}
            spellCheck={false}
            autoCapitalize="off"
            sx={styles.mono}
          />
        </Field>
      )}
      {variable.kind === "Sensitive" && (
        <Field
          label={
            <span {...stylex.props(styles.valueLine)}>
              Value
              {hasSavedValue && variable.value === "" && <Badge intent="success">set</Badge>}
              {savedNeedsValue && variable.value === "" && (
                <Badge intent="danger">needs a value</Badge>
              )}
            </span>
          }
          sx={styles.rowValue}
        >
          <Input
            size="sm"
            type="password"
            value={variable.value}
            placeholder={
              hasSavedValue
                ? "Saved: type to replace it"
                : savedNeedsValue
                  ? "Cleared: enter it again"
                  : "Enter a value"
            }
            autoComplete="off"
            onValueChange={(value: string) => onChange({ value })}
            sx={styles.mono}
          />
        </Field>
      )}
      {variable.kind === "Link" && (
        <Field
          label={
            <span {...stylex.props(styles.valueLine)}>
              Shared variable
              {variable.kind === "Link" && needsValue(linked) && (
                <Badge intent="danger">needs a value</Badge>
              )}
            </span>
          }
          {...(sharedVariables?.length === 0 && {
            description: (
              <Link to="/variables" {...stylex.props(styles.link, focus.ring)}>
                Add a shared variable first
              </Link>
            ),
          })}
          sx={styles.rowValue}
        >
          <Select
            size="sm"
            value={variable.sharedVariable === "" ? null : variable.sharedVariable}
            placeholder={sharedVariables === null ? "Loading…" : "Pick one"}
            disabled={sharedVariables === null || sharedVariables.length === 0}
            onValueChange={(sharedVariable) =>
              onChange({
                sharedVariable,
                ...(variable.name === "" && { name: sharedVariable }),
              })
            }
            options={(sharedVariables ?? []).map((shared) => ({
              value: shared.name,
              label: `${shared.name} (${shared._tag})`,
            }))}
            sx={styles.valueSelect}
          />
        </Field>
      )}
      <Checkbox
        label="At build"
        checked={variable.kind === "Plain" ? true : variable.availableAtBuild}
        disabled={variable.kind === "Plain"}
        onCheckedChange={(availableAtBuild) => onChange({ availableAtBuild })}
        sx={styles.rowBuild}
      />
      <IconButton
        label={`Remove ${name || "this variable"}`}
        size="sm"
        intent="ghost"
        sx={styles.rowBuild}
        onClick={onRemove}
      >
        <TrashIcon />
      </IconButton>
      {problem && (
        <p role="alert" {...stylex.props(styles.rowError)}>
          {problem}
        </p>
      )}
    </div>
  )
}

/** Whether the draft needs a Test build before it can be applied, and how that stands. */
function BuildStatus({
  checked,
  checkable,
  unchanged,
  testRun,
  testedThisDraft,
}: {
  checked: Check | null
  checkable: boolean
  unchanged: boolean
  testRun: TestBuildRun | undefined
  testedThisDraft: boolean
}) {
  const online = useHubState((state) => state.connection.status === "online")
  if (unchanged) {
    return <Status intent="neutral" text="No changes to apply." />
  }
  if (!checkable) return null
  if (checked === null) return <Status spinner text="Checking the draft with the Hub…" />
  if ("refused" in checked) return <Status intent="danger" text={checked.refused} />
  if (testRun && testRun.result === null) {
    return online ? (
      <Status spinner text="Test build running…" />
    ) : (
      <Status intent="warning" text="Lost the connection: run the Test build again once back." />
    )
  }
  if (testRun?.result === "Failed" && testedThisDraft) {
    return (
      <Status
        intent="danger"
        badge="Test build failed"
        text={testRun.message ?? "See the log. Fix the draft and run it again."}
      />
    )
  }
  if (!checked.needsTestBuild) {
    return (
      <Status intent="success" badge="No Test build needed" text="It doesn't change the build." />
    )
  }
  if (checked.passed) {
    return (
      <Status intent="success" badge="Test build passed" text="This exact draft built. Apply it." />
    )
  }
  return (
    <Status
      intent="warning"
      badge="Needs a Test build"
      text="It changes the build: Apply is enabled once a Test build of exactly this draft passes."
    />
  )
}

function Status({
  intent = "neutral",
  badge,
  text: label,
  spinner = false,
}: {
  intent?: "neutral" | "success" | "warning" | "danger"
  badge?: string
  text: string
  spinner?: boolean
}) {
  return (
    <div role="status" {...stylex.props(styles.status)}>
      {spinner && <Spinner size="sm" />}
      {badge && <Badge intent={intent}>{badge}</Badge>}
      <span {...stylex.props(styles.statusText)}>{label}</span>
    </div>
  )
}

function VersionRow({ version, first }: { version: EnvironmentVersionInfo; first: boolean }) {
  return (
    <li {...stylex.props(styles.version, first && styles.firstVersion)}>
      <span {...stylex.props(styles.versionNumber)}>Version {version.version}</span>
      <Avatar name={version.appliedBy.name} src={version.appliedBy.avatarUrl} size="sm" />
      <span>{version.appliedBy.name}</span>
      <span {...stylex.props(styles.muted)} title={new Date(version.appliedAt).toLocaleString()}>
        {timeAgo(version.appliedAt)}
      </span>
      <span {...stylex.props(styles.grow)} />
      {version.rebuilt ? (
        <Badge intent="accent">Changed the build</Badge>
      ) : (
        <Badge>Same build</Badge>
      )}
    </li>
  )
}

function memoryHint(typed: string): string {
  const mib = Number(typed)
  if (!Number.isFinite(mib) || mib <= 0) return "In MiB: 4096 is 4 GiB."
  return `${(mib / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} GiB`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
