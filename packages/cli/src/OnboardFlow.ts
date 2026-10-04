// `claude-hub onboard`: asks what Onboard.ts can't decide on its own, writes `hub.env` and
// `runner.env`, builds, and installs and starts the services. Every question has a flag; with
// `--non-interactive` (or no terminal) it never asks.
import { mkdir } from "node:fs/promises"
import { hostname, networkInterfaces, userInfo } from "node:os"
import { generateSecretsKey } from "@claude-hub/hub/src/Secrets.ts"
import { Console, Effect, Redacted } from "effect"
import { Prompt } from "effect/cli"
import {
  build,
  enableLinger,
  installPrerequisites,
  installService,
  issueToken,
  requireInstall,
  requirePlatform,
  RoleTitle,
  waitForHub,
} from "./Actions.ts"
import { updateEnv } from "./EnvFile.ts"
import { fail } from "./Failure.ts"
import { refuseHome } from "./Guards.ts"
import {
  canAsk,
  homeFacts,
  hostFacts,
  platform,
  readEnvFile,
  readEnvValues,
  writeEnvFile,
} from "./Host.ts"
import type { Layout, Role } from "./Layout.ts"
import {
  type Answer,
  checkPublicUrl,
  checkRunnerToken,
  DefaultPort,
  defaultPublicUrl,
  existingRole,
  hubChoicesFrom,
  hubEnvUpdates,
  lanAddress,
  localHubUrl,
  pickAnswer,
  type Reach,
  Reaches,
  ReachTitles,
  RoleChoices,
  type RoleChoice,
  rolesOf,
  runnerEnvUpdates,
} from "./Onboard.ts"
import { prerequisitePlan } from "./Prerequisites.ts"
import { lingers, lingerStatusStep } from "./Services.ts"
import { Shell } from "./Shell.ts"
import { runnerConnectionAfter, runnerLogSize } from "./Status.ts"

/** Onboard's flags: each answers a question. */
export interface OnboardOptions {
  readonly role: RoleChoice | undefined
  readonly reach: Reach | undefined
  readonly port: number | undefined
  readonly publicUrl: string | undefined
  readonly insecureCookies: boolean | undefined
  readonly devLogin: boolean | undefined
  readonly hubUrl: string | undefined
  readonly token: string | undefined
  readonly runnerName: string | undefined
  readonly installPrerequisites: boolean | undefined
  readonly services: boolean | undefined
  readonly linger: boolean | undefined
  readonly nonInteractive: boolean
  readonly reset: boolean
}

const RoleChoiceTitles: Record<RoleChoice, string> = {
  hub: "Hub: serves the web UI, and the Runners connect to it",
  runner: "Runner: runs Sessions, for a Hub elsewhere",
  both: "Both: a Hub, and a Runner for it, on this machine",
}

