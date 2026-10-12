// `kndl onboard`: asks what Onboard.ts can't decide on its own, writes `hub.env` and
// `runner.env`, builds, and installs and starts the services. Every question has a flag; with
// `--non-interactive` (or no terminal) it never asks, and never loads the prompt library. The
// questions go through Ui, so the flow runs in tests against a script of answers.
//
// Every question comes before anything is written, and each file is written whole, so Ctrl-C at a
// question leaves the home as it was.
import { mkdir } from "node:fs/promises"
import { hostname, networkInterfaces, userInfo } from "node:os"
import { setupLinkNotice } from "@kndl/hub/src/Admin.ts"
import { generateSecretsKey } from "@kndl/hub/src/Secrets.ts"
import { type PairingTarget, parsePairing } from "@kndl/protocol"
import { Effect, Option } from "effect"
import {
  build,
  enableLinger,
  installPrerequisites,
  installService,
  issueToken,
  newSetupLink,
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
import { explainOldData, findOldData } from "./HomeData.ts"
import {
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
import { HubClient } from "./HubClient.ts"
import {
  type ConnectionCheck,
  connectionSettled,
  describeConnectionCheck,
  describePaired,
  shortHostname,
} from "./Join.ts"
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
  /**
   * A pairing link from the Hub's Runners page, `<hub-url>#<code>`, or a code alone with
   * `hubUrl`: the Runner redeems it for its token (`runner join`, `--pair`).
   */
  readonly pair: string | undefined
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
    yield* ui.intro(`kndl onboard, in ${layout.home.dir}`)

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
        "Services not installed (--no-services): `kndl hub install`, `kndl runner install`.",
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
    // A Hub without an Owner lets nobody in with GitHub but whoever brings its Setup link.
    if (roles.includes("hub") && signsInWithGitHub(layout) && !shell.dryRun) {
      const link = yield* newSetupLink(layout)
      if (Option.isSome(link)) yield* ui.note(setupLinkNotice(link.value), "Become the Owner")
    }
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
    // a kndl home, such as the home directory itself.
    const refused = refuseHome(homeFacts(layout))
    if (refused !== undefined) return yield* fail(refused)

    const hubValues = readEnvValues(layout.envFile("hub"))
    const runnerValues = readEnvValues(layout.envFile("runner"))

    // 1. Role. A pairing link sets up a Runner for a Hub elsewhere.
    if (options.pair !== undefined && options.role !== undefined && options.role !== "runner") {
      return yield* fail(
        `A pairing link sets up a Runner for a Hub elsewhere, so it goes with --role runner, not --role ${options.role}.`,
      )
    }
    const choice = yield* answer(
      pickAnswer({
        flag: options.pair === undefined ? options.role : "runner",
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
    const renames = yield* protectHome(layout, options.moveOldData)

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
    // A pairing link is redeemed for the token once every question is answered.
    let runner:
      | {
          name: string
          hubUrl: string
          token: string | undefined
          pairing?: PairingTarget
        }
      | undefined
    if (roles.includes("runner")) {
      const name =
        options.runnerName ??
        (options.reset ? undefined : runnerValues.RUNNER_NAME) ??
        shortHostname(hostname())
      const pairing = hub === undefined ? yield* askPairing(options, runnerValues) : undefined
      if (pairing !== undefined) {
        runner = { name, hubUrl: pairing.hubUrl, token: undefined, pairing }
      } else if (hub !== undefined) {
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
          "--pair '<link>' (from the Hub's Runners page), or --hub-url <url> and --token <token>",
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
          "--token <token> (from `kndl runner token <name>` on the Hub's machine)",
          () =>
            ui.password({
              message: `This Runner's token, from \`kndl runner token ${name}\` on the Hub's machine`,
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

    // 5. Redeem the pairing link, move the old data aside, and write the env files, each whole.
    // The code is redeemed before the prerequisites are installed and the Runner built, which can
    // take longer than its 15 minutes; with the token in runner.env, a later step that fails is
    // retried with `kndl onboard`, which keeps it, without a new code.
    if (runner?.pairing !== undefined) {
      const target = runner.pairing
      const client = yield* HubClient
      const name = runner.name
      const outcome = yield* ui.spin(
        `Pairing with ${target.hubUrl}`,
        () => client.pair(target, name),
        (done) => (done._tag === "Paired" ? `Paired as ${done.paired.name}` : "Not paired"),
      )
      if (outcome._tag === "Refused") return yield* fail(outcome.message)
      yield* ui.log("success", describePaired(outcome.paired, target.hubUrl))
      runner = { ...runner, name: outcome.paired.name, token: outcome.paired.token }
    }
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
          `Install ${created.slug} on the Repos kndl works in: ${created.installUrl}\nUntil then, the Hub has no Repos to offer.`,
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
 * The pairing link a Runner for a Hub elsewhere joins with: `--pair`'s; or, when nothing set this
 * Runner up before (or `--reset`) and no `--hub-url` or `--token` says otherwise, the person's
 * choice of a link over a token. `undefined` when the Runner gets a token instead.
 */
const askPairing = (options: OnboardOptions, runnerValues: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const ui = yield* Ui
    const check = (text: string) => parsePairing(text, options.hubUrl)
    let text = options.pair
    if (text === undefined) {
      const settled =
        options.token !== undefined ||
        options.hubUrl !== undefined ||
        (!options.reset && runnerValues.RUNNER_TOKEN !== undefined)
      if (settled || !ui.interactive) return undefined
      const how = yield* ui.select({
        message: "How does this Runner get its token?",
        choices: [
          {
            value: "pair" as const,
            label: "A pairing link, from the Hub's Runners page (Add a Runner)",
          },
          {
            value: "token" as const,
            label: "A Runner token, from `kndl runner token <name>` on the Hub's machine",
          },
        ],
      })
      if (how === "token") return undefined
      text = yield* ui.text({
        message: "The pairing link, from the Hub's Runners page (Add a Runner)",
        validate: (value) => {
          const parsed = check(value)
          return parsed._tag === "Invalid" ? parsed.message : undefined
        },
      })
    }
    const parsed = check(text)
    if (parsed._tag === "Invalid") return yield* fail(parsed.message)
    return parsed.target
  })

/**
 * Stops on kndl data in the home that this install didn't make (HomeData.ts), unless it is to
 * be moved aside: with `--move-old-data`, or when the person chooses to and confirms it. Returns the
 * renames for configure to make once every question is answered, or `undefined` when there's no
 * old data. Nothing is ever deleted.
 */
const protectHome = (layout: Layout, moveOldData: boolean) =>
  Effect.gen(function* () {
    const ui = yield* Ui
    const old = findOldData(homeDataFacts(layout))
    if (old === undefined) return undefined
    const renames = planMoveAside(layout, old.entries)
    const explanation = explainOldData(old, layout.home.dir, renames)
    const listed = renames.map((rename) => `${rename.from} → ${rename.to}`).join(", ")
    if (!moveOldData) {
      if (!ui.interactive) {
        return yield* fail(
          `${explanation}\n\nonboard can't ask, so it needs --move-old-data to move it aside.`,
        )
      }
      yield* ui.note(explanation, "Old kndl data")
      const choice = yield* ui.select({
        message: "What now?",
        choices: [
          { value: "move", label: "Move it aside", hint: listed },
          { value: "stop", label: "Stop, to set KNDL_HOME to another directory" },
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
          "Nothing was changed. Move the old data yourself, or set KNDL_HOME to another directory, and onboard again.",
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
          `Hub: ${result.url}/health: ${result.detail}. See \`kndl logs hub\` and \`kndl doctor\`.`,
        )
      }
    }
    if (roles.includes("runner")) {
      const said = yield* ui.spin(
        "Waiting for the Runner to connect",
        () => runnerConnected(layout, runnerLogFrom, 30),
        (result) => `Runner: ${result.said}`,
      )
      if (!said.ok) yield* ui.log("warn", `Runner: ${said.said}`)
    }
  })

/**
 * Waits up to `seconds` for the Hub to say it has the Runner connected, asking it with the
 * Runner's token. A Hub too old to say, or that this machine can't ask, leaves it to what the
 * Runner's log says after byte `logFrom`.
 */
const runnerConnected = (layout: Layout, logFrom: number, seconds: number) =>
  Effect.gen(function* () {
    const client = yield* HubClient
    const values = readEnvValues(layout.envFile("runner"))
    const { HUB_URL: hubUrl, RUNNER_TOKEN: token } = values
    let check: ConnectionCheck = { _tag: "Unsupported" }
    if (hubUrl !== undefined && token !== undefined) {
      for (let waited = 0; ; waited += 1) {
        check = yield* client.connection(hubUrl, token)
        if (connectionSettled(check) || waited >= seconds) break
        yield* Effect.sleep("1 second")
      }
    }
    if (check._tag === "Unsupported" || check._tag === "Unreachable") {
      const said = yield* runnerConnectionAfter(layout, logFrom, seconds)
      return { ok: said.startsWith("connected"), said }
    }
    return { ok: check._tag === "Online", said: describeConnectionCheck(check, seconds) }
  })

/** Whether this home's Hub has GitHub sign-in: the GitHub App's client id and secret. */
const signsInWithGitHub = (layout: Layout) => {
  const values = readEnvValues(layout.envFile("hub"))
  return values.GITHUB_CLIENT_ID !== undefined && values.GITHUB_CLIENT_SECRET !== undefined
}

function summary(layout: Layout, roles: ReadonlyArray<Role>): string {
  const lines: Array<string> = []
  if (roles.includes("hub")) {
    const values = readEnvValues(layout.envFile("hub"))
    lines.push(`The Hub: ${values.HUB_PUBLIC_URL ?? "(no HUB_PUBLIC_URL)"}`)
    lines.push(
      values.GITHUB_APP_ID === undefined
        ? "GitHub sign-in needs a GitHub App: `kndl onboard --github-app create` creates one. See https://kddige.github.io/kndl/self-hosting/set-up-the-github-app/."
        : "Install the GitHub App on the Repos kndl works in; `kndl doctor` checks its permissions.",
    )
    if (!signsInWithGitHub(layout)) {
      lines.push(
        "The Hub is invite-only: once GitHub sign-in is on, `kndl hub setup-link` prints the link you sign in with first, as its Owner.",
      )
    }
    lines.push(
      "Add a Runner on another machine: Add a Runner on the Hub's Runners page, and run the command it shows there.",
    )
  }
  lines.push("`kndl status` shows how things are; `kndl doctor` checks them.")
  return lines.join("\n")
}

/** Resolves one answer: given, asked with `ask`, or a failure naming the flag. */
const answer = <A, E, R>(picked: Answer<A>, flag: string, ask: () => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    if (picked._tag === "Given") return picked.value
    if (picked._tag === "Missing") return yield* fail(`onboard can't ask, so it needs ${flag}.`)
    return yield* ask()
  })
