// The `claude-hub` command tree. Each command resolves the home (Layout.ts) and hands off to the
// module that does the work; a command that ends badly sets the exit code.
import { runnerTokenNotice, secretsKeyNotice } from "@claude-hub/hub/src/Admin.ts"
import { Console, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import {
  installService,
  issueToken,
  requireInstall,
  requirePlatform,
  RoleTitle,
  startService,
  stopService,
} from "./Actions.ts"
import { fail } from "./Failure.ts"
import { configuredRoles, platform, serviceState, serviceTarget } from "./Host.ts"
import { resolveLayout, type Role, Roles } from "./Layout.ts"
import { doctor, uninstall, update } from "./Maintain.ts"
import { type RoleChoice, RoleChoices, type Reach, Reaches } from "./Onboard.ts"
import { onboard } from "./OnboardFlow.ts"
import { describeServiceState } from "./Services.ts"
import { Shell, step } from "./Shell.ts"
import { status } from "./Status.ts"

/** Sets the exit code when a command reports that something is wrong. */
const exitWith = (ok: boolean) =>
  Effect.sync(() => {
    if (!ok) process.exitCode = 1
  })

const layout = () => resolveLayout()

const optional = <A>(flag: Flag.Flag<A>) =>
  flag.pipe(Flag.optional, Flag.map(Option.getOrUndefined))

const yes = Flag.Boolean("yes").pipe(
  Flag.withAlias("y"),
  Flag.withDescription("Don't ask for confirmation"),
)

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
    hubUrl: optional(
      Flag.String("hub-url").pipe(
        Flag.withDescription("A Runner's Hub, as the Runner reaches it (HUB_URL)"),
      ),
    ),
    token: optional(
      Flag.String("token").pipe(
        Flag.withDescription("A Runner's token, from `claude-hub runner token <name>`"),
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
    nonInteractive: Flag.Boolean("non-interactive").pipe(
      Flag.withDescription("Never ask: an answer with no flag takes its default, or fails"),
    ),
    reset: Flag.Boolean("reset").pipe(
      Flag.withDescription("Ask again instead of keeping the existing settings"),
    ),
  },
  (options) =>
    onboard(layout(), {
      ...options,
      role: options.role as RoleChoice | undefined,
      reach: options.reach as Reach | undefined,
    }),
).pipe(Command.withDescription("Set up a Hub, a Runner, or both on this machine, as services"))

const statusCommand = Command.make("status", {}, () =>
  Effect.flatMap(status(layout()), exitWith),
).pipe(Command.withDescription("What's installed, which services run, and the Hub and Runner"))

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
    follow: Flag.Boolean("follow").pipe(
      Flag.withAlias("f"),
      Flag.withDescription("Keep printing as it logs"),
    ),
    lines: Flag.Int("lines").pipe(Flag.withAlias("n"), Flag.withDefault(100)),
  },
  ({ role, follow, lines }) =>
    Effect.gen(function* () {
      const which = yield* pickRole(role)
      const file = layout().logFile(which)
      const args = ["-n", String(lines), ...(follow ? ["-F"] : []), file]
      yield* (yield* Shell).attached(step("tail", args, { mayFail: true }))
    }),
).pipe(Command.withDescription("Print the Hub's or Runner's log"))

const doctorCommand = Command.make(
  "doctor",
  { fix: Flag.Boolean("fix").pipe(Flag.withDescription("Repair what can be repaired")), yes },
  (options) => Effect.flatMap(doctor(layout(), options), exitWith),
).pipe(Command.withDescription("Check the install, its configuration and its services"))

const updateCommand = Command.make(
  "update",
  {
    ref: optional(
      Flag.String("ref").pipe(
        Flag.withAlias("branch"),
        Flag.withDescription("A branch to follow, or a tag or commit to pin to"),
      ),
    ),
  },
  ({ ref }) => Effect.flatMap(update(layout(), ref), exitWith),
).pipe(
  Command.withAlias("upgrade"),
  Command.withDescription("Update the install, rebuild, and restart its services"),
)

const uninstallCommand = Command.make(
  "uninstall",
  {
    purge: Flag.Boolean("purge").pipe(
      Flag.withDescription(
        "Remove the whole home too: the Hub's database, its key, the Runner's Sessions",
      ),
    ),
    yes,
  },
  (options) => Effect.flatMap(uninstall(layout(), options), exitWith),
).pipe(
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
    ).pipe(Command.withDescription(`Install the ${title}'s service, and start it`)),
    Command.make("start", {}, () =>
      Effect.gen(function* () {
        yield* startService(layout(), role, yield* onPlatform)
      }),
    ).pipe(Command.withDescription(`Start the ${title}'s service`)),
    Command.make("stop", {}, () =>
      Effect.gen(function* () {
        yield* stopService(layout(), role, yield* onPlatform)
      }),
    ).pipe(Command.withDescription(`Stop the ${title}'s service, until the next login or start`)),
    Command.make("status", {}, () =>
      Effect.gen(function* () {
        const state = yield* serviceState(serviceTarget(layout(), role, yield* onPlatform))
        yield* Console.log(`${title} service: ${describeServiceState(state)}`)
        yield* exitWith(state._tag === "Running")
      }),
    ).pipe(Command.withDescription(`Whether the ${title}'s service runs`)),
  ] as const
}

const tokenCommand = Command.make("token", { name: Argument.String("name") }, ({ name }) =>
  Effect.gen(function* () {
    const issued = yield* issueToken(layout(), name)
    yield* Console.log(runnerTokenNotice(issued))
  }),
).pipe(
  Command.withDescription("Issue a Runner's token, on the Hub's machine; rotates any earlier one"),
)

const hubCommand = Command.make("hub").pipe(
  Command.withSubcommands(serviceCommands("hub")),
  Command.withDescription("The Hub's service"),
)

const runnerCommand = Command.make("runner").pipe(
  Command.withSubcommands([...serviceCommands("runner"), tokenCommand]),
  Command.withDescription("The Runner's service, and Runner tokens"),
)

const secretsCommand = Command.make("secrets").pipe(
  Command.withSubcommands([
    Command.make("key", {}, () => Console.log(secretsKeyNotice(layout().envFile("hub")))).pipe(
      Command.withDescription("Print a new HUB_SECRETS_KEY"),
    ),
  ]),
  Command.withDescription("The Hub's secrets key"),
)

export const cli = Command.make("claude-hub").pipe(
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
  ]),
  Command.withDescription("Install, run and look after a claude-hub Hub and Runner"),
)
