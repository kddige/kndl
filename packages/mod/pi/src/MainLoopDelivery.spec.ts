// What a pi Session's main loop is given, against a pi that does as it's told: it takes a prompt
// or a result and runs it, or doesn't, as each test says, with the looks and the settling's end
// driven by hand.

import { describe, expect, test } from "bun:test"
import { ModEvent } from "@kndl/protocol"
import { Schema } from "effect"
import { idleLooksBeforeGivingUp, lookEvery, MainLoopDelivery } from "./MainLoopDelivery.ts"
import type { MainLoop } from "./MainLoopDelivery.ts"
import { Turns } from "./Turns.ts"
import type { AgentResultMessage, AnswerMessage } from "./Turns.ts"

const ada = { id: "p1", login: "ada", name: "Ada Lovelace" }

const prompt = (promptId: string, text = "hi") => ({
  _tag: "DeliverPrompt" as const,
  sessionId: "s1" as never,
  promptId: promptId as never,
  text,
  sender: ada as never,
})

const result = (agentId: string): AgentResultMessage => ({
  agentId,
  text: `<task-notification>\n<task-id>${agentId}</task-id>\n</task-notification>`,
})

/** A main loop over a pi whose runs the test plays, with the looks and `soon` run by hand. */
const harness = (options: { takesAlreadySubmitted?: boolean } = {}) => {
  const events: Array<Record<string, unknown>> = []
  const given: Array<string> = []
  const steered: Array<[string, string]> = []
  const answered: Array<AnswerMessage> = []
  const recorded: Array<[string, boolean]> = []
  const taken: Array<AgentResultMessage> = []
  const logged: Array<string> = []
  const looks: Array<() => void> = []
  const soon: Array<() => void> = []
  let ids = 0
  const turns = new Turns({
    report: (event) => events.push(event),
    now: () => 0,
    newId: () => `t${++ids}`,
  })
  const pi = {
    idle: true,
    cannotRun: undefined as string | undefined,
    refuse: undefined as Error | undefined,
  }
  const loop: MainLoop = {
    isIdle: () => pi.idle,
    cannotRun: () => pi.cannotRun,
    prompt: (text) => {
      if (pi.refuse !== undefined) throw pi.refuse
      given.push(text)
    },
    result: (each) => {
      if (pi.refuse !== undefined) throw pi.refuse
      given.push(each.text)
    },
    answer: (each) => {
      if (pi.refuse !== undefined) throw pi.refuse
      answered.push(each)
    },
    steer: (promptId, text) => {
      if (pi.refuse !== undefined) throw pi.refuse
      steered.push([promptId, text])
    },
    record: (promptId, submitted) => recorded.push([promptId, submitted]),
  }
  const delivery = new MainLoopDelivery({
    turns,
    report: (event) => events.push(event),
    takesAlreadySubmitted: () => options.takesAlreadySubmitted ?? true,
    resultTaken: (each) => taken.push(each),
    every: (ms, fn) => {
      expect(ms).toBe(lookEvery)
      looks.push(fn)
      return () => looks.splice(looks.indexOf(fn), 1)
    },
    soon: (fn) => soon.push(fn),
    log: (text) => logged.push(text),
  })
  /** pi runs the prompt it was given last: takes it in, starts, and is busy. */
  const runsPrompt = (text: string) => {
    turns.input(text, "extension")
    turns.beforeAgentStart(text)
    pi.idle = false
    delivery.started(turns.agentStart())
  }
  /** pi runs the agent's result it was given: starts, and is busy. */
  const runsResult = (each: AgentResultMessage) => {
    turns.beforeAgentStart(undefined, each)
    pi.idle = false
    delivery.started(turns.agentStart())
  }
  /** pi runs the answer it was given: starts, and is busy. */
  const runsAnswer = (each: AnswerMessage) => {
    turns.beforeAgentStart(undefined, undefined, each)
    pi.idle = false
    delivery.started(turns.agentStart())
  }
  /** pi's run ends: it is idle, and the settling's handling is over. */
  const settles = () => {
    pi.idle = true
    turns.settled(false)
    delivery.settled()
    for (const fn of soon.splice(0)) fn()
  }
  /** `n` looks go by. */
  const look = (n = 1) => {
    for (let at = 0; at < n; at++) for (const fn of looks.slice()) fn()
  }
  return {
    delivery,
    pi,
    loop,
    events,
    given,
    steered,
    answered,
    recorded,
    taken,
    logged,
    looks,
    takesIn: (text: string) => turns.input(text, "extension"),
    runsPrompt,
    runsResult,
    runsAnswer,
    settles,
    look,
    attach: (submitted: Array<[string, boolean]> = []) => delivery.attach(loop, submitted),
  }
}

