import { describe, expect, test } from "bun:test"
import { InstallationId, McpServerId } from "./Ids.ts"
import type { SessionInstallation } from "./Session.ts"
import {
  cancelRefusal,
  deliveryBlocked,
  installationsDiffer,
  messageAgentVerdict,
  restartVerdict,
  sleepVerdict,
  steerVerdict,
  stopAgentRefusal,
  stopTurnRefusal,
  sendPromptRefusal,
  wakeVerdict,
} from "./SessionRules.ts"

/** A Refusal saying `refusal`. */
const refused = (refusal: string) => ({ refusal: expect.stringContaining(refusal) })

describe("steering a queued prompt (ADR 0018)", () => {
  const queued = {
    queued: true,
    delivered: false,
    steering: false,
    turnRunning: true,
    modSteers: true,
    hasAttachments: false,
  }

  test("hands a queued prompt to a running Turn, once", () => {
    expect(steerVerdict(queued)).toBe("ok")
    expect(steerVerdict({ ...queued, steering: true })).toBe("already")
  })

  test("is refused without a running Turn, for a prompt delivered or not queued, and by an old mod", () => {
    expect(steerVerdict({ ...queued, turnRunning: false })).toEqual(refused("No Turn is running"))
    expect(steerVerdict({ ...queued, delivered: true })).toEqual(refused("already delivered"))
    expect(steerVerdict({ ...queued, queued: false })).toEqual(refused("not in the Prompt queue"))
    expect(steerVerdict({ ...queued, modSteers: false })).toEqual(
      refused("a mod from before steering"),
    )
  })

  test("says why in the order the Hub checks", () => {
    // No Turn comes first: the prompt goes next anyway.
    expect(steerVerdict({ ...queued, turnRunning: false, modSteers: false })).toEqual(
      refused("No Turn is running"),
    )
    // A steer under way is done whatever the mod says now.
    expect(steerVerdict({ ...queued, steering: true, modSteers: false })).toBe("already")
    // An old mod is said before a prompt that is gone.
    expect(steerVerdict({ ...queued, queued: false, modSteers: false })).toEqual(
      refused("a mod from before steering"),
    )
  })

  test("is refused for a prompt with attachments, which waits for the Turn to end (#276)", () => {
    expect(steerVerdict({ ...queued, hasAttachments: true })).toEqual(refused("attachments"))
  })
})

describe("cancelling a queued prompt", () => {
  const queued = { queued: true, delivered: false, steering: false }

  test("is allowed for a prompt waiting in the queue", () => {
    expect(cancelRefusal(queued)).toBeUndefined()
  })

  test("is refused for one on its way to Claude Code, or not queued", () => {
    expect(cancelRefusal({ ...queued, delivered: true })).toEqual({
      refusal: "The prompt was already delivered to Claude Code.",
    })
    expect(cancelRefusal({ ...queued, steering: true })).toEqual({
      refusal: "The prompt is being handed to the running Turn.",
    })
    expect(cancelRefusal({ ...queued, queued: false })).toEqual({
      refusal: "The prompt is not in the Prompt queue.",
    })
  })
})

describe("delivering the head of the queue", () => {
  const free = { promptOut: false, awaitingHello: false, goingToSleep: false, steering: false }

  test("waits for a prompt out, a mod's hello, a sleep and a steer, each alone", () => {
    expect(deliveryBlocked(free)).toBe(false)
    for (const hold of ["promptOut", "awaitingHello", "goingToSleep", "steering"] as const) {
      expect(deliveryBlocked({ ...free, [hold]: true })).toBe(true)
    }
  })
})

/** An Active Session with nothing under way. */
const idle = {
  state: "Active",
  starting: false,
  goingToSleep: false,
  restarting: false,
  turnRunning: false,
  promptOut: false,
  queued: 0,
  runnerOnline: true,
} as const