export const onboard = (layout: Layout, options: OnboardOptions) =>
  Effect.gen(function* () {
    yield* requireInstall(layout)
    const on = yield* requirePlatform(platform())
    const interactive = canAsk(options.nonInteractive)
    const shell = yield* Shell

    // Onboard writes the home's env files, and `--reset` rewrites them: never somewhere that isn't
    // a claude-hub home, such as the home directory itself.
    const refused = refuseHome(homeFacts(layout))
    if (refused !== undefined) return yield* fail(refused)

    const hubValues = readEnvValues(layout.envFile("hub"))
    const runnerValues = readEnvValues(layout.envFile("runner"))

    // 1. Role.
    const choice = yield* answer(
      pickAnswer({
        flag: options.role,
        existing: existingRole(
          hubValues.HUB_PUBLIC_URL !== undefined,
          runnerValues.RUNNER_TOKEN !== undefined,
        ),
        reset: options.reset,
        interactive,
      }),
      "--role hub|runner|both",
      () =>
        Prompt.Select({
          message: "What does this machine run?",
          choices: RoleChoices.map((value) => ({ title: RoleChoiceTitles[value], value })),
        }),
    )
    const roles = rolesOf(choice)
    yield* Console.log(
      `Setting up: ${roles.map((role) => RoleTitle[role]).join(" and ")}, in ${layout.home.dir}`,
    )

    // 2. Prerequisites.
    const plan = prerequisitePlan(yield* hostFacts(layout), roles)
    yield* installPrerequisites(plan, { approved: options.installPrerequisites, interactive })
    for (const missing of plan.missing.filter((m) => !m.fixable)) {
      yield* Console.log(`! ${missing.name}: ${missing.detail}`)
    }

    yield* Effect.promise(() => mkdir(layout.logs, { recursive: true }))

    // 3. Hub.
    let hubPort = DefaultPort
    if (roles.includes("hub")) {
      const existing = hubChoicesFrom(hubValues)
      const reach = yield* answer(
        pickAnswer({
          flag: options.reach,
          existing: existing?.reach,
          reset: options.reset,
          interactive,
        }),
        "--reach local|lan|https",
        () =>
          Prompt.Select({
            message: "Who reaches this Hub?",
            choices: Reaches.map((value) => ({ title: ReachTitles[value], value })),
          }),
      )
      const keep = existing !== undefined && !options.reset && existing.reach === reach
      hubPort = options.port ?? (keep ? existing.port : undefined) ?? DefaultPort
      const suggested = defaultPublicUrl(reach, hubPort, lanAddress(networkInterfaces()))
      const publicUrl = yield* answer(
        pickAnswer({
          flag: options.publicUrl,
          existing: keep ? existing.publicUrl : undefined,
          reset: options.reset,
          interactive: interactive && reach !== "local",
          fallback: suggested,
        }),
        "--public-url <url>",
        () =>
          Prompt.String({
            message:
              reach === "https"
                ? "The Hub's public HTTPS URL, where browsers reach it"
                : "The Hub's URL on your network, where browsers reach it",
            ...(suggested === undefined ? {} : { default: suggested }),
            validate: (value) => {
              const problem = checkPublicUrl(reach, value)
              return problem === undefined ? Effect.succeed(value) : Effect.fail(problem)
            },
          }),
      )
      const problem = checkPublicUrl(reach, publicUrl)
      if (problem !== undefined) return yield* fail(problem)

      let insecureCookies = false
      if (reach === "lan") {
        yield* Console.log(
          "Over plain HTTP on your network, browsers drop the Hub's Secure cookies and sign-in fails, unless HUB_INSECURE_COOKIES=1 drops Secure. Then sign-in tokens travel in cleartext: anyone who can watch the network can take over a sign-in. Only do it on a network you trust; prefer HTTPS, an SSH tunnel or Tailscale.",
        )
        insecureCookies = yield* answer(
          pickAnswer({
            flag: options.insecureCookies,
            existing: keep ? existing.insecureCookies : undefined,
            reset: options.reset,
            interactive,
            fallback: false,
          }),
          "--insecure-cookies",
          () => Prompt.Confirm({ message: "Set HUB_INSECURE_COOKIES=1?", initial: false }),
        )
      }
      let devLogin = false
      if (reach === "local") {
        devLogin = yield* answer(
          pickAnswer({
            flag: options.devLogin,
            existing: keep ? existing.devLogin : undefined,
            reset: options.reset,
            interactive,
            fallback: false,
          }),
          "--dev-login",
          () =>
            Prompt.Confirm({
              message:
                "Sign in without GitHub (dev login, this machine only), until the GitHub App is set up?",
              initial: true,
            }),
        )
      }

      const existingKey = hubValues.HUB_SECRETS_KEY
      const secretsKey = existingKey ?? generateSecretsKey()
      yield* writeEnvFile(
        layout.envFile("hub"),
        updateEnv(
          readEnvFile(layout.envFile("hub")),
          hubEnvUpdates({ reach, port: hubPort, publicUrl, insecureCookies, devLogin }, secretsKey),
        ),
      )
      yield* Console.log(`- wrote ${layout.envFile("hub")}`)
      if (existingKey === undefined) {
        yield* Console.log(
          `\nA new HUB_SECRETS_KEY is in ${layout.envFile("hub")}. Back it up together with ${layout.hubDb}: without it, the Sensitive values saved in the database can't be read, and the Hub won't start.\n`,
        )
      }
    }

    // 4. Runner.
    if (roles.includes("runner")) {
      const name =
        options.runnerName ??
        (options.reset ? undefined : runnerValues.RUNNER_NAME) ??
        hostname().split(".")[0] ??
        "runner"
      let hubUrl: string
      let token: string
      if (roles.includes("hub")) {
        // The Hub is on this machine: reach it on loopback, and issue the token directly.
        hubUrl = localHubUrl(hubPort)
        const kept =
          !options.reset &&
          options.token === undefined &&
          runnerValues.RUNNER_TOKEN !== undefined &&
          runnerValues.HUB_URL === hubUrl &&
          (options.runnerName === undefined || options.runnerName === runnerValues.RUNNER_NAME)
        if (kept && runnerValues.RUNNER_TOKEN !== undefined) {
          token = runnerValues.RUNNER_TOKEN
        } else if (options.token !== undefined) {
          token = options.token
        } else {
          const issued = yield* issueToken(layout, name)
          yield* Console.log(`- issued a token for Runner ${issued.name} (${issued.runnerId})`)
          token = issued.token
        }
      } else {
        hubUrl = yield* answer(
          pickAnswer({
            flag: options.hubUrl,
            existing: runnerValues.HUB_URL,
            reset: options.reset,
            interactive,
          }),
          "--hub-url <url>",
          () =>
            Prompt.String({
              message: "The Hub's URL, as this machine reaches it",
              validate: (value) =>
                checkPublicUrl("local", value) === undefined
                  ? Effect.succeed(value)
                  : Effect.fail(`${value} isn't an http or https URL.`),
            }),
        )
        if (checkPublicUrl("local", hubUrl) !== undefined) {
          return yield* fail(`--hub-url ${hubUrl} isn't an http or https URL.`)
        }
        token = yield* answer(
          pickAnswer({
            flag: options.token,
            existing: runnerValues.RUNNER_TOKEN,
            reset: options.reset,
            interactive,
          }),
          "--token <token> (from `claude-hub runner token <name>` on the Hub's machine)",
          () =>
            Prompt.Password({
              message: `This Runner's token, from \`claude-hub runner token ${name}\` on the Hub's machine`,
              validate: (value) => {
                const problem = checkRunnerToken(value)
                return problem === undefined ? Effect.succeed(value) : Effect.fail(problem)
              },
            }).pipe(Prompt.map(Redacted.value)),
        )
      }
      const tokenProblem = checkRunnerToken(token)
      if (tokenProblem !== undefined) return yield* fail(tokenProblem)
      yield* writeEnvFile(
        layout.envFile("runner"),
        updateEnv(
          readEnvFile(layout.envFile("runner")),
          runnerEnvUpdates({ hubUrl, token: token.trim(), name }),
        ),
      )
      yield* Console.log(`- wrote ${layout.envFile("runner")}`)
    }

    // Build what the roles run.
    yield* build(layout, roles)

    // 5. Services.
    const services = options.services ?? true
    if (!services) {
      yield* Console.log(
        "Services not installed (--no-services): `claude-hub hub install`, `claude-hub runner install`.",
      )
    } else {
      const runnerLogFrom = runnerLogSize(layout)
      for (const role of roles) yield* installService(layout, role, on)
      if (on === "linux") {
        const user = userInfo().username
        const already = shell.dryRun
          ? false
          : lingers(
              (yield* shell
                .capture(lingerStatusStep(user))
                .pipe(Effect.orElseSucceed(() => ({ exitCode: 1, stdout: "", stderr: "" }))))
                .stdout,
            )
        if (!already) {
          const linger = yield* answer(
            pickAnswer({
              flag: options.linger,
              existing: undefined,
              reset: false,
              interactive,
              fallback: false,
            }),
            "--linger",
            () =>
              Prompt.Confirm({
                message:
                  "Keep the services running while you're logged out, and start them at boot (loginctl enable-linger)?",
                initial: true,
              }),
          )
          if (linger) yield* enableLinger
        }
      }
      yield* healthCheck(layout, roles, runnerLogFrom)
    }

    yield* Console.log(summary(layout, roles))
  })