const tags = (events: ReadonlyArray<Record<string, unknown>>) => events.map((event) => event._tag)

/** Every event decodes as the protocol has it. */
const valid = (events: ReadonlyArray<unknown>) =>
  events.every((event) =>
    Schema.is(Schema.toType(ModEvent))(Schema.decodeUnknownSync(ModEvent)(event)),
  )

describe("a prompt from the Hub (#323)", () => {
  test("is given to an idle pi at once, with its sender's name, and is said to be given", () => {
    const h = harness()
    h.attach()
    h.delivery.prompt(prompt("q1"))
    expect(h.given).toEqual(["[Ada Lovelace] hi"])
    expect(h.recorded).toEqual([["q1", true]])
    h.runsPrompt("[Ada Lovelace] hi")
    expect(h.events).toEqual([
      {
        _tag: "TurnStarted",
        turnId: "t1",
        text: "[Ada Lovelace] hi",
        sender: { _tag: "FromParticipant", participant: ada },
        promptId: "q1",
      },
    ])
    h.settles()
    expect(h.looks).toEqual([])
  })

  test("waits while pi is busy, and goes once pi has settled, after its settling is over", () => {
    const h = harness()
    h.attach()
    h.pi.idle = false
    h.delivery.prompt(prompt("q1"))
    h.look(10)
    expect(h.given).toEqual([])
    h.pi.idle = true
    h.delivery.settled()
    // Not while pi handles its settling: it would defer it, and drop what it deferred after it.
    expect(h.given).toEqual([])
    h.settles()
    expect(h.given).toEqual(["[Ada Lovelace] hi"])
  })

  test("goes at the next look once pi is idle, as after a compaction, which settles no run", () => {
    const h = harness()
    h.attach()
    h.pi.idle = false
    h.delivery.prompt(prompt("q1"))
    h.pi.idle = true
    h.look()
    expect(h.given).toEqual(["[Ada Lovelace] hi"])
  })

  test("one delivered again, after pi was given it, isn't run twice", () => {
    const h = harness()
    h.attach([["q0", true]])
    h.delivery.prompt(prompt("q0"))
    expect(h.given).toEqual([])
    expect(h.events).toEqual([{ _tag: "PromptAlreadySubmitted", promptId: "q0" }])
    const older = harness({ takesAlreadySubmitted: false })
    older.attach([["q0", true]])
    older.delivery.prompt(prompt("q0"))
    expect(older.events).toEqual([])
  })

  test("one pi can't run fails, saying why, and isn't said to be given", () => {
    const h = harness()
    h.attach()
    h.delivery.prompt(prompt("q1"))
    h.runsPrompt("[Ada Lovelace] hi")
    h.settles()
    h.pi.cannotRun = "pi has no credential for openai/gpt-4.1"
    h.delivery.prompt(prompt("q2"))
    expect(h.events.at(-1)).toEqual({
      _tag: "PromptFailed",
      promptId: "q2",
      message: "pi has no credential for openai/gpt-4.1",
    })
    expect(h.recorded).toEqual([["q1", true]])
    const before = harness()
    before.delivery.prompt(prompt("q3"))
    expect(before.events).toEqual([
      { _tag: "PromptFailed", promptId: "q3", message: "pi's session hasn't started" },
    ])
  })

  test("one pi throws at fails, and is said not to be given after all", () => {
    const h = harness()
    h.attach()
    h.pi.refuse = new Error("Agent is already processing.")
    h.delivery.prompt(prompt("q1"))
    expect(h.events).toEqual([
      { _tag: "PromptFailed", promptId: "q1", message: "Error: Agent is already processing." },
    ])
    expect(h.recorded).toEqual([
      ["q1", true],
      ["q1", false],
    ])
    expect(valid(h.events)).toBe(true)
  })

  // pi takes a prompt without saying whether it ran it: an input handler can handle it, or the
  // run fail to start, and pi says so only in its own log.
  test("one pi took and never ran fails once pi has stayed idle, and can be delivered again", () => {
    const h = harness()
    h.attach()
    h.delivery.prompt(prompt("q1"))
    h.look(idleLooksBeforeGivingUp - 1)
    expect(h.events).toEqual([])
    h.look()
    expect(h.events).toEqual([
      { _tag: "PromptFailed", promptId: "q1", message: "pi didn't run it" },
    ])
    expect(h.recorded).toEqual([
      ["q1", true],
      ["q1", false],
    ])
    h.delivery.prompt(prompt("q1"))
    expect(h.given).toEqual(["[Ada Lovelace] hi", "[Ada Lovelace] hi"])
  })

  test("so does one pi took in, whose run never started", () => {
    const h = harness()
    h.attach()
    h.delivery.prompt(prompt("q1"))
    // An input handler after this extension's handled it: no run.
    h.takesIn("[Ada Lovelace] hi")
    h.look(idleLooksBeforeGivingUp)
    expect(tags(h.events)).toEqual(["PromptFailed"])
  })

  test("while pi stays busy, as with a run of the terminal's, it waits for it", () => {
    const h = harness()
    h.attach()
    h.delivery.prompt(prompt("q1"))
    h.pi.idle = false
    h.look(idleLooksBeforeGivingUp * 3)
    h.pi.idle = true
    h.look(idleLooksBeforeGivingUp - 1)
    expect(h.events).toEqual([])
    h.runsPrompt("[Ada Lovelace] hi")
    h.look(idleLooksBeforeGivingUp * 3)
    expect(tags(h.events)).toEqual(["TurnStarted"])
  })

  test("as pi's session ends, one it was given and never ran is said not to be given, so it runs when pi is back", () => {
    const h = harness()
    h.attach()
    h.pi.idle = false
    h.delivery.prompt(prompt("q2"))
    h.pi.idle = true
    h.look()
    h.delivery.detach()
    expect(h.recorded).toEqual([
      ["q2", true],
      ["q2", false],
    ])
    expect(h.looks).toEqual([])
    expect(h.events).toEqual([])
  })
})

