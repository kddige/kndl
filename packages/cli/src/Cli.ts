// The `kndl` command tree. Each command resolves the home (Layout.ts) and hands off to the
// module that does the work; a command that ends badly sets the exit code.
import { runnerTokenNotice, secretsKeyNotice, setupLinkNotice } from "@kndl/hub/src/Admin.ts"
import { hasOwnerMessage } from "@kndl/hub/src/Members.ts"
import { Console, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import {
  installService,
  issueToken,
  newSetupLink,
  requireInstall,
  requirePlatform,
  resetHubSecrets,
  RoleTitle,
  startService,
  stopService,
} from "./Actions.ts"
import { AppSetupChoices } from "./AppManifest.ts"
import { cliConfigPath } from "./CliConfig.ts"
import { fail } from "./Failure.ts"
import { forward } from "./Forward.ts"
import { configuredRoles, platform, serviceState, serviceTarget } from "./Host.ts"
import { requireCheckoutCli } from "./InstallGate.ts"
import { resolveLayout, type Role, Roles } from "./Layout.ts"
import { login, loginContext, logout, whoami } from "./Login.ts"
import { doctor, uninstall, update } from "./Maintain.ts"
import { type RoleChoice, RoleChoices, type Reach, Reaches } from "./Onboard.ts"
import { onboard } from "./OnboardFlow.ts"
import { describeServiceState } from "./Services.ts"
import { Shell, step } from "./Shell.ts"
import { status } from "./Status.ts"
import { Channels } from "./Update.ts"

/** Sets the exit code when a command reports that something is wrong. */
const exitWith = (ok: boolean) =>
  Effect.sync(() => {
    if (!ok) process.exitCode = 1
  })

const layout = () => resolveLayout()

const optional = <A>(flag: Flag.Flag<A>) =>
  flag.pipe(Flag.optional, Flag.map(Option.getOrUndefined))

/**
 * For a command that sets up or runs a Hub or a Runner: a binary installed from a Hub refuses it,
 * saying it needs a kndl install (InstallGate.ts).
 */
const operator =
  (command: string) =>
  <const Name extends string, Input, ContextInput, E, R>(
    self: Command.Command<Name, Input, ContextInput, E, R>,
  ) =>
    Command.provideEffectDiscard(self, requireCheckoutCli(command))

/** A switch: off unless given. */
const off = (name: string) => Flag.Boolean(name).pipe(Flag.withDefault(false))

const yes = off("yes").pipe(Flag.withAlias("y"), Flag.withDescription("Don't ask for confirmation"))

const onboardCommand = Command.make(
  "onboard",
  {
    role: optional(
      Flag.Literals("role", RoleChoices).pipe(
        Flag.withDescription("What this machine runs: hub, runner or both"),
      ),
    ),
    reach: optional(
      Flag.Literals("reach", Reaches).pipe(
        Flag.withDescription(
          "Who reaches the Hub: local (127.0.0.1), lan (0.0.0.0, plain HTTP) or https (behind a proxy or tunnel)",
        ),
      ),
    ),
    port: optional(Flag.Int("port").pipe(Flag.withDescription("The Hub's port (7777)"))),
    publicUrl: optional(
      Flag.String("public-url").pipe(
        Flag.withDescription("Where browsers reach the Hub (HUB_PUBLIC_URL)"),
      ),
    ),
    insecureCookies: optional(
      Flag.Boolean("insecure-cookies").pipe(
        Flag.withDescription(
          "lan: drop Secure from the Hub's cookies, so sign-in works over plain HTTP",
        ),
      ),
    ),
    devLogin: optional(
      Flag.Boolean("dev-login").pipe(Flag.withDescription("local: sign in without GitHub")),
    ),
    githubApp: optional(
      Flag.Literals("github-app", AppSetupChoices).pipe(
        Flag.withDescription(
          "The GitHub App: create it on GitHub from kndl's manifest, paste a manual one's settings, or skip",
        ),
      ),
    ),
    hubUrl: optional(
      Flag.String("hub-url").pipe(
        Flag.withDescription("A Runner's Hub, as the Runner reaches it (HUB_URL)"),
      ),
    ),
    token: optional(
      Flag.String("token").pipe(
        Flag.withDescription("A Runner's token, from `kndl runner token <name>`"),
      ),
    ),
    pair: optional(
      Flag.String("pair").pipe(
        Flag.withDescription(
          "A Runner's pairing link, from the Hub's Runners page (Add a Runner), instead of --hub-url and --token",
        ),
      ),
    ),
    runnerName: optional(
      Flag.String("runner-name").pipe(
        Flag.withDescription("The Runner's name (the short hostname)"),
      ),
    ),
    installPrerequisites: optional(
      Flag.Boolean("install-prerequisites").pipe(
        Flag.withDescription("Install what's missing without asking (may use sudo)"),
      ),
    ),
    services: optional(
      Flag.Boolean("services").pipe(Flag.withDescription("Install and start the services (yes)")),
    ),
    linger: optional(
      Flag.Boolean("linger").pipe(
        Flag.withDescription("Linux: keep the services running while you're logged out"),
      ),
    ),
    nonInteractive: off("non-interactive").pipe(
      Flag.withDescription("Never ask: an answer with no flag takes its default, or fails"),
    ),
    reset: off("reset").pipe(
      Flag.withDescription("Ask again instead of keeping the existing settings"),
    ),
    moveOldData: off("move-old-data").pipe(
      Flag.withDescription(
        "Rename kndl data the home holds without its env file (sessions, claude-code, hub.db) to <name>.old-<YYYYMMDD>, keeping it",
      ),
    ),
  },
  (options) =>
    onboard(layout(), {
      ...options,
      role: options.role as RoleChoice | undefined,
      reach: options.reach as Reach | undefined,
    }),
).pipe(
  operator("onboard"),
  Command.withDescription("Set up a Hub, a Runner, or both on this machine, as services"),
)

const statusCommand = Command.make("status", {}, () =>
  Effect.flatMap(status(layout()), exitWith),
).pipe(
  operator("status"),
  Command.withDescription("What's installed, which services run, and the Hub and Runner"),
)

/** The role a command acts on: the one given, or the only one set up here. */
const pickRole = (given: Role | undefined) =>
  Effect.gen(function* () {
    if (given !== undefined) return given
    const roles = configuredRoles(layout())
    if (roles.length === 1 && roles[0] !== undefined) return roles[0]
    return yield* fail("Say which: hub or runner.")
  })

const logsCommand = Command.make(
  "logs",
  {
    role: Argument.Literals("role", Roles).pipe(
      Argument.optional,
      Argument.map(Option.getOrUndefined),
    ),
    follow: off("follow").pipe(
      Flag.withAlias("f"),
      Flag.withDescription("Keep printing as it logs"),
    ),
    lines: Flag.Int("lines").pipe(
      Flag.withAlias("n"),
      Flag.withDefault(100),
      Flag.withDescription("How many of the last lines to print"),
    ),
  },
  ({ role, follow, lines }) =>
    Effect.gen(function* () {
      yield* requireInstall(layout())
      const which = yield* pickRole(role)
      const file = layout().logFile(which)
      const args = ["-n", String(lines), ...(follow ? ["-F"] : []), file]
      yield* (yield* Shell).attached(step("tail", args, { mayFail: true }))
    }),
).pipe(operator("logs"), Command.withDescription("Print the Hub's or Runner's log"))

const doctorCommand = Command.make(
  "doctor",
  { fix: off("fix").pipe(Flag.withDescription("Repair what can be repaired")), yes },
  (options) => Effect.flatMap(doctor(layout(), options), exitWith),
).pipe(
  operator("doctor"),
  Command.withDescription("Check the install, its configuration and its services"),
)

const updateCommand = Command.make(
  "update",
  {
    ref: optional(
      Flag.String("ref").pipe(
        Flag.withAlias("branch"),
        Flag.withDescription("A branch to follow, or a tag or commit to pin to"),
      ),
    ),
    channel: optional(
      Flag.Literals("channel", Channels).pipe(
        Flag.withDescription("Follow stable (the latest Release) or dev (main) from now on"),
      ),
    ),
    noUpdateRunners: off("no-update-runners").pipe(
      Flag.withDescription(
        "On the Hub's machine: leave Runners on other machines on their commit (the Runner here still follows)",
      ),
    ),
    now: off("now").pipe(
      Flag.withDescription(
        "Runners updating stop their running Turns at once, rather than letting them end",
      ),
    ),
  },
  ({ ref, channel, noUpdateRunners, now }) =>
    Effect.flatMap(
      update(layout(), { ref, channel, updateRunners: !noUpdateRunners, now }),
      exitWith,
    ),
).pipe(
  operator("update"),
  Command.withAlias("upgrade"),
  Command.withDescription("Update the install, rebuild, and restart its services"),
)

const uninstallCommand = Command.make(
  "uninstall",
  {
    purge: off("purge").pipe(
      Flag.withDescription(
        "Remove the whole home too: the Hub's database, its key, the Runner's Sessions",
      ),
    ),
    yes,
  },
  (options) => Effect.flatMap(uninstall(layout(), options), exitWith),
).pipe(
  operator("uninstall"),
  Command.withDescription("Remove the services, the command and the install, keeping the data"),
)

/** `hub install|start|stop|status`, `runner install|start|stop|status`. */
const serviceCommands = (role: Role) => {
  const title = RoleTitle[role]
  const onPlatform = requirePlatform(platform())
  return [
    Command.make("install", {}, () =>
      Effect.gen(function* () {
        yield* requireInstall(layout())
        yield* installService(layout(), role, yield* onPlatform)
      }),
    ).pipe(
      operator(`${role} install`),
      Command.withDescription(`Install the ${title}'s service, and start it`),
    ),
    Command.make("start", {}, () =>
      Effect.gen(function* () {
        yield* startService(layout(), role, yield* onPlatform)
      }),
    ).pipe(operator(`${role} start`), Command.withDescription(`Start the ${title}'s service`)),
    Command.make("stop", {}, () =>
      Effect.gen(function* () {
        yield* stopService(layout(), role, yield* onPlatform)
      }),
    ).pipe(
      operator(`${role} stop`),
      Command.withDescription(`Stop the ${title}'s service, until the next login or start`),
    ),
    Command.make("status", {}, () =>
      Effect.gen(function* () {
        const state = yield* serviceState(serviceTarget(layout(), role, yield* onPlatform))
        yield* Console.log(`${title} service: ${describeServiceState(state)}`)
        yield* exitWith(state._tag === "Running")
      }),
    ).pipe(
      operator(`${role} status`),
      Command.withDescription(`Whether the ${title}'s service runs`),
    ),
  ] as const
}

const tokenCommand = Command.make("token", { name: Argument.String("name") }, ({ name }) =>
  Effect.gen(function* () {
    const issued = yield* issueToken(layout(), name)
    yield* Console.log(runnerTokenNotice(issued))
  }),
).pipe(
  operator("runner token"),
  Command.withDescription("Issue a Runner's token, on the Hub's machine; rotates any earlier one"),
)

const joinCommand = Command.make(
  "join",
  {
    link: Argument.String("link").pipe(
      Argument.withDescription(
        "The pairing link from the Hub's Runners page (Add a Runner): '<hub-url>#<code>'",
      ),
    ),
    name: optional(
      Flag.String("name").pipe(
        Flag.withDescription("The new Runner's name (the short hostname); a Re-pair keeps its own"),
      ),
    ),
    hubUrl: optional(
      Flag.String("hub-url").pipe(
        Flag.withDescription("The Hub's URL, when the link is only the code"),
      ),
    ),
    installPrerequisites: optional(
      Flag.Boolean("install-prerequisites").pipe(
        Flag.withDescription("Install what's missing without asking (may use sudo)"),
      ),
    ),
    services: optional(
      Flag.Boolean("services").pipe(Flag.withDescription("Install and start the service (yes)")),
    ),
    linger: optional(
      Flag.Boolean("linger").pipe(
        Flag.withDescription("Linux: keep the service running while you're logged out"),
      ),
    ),
    nonInteractive: off("non-interactive").pipe(
      Flag.withDescription("Never ask: an answer with no flag takes its default, or fails"),
    ),
    moveOldData: off("move-old-data").pipe(
      Flag.withDescription(
        "Rename kndl data the home holds without its env file to <name>.old-<YYYYMMDD>, keeping it",
      ),
    ),
  },
  (options) =>
    onboard(layout(), {
      role: "runner",
      reach: undefined,
      port: undefined,
      publicUrl: undefined,
      insecureCookies: undefined,
      devLogin: undefined,
      githubApp: undefined,
      hubUrl: options.hubUrl,
      token: undefined,
      pair: options.link,
      runnerName: options.name,
      installPrerequisites: options.installPrerequisites,
      services: options.services,
      linger: options.linger,
      nonInteractive: options.nonInteractive,
      reset: false,
      moveOldData: options.moveOldData,
    }),
).pipe(
  operator("runner join"),
  Command.withDescription(
    "Make this machine a Runner, with a pairing link from the Hub's Runners page; installs and starts its service",
  ),
)

const setupLinkCommand = Command.make("setup-link", {}, () =>
  Effect.gen(function* () {
    const link = yield* newSetupLink(layout())
    if (Option.isNone(link)) return yield* fail(hasOwnerMessage)
    yield* Console.log(setupLinkNotice(link.value))
  }),
).pipe(
  operator("hub setup-link"),
  Command.withDescription(
    "Print the link the Hub's Owner signs in with first, on the Hub's machine; replaces any earlier one",
  ),
)

const hubCommand = Command.make("hub").pipe(
  Command.withSubcommands([...serviceCommands("hub"), setupLinkCommand]),
  Command.withDescription("The Hub's service, and the link its Owner signs in with first"),
)

const runnerCommand = Command.make("runner").pipe(
  Command.withSubcommands([joinCommand, ...serviceCommands("runner"), tokenCommand]),
  Command.withDescription("Join a Hub as a Runner; the Runner's service, and Runner tokens"),
)

const secretsCommand = Command.make("secrets").pipe(
  Command.withSubcommands([
    Command.make("key", {}, () => Console.log(secretsKeyNotice(layout().envFile("hub")))).pipe(
      operator("secrets key"),
      Command.withDescription("Print a new HUB_SECRETS_KEY"),
    ),
    Command.make("reset", { yes }, (options) => resetHubSecrets(layout(), options)).pipe(
      operator("secrets reset"),
      Command.withDescription(
        "After losing HUB_SECRETS_KEY: clear the Sensitive values it encrypted, with the Hub stopped",
      ),
    ),
  ]),
  Command.withDescription("The Hub's secrets key, and starting over without it"),
)

// Signing the CLI in to a Hub (Login.ts): anyone with an account there, on any machine.
const signedIn = () => loginContext(cliConfigPath())

const loginCommand = Command.make(
  "login",
  {
    hub: Argument.String("hub").pipe(
      Argument.withDescription("The Hub's URL; by default the one the CLI was installed from"),
      Argument.optional,
      Argument.map(Option.getOrUndefined),
    ),
    noBrowser: off("no-browser").pipe(
      Flag.withDescription("Don't wait for a browser here: paste the code the Hub's page shows"),
    ),
  },
  (options) => login(options, signedIn()),
).pipe(
  Command.withDescription(
    "Sign the CLI in to a Hub, approving it in a browser; replaces any earlier sign-in",
  ),
)

const logoutCommand = Command.make("logout", {}, () => logout(signedIn())).pipe(
  Command.withDescription("Sign the CLI out: revoke its CLI token, and forget it"),
)

const whoamiCommand = Command.make("whoami", {}, () => whoami(signedIn())).pipe(
  Command.withDescription("Which Hub the CLI is signed in to, and as whom"),
)

// Forwarding a Session's Open ports here (Forward.ts, #180), as the CLI is signed in.
const forwardCommand = Command.make(
  "forward",
  {
    session: Argument.String("session").pipe(
      Argument.withDescription(
        "The Session: its id, the start of it (the short id) or its URL; by default, pick one",
      ),
      Argument.optional,
      Argument.map(Option.getOrUndefined),
    ),
    ports: Argument.String("ports").pipe(
      Argument.withDescription(
        "Only these of its ports: 3000, or 3000:3100 for its port 3000 at port 3100 here",
      ),
      Argument.variadic(),
    ),
    bind: optional(
      Flag.String("bind").pipe(
        Flag.withDescription("The address to listen on; by default 127.0.0.1 and ::1"),
      ),
    ),
  },
  (options) => forward(options, signedIn()),
).pipe(
  Command.withDescription(
    "Forward a Session's Open ports to localhost here, as they open and close; wakes it if Asleep",
  ),
)

export const cli = Command.make("kndl").pipe(
  Command.withSubcommands([
    onboardCommand,
    statusCommand,
    logsCommand,
    doctorCommand,
    updateCommand,
    uninstallCommand,
    hubCommand,
    runnerCommand,
    secretsCommand,
    loginCommand,
    logoutCommand,
    whoamiCommand,
    forwardCommand,
  ]),
  Command.withDescription(
    "Install, run and look after a kndl Hub and Runner; sign the CLI in to a Hub",
  ),
)
