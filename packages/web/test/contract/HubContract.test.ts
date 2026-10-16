// One set of HubClient tests, run against both of the web's Hubs: the fake one (FakeHub.ts) and a
// real one, started in-process from packages/hub, with a fake Runner and a scripted mod. What the
// web sees of the Prompt queue, Steer, Cancel and a Session's history must be the same on both
// (#263): the real Hub is the reference, and a test that fails on the fake only is the fake's bug.
//
// Each Hub plays Claude Code the same way: a delivered prompt starts a Turn, which runs until it
// is stopped; a steered prompt joins it if it still runs when the mod appends it; and a stop ends
// it. The fake Hub plays that itself (its `reply` option); for the real one, `scriptedMod` does.

import { afterEach, describe, expect, test } from "bun:test"
import { issueRunnerToken, openRunner } from "@kndl/hub/src/testChannels.ts"
import {
  cookieFrom,
  devSignIn,
  seedEnvironment,
  startHub,
  webOrigin,
} from "@kndl/hub/src/testSupport.ts"
import type { TestHub } from "@kndl/hub/src/testSupport.ts"
import {
  type AttachmentId,
  AttachmentNameHeader,
  type CommandFailed,
  type ModCommandsEncoded,
  type ModEventsEncoded,
  Participant,
  type PromptId,
  ProtocolVersion,
  type SessionEvent,
  type SessionId,
  type ToolCallId,
} from "@kndl/protocol"
import { Schema } from "effect"
import { HubClient } from "../../src/hub/client.ts"
import { attachmentPath, attachmentsPath, hubPaths } from "../../src/hub/config.ts"
import { FakeHub } from "../../src/hub/fake/FakeHub.ts"
import type { HubTransport } from "../../src/hub/transport.ts"

/** A signed-in client of either Hub, with a new Session that has started, its Claude Code idle. */
interface Scene {
  readonly client: HubClient
  readonly sessionId: SessionId
  /** Another client, signed in as the same person: another tab. */
  readonly newClient: () => HubClient
  /** Drops every client's connection, as a network blip does: each reconnects. */
  readonly dropConnections: () => void
}

interface SceneOptions {
  readonly modSteers?: boolean
  readonly modAttaches?: boolean
}

/** The question Claude asks when a prompt says "ask" (#193). */
const question = {
  question: "Which layout?",
  header: "Layout",
  options: [{ label: "Grid" }],
  multiSelect: false,
}

/** The subagent Claude starts in the background when a prompt says "delegate" (ADR 0014). */
const agent = {
  agentId: "a-1",
  agentType: "general-purpose",
  description: "Check the layout",
  model: "claude-haiku-4-5",
}

interface Adapter {
  readonly name: string
  /**
   * A Scene; its mod says it steers unless `modSteers` is false, and marks attachments beyond
   * prompts unless `modAttaches` is false (#278).
   */
  readonly scene: (options?: SceneOptions) => Promise<Scene>
}

const repo = "kddige/kndl"
const branch = { _tag: "Existing", name: "main", newWorkBranch: true } as const

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

/** A client of `transport`, started, and stopped when the test ends. */
function startClient(transport: HubTransport): HubClient {
  const client = new HubClient(transport, { retryDelay: () => 1 })
  cleanups.push(() => client.stop())
  client.start()
  return client
}

/** Creates a Session through the client, and waits until it has started. */
async function started(client: HubClient): Promise<SessionId> {
  await eventually(() => expect(client.getState().connection.status).toBe("online"))
  const { id } = await client.createSession({ repo, branch })
  await eventually(() => {
    const summary = client.getState().sessions?.find((session) => session.id === id)
    expect(summary?.state).toBe("Active")
    expect(summary?.starting).toBeUndefined()
  })
  return id
}

// ── The fake Hub ─────────────────────────────────────────────────────────