describe("an agent's result (ADR 0014)", () => {
  test("starts a run of its own once pi is idle, before a prompt that waits, one run each, oldest first", () => {
    const h = harness()
    h.attach()
    h.pi.idle = false
    h.delivery.result(result("a1"))
    h.delivery.prompt(prompt("q1"))
    h.delivery.result(result("a2"))
    h.settles()
    expect(h.given).toEqual([result("a1").text])
    // Nothing more until the run it starts has started.
    h.look()
    expect(h.given).toHaveLength(1)
    h.runsResult(result("a1"))
    expect(h.taken).toEqual([result("a1")])
    h.settles()
    expect(h.given).toEqual([result("a1").text, result("a2").text])
    h.runsResult(result("a2"))
    h.settles()
    expect(h.given.at(-1)).toBe("[Ada Lovelace] hi")
    expect(h.taken).toEqual([result("a1"), result("a2")])
    expect(h.events.filter((event) => event._tag === "TurnStarted")).toEqual([
      expect.objectContaining({ sender: { _tag: "FromAgent", agentId: "a1" } }),
      expect.objectContaining({ sender: { _tag: "FromAgent", agentId: "a2" } }),
    ])
  })

  test("one pi never ran is given up on once pi stays idle, and what waits after it goes", () => {
    const h = harness()
    h.attach()
    h.delivery.result(result("a1"))
    h.delivery.prompt(prompt("q1"))
    expect(h.given).toEqual([result("a1").text])
    h.look(idleLooksBeforeGivingUp)
    expect(h.logged[0]).toContain("agent a1's result")
    expect(h.taken).toEqual([])
    expect(h.given).toEqual([result("a1").text, "[Ada Lovelace] hi"])
  })

  test("as pi's session ends, the results waiting are dropped: Subagents gives them again when pi starts", () => {
    const h = harness()
    h.attach()
    h.pi.idle = false
    h.delivery.result(result("a1"))
    h.delivery.detach()
    h.pi.idle = true
    h.attach()
    h.look()
    expect(h.given).toEqual([])
  })
})

