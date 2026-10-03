// Environments on the Hub (issue #47, ADR 0009): each Repo's recipe as last applied, its
// variables and links, the Hub-wide shared variables, the versions applied, and Test builds.
//
// - A draft is applied whole, as the next version. A draft that changes the build (the image,
//   scripts, Docker, dependency folders, or the names and values of the variables available at
//   build) needs a passing Test build of exactly it: Test builds are recorded against the digest
//   of those inputs, values included, so a build of any other draft doesn't count.
// - Sensitive values are stored encrypted (Secrets.ts) and leave the Hub only to a Runner, for a
//   Session or Test build it runs. Versions record who applied them and when, never values.
// - A shared variable available at build in some Environment can't change value: that would
//   change those builds without a Test build. Untick "available at build" on its links first.
// - Sensitive values are redacted from what the Hub stores or shows (issue #48, Redaction.ts).
//   A value an apply or a shared variable's change replaces is kept, encrypted, as retired: a
//   Session that started before may still print it. It is dropped once no Session that could
//   have it is running (Active or Frozen) on a version from before the change.

import {
  type DependencyFolder,
  DependencyFolder as DependencyFolderSchema,
  type Environment,
  type EnvironmentDraft,
  type EnvironmentRecipe,
  EnvironmentVersion,
  type EnvironmentVersionInfo,
  environmentDraftProblems,
  MaxVariableValueLength,
  MinSensitiveValueLength,
  ParticipantId,
  type Participant,
  type RunnerId,
  type SessionEnvironment,
  type SharedVariable,
  type SharedVariableInput,
  type TestBuildId,
  type TestBuildResult,
  type VariableValue,
  variableNameProblem,
} from "@claude-hub/protocol"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { Secrets } from "./Secrets.ts"

/** The Hub refused a change to an Environment or shared variable, saying why. */
// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class EnvironmentRefused extends Schema.TaggedError<EnvironmentRefused>()(
  "EnvironmentRefused",
  { message: Schema.String },
) {}

/** A draft, checked and its variables resolved: what a Test build runs and an apply stores. */
export interface PreparedDraft {
  readonly repo: string
  readonly recipe: EnvironmentRecipe
  /** Every variable's value, for the Runner of a Test build; in memory only. */
  readonly values: ReadonlyArray<VariableValue>
  /** The digest of its build inputs. */
  readonly digest: string
  /** Whether it changes the build of the Repo's Environment as applied, or there is none. */
  readonly changesBuild: boolean
  /** The values of its Sensitive variables and of its links to Sensitive shared variables. */
  readonly sensitiveValues: ReadonlyArray<Redacted.Redacted<string>>
}

/** A Test build to record. */
export interface NewTestBuild {
  readonly id: TestBuildId
  readonly repo: string
  readonly runnerId: RunnerId
  readonly digest: string
  readonly startedBy: ParticipantId
  readonly startedAt: number
}

interface EnvironmentRow {
  readonly repo: string
  readonly version: number
  readonly buildVersion: number
  readonly image: string
  readonly bootstrapScript: string
  readonly startScript: string | null
  readonly docker: number
  readonly dependencyFolders: string
  readonly cpus: number
  readonly memoryMib: number
}

type VariableKind = "Plain" | "Sensitive" | "Link"

interface VariableRow {
  readonly name: string
  readonly kind: VariableKind
  /** The plain value, a Sensitive one's ciphertext, or null for a link. */
  readonly value: string | null
  readonly sharedName: string | null
  readonly availableAtBuild: number
}

interface SharedRow {
  readonly name: string
  readonly kind: "Plain" | "Sensitive"
  /** The plain value, or a Sensitive one's ciphertext. */
  readonly value: string
}