/** After the services start: the Hub answers `/health`, and the Runner says it connected. */
const healthCheck = (layout: Layout, roles: ReadonlyArray<Role>, runnerLogFrom: number) =>
  Effect.gen(function* () {
    if ((yield* Shell).dryRun) {
      yield* Console.log("[dry run] the services weren't started, so their health isn't checked.")
      return
    }
    if (roles.includes("hub")) {
      const result = yield* waitForHub(layout)
      yield* Console.log(
        result.ok
          ? `Hub: ${result.url}/health answers.`
          : `Hub: ${result.url}/health: ${result.detail}. See \`claude-hub logs hub\` and \`claude-hub doctor\`.`,
      )
    }
    if (roles.includes("runner")) {
      yield* Console.log(`Runner: ${yield* runnerConnectionAfter(layout, runnerLogFrom, 30)}`)
    }
  })

function summary(layout: Layout, roles: ReadonlyArray<Role>): string {
  const lines = ["", "Done."]
  if (roles.includes("hub")) {
    const values = readEnvValues(layout.envFile("hub"))
    lines.push(`The Hub: ${values.HUB_PUBLIC_URL ?? "(no HUB_PUBLIC_URL)"}`)
    lines.push(
      "GitHub sign-in needs a GitHub App, which you set up by hand for now: see https://kddige.github.io/claude-hub/how-to/set-up-the-github-app/ and put its settings in hub.env.",
    )
    lines.push(
      "Add a Runner on another machine: `claude-hub runner token <name>` here, then `claude-hub onboard --role runner` there.",
    )
  }
  lines.push("`claude-hub status` shows how things are; `claude-hub doctor` checks them.")
  return lines.join("\n")
}

/** Resolves one answer: given, asked with `prompt`, or a failure naming the flag. */
const answer = <A>(picked: Answer<A>, flag: string, prompt: () => Prompt.Prompt<A>) =>
  Effect.gen(function* () {
    if (picked._tag === "Given") return picked.value
    if (picked._tag === "Missing") return yield* fail(`onboard can't ask, so it needs ${flag}.`)
    return yield* prompt()
  })