describe("the Session lifecycle", () => {
  test("Sleep: only an idle Active Session, and one going to sleep already only stops Keep awake", () => {
    expect(sleepVerdict(idle)).toBe("sleep")
    expect(sleepVerdict({ ...idle, goingToSleep: true, turnRunning: true })).toBe("going")
    expect(sleepVerdict({ ...idle, state: "Asleep" })).toEqual({
      refusal: "Only an Active Session can be put to sleep; this one is Asleep.",
    })
    expect(sleepVerdict({ ...idle, starting: true })).toEqual(refused("still starting"))
    expect(sleepVerdict({ ...idle, turnRunning: true })).toEqual({
      refusal: "A Turn is running: stop it first.",
    })
    expect(sleepVerdict({ ...idle, promptOut: true })).toEqual(refused("Prompts are waiting"))
    expect(sleepVerdict({ ...idle, queued: 2 })).toEqual(refused("Prompts are waiting"))
  })

  test("Wake: an Asleep Session is woken, an Active one is awake, unless it is going to sleep", () => {
    expect(wakeVerdict({ ...idle, state: "Asleep" })).toBe("wake")
    expect(wakeVerdict(idle)).toBe("awake")
    expect(wakeVerdict({ ...idle, goingToSleep: true })).toEqual(refused("still going to sleep"))
    expect(wakeVerdict({ ...idle, state: "Frozen" })).toEqual(refused("Runner is offline"))
    expect(wakeVerdict({ ...idle, state: "Archived" })).toEqual({
      refusal: "The Session is archived.",
    })
  })

  test("Restart: an Asleep Session is woken, an idle Active one stopped first", () => {
    expect(restartVerdict({ ...idle, state: "Asleep" })).toBe("wake")
    expect(restartVerdict(idle)).toBe("stop")
    expect(restartVerdict({ ...idle, restarting: true, state: "Asleep" })).toEqual({
      refusal: "The Session is already restarting.",
    })
    expect(restartVerdict({ ...idle, starting: true })).toEqual(refused("still starting"))
    expect(restartVerdict({ ...idle, goingToSleep: true })).toEqual(refused("going to sleep"))
    expect(restartVerdict({ ...idle, turnRunning: true })).toEqual(refused("A Turn is running"))
    expect(restartVerdict({ ...idle, promptOut: true })).toEqual(refused("A Turn is running"))
    expect(restartVerdict({ ...idle, runnerOnline: false })).toEqual({
      refusal: "The Session's Runner is offline.",
    })
    expect(restartVerdict({ ...idle, state: "Frozen" })).toEqual(refused("Restart it once"))
    expect(restartVerdict({ ...idle, state: "Archived" })).toEqual({
      refusal: "The Session is archived.",
    })
  })

  test("prompts and stops are refused only in an Archived Session", () => {
    for (const state of ["Active", "Asleep", "Frozen"] as const) {
      expect(sendPromptRefusal({ state })).toBeUndefined()
      expect(stopTurnRefusal({ state })).toBeUndefined()
    }
    expect(sendPromptRefusal({ state: "Archived" })).toEqual(refused("restore it to send prompts"))
    expect(stopTurnRefusal({ state: "Archived" })).toEqual(refused("no Turn is running"))
  })
})

describe("subagents (ADR 0014)", () => {
  test("a message reaches an agent of an Active Session, and wakes an Asleep one", () => {
    const known = { ...idle, agentKnown: true }
    expect(messageAgentVerdict(known)).toBe("deliver")
    expect(messageAgentVerdict({ ...known, state: "Asleep" })).toBe("wake")
    expect(messageAgentVerdict({ ...known, agentKnown: false })).toEqual({
      refusal: "The Session has no such agent.",
    })
    expect(messageAgentVerdict({ ...known, goingToSleep: true })).toEqual(refused("going to sleep"))
    expect(messageAgentVerdict({ ...known, state: "Frozen" })).toEqual(refused("Runner is offline"))
    expect(messageAgentVerdict({ ...known, state: "Archived" })).toEqual(
      refused("restore it to message agents"),
    )
  })

  test("only a Running agent of an Active Session can be stopped", () => {
    expect(stopAgentRefusal({ state: "Active", agent: "Running" })).toBeUndefined()
    expect(stopAgentRefusal({ state: "Active", agent: undefined })).toEqual({
      refusal: "The Session has no such agent.",
    })
    expect(stopAgentRefusal({ state: "Active", agent: "Done" })).toEqual({
      refusal: "The agent isn't running.",
    })
    expect(stopAgentRefusal({ state: "Frozen", agent: "Running" })).toEqual({
      refusal: "The agent isn't running.",
    })
  })
})

describe("a Session's Installations against its Repo's (ADR 0020)", () => {
  const sentry: SessionInstallation = {
    id: InstallationId.make("i-1"),
    name: "Sentry",
    mcpServerId: McpServerId.make("m-1"),
    mcpServerName: "sentry",
    server: "sentry",
    values: [{ key: "token", setAt: 1 }],
  }
  const linear = { ...sentry, id: InstallationId.make("i-2"), name: "Linear" }

  test("are the same in any order, and whether global or not", () => {
    expect(installationsDiffer([sentry, linear], [linear, sentry])).toBe(false)
    expect(installationsDiffer([sentry], [{ ...sentry, global: true }])).toBe(false)
  })

  test("differ in what the Session runs with: names, version, server, values and when set", () => {
    expect(installationsDiffer([sentry], [])).toBe(true)
    expect(installationsDiffer([sentry], [{ ...sentry, name: "Errors" }])).toBe(true)
    expect(installationsDiffer([sentry], [{ ...sentry, mcpServerVersion: "1.1.0" }])).toBe(true)
    expect(installationsDiffer([sentry], [{ ...sentry, server: "sentry-2" }])).toBe(true)
    expect(
      installationsDiffer([sentry], [{ ...sentry, values: [{ key: "token", setAt: 2 }] }]),
    ).toBe(true)
    expect(installationsDiffer([sentry], [{ ...sentry, values: [] }])).toBe(true)
  })

  test("tell an empty version from none, and no values from an empty list alike", () => {
    // The fake Hub took "" for none, so an Upgrade to "" would have asked for no Restart.
    expect(installationsDiffer([sentry], [{ ...sentry, mcpServerVersion: "" }])).toBe(true)
    const { values: _, ...withoutValues } = sentry
    expect(installationsDiffer([withoutValues], [{ ...sentry, values: [] }])).toBe(false)
  })
})