/** A variable with its value, and how it is stored. */
interface ResolvedVariable {
  readonly name: string
  readonly availableAtBuild: boolean
  readonly value: Redacted.Redacted<string>
  readonly stored:
    | { readonly kind: "Plain" }
    /** A saved value keeps its ciphertext; a new one has none until it is applied. */
    | { readonly kind: "Sensitive"; readonly ciphertext: string | undefined }
    | { readonly kind: "Link"; readonly sharedName: string; readonly sensitive: boolean }
}

/** The parts of a recipe beside its variables. */
type RecipeFields = Omit<EnvironmentRecipe, "variables">

const decodeFolders = Schema.decodeUnknownSync(Schema.Array(DependencyFolderSchema))

const recipeFieldsOf = (row: EnvironmentRow): RecipeFields => ({
  image: row.image,
  bootstrapScript: row.bootstrapScript,
  ...(row.startScript !== null && { startScript: row.startScript }),
  docker: row.docker === 1,
  dependencyFolders: decodeFolders(JSON.parse(row.dependencyFolders)),
  resources: { cpus: row.cpus, memoryMib: row.memoryMib },
})

const draftFieldsOf = (draft: EnvironmentDraft): RecipeFields => ({
  image: draft.image,
  bootstrapScript: draft.bootstrapScript,
  ...(draft.startScript !== undefined && { startScript: draft.startScript }),
  docker: draft.docker,
  dependencyFolders: draft.dependencyFolders,
  resources: draft.resources,
})

/** What a Sensitive value's ciphertext is bound to, so it can't be moved to another variable. */
const environmentContext = (repo: string, name: string) => `environment:${repo}:${name}`
const sharedContext = (name: string) => `shared:${name}`
/** A retired value is kept under its Repo, whatever variable it came from. */
const retiredContext = (repo: string) => `retired:${repo}`

/** The values of the Sensitive variables and links to Sensitive shared variables among these. */
const sensitiveOf = (variables: ReadonlyArray<ResolvedVariable>) =>
  variables
    .filter(
      ({ stored }) => stored.kind === "Sensitive" || (stored.kind === "Link" && stored.sensitive),
    )
    .map((variable) => variable.value)

const tooShort = (name: string) =>
  refuse(
    `The value of ${name} is under ${MinSensitiveValueLength} characters: too short to redact from output. Make it Plain, or use a longer value.`,
  )

const refuse = (message: string) => Effect.fail(new EnvironmentRefused({ message }))

const recipeOf = (
  fields: RecipeFields,
  variables: ReadonlyArray<ResolvedVariable>,
): EnvironmentRecipe => ({
  ...fields,
  variables: variables.map(({ name, availableAtBuild }) => ({ name, availableAtBuild })),
})

const valuesOf = (variables: ReadonlyArray<ResolvedVariable>): Array<VariableValue> =>
  variables.map(({ name, value, availableAtBuild }) => ({ name, value, availableAtBuild }))

const secretsUnavailable = (name: string) =>
  refuse(
    `${name} is Sensitive, but the Hub has no HUB_SECRETS_KEY to encrypt it with. Run \`bun run secrets-key\`, put the key in packages/hub/.env.local, and restart the Hub.`,
  )

const toParticipant = (row: {
  readonly id: string
  readonly login: string
  readonly name: string
  readonly avatarUrl: string | null
}): Participant => ({
  id: ParticipantId.make(row.id),
  login: row.login,
  name: row.name,
  ...(row.avatarUrl !== null && { avatarUrl: row.avatarUrl }),
})