const fake: Adapter = {
  name: "the fake Hub",
  scene: async ({ modSteers = true, modAttaches = true } = {}) => {
    // Claude works on every prompt until it is stopped, asking or delegating first if told to.
    const working = { kind: "pause", steps: 1e6 } as const
    const hub = new FakeHub({
      stepMs: 2,
      autoplay: false,
      reply: (text) =>
        text === "ask"
          ? [{ kind: "question", questions: [question] }, working]
          : text === "delegate"
            ? [
                {
                  kind: "agent",
                  ...agent,
                  prompt: "Look at the layout.",
                  background: true,
                  steps: [working],
                  result: "Done.",
                },
                working,
              ]
            : [working],
    })
    cleanups.push(() => hub.dispose())
    const client = startClient(hub)
    const sessionId = await started(client)
    if (!modSteers) hub.modFromBeforeSteering(sessionId)
    if (!modAttaches) hub.modFromBeforeAttaching(sessionId)
    return {
      client,
      sessionId,
      newClient: () => startClient(hub),
      dropConnections: () => hub.dropConnections(),
    }
  },
}

// ── The real Hub ─────────────────────────────────────────────────────────

type ModCommand = ModCommandsEncoded["messages"][number]["message"]
type ModEvent = ModEventsEncoded["messages"][number]

/** A PNG's signature and a little more: what the Hub tells a PNG by. */
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

/** A transport's sign-in routes, which these tests never use. */
const unused = async (): Promise<never> => {
  throw new Error("unused")
}

/** The web channel to a real Hub, as the browser's transport opens it, signed in by `cookie`. */
function realTransport(hub: TestHub, cookie: string) {
  const sockets = new Set<WebSocket>()
  const transport: HubTransport = {
    open(handlers) {
      const socket = new WebSocket(`${hub.url.replace(/^http/, "ws")}${hubPaths.webSocket}`, {
        headers: { cookie, origin: webOrigin },
      })
      sockets.add(socket)
      socket.addEventListener("open", () => handlers.onOpen())
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") handlers.onMessage(event.data)
      })
      socket.addEventListener("close", () => {
        sockets.delete(socket)
        handlers.onClose()
      })
      return { send: (text) => socket.send(text), close: () => socket.close() }
    },
    signInStatus: async () => {
      const response = await fetch(`${hub.url}${hubPaths.me}`, { headers: { cookie } })
      return { signedIn: true, you: Schema.decodeUnknownSync(Participant)(await response.json()) }
    },
    devSignIn: unused,
    signOut: unused,
    approveCli: unused,
    admit: unused,
    // fetch, which says nothing of how far an upload got: all of it, at the end.
    uploadAttachment: async (sessionId, file, { onProgress }) => {
      const response = await fetch(`${hub.url}${attachmentsPath(sessionId)}`, {
        method: "POST",
        headers: {
          cookie,
          origin: webOrigin,
          [AttachmentNameHeader]: encodeURIComponent(file.name),
        },
        body: file,
      })
      const body = (await response.json()) as { id?: AttachmentId; error?: string }
      if (response.status !== 201 || body.id === undefined) throw new Error(body.error)
      onProgress(file.size)
      return body.id
    },
    attachmentUrl: (sessionId, attachmentId) =>
      `${hub.url}${attachmentPath(sessionId, attachmentId)}`,
  }
  return {
    transport,
    drop: () => {
      for (const socket of sockets) socket.close()
    },
  }
}

/**
 * The Session's mod and Claude Code, scripted as the fake Hub plays them: it says hello, then
 * answers each command from the Hub as it comes, until stopped.
 */
