// `claude-hub onboard`: asks what Onboard.ts can't decide on its own, writes `hub.env` and
// `runner.env`, builds, and installs and starts the services. Every question has a flag; with
// `--non-interactive` (or no terminal) it never asks, and never loads the prompt library. The
// questions go through Ui, so the flow runs in tests against a script of answers.
//
// Every question comes before anything is written, and each file is written whole, so Ctrl-C at a
// question leaves the home as it was.
import { mkdir } from "node:fs/promises"
import { hostname, networkInterfaces, userInfo } from "node:os"
import { generateSecretsKey } from "@claude-hub/hub/src/Secrets.ts"
import { Effect } from "effect"
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
import { type AppSetupChoice, AppSetupChoices, appEnvUpdates } from "./AppManifest.ts"
import { type AppPlan, AppSetupTitles, askAppPlan, createApp } from "./AppSetup.ts"
import { updateEnv } from "./EnvFile.ts"
import { fail } from "./Failure.ts"
import { refuseHome } from "./Guards.ts"
import { canMoveAside, explainOldData, findOldData } from "./HomeData.ts"
import {
  configuredRoles,
  homeDataFacts,
  homeFacts,
  hostFacts,
  moveAside,
  planMoveAside,
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
  type HubChoices,
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
import { plainUi, Ui } from "./Ui.ts"

/** Onboard's flags: each answers a question. */
export interface OnboardOptions {
  readonly role: RoleChoice | undefined
  readonly reach: Reach | undefined
  readonly port: number | undefined
  readonly publicUrl: string | undefined
  readonly insecureCookies: boolean | undefined
  readonly devLogin: boolean | undefined
  /** The GitHub App: create it from the manifest, paste its settings, or leave it. */
  readonly githubApp: AppSetupChoice | undefined
  readonly hubUrl: string | undefined
  readonly token: string | undefined
  readonly runnerName: string | undefined
  readonly installPrerequisites: boolean | undefined
  readonly services: boolean | undefined
  readonly linger: boolean | undefined
  readonly nonInteractive: boolean
  readonly reset: boolean
  /** Move old data in the home aside without asking: see HomeData.ts. */
  readonly moveOldData: boolean
}

const RoleChoiceTitles: Record<RoleChoice, string> = {
  hub: "Hub: serves the web UI, and the Runners connect to it",
  runner: "Runner: runs Sessions, for a Hub elsewhere",
  both: "Both: a Hub, and a Runner for it, on this machine",
}

/** Onboard: settings, prerequisites, builds, services. `--non-interactive` gets the plain Ui. */
export const onboard = (layout: Layout, options: OnboardOptions) => {
  const flow = Effect.gen(function* () {
    yield* requireInstall(layout)
    const on = yield* requirePlatform(platform())
    const ui = yield* Ui
    const shell = yield* Shell
    yield* ui.intro(`claude-hub onboard, in ${layout.home.dir}`)

    const roles = yield* configure(layout, options)

    const plan = prerequisitePlan(yield* hostFacts(layout), roles)
    yield* installPrerequisites(plan, { approved: options.installPrerequisites })
    for (const missing of plan.missing.filter((m) => !m.fixable)) {
      yield* ui.log("warn", `${missing.name}: ${missing.detail}`)
    }

    yield* Effect.promise(() => mkdir(layout.logs, { recursive: true }))
    yield* build(layout, roles)

    const services = options.services ?? true
    if (!services) {
      yield* ui.log(
        "info",
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
              interactive: ui.interactive,
              fallback: false,
            }),
            "--linger",
            () =>
              ui.confirm({
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

    yield* ui.note(summary(layout, roles), "Next")
    yield* ui.outro("Done.")
  })
  return options.nonInteractive ? flow.pipe(Effect.provideService(Ui, plainUi)) : flow
}

/**
 * Onboard's questions, and the env files their answers make: the role, the old data in the home,
 * the Hub's reach, the Runner's Hub and token. Asks everything before it writes anything. Returns
 * the roles set up.
 */
export const configure = (layout: Layout, options: OnboardOptions) =>
  Effect.gen(function* () {
    const ui = yield* Ui
    const interactive = ui.interactive

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
        ui.select({
          message: "What does this machine run?",
          choices: RoleChoices.map((value) => ({ value, label: RoleChoiceTitles[value] })),
        }),
    )
    const roles = rolesOf(choice)
    yield* ui.log("info", `Setting up: ${roles.map((role) => RoleTitle[role]).join(" and ")}`)

    // 2. Data in the home that isn't this install's: what to move aside, once all is answered.
    const renames = yield* protectHome(layout, roles, options.moveOldData)

    // 3. The Hub's questions.
    let hub: (HubChoices & { readonly app: AppPlan }) | undefined
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
          ui.select({
            message: "Who reaches this Hub?",
            choices: Reaches.map((value) => ({ value, label: ReachTitles[value] })),
          }),
      )
      const keep = existing !== undefined && !options.reset && existing.reach === reach
      const port = options.port ?? (keep ? existing.port : undefined) ?? DefaultPort
      const suggested = defaultPublicUrl(reach, port, lanAddress(networkInterfaces()))
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
          ui.text({
            message:
              reach === "https"
                ? "The Hub's public HTTPS URL, where browsers reach it"
                : "The Hub's URL on your network, where browsers reach it",
            ...(suggested === undefined ? {} : { initial: suggested }),
            validate: (value) => checkPublicUrl(reach, value),
          }),
      )
      const problem = checkPublicUrl(reach, publicUrl)
      if (problem !== undefined) return yield* fail(problem)

      let insecureCookies = false
      if (reach === "lan") {
        yield* ui.note(
          "Over plain HTTP on your network, browsers drop the Hub's Secure cookies and sign-in fails, unless HUB_INSECURE_COOKIES=1 drops Secure. Then sign-in tokens travel in cleartext: anyone who can watch the network can take over a sign-in. Only do it on a network you trust; prefer HTTPS, an SSH tunnel or Tailscale.",
          "Plain HTTP",
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
          () => ui.confirm({ message: "Set HUB_INSECURE_COOKIES=1?", initial: false }),
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
            ui.confirm({
              message:
                "Sign in without GitHub (dev login, this machine only), until the GitHub App is set up?",
              initial: true,
            }),
        )
      }
      const hasApp = hubValues.GITHUB_APP_ID !== undefined
      const appChoice = yield* answer(
        pickAnswer<AppSetupChoice>({
          flag: options.githubApp,
          // A home set up before keeps what it has: `--github-app create` makes one later.
          existing: existing === undefined ? undefined : "skip",
          reset: options.reset,
          interactive,
          fallback: "skip",
        }),
        "--github-app create|manual|skip",
        () =>
          ui.select({
            message: "GitHub sign-in, and Repos' tokens, need a GitHub App. Set it up now?",
            choices: AppSetupChoices.map((value) => ({
              value,
              label: AppSetupTitles(hasApp)[value],
            })),
            initial: hasApp ? "skip" : "create",
          }),
      )
      const app = yield* askAppPlan(appChoice)
      hub = { reach, port, publicUrl, insecureCookies, devLogin, app }
    }

    // 4. The Runner's questions. With the Hub on this machine, the Runner reaches it on loopback,
    // and its token is issued directly once hub.env is written.
    let runner: { name: string; hubUrl: string; token: string | undefined } | undefined
    if (roles.includes("runner")) {
      const name =
        options.runnerName ??
        (options.reset ? undefined : runnerValues.RUNNER_NAME) ??
        hostname().split(".")[0] ??
        "runner"
      if (hub !== undefined) {
        const hubUrl = localHubUrl(hub.port)
        const kept =
          !options.reset &&
          options.token === undefined &&
          runnerValues.HUB_URL === hubUrl &&
          (options.runnerName === undefined || options.runnerName === runnerValues.RUNNER_NAME)
        runner = {
          name,
          hubUrl,
          token: options.token ?? (kept ? runnerValues.RUNNER_TOKEN : undefined),
        }
      } else {
        const hubUrl = yield* answer(
          pickAnswer({
            flag: options.hubUrl,
            existing: runnerValues.HUB_URL,
            reset: options.reset,
            interactive,
          }),
          "--hub-url <url>",
          () =>
            ui.text({
              message: "The Hub's URL, as this machine reaches it",
              validate: (value) =>
                checkPublicUrl("local", value) === undefined
                  ? undefined
                  : `${value} isn't an http or https URL.`,
            }),
        )
        if (checkPublicUrl("local", hubUrl) !== undefined) {
          return yield* fail(`--hub-url ${hubUrl} isn't an http or https URL.`)
        }
        const token = yield* answer(
          pickAnswer({
            flag: options.token,
            existing: runnerValues.RUNNER_TOKEN,
            reset: options.reset,
            interactive,
          }),
          "--token <token> (from `claude-hub runner token <name>` on the Hub's machine)",
          () =>
            ui.password({
              message: `This Runner's token, from \`claude-hub runner token ${name}\` on the Hub's machine`,
              validate: checkRunnerToken,
            }),
        )
        runner = { name, hubUrl, token }
      }
      if (runner.token !== undefined) {
        const tokenProblem = checkRunnerToken(runner.token)
        if (tokenProblem !== undefined) return yield* fail(tokenProblem)
      }
    }

    // 5. Move the old data aside, and write the env files, each whole.
    if (renames !== undefined) {
      yield* moveAside(layout, renames)
      yield* ui.log(
        "success",
        `Moved aside, in ${layout.home.dir}: ${renames.map((r) => `${r.from} → ${r.to}`).join(", ")}`,
      )
    }
    if (hub !== undefined) {
      // GitHub hands out a new App's credentials once: they're saved as soon as they come.
      const created =
        hub.app._tag === "Create"
          ? yield* createApp(layout, hub.publicUrl, hub.app.owner, platform() ?? "linux")
          : undefined
      const appSettings = hub.app._tag === "Manual" ? hub.app.settings : created?.settings
      const existingKey = hubValues.HUB_SECRETS_KEY
      yield* writeEnvFile(
        layout.envFile("hub"),
        updateEnv(readEnvFile(layout.envFile("hub")), {
          ...hubEnvUpdates(hub, existingKey ?? generateSecretsKey()),
          ...(appSettings === undefined ? {} : appEnvUpdates(appSettings)),
        }),
      )
      yield* ui.log(
        "step",
        `wrote ${layout.envFile("hub")}${appSettings === undefined ? "" : `, with the GitHub App ${appSettings.appId}`}`,
      )
      if (created !== undefined) {
        yield* ui.note(
          `Install ${created.slug} on the Repos claude-hub works in: ${created.installUrl}\nUntil then, the Hub has no Repos to offer.`,
          "Install the GitHub App",
        )
      }
      if (existingKey === undefined) {
        yield* ui.note(
          `A new HUB_SECRETS_KEY is in ${layout.envFile("hub")}. Back it up together with ${layout.hubDb}: without it, the Sensitive values saved in the database can't be read, and the Hub won't start.`,
          "Back up the secrets key",
        )
      }
    }
    if (runner !== undefined) {
      let token = runner.token
      if (token === undefined) {
        const issued = yield* issueToken(layout, runner.name)
        yield* ui.log("step", `issued a token for Runner ${issued.name} (${issued.runnerId})`)
        token = issued.token
      }
      yield* writeEnvFile(
        layout.envFile("runner"),
        updateEnv(
          readEnvFile(layout.envFile("runner")),
          runnerEnvUpdates({ hubUrl: runner.hubUrl, token: token.trim(), name: runner.name }),
        ),
      )
      yield* ui.log("step", `wrote ${layout.envFile("runner")}`)
    }
    return roles
  })