export class Environments extends Context.Service<
  Environments,
  {
    /** The Repo's Environment as last applied, or null, and its versions, newest first. */
    readonly state: (repo: string) => Effect.Effect<
      {
        readonly environment: Environment | null
        readonly versions: ReadonlyArray<EnvironmentVersionInfo>
      },
      SqlError
    >
    /** Whether the Repo has an applied Environment. */
    readonly exists: (repo: string) => Effect.Effect<boolean, SqlError>
    /** Checks a draft and resolves its variables, against the Repo's Environment as applied. */
    readonly prepare: (
      repo: string,
      draft: EnvironmentDraft,
    ) => Effect.Effect<PreparedDraft, EnvironmentRefused | SqlError>
    /**
     * Applies a draft as the Repo's next version, by `by`. Refused if `baseVersion` isn't the
     * Repo's version now, or if the draft changes the build and no Test build of exactly it
     * passed.
     */
    readonly apply: (
      repo: string,
      baseVersion: EnvironmentVersion | null,
      draft: EnvironmentDraft,
      by: ParticipantId,
      at: number,
    ) => Effect.Effect<void, EnvironmentRefused | SqlError>
    /** The Repo's Environment as StartSession gives it, or none before its first version. */
    readonly forSession: (
      repo: string,
    ) => Effect.Effect<Option.Option<SessionEnvironment>, SqlError>
    /**
     * The Sensitive values to redact from what the Repo's Sessions print: its Sensitive variables
     * and links to Sensitive shared variables as applied, and the values those replaced that a
     * running Session may still have.
     */
    readonly sensitiveValues: (
      repo: string,
    ) => Effect.Effect<ReadonlyArray<Redacted.Redacted<string>>, EnvironmentRefused | SqlError>
    /** Every variable of the Repo's Environment as applied, with its value. */
    readonly values: (
      repo: string,
    ) => Effect.Effect<ReadonlyArray<VariableValue>, EnvironmentRefused | SqlError>
    /** Whether a Test build of a draft with this digest passed. */
    readonly testBuildPassed: (repo: string, digest: string) => Effect.Effect<boolean, SqlError>
    readonly recordTestBuild: (build: NewTestBuild) => Effect.Effect<void, SqlError>
    readonly finishTestBuild: (
      id: TestBuildId,
      result: TestBuildResult,
      at: number,
    ) => Effect.Effect<void, SqlError>
    /** Records every Test build still running failed, as on a Hub restart. */
    readonly failUnfinishedTestBuilds: (at: number) => Effect.Effect<void, SqlError>
    /** Every shared variable, by name, with where it is linked; no Sensitive values. */
    readonly sharedVariables: Effect.Effect<ReadonlyArray<SharedVariable>, SqlError>
    readonly setSharedVariable: (
      input: SharedVariableInput,
      by: ParticipantId,
      at: number,
    ) => Effect.Effect<void, EnvironmentRefused | SqlError>
    /** Deletes a shared variable no Environment links. */
    readonly deleteSharedVariable: (
      name: string,
    ) => Effect.Effect<void, EnvironmentRefused | SqlError>
  }