const steer = (promptId: string) => ({
  _tag: "DeliverIntoTurn" as const,
  sessionId: "s1" as never,
  promptId: promptId as never,
  text: "and b.ts",
  sender: ada as never,
})

describe("a prompt steered into the running Turn (ADR 0018)", () => {
  test("joins the running Turn as Claude Code frames a prompt typed while it works", () => {
    const h = harness()
    h.attach()
    h.delivery.prompt(prompt("q1"))
    h.runsPrompt("[Ada Lovelace] hi")
    h.delivery.steer(steer("q2"))
    expect(h.steered).toEqual([
      [
        "q2",
        expect.stringContaining(
          "Ada Lovelace sent a new message while you were working:\n[Ada Lovelace] and b.ts",
        ),
      ],
    ])
    expect(h.events.at(-1)).toEqual({
      _tag: "PromptSteered",
      turnId: "t1",
      promptId: "q2",
      text: "and b.ts",
      sender: ada,
    })
  })

  test("fails with no Turn running, or when pi refuses it", () => {
    const h = harness()
    h.delivery.steer(steer("q2"))
    h.attach()
    h.delivery.steer(steer("q3"))
    h.delivery.prompt(prompt("q1"))
    h.runsPrompt("[Ada Lovelace] hi")
    h.pi.refuse = new Error("closing")
    h.delivery.steer(steer("q4"))
    expect(h.events.filter((event) => event._tag === "PromptFailed")).toEqual([
      { _tag: "PromptFailed", promptId: "q2", message: "no Turn is running" },
      { _tag: "PromptFailed", promptId: "q3", message: "no Turn is running" },
      { _tag: "PromptFailed", promptId: "q4", message: "Error: closing" },
    ])
    expect(h.steered).toEqual([])
  })
})

describe("the answer to an async question", () => {
  const answer: AnswerMessage = { text: "Ada Lovelace answered: date-fns", sender: ada as never }

  test("goes into the running Turn at once", () => {
    const h = harness()
    h.attach()
    h.delivery.prompt(prompt("q1"))
    h.runsPrompt("[Ada Lovelace] hi")
    h.delivery.answer(answer)
    expect(h.answered).toEqual([answer])
    expect(h.events.filter((event) => event._tag === "TurnStarted")).toHaveLength(1)
  })

  test("with no Turn running, starts one from whoever answered, once pi is idle", () => {
    const h = harness()
    h.attach()
    h.pi.idle = false
    h.delivery.answer(answer)
    expect(h.answered).toEqual([])
    h.pi.idle = true
    h.look()
    expect(h.answered).toEqual([answer])
    h.runsAnswer(answer)
    expect(h.events).toEqual([
      {
        _tag: "TurnStarted",
        turnId: "t1",
        text: answer.text,
        sender: { _tag: "FromParticipant", participant: ada },
      },
    ])
    expect(valid(h.events)).toBe(true)
    h.look(10)
    expect(h.answered).toEqual([answer])
  })

  test("one answered at pi's terminal starts a Turn from the terminal", () => {
    const h = harness()
    h.attach()
    h.delivery.answer({ text: "dismissed" })
    h.runsAnswer({ text: "dismissed" })
    expect(h.events[0]).toMatchObject({ sender: { _tag: "FromTerminal" } })
  })
})