/**
 * Stops on claude-hub data in the home that this install didn't make (HomeData.ts), unless it is to
 * be moved aside: with `--move-old-data`, or when the person chooses to and confirms it. Returns the
 * renames for configure to make once every question is answered, or `undefined` when there's no
 * old data. Nothing is ever deleted.
 */
const protectHome = (layout: Layout, roles: ReadonlyArray<Role>, moveOldData: boolean) =>
  Effect.gen(function* () {
    const ui = yield* Ui
    const setUp = configuredRoles(layout)
    const facts = yield* homeDataFacts(layout, {
      tmux: roles.includes("runner") && !setUp.includes("runner"),
    })
    const old = findOldData(facts, roles)
    if (old === undefined) return undefined
    const renames = planMoveAside(layout, old.entries)
    const explanation = explainOldData(old, layout.home.dir, renames)
    if (!canMoveAside(old)) return yield* fail(explanation)
    const listed = renames.map((rename) => `${rename.from} → ${rename.to}`).join(", ")
    if (!moveOldData) {
      if (!ui.interactive) {
        return yield* fail(
          `${explanation}\n\nonboard can't ask, so it needs --move-old-data to move it aside.`,
        )
      }
      yield* ui.note(explanation, "Old claude-hub data")
      const choice = yield* ui.select({
        message: "What now?",
        choices: [
          { value: "move", label: "Move it aside", hint: listed },
          { value: "stop", label: "Stop, to set CLAUDE_HUB_HOME to another directory" },
        ],
      })
      const confirmed =
        choice === "move" &&
        (yield* ui.confirm({
          message: `Rename ${listed}, in ${layout.home.dir}?`,
          initial: false,
        }))
      if (!confirmed) {
        return yield* fail(
          "Nothing was changed. Move the old data yourself, or set CLAUDE_HUB_HOME to another directory, and onboard again.",
        )
      }
    }
    return renames
  })