function scriptedMod(hub: TestHub, sessionId: string, modToken: string) {
  let after = 0
  let turn: { readonly turnId: string } | null = null
  let turns = 0
  const stopping = new AbortController()
  const request = (path: string, body?: unknown) =>
    fetch(`${hub.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${modToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const post = (...messages: ReadonlyArray<ModEvent>) => request("/mod/events", { messages })
  const answer = async (command: ModCommand) => {
    switch (command._tag) {
      case "DeliverPrompt": {
        turn = { turnId: `t-${++turns}` }
        const { turnId } = turn
        await post({
          _tag: "TurnStarted",
          turnId,
          text: command.text,
          sender: { _tag: "FromParticipant", participant: command.sender },
          promptId: command.promptId,
        })
        if (command.text === "ask")
          await post({ _tag: "QuestionAsked", turnId, toolCallId: "q-1", questions: [question] })
        if (command.text === "delegate")
          await post({
            _tag: "AgentStarted",
            turnId,
            toolCallId: "call-a-1",
            ...agent,
            background: true,
          })
        return
      }
      // The first answer is Claude's: the mod reports the question closed with it.
      case "DeliverAnswer": {
        if (turn === null) return
        await post({
          _tag: "QuestionClosed",
          turnId: turn.turnId,
          toolCallId: command.toolCallId,
          outcome: command.answer,
          by: command.sender,
        })
        return
      }
      case "DeliverIntoTurn": {
        const { promptId, text, sender, attachments } = command
        if (turn === null) {
          await post({ _tag: "PromptFailed", promptId, message: "no Turn is running" })
          return
        }
        const { turnId } = turn
        await post(
          {
            _tag: "PromptSteered",
            turnId,
            promptId,
            text,
            sender,
            ...(attachments !== undefined && { attachments }),
          },
          { _tag: "SteeredPromptRead", turnId, promptId },
        )
        return
      }
      case "StopTurn": {
        if (turn === null) return
        const { turnId } = turn
        turn = null
        await post({ _tag: "TurnEnded", turnId, reason: "Stopped", durationMs: 1 })
        return
      }
    }
  }
  let loop: Promise<void> = Promise.resolve()
  return {
    /**
     * Says hello, saying whether it steers and marks attachments beyond prompts, and then polls
     * for the Hub's commands.
     */
    hello: async (steers: boolean, attaches: boolean) => {
      const hello = await request("/mod/hello", {
        _tag: "ModHello",
        protocolVersion: ProtocolVersion,
        sessionId,
        claudeSessionId: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
        model: "claude-opus",
        ...(steers && { steers: true }),
        ...(attaches && { attaches: true }),
      })
      loop = (async () => {
        while (!stopping.signal.aborted) {
          const response = await request(`/mod/commands?after=${after}&waitMs=50`)
          if (response.status !== 200) return
          const body = (await response.json()) as ModCommandsEncoded
          after = body.messages.at(-1)?.seq ?? after
          for (const { message } of body.messages) await answer(message)
        }
      })()
      return hello
    },
    stop: async () => {
      stopping.abort()
      await loop
    },
  }
}

const real: Adapter = {
  name: "the real Hub",
  scene: async ({ modSteers = true, modAttaches = true } = {}) => {
    const hub = await startHub({ config: { devLogin: true } })
    // Last, once its clients and mod are gone: its shutdown waits for their connections.
    cleanups.push(() => hub.stop())
    const cookie = cookieFrom(await devSignIn(hub, "alice"))
    await seedEnvironment(hub, repo, "dev:alice")
    const runner = await openRunner(hub, (await issueRunnerToken(hub)).token)
    cleanups.push(() => runner.close())
    const transports: Array<ReturnType<typeof realTransport>> = []
    const newClient = () => {
      const opened = realTransport(hub, cookie)
      transports.push(opened)
      return startClient(opened.transport)
    }
    const client = newClient()
    // A Session runs on its Creator's own setup token, with no fallback (ADR 0026); the test Hub
    // stores it without asking Anthropic.
    await eventually(() => expect(client.getState().connection.status).toBe("online"))
    await client.setClaudeCredential("sk-ant-oat01-FAKE_TOKEN_FOR_CONTRACT_TESTS_ONLY")
    // Its Runner starts it: the mod says hello, and then the Runner says it started.
    const creating = started(client)
    const start = await runner.take("StartSession")
    const mod = scriptedMod(hub, start.sessionId, start.modToken)
    // Stopped before the clients and the Hub, whose shutdown waits for its held poll.
    cleanups.push(() => mod.stop())
    expect((await mod.hello(modSteers, modSteers && modAttaches)).status).toBe(200)
    runner.send({ _tag: "SessionStarted", sessionId: start.sessionId, environmentVersion: 1 })
    return {
      client,
      sessionId: await creating,
      newClient,
      dropConnections: () => {
        for (const opened of transports) opened.drop()
      },
    }
  },
}

/** shot.png, uploaded to the Scene's Session through its client. */
const uploadShot = (scene: Scene) =>
  scene.client.uploadAttachment(
    scene.sessionId,
    new File([png], "shot.png", { type: "image/png" }),
    { onProgress: () => {}, signal: new AbortController().signal },
  )
const shotOf = (id: AttachmentId) => ({
  id,
  name: "shot.png",
  mediaType: "image/png" as const,
  size: png.byteLength,
})

// ── The contract ─────────────────────────────────────────────────────────

/** Waits until `check` stops throwing, or fails with its last error. */
async function eventually(check: () => void, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      check()
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await Bun.sleep(5)
    }
  }
}

/** What the client knows of the joined Session, and the refusals it was sent. */
function watch(client: HubClient, sessionId: SessionId) {
  const failures: Array<CommandFailed> = []
  cleanups.push(client.onCommandFailed((failure) => failures.push(failure)))
  client.join(sessionId)
  const joined = () => client.getState().joined[sessionId]
  const events = () => joined()?.log.map((entry) => entry.event) ?? []
  const ofTag = <T extends SessionEvent["_tag"]>(tag: T) =>
    events().filter((event): event is Extract<SessionEvent, { _tag: T }> => event._tag === tag)
  return {
    failures,
    events,
    ofTag,
    queue: () => joined()?.queue.map((prompt) => prompt.text) ?? [],
    queued: (text: string): PromptId => {
      const prompt = joined()?.queue.find((queued) => queued.text === text)
      if (!prompt) throw new Error(`"${text}" isn't queued`)
      return prompt.id
    },
    summary: () => client.getState().sessions?.find((session) => session.id === sessionId),
    /** The refusals of `command`, by what they say. */
    refusals: (command: string) =>
      failures.filter((failure) => failure.command === command).map((failure) => failure.message),
  }
}