>()("@claude-hub/hub/Environments") {
  static readonly layer = Layer.effect(
    Environments,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const secrets = yield* Secrets

      const decrypt = (ciphertext: string, context: string) =>
        secrets
          .decrypt(ciphertext, context)
          .pipe(Effect.mapError((error) => new EnvironmentRefused({ message: error.message })))

      const environmentRow = Effect.fn("Environments.environmentRow")(function* (repo: string) {
        const rows = yield* sql<EnvironmentRow>`
          SELECT repo, version, build_version AS buildVersion, image,
            bootstrap_script AS bootstrapScript, start_script AS startScript, docker,
            dependency_folders AS dependencyFolders, cpus, memory_mib AS memoryMib
          FROM environments WHERE repo = ${repo}
        `
        return Option.fromNullishOr(rows[0])
      })

      const variableRows = (repo: string) => sql<VariableRow>`
        SELECT name, kind, value, shared_name AS sharedName,
          available_at_build AS availableAtBuild
        FROM environment_variables WHERE repo = ${repo} ORDER BY position
      `

      const sharedRow = Effect.fn("Environments.sharedRow")(function* (name: string) {
        const rows = yield* sql<SharedRow>`
          SELECT name, kind, value FROM shared_variables WHERE name = ${name}
        `
        return Option.fromNullishOr(rows[0])
      })

      const sharedValue = (row: SharedRow) =>
        row.kind === "Plain"
          ? Effect.succeed(Redacted.make(row.value))
          : decrypt(row.value, sharedContext(row.name))

      /**
       * Keeps a Sensitive value the Repo no longer has, encrypted, for redacting what Sessions on
       * a version below `untilVersion` print.
       */
      const retire = Effect.fn("Environments.retire")(function* (
        repo: string,
        value: Redacted.Redacted<string>,
        untilVersion: number,
      ) {
        const ciphertext = yield* secrets
          .encrypt(value, retiredContext(repo))
          .pipe(Effect.mapError((error) => new EnvironmentRefused({ message: error.message })))
        yield* sql`
          INSERT INTO retired_values (repo, value, until_version, retired_at)
          VALUES (${repo}, ${ciphertext}, ${untilVersion}, ${yield* Clock.currentTimeMillis})
        `
      })

      /** The Repo's variables as applied, with their values. */
      const storedVariables = Effect.fn("Environments.storedVariables")(function* (repo: string) {
        const resolved: Array<ResolvedVariable> = []
        for (const row of yield* variableRows(repo)) {
          const availableAtBuild = row.availableAtBuild === 1
          if (row.kind === "Plain") {
            resolved.push({
              name: row.name,
              availableAtBuild: true,
              value: Redacted.make(row.value ?? ""),
              stored: { kind: "Plain" },
            })
          } else if (row.kind === "Sensitive") {
            const ciphertext = row.value ?? ""
            resolved.push({
              name: row.name,
              availableAtBuild,
              value: yield* decrypt(ciphertext, environmentContext(repo, row.name)),
              stored: { kind: "Sensitive", ciphertext },
            })
          } else {
            const sharedName = row.sharedName ?? ""
            const shared = yield* sharedRow(sharedName)
            if (Option.isNone(shared)) {
              return yield* refuse(`The shared variable ${sharedName} is gone.`)
            }
            resolved.push({
              name: row.name,
              availableAtBuild,
              value: yield* sharedValue(shared.value),
              stored: { kind: "Link", sharedName, sensitive: shared.value.kind === "Sensitive" },
            })
          }
        }
        return resolved
      })

      /**
       * The digest of what goes into a build: the recipe but its resources, and the names and
       * values of the variables available at build. Keyed, as it covers Sensitive values.
       */
      const buildDigest = (fields: RecipeFields, variables: ReadonlyArray<ResolvedVariable>) =>
        secrets.digest(
          JSON.stringify([
            fields.image,
            fields.bootstrapScript,
            fields.startScript ?? null,
            fields.docker,
            fields.dependencyFolders.map((folder: DependencyFolder) => [
              folder.pattern,
              folder.nextTo ?? null,
            ]),
            variables
              .filter((variable) => variable.availableAtBuild)
              .map((variable) => [variable.name, Redacted.value(variable.value)])
              .toSorted(([a = ""], [b = ""]) => (a < b ? -1 : a > b ? 1 : 0)),
          ]),
        )

      const prepare = Effect.fn("Environments.prepare")(function* (
        repo: string,
        draft: EnvironmentDraft,
      ) {
        const problems = environmentDraftProblems(draft)
        if (problems.length > 0) return yield* refuse(problems.join(" "))

        const current = yield* environmentRow(repo)
        const saved = new Map((yield* variableRows(repo)).map((row) => [row.name, row] as const))
        const variables: Array<ResolvedVariable> = []
        for (const variable of draft.variables) {
          const { name } = variable
          switch (variable._tag) {
            case "Plain":
              variables.push({
                name,
                availableAtBuild: true,
                value: Redacted.make(variable.value),
                stored: { kind: "Plain" },
              })
              break
            case "Sensitive": {
              const { availableAtBuild } = variable
              if (variable.value !== undefined) {
                if (!secrets.available) return yield* secretsUnavailable(name)
                if (Redacted.value(variable.value).length > MaxVariableValueLength) {
                  return yield* refuse(
                    `The value of ${name} is over ${MaxVariableValueLength} characters.`,
                  )
                }
                if (Redacted.value(variable.value).trim().length < MinSensitiveValueLength) {
                  return yield* tooShort(name)
                }
                variables.push({
                  name,
                  availableAtBuild,
                  value: variable.value,
                  stored: { kind: "Sensitive", ciphertext: undefined },
                })
                break
              }
              const kept = saved.get(name)
              if (kept?.kind !== "Sensitive" || kept.value === null) {
                return yield* refuse(`${name} has no saved Sensitive value: enter one.`)
              }
              variables.push({
                name,
                availableAtBuild,
                value: yield* decrypt(kept.value, environmentContext(repo, name)),
                stored: { kind: "Sensitive", ciphertext: kept.value },
              })
              break
            }
            case "Link": {
              const shared = yield* sharedRow(variable.sharedVariable)
              if (Option.isNone(shared)) {
                return yield* refuse(
                  `There is no shared variable ${variable.sharedVariable} to link as ${name}.`,
                )
              }
              variables.push({
                name,
                availableAtBuild: variable.availableAtBuild,
                value: yield* sharedValue(shared.value),
                stored: {
                  kind: "Link",
                  sharedName: shared.value.name,
                  sensitive: shared.value.kind === "Sensitive",
                },
              })
              break
            }
          }
        }

        const fields = draftFieldsOf(draft)
        const digest = buildDigest(fields, variables)
        const changesBuild = Option.isNone(current)
          ? true
          : buildDigest(recipeFieldsOf(current.value), yield* storedVariables(repo)) !== digest
        return {
          repo,
          recipe: recipeOf(fields, variables),
          values: valuesOf(variables),
          digest,
          changesBuild,
          sensitiveValues: sensitiveOf(variables),
          variables,
        }
      })

      const testBuildPassed = Effect.fn("Environments.testBuildPassed")(function* (
        repo: string,
        digest: string,
      ) {
        const rows = yield* sql<{ readonly id: string }>`
          SELECT id FROM test_builds
          WHERE repo = ${repo} AND digest = ${digest} AND result = 'Passed' LIMIT 1
        `
        return rows.length > 0
      })

      const apply = Effect.fn("Environments.apply")(
        function* (
          repo: string,
          baseVersion: EnvironmentVersion | null,
          draft: EnvironmentDraft,
          by: ParticipantId,
          at: number,
        ) {
          const current = yield* environmentRow(repo)
          const currentVersion = Option.isSome(current) ? current.value.version : null
          if (currentVersion !== baseVersion) {
            return yield* refuse(
              currentVersion === null
                ? `${repo} has no Environment to change yet; apply a new one.`
                : `${repo}'s Environment has changed since: version ${currentVersion} is the latest. Reload it, and apply your draft on top.`,
            )
          }
          const prepared = yield* prepare(repo, draft)
          if (prepared.changesBuild && !(yield* testBuildPassed(repo, prepared.digest))) {
            return yield* refuse(
              "This change affects the build: run a Test build of exactly this draft, and apply it once it passes.",
            )
          }

          const version = (currentVersion ?? 0) + 1
          const buildVersion =
            prepared.changesBuild || Option.isNone(current) ? version : current.value.buildVersion
          const fields = draftFieldsOf(draft)
          yield* sql`
            INSERT INTO environments (
              repo, version, build_version, image, bootstrap_script, start_script, docker,
              dependency_folders, cpus, memory_mib
            ) VALUES (
              ${repo}, ${version}, ${buildVersion}, ${fields.image}, ${fields.bootstrapScript},
              ${fields.startScript ?? null}, ${fields.docker ? 1 : 0},
              ${JSON.stringify(fields.dependencyFolders)}, ${fields.resources.cpus},
              ${fields.resources.memoryMib}
            )
            ON CONFLICT (repo) DO UPDATE SET
              version = excluded.version, build_version = excluded.build_version,
              image = excluded.image, bootstrap_script = excluded.bootstrap_script,
              start_script = excluded.start_script, docker = excluded.docker,
              dependency_folders = excluded.dependency_folders, cpus = excluded.cpus,
              memory_mib = excluded.memory_mib
          `
          const kept = new Set(prepared.sensitiveValues.map(Redacted.value))
          for (const value of sensitiveOf(yield* storedVariables(repo))) {
            if (!kept.has(Redacted.value(value))) yield* retire(repo, value, version)
          }
          yield* sql`DELETE FROM environment_variables WHERE repo = ${repo}`
          for (const [position, variable] of prepared.variables.entries()) {
            const { stored } = variable
            const value =
              stored.kind === "Plain"
                ? Redacted.value(variable.value)
                : stored.kind === "Sensitive"
                  ? (stored.ciphertext ??
                    (yield* secrets
                      .encrypt(variable.value, environmentContext(repo, variable.name))
                      .pipe(
                        Effect.mapError(
                          (error) => new EnvironmentRefused({ message: error.message }),
                        ),
                      )))
                  : null
            yield* sql`
              INSERT INTO environment_variables (
                repo, name, kind, value, shared_name, available_at_build, position
              ) VALUES (
                ${repo}, ${variable.name}, ${stored.kind}, ${value},
                ${stored.kind === "Link" ? stored.sharedName : null},
                ${variable.availableAtBuild ? 1 : 0}, ${position}
              )
            `
          }
          yield* sql`
            INSERT INTO environment_versions (repo, version, applied_by, applied_at, rebuilt)
            VALUES (${repo}, ${version}, ${by}, ${at}, ${buildVersion === version ? 1 : 0})
          `
        },
        (effect) => sql.withTransaction(effect),
      )

      const state = Effect.fn("Environments.state")(function* (repo: string) {
        const versions = (yield* sql<{
          readonly version: number
          readonly id: string
          readonly login: string
          readonly name: string
          readonly avatarUrl: string | null
          readonly appliedAt: number
          readonly rebuilt: number
        }>`
          SELECT v.version, p.id, p.login, p.name, p.avatar_url AS avatarUrl,
            v.applied_at AS appliedAt, v.rebuilt
          FROM environment_versions v JOIN participants p ON p.id = v.applied_by
          WHERE v.repo = ${repo} ORDER BY v.version DESC
        `).map((row): EnvironmentVersionInfo => ({
          version: EnvironmentVersion.make(row.version),
          appliedBy: toParticipant(row),
          appliedAt: row.appliedAt,
          rebuilt: row.rebuilt === 1,
        }))
        const row = yield* environmentRow(repo)
        if (Option.isNone(row)) return { environment: null, versions }
        const variables = (yield* variableRows(repo)).map((variable) => {
          const availableAtBuild = variable.availableAtBuild === 1
          switch (variable.kind) {
            case "Plain":
              return { _tag: "Plain" as const, name: variable.name, value: variable.value ?? "" }
            case "Sensitive":
              return { _tag: "Sensitive" as const, name: variable.name, availableAtBuild }
            case "Link":
              return {
                _tag: "Link" as const,
                name: variable.name,
                sharedVariable: variable.sharedName ?? "",
                availableAtBuild,
              }
          }
        })
        const environment: Environment = {
          repo,
          version: EnvironmentVersion.make(row.value.version),
          ...recipeFieldsOf(row.value),
          variables,
        }
        return { environment, versions }
      })

      const exists = Effect.fn("Environments.exists")(function* (repo: string) {
        return Option.isSome(yield* environmentRow(repo))
      })

      const forSession = Effect.fn("Environments.forSession")(function* (repo: string) {
        const row = yield* environmentRow(repo)
        if (Option.isNone(row)) return Option.none<SessionEnvironment>()
        const variables = (yield* variableRows(repo)).map((variable) => ({
          name: variable.name,
          availableAtBuild: variable.kind === "Plain" || variable.availableAtBuild === 1,
        }))
        return Option.some<SessionEnvironment>({
          version: EnvironmentVersion.make(row.value.version),
          buildVersion: EnvironmentVersion.make(row.value.buildVersion),
          recipe: { ...recipeFieldsOf(row.value), variables },
        })
      })

      const values = Effect.fn("Environments.values")(function* (repo: string) {
        return valuesOf(yield* storedVariables(repo))
      })

      const sensitiveValues = Effect.fn("Environments.sensitiveValues")(function* (repo: string) {
        // Retired values no Session can still have are dropped: only a running Claude Code
        // keeps the values it started with, as one woken or started anew fetches them again.
        yield* sql`
          DELETE FROM retired_values WHERE repo = ${repo} AND NOT EXISTS (
            SELECT 1 FROM sessions s
            WHERE s.repo = retired_values.repo AND s.state IN ('Active', 'Frozen')
              AND (s.environment_version IS NULL
                OR s.environment_version < retired_values.until_version)
          )
        `
        const retired = yield* sql<{ readonly value: string }>`
          SELECT value FROM retired_values WHERE repo = ${repo}
        `
        const sensitive = sensitiveOf(yield* storedVariables(repo))
        for (const row of retired) sensitive.push(yield* decrypt(row.value, retiredContext(repo)))
        return sensitive
      })

      const recordTestBuild = Effect.fn("Environments.recordTestBuild")(function* (
        build: NewTestBuild,
      ) {
        yield* sql`
          INSERT INTO test_builds (id, repo, runner_id, digest, started_by, started_at)
          VALUES (${build.id}, ${build.repo}, ${build.runnerId}, ${build.digest},
            ${build.startedBy}, ${build.startedAt})
        `
      })

      const finishTestBuild = Effect.fn("Environments.finishTestBuild")(function* (
        id: TestBuildId,
        result: TestBuildResult,
        at: number,
      ) {
        yield* sql`
          UPDATE test_builds SET result = ${result}, finished_at = ${at}
          WHERE id = ${id} AND result IS NULL
        `
      })

      const failUnfinishedTestBuilds = Effect.fn("Environments.failUnfinishedTestBuilds")(
        function* (at: number) {
          yield* sql`
            UPDATE test_builds SET result = 'Failed', finished_at = ${at} WHERE result IS NULL
          `
        },
      )

      const sharedVariables = Effect.gen(function* () {
        const links = yield* sql<{
          readonly sharedName: string
          readonly repo: string
          readonly name: string
          readonly availableAtBuild: number
        }>`
          SELECT shared_name AS sharedName, repo, name, available_at_build AS availableAtBuild
          FROM environment_variables WHERE kind = 'Link' ORDER BY repo, name
        `
        const rows = yield* sql<SharedRow>`
          SELECT name, kind, value FROM shared_variables ORDER BY name
        `
        return rows.map((row): SharedVariable => {
          const linkedBy = links
            .filter((link) => link.sharedName === row.name)
            .map((link) => ({
              repo: link.repo,
              name: link.name,
              availableAtBuild: link.availableAtBuild === 1,
            }))
          return row.kind === "Plain"
            ? { _tag: "Plain", name: row.name, value: row.value, linkedBy }
            : { _tag: "Sensitive", name: row.name, linkedBy }
        })
      }).pipe(Effect.withSpan("Environments.sharedVariables"))

      const linksTo = (name: string) => sql<{
        readonly repo: string
        readonly availableAtBuild: number
      }>`
        SELECT repo, available_at_build AS availableAtBuild FROM environment_variables
        WHERE kind = 'Link' AND shared_name = ${name} ORDER BY repo
      `

      const setSharedVariable = Effect.fn("Environments.setSharedVariable")(
        function* (input: SharedVariableInput, by: ParticipantId, at: number) {
          const { name } = input
          const nameProblem = variableNameProblem(name)
          if (nameProblem !== undefined) return yield* refuse(nameProblem)
          const existing = yield* sharedRow(name)

          let value: Redacted.Redacted<string> | undefined
          if (input._tag === "Plain") value = Redacted.make(input.value)
          else if (input.value !== undefined) value = input.value
          if (value !== undefined && Redacted.value(value).length > MaxVariableValueLength) {
            return yield* refuse(
              `The value of ${name} is over ${MaxVariableValueLength} characters.`,
            )
          }

          let stored: string
          if (input._tag === "Plain") {
            stored = input.value
          } else if (value === undefined) {
            if (Option.isNone(existing) || existing.value.kind !== "Sensitive") {
              return yield* refuse(`${name} has no saved Sensitive value: enter one.`)
            }
            stored = existing.value.value
          } else {
            if (!secrets.available) return yield* secretsUnavailable(name)
            if (Redacted.value(value).trim().length < MinSensitiveValueLength) {
              return yield* tooShort(name)
            }
            stored = yield* secrets
              .encrypt(value, sharedContext(name))
              .pipe(Effect.mapError((error) => new EnvironmentRefused({ message: error.message })))
          }

          if (Option.isSome(existing) && value !== undefined) {
            const before = Redacted.value(yield* sharedValue(existing.value))
            const atBuild = (yield* linksTo(name)).filter((link) => link.availableAtBuild === 1)
            if (before !== Redacted.value(value) && atBuild.length > 0) {
              const repos = [...new Set(atBuild.map((link) => link.repo))].join(", ")
              return yield* refuse(
                `${name} is available at build in ${repos}: a new value would change those builds without a Test build. Untick "available at build" on its links first, or link a new shared variable.`,
              )
            }
          }

          // A Sensitive value replaced is retired in every Repo linking it: their running
          // Sessions started with it. They are on the Repo's version as it is now, or older.
          if (
            Option.isSome(existing) &&
            existing.value.kind === "Sensitive" &&
            value !== undefined
          ) {
            const before = yield* sharedValue(existing.value)
            if (Redacted.value(before) !== Redacted.value(value)) {
              for (const repo of new Set((yield* linksTo(name)).map((link) => link.repo))) {
                const environment = yield* environmentRow(repo)
                const version = Option.isSome(environment) ? environment.value.version : 0
                yield* retire(repo, before, version + 1)
              }
            }
          }

          yield* sql`
            INSERT INTO shared_variables (name, kind, value, updated_by, updated_at)
            VALUES (${name}, ${input._tag}, ${stored}, ${by}, ${at})
            ON CONFLICT (name) DO UPDATE SET kind = excluded.kind, value = excluded.value,
              updated_by = excluded.updated_by, updated_at = excluded.updated_at
          `
        },
        (effect) => sql.withTransaction(effect),
      )

      const deleteSharedVariable = Effect.fn("Environments.deleteSharedVariable")(function* (
        name: string,
      ) {
        if (Option.isNone(yield* sharedRow(name))) {
          return yield* refuse(`There is no shared variable ${name}.`)
        }
        const links = yield* linksTo(name)
        if (links.length > 0) {
          const repos = [...new Set(links.map((link) => link.repo))].join(", ")
          return yield* refuse(`${name} is linked in ${repos}: remove those links first.`)
        }
        yield* sql`DELETE FROM shared_variables WHERE name = ${name}`
      })

      return Environments.of({
        state,
        exists,
        prepare,
        apply,
        forSession,
        values,
        sensitiveValues,
        testBuildPassed,
        recordTestBuild,
        finishTestBuild,
        failUnfinishedTestBuilds,
        sharedVariables,
        setSharedVariable,
        deleteSharedVariable,
      })
    }),
  )
}