/** After the services start: the Hub answers `/health`, and the Runner says it connected. */
const healthCheck = (layout: Layout, roles: ReadonlyArray<Role>, runnerLogFrom: number) =>
  Effect.gen(function* () {
    const ui = yield* Ui
    if ((yield* Shell).dryRun) {
      yield* ui.log(
        "info",
        "[dry run] the services weren't started, so their health isn't checked.",
      )
      return
    }
    if (roles.includes("hub")) {
      const result = yield* ui.spin(
        "Waiting for the Hub to answer",
        () => waitForHub(layout),
        (answered) => (answered.ok ? `Hub: ${answered.url}/health answers` : "Hub: no answer"),
      )
      if (!result.ok) {
        yield* ui.log(
          "warn",
          `Hub: ${result.url}/health: ${result.detail}. See \`claude-hub logs hub\` and \`claude-hub doctor\`.`,
        )
      }
    }
    if (roles.includes("runner")) {
      yield* ui.spin(
        "Waiting for the Runner to connect",
        () => runnerConnectionAfter(layout, runnerLogFrom, 30),
        (said) => `Runner: ${said}`,
      )
    }
  })

function summary(layout: Layout, roles: ReadonlyArray<Role>): string {
  const lines: Array<string> = []
  if (roles.includes("hub")) {
    const values = readEnvValues(layout.envFile("hub"))
    lines.push(`The Hub: ${values.HUB_PUBLIC_URL ?? "(no HUB_PUBLIC_URL)"}`)
    lines.push(
      values.GITHUB_APP_ID === undefined
        ? "GitHub sign-in needs a GitHub App: `claude-hub onboard --github-app create` creates one. See https://kddige.github.io/claude-hub/how-to/set-up-the-github-app/."
        : "Install the GitHub App on the Repos claude-hub works in; `claude-hub doctor` checks its permissions.",
    )
    lines.push(
      "Add a Runner on another machine: `claude-hub runner token <name>` here, then `claude-hub onboard --role runner` there.",
    )
  }
  lines.push("`claude-hub status` shows how things are; `claude-hub doctor` checks them.")
  return lines.join("\n")
}

/** Resolves one answer: given, asked with `ask`, or a failure naming the flag. */
const answer = <A, E, R>(picked: Answer<A>, flag: string, ask: () => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    if (picked._tag === "Given") return picked.value
    if (picked._tag === "Missing") return yield* fail(`onboard can't ask, so it needs ${flag}.`)
    return yield* ask()
  })