/** A Session whose Turn runs from `first`, and `waiting` in its queue behind it. */
async function turnRunning(scene: Scene, first = "one", ...waiting: ReadonlyArray<string>) {
  const session = watch(scene.client, scene.sessionId)
  await eventually(() =>
    expect(scene.client.getState().joined[scene.sessionId]?.historyLoaded).toBe(true),
  )
  scene.client.sendPrompt(scene.sessionId, first)
  await eventually(() => expect(session.ofTag("TurnStarted")).toHaveLength(1))
  for (const text of waiting) scene.client.sendPrompt(scene.sessionId, text)
  await eventually(() => expect(session.queue()).toEqual([...waiting]))
  return session
}

for (const adapter of [fake, real]) {
  describe(`the HubClient against ${adapter.name}`, () => {
    test("a prompt is queued, delivered, and starts a Turn from it, under its sender", async () => {
      const scene = await adapter.scene()
      const session = await turnRunning(scene)
      const [turn] = session.ofTag("TurnStarted")
      const sender = turn?.sender
      const from = sender?._tag === "FromParticipant" ? sender.participant.id : undefined
      expect(from).toBe(scene.client.getState().you?.id)
      expect(turn?.promptId).toBeDefined()
      await eventually(() => expect(session.queue()).toEqual([]))
      // The Hub sends the Session's summary after the queue it emptied (#314).
      await eventually(() => expect(session.summary()?.currentTurn).toBe(turn?.turnId))
    })

    test("a prompt sent while a Turn runs waits, and goes next once the Turn ends", async () => {
      const scene = await adapter.scene()
      const session = await turnRunning(scene, "one", "two")
      await Bun.sleep(50)
      expect(session.ofTag("TurnStarted")).toHaveLength(1)
      expect(session.queue()).toEqual(["two"])

      scene.client.stopTurn(scene.sessionId)
      await eventually(() => expect(session.ofTag("TurnStarted")).toHaveLength(2))
      expect(session.ofTag("TurnStopRequested")).toHaveLength(1)
      expect(session.ofTag("TurnEnded").map((ended) => ended.reason)).toEqual(["Stopped"])
      await eventually(() => expect(session.queue()).toEqual([]))
      expect(session.failures).toEqual([])
    })

    test("a steered prompt joins the running Turn, once, and leaves the queue then", async () => {
      const scene = await adapter.scene()
      const session = await turnRunning(scene, "one", "two", "three")
      const two = session.queued("two")
      // Pressed twice: the second is the same steer, on its way.
      scene.client.steerPrompt(scene.sessionId, two)
      scene.client.steerPrompt(scene.sessionId, two)

      await eventually(() => expect(session.ofTag("SteeredPromptRead")).toHaveLength(1))
      const [turn] = session.ofTag("TurnStarted")
      expect(session.ofTag("PromptSteered")).toEqual([
        expect.objectContaining({ turnId: turn?.turnId, promptId: two, text: "two" }),
      ])
      await eventually(() => expect(session.queue()).toEqual(["three"]))
      // It started no Turn of its own, and the rest of the queue waits for the Turn to end.
      await Bun.sleep(50)
      expect(session.ofTag("TurnStarted")).toHaveLength(1)
      expect(session.failures).toEqual([])

      // Gone from the queue, it can't be steered again.
      scene.client.steerPrompt(scene.sessionId, two)
      await eventually(() =>
        expect(session.refusals("SteerPrompt")).toEqual(["The prompt is not in the Prompt queue."]),
      )
    })

    test("a steer is refused without a running Turn, and by a mod from before steering", async () => {
      const idle = await adapter.scene()
      const idleSession = watch(idle.client, idle.sessionId)
      await eventually(() => expect(idleSession.summary()).toBeDefined())
      idle.client.steerPrompt(idle.sessionId, "p-none" as PromptId)
      await eventually(() =>
        expect(idleSession.refusals("SteerPrompt")).toEqual([
          "No Turn is running to steer the prompt into: it goes next.",
        ]),
      )

      const old = await adapter.scene({ modSteers: false })
      const session = await turnRunning(old, "one", "two")
      old.client.steerPrompt(old.sessionId, session.queued("two"))
      await eventually(() =>
        expect(session.refusals("SteerPrompt")).toEqual([
          expect.stringContaining("runs a mod from before steering"),
        ]),
      )
      // It waits in its place, for the Turn to end.
      expect(session.queue()).toEqual(["two"])
      expect(session.ofTag("PromptSteered")).toEqual([])
    })

    test("a queued prompt can be cancelled, unless it is on its way into the Turn", async () => {
      const scene = await adapter.scene()
      const session = await turnRunning(scene, "one", "two", "three")
      scene.client.cancelPrompt(scene.sessionId, session.queued("two"))
      await eventually(() => expect(session.queue()).toEqual(["three"]))
      expect(session.failures).toEqual([])

      // Steered, it is the Turn's: cancelling it is refused, and it joins the Turn.
      const three = session.queued("three")
      scene.client.steerPrompt(scene.sessionId, three)
      scene.client.cancelPrompt(scene.sessionId, three)
      await eventually(() => expect(session.ofTag("PromptSteered")).toHaveLength(1))
      await eventually(() =>
        expect(session.refusals("CancelPrompt")).toEqual([
          "The prompt is being handed to the running Turn.",
        ]),
      )
      // One that isn't queued can't be cancelled either.
      scene.client.cancelPrompt(scene.sessionId, three)
      await eventually(() => expect(session.refusals("CancelPrompt")).toHaveLength(2))
      expect(session.refusals("CancelPrompt")[1]).toBe("The prompt is not in the Prompt queue.")
    })

    test("a Session with a Turn running can't be put to sleep", async () => {
      const scene = await adapter.scene()
      const session = await turnRunning(scene)
      scene.client.sleepSession(scene.sessionId)
      await eventually(() =>
        expect(session.refusals("SleepSession")).toEqual(["A Turn is running: stop it first."]),
      )
    })

    test("only an Archived Session can be purged, and it's gone at once (#351)", async () => {
      const scene = await adapter.scene()
      const session = watch(scene.client, scene.sessionId)
      await eventually(() => expect(session.summary()).toBeDefined())
      await expect(scene.client.purgeSession(scene.sessionId)).rejects.toThrow(
        "Only an Archived Session can be purged: delete it first.",
      )
      scene.client.archiveSession(scene.sessionId)
      await eventually(() => expect(session.summary()?.state).toBe("Archived"))
      expect(await scene.client.purgeSession(scene.sessionId)).toEqual({
        _tag: "ArchivedSessionPurged",
        requestId: expect.any(String),
        sessionId: scene.sessionId,
        runnerOnline: true,
      })
      await eventually(() => expect(session.summary()).toBeUndefined())
    })

    test("a join gets the history, and a rejoin after a dropped connection what came since", async () => {
      const scene = await adapter.scene()
      const session = await turnRunning(scene, "one", "two")
      const seqs = () =>
        scene.client.getState().joined[scene.sessionId]?.log.map((entry) => entry.seq) ?? []
      const before = seqs()

      const statuses: Array<string> = []
      cleanups.push(
        scene.client.subscribe(() => statuses.push(scene.client.getState().connection.status)),
      )
      scene.dropConnections()
      await eventually(() => expect(statuses).toContain("reconnecting"))
      await eventually(() => expect(scene.client.getState().connection.status).toBe("online"))
      scene.client.stopTurn(scene.sessionId)
      await eventually(() => expect(session.ofTag("TurnStarted")).toHaveLength(2))
      // Nothing twice, nothing missed: the log goes on from where it was.
      const after = seqs()
      expect(after.slice(0, before.length)).toEqual(before)
      expect(new Set(after).size).toBe(after.length)
      expect(after).toEqual(after.toSorted((a, b) => a - b))
      expect(session.queue()).toEqual([])

      // Another tab joining now gets the same history.
      const other = scene.newClient()
      const otherSession = watch(other, scene.sessionId)
      await eventually(() => expect(otherSession.events()).toEqual(session.events()))
    })

    test("an image alone is a prompt: its Turn carries it (#276)", async () => {
      const scene = await adapter.scene()
      const session = await turnRunning(scene)
      const file = new File([png], "shot.png", { type: "image/png" })
      const progress: Array<number> = []
      const id = await scene.client.uploadAttachment(scene.sessionId, file, {
        onProgress: (sent) => progress.push(sent),
        signal: new AbortController().signal,
      })
      expect(progress.at(-1)).toBe(png.byteLength)
      expect(scene.client.sendPrompt(scene.sessionId, "", [id])).toBe(true)
      await eventually(() => expect(session.queue()).toEqual([""]))

      scene.client.stopTurn(scene.sessionId)
      await eventually(() => expect(session.ofTag("TurnStarted")).toHaveLength(2))
      expect(session.ofTag("TurnStarted")[1]?.attachments).toEqual([
        { id, name: "shot.png", mediaType: "image/png", size: png.byteLength },
      ])
    })

    test("a prompt with an image steered into the running Turn carries it there (#278)", async () => {
      const scene = await adapter.scene()
      const session = await turnRunning(scene)
      const file = new File([png], "shot.png", { type: "image/png" })
      const id = await scene.client.uploadAttachment(scene.sessionId, file, {
        onProgress: () => {},
        signal: new AbortController().signal,
      })
      expect(scene.client.sendPrompt(scene.sessionId, "", [id])).toBe(true)
      await eventually(() => expect(session.queue()).toEqual([""]))
      scene.client.steerPrompt(scene.sessionId, session.queued(""))
      await eventually(() => expect(session.ofTag("PromptSteered")).toHaveLength(1))
      expect(session.ofTag("PromptSteered")[0]).toMatchObject({
        text: "",
        attachments: [{ id, name: "shot.png", mediaType: "image/png", size: png.byteLength }],
      })
      expect(session.queue()).toEqual([])
    })

    test("a message to a subagent carries its attachments, but not to a mod from before (#278)", async () => {
      for (const modAttaches of [true, false]) {
        const scene = await adapter.scene({ modAttaches })
        const session = watch(scene.client, scene.sessionId)
        scene.client.sendPrompt(scene.sessionId, "delegate")
        await eventually(() =>
          expect(session.summary()?.agents?.some((one) => one.id === agent.agentId)).toBe(true),
        )
        const id = await uploadShot(scene)
        expect(
          scene.client.messageAgent(scene.sessionId, agent.agentId as never, "look", [id]),
        ).toBe(true)
        if (modAttaches) {
          await eventually(() => expect(session.ofTag("AgentMessaged")).toHaveLength(1))
          expect(session.ofTag("AgentMessaged")[0]).toMatchObject({
            text: "look",
            attachments: [shotOf(id)],
          })
        } else {
          await eventually(() =>
            expect(session.refusals("MessageAgent")).toEqual([
              expect.stringContaining("a mod from before attachments"),
            ]),
          )
          expect(session.ofTag("AgentMessaged")).toEqual([])
        }
      }
    })

    test("a reply to Claude's question carries its attachments, but not to a mod from before (#278)", async () => {
      for (const modAttaches of [true, false]) {
        const scene = await adapter.scene({ modAttaches })
        const session = watch(scene.client, scene.sessionId)
        scene.client.sendPrompt(scene.sessionId, "ask")
        await eventually(() => expect(session.summary()?.openQuestion).toBeDefined())
        const toolCallId = session.summary()?.openQuestion?.toolCallId as ToolCallId
        const id = await uploadShot(scene)
        // Only a reply carries attachments.
        scene.client.answerQuestion(scene.sessionId, toolCallId, { _tag: "Dismissed" }, [id])
        scene.client.answerQuestion(
          scene.sessionId,
          toolCallId,
          { _tag: "Replied", text: "like this" },
          [id],
        )
        if (modAttaches) {
          await eventually(() => expect(session.ofTag("QuestionClosed")).toHaveLength(1))
          expect(session.refusals("AnswerQuestion")).toEqual([
            "Only a reply to a question carries attachments.",
          ])
          expect(session.ofTag("QuestionClosed")[0]?.outcome).toEqual({
            _tag: "Replied",
            text: "like this",
            attachments: [shotOf(id)],
          })
        } else {
          await eventually(() => expect(session.refusals("AnswerQuestion")).toHaveLength(2))
          expect(session.refusals("AnswerQuestion")[1]).toContain("a mod from before attachments")
          expect(session.ofTag("QuestionClosed")).toEqual([])
        }
      }
    })

    test("a PDF goes with a prompt, and its Turn carries it as one (#277)", async () => {
      const scene = await adapter.scene()
      const session = await turnRunning(scene)
      const pdf = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n")
      const file = new File([pdf], "spec.pdf", { type: "application/pdf" })
      const id = await scene.client.uploadAttachment(scene.sessionId, file, {
        onProgress: () => {},
        signal: new AbortController().signal,
      })
      expect(scene.client.sendPrompt(scene.sessionId, "read it", [id])).toBe(true)
      scene.client.stopTurn(scene.sessionId)
      await eventually(() => expect(session.ofTag("TurnStarted")).toHaveLength(2))
      expect(session.ofTag("TurnStarted")[1]?.attachments).toEqual([
        { id, name: "spec.pdf", mediaType: "application/pdf", size: pdf.byteLength },
      ])
    })

    test("a prompt names only files its sender uploaded to the Session (#276)", async () => {
      const scene = await adapter.scene()
      const session = watch(scene.client, scene.sessionId)
      scene.client.sendPrompt(scene.sessionId, "look", ["att-nope" as AttachmentId])
      await eventually(() =>
        expect(session.refusals("SendPrompt")).toEqual([expect.stringContaining("attachment")]),
      )
    })
  })
}
