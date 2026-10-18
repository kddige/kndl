// Answering Claude's question from the web UI (#193): the whole app on the fake Hub's demo
// Session, asked to ask with "ask me". Only its Creator answers; anyone else watches (ADR 0026).

import { expect, test } from "bun:test"
import { installDom } from "./dom.ts"
import { button, render, settle, step } from "./render.ts"

let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())

// Loaded after installDom() and the StyleX compiler, so components see the DOM and compile.
const { createMemoryHistory, RouterProvider } = await import("@tanstack/react-router")
const { HubProvider } = await import("../src/app/hub.tsx")
const { HubClient } = await import("../src/hub/client.ts")
const { FakeHub } = await import("../src/hub/fake/FakeHub.ts")
const { bob, demoSessionId } = await import("../src/hub/fake/script.ts")
const { createAppRouter } = await import("../src/router.tsx")

const library = "Which date library should the web UI use?"
const views = "Which views should show relative times?"

/** Waits, letting React render, until `check` stops throwing. */
async function eventually(check: () => void, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      check()
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await settle(10)
    }
  }
}

function typeInto(field: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  // React tracks the value it last saw; the prototype's setter goes around that, as typing does.
  const prototype = Object.getPrototypeOf(field) as object
  const setValue = Object.getOwnPropertyDescriptor(prototype, "value")?.set
  setValue?.call(field, value)
  field.dispatchEvent(new Event("input", { bubbles: true }))
}

/** The demo Session, idle, once Claude has asked its question in reply to "ask me". */
async function asked() {
  const hub = new FakeHub({ stepMs: 2, autoplay: false })
  const client = new HubClient(hub, { retryDelay: () => 1 })
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [`/sessions/${demoSessionId}`] }),
  )
  const view = await render(
    <HubProvider client={client}>
      <RouterProvider router={router} />
    </HubProvider>,
  )
  cleanup = async () => {
    await view.unmount()
    client.stop()
    hub.dispose()
  }
  const page = view.container
  const field = (label: string) => {
    const found = page.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)
    if (!found) throw new Error(`no ${label} field`)
    return found
  }
  await eventually(() => expect(page.querySelector("h1")).not.toBeNull())
  await step(() => typeInto(field("Prompt"), "Add relative times, but ask me first"))
  await step(() => button("Send prompt", page).click())

  const card = () => page.querySelector<HTMLElement>('[aria-label="Question"]')
  await eventually(() => expect(card()).not.toBeNull())
  return {
    hub,
    client,
    page,
    card,
    field,
    conversation: () => page.querySelector('[aria-label="Conversation"]')?.textContent ?? "",
    header: () => page.querySelector("h1")?.closest("header")?.textContent ?? "",
    /** The card's row for the option labelled `label`. */
    option: (label: string) => {
      const row = [...(card()?.querySelectorAll("li button") ?? [])].find((el) =>
        el.textContent?.includes(label),
      )
      if (!row) throw new Error(`no ${label} option`)
      return row as HTMLButtonElement
    },
    answers: () =>
      hub.received.flatMap((message) =>
        message._tag === "AnswerQuestion" ? [message.answer] : [],
      ),
  }
}

test("the Creator answers Claude's questions from the chat, as the terminal would", async () => {
  const { hub, client, page, card, field, conversation, header, option, answers } = await asked()

  // The Session is waiting on someone: on its page, in the sidebar and in the transcript.
  expect(header()).toContain("Waiting on you")
  expect(page.querySelector('[role="img"][aria-label="Waiting on you"]')).not.toBeNull()
  expect(conversation()).toContain("Asking a question")
  expect(card()?.textContent).toContain(library)
  expect(card()?.textContent).toContain("1 of 2")
  // The prompt box still works: what's sent there replies instead of answering.
  expect(field("Reply").placeholder).toBe("Or reply directly…")

  // Their own picks, from another tab, don't show as someone else's.
  await settle(50)
  expect(card()?.querySelector('[aria-label^="Picked by"]')).toBeNull()

  // One option for the first question moves on to the second, which takes several.
  await step(() => option("Luxon").click())
  await eventually(() => expect(card()?.textContent).toContain(views))
  expect(card()?.textContent).toContain("2 of 2")
  await step(() => option("Sessions list").click())
  await step(() => option("Transcript").click())
  expect(option("Transcript").getAttribute("aria-pressed")).toBe("true")
  await step(() => option("Runners page").click())
  await step(() => option("Runners page").click())
  expect(option("Runners page").getAttribute("aria-pressed")).toBe("false")
  // What was picked so far is shared with the others.
  await eventually(() =>
    expect(hub.received.map((message) => message._tag)).toContain("PickAnswer"),
  )

  await step(() => button("Submit", page).click())
  expect(answers()).toEqual([
    { _tag: "Answered", answers: { [library]: "Luxon", [views]: "Sessions list, Transcript" } },
  ])

  // Answered: the card goes, and the transcript says who answered what, and Claude goes on.
  await eventually(() => expect(card()).toBeNull())
  expect(conversation()).toContain(`Alice Kim answered: ${library} Luxon`)
  expect(header()).not.toContain("Waiting on you")
  expect(field("Prompt")).not.toBeNull()
  await eventually(() => expect(conversation()).toContain("Thanks. Going with that."))

  // An answer that comes after the first is refused, saying who answered first and what.
  const closed = hub.received.find((message) => message._tag === "AnswerQuestion")
  if (closed?._tag !== "AnswerQuestion") throw new Error("no answer sent")
  await step(() =>
    client.answerQuestion(closed.sessionId, closed.toolCallId, { _tag: "Dismissed" }),
  )
  await eventually(() => expect(document.body.textContent).toContain("The question had closed"))
  expect(document.body.textContent).toContain(`Alice Kim answered first: ${library} Luxon`)
})

test("Something else, Skip, the keyboard, and replying in the prompt box", async () => {
  const { page, card, field, conversation, option, answers } = await asked()

  // Number keys pick: 2 answers the first question with its second option, Luxon.
  const keyDown = (key: string, target: Element | null | undefined = card()) =>
    step(() =>
      target?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })),
    )
  await keyDown("2")
  await eventually(() => expect(card()?.textContent).toContain(views))
  // ← goes back to it, with Luxon still picked; → returns.
  await keyDown("ArrowLeft")
  await eventually(() => expect(card()?.textContent).toContain(library))
  expect(option("Luxon").textContent).toContain("Luxon")
  await keyDown("ArrowRight")
  await eventually(() => expect(card()?.textContent).toContain(views))
  await keyDown("ArrowLeft")
  await eventually(() => expect(card()?.textContent).toContain(library))

  // Something else, typed, answers in place of an option; Enter moves on.
  const other = card()?.querySelector<HTMLInputElement>('input[aria-label="Something else"]')
  if (!other) throw new Error("no Something else field")
  await step(() => typeInto(other, "Day.js"))
  await keyDown("Enter", other)
  await eventually(() => expect(card()?.textContent).toContain(views))

  // Skip leaves the second question out, as the terminal's dialog does, and sends the answers.
  await step(() => button("Skip", card() ?? undefined).click())
  expect(answers()).toEqual([{ _tag: "Answered", answers: { [library]: "Day.js" } }])
  await eventually(() => expect(card()).toBeNull())
  await eventually(() => expect(conversation()).toContain("Thanks. Going with that."))

  // Asked again: a reply in the prompt box declines the question and goes to Claude instead.
  await eventually(() => expect(field("Prompt").disabled).toBe(false))
  await step(() => typeInto(field("Prompt"), "ask me again"))
  await step(() => button("Send prompt", page).click())
  await eventually(() => expect(card()).not.toBeNull())
  await step(() => typeInto(field("Reply"), "Use Temporal, and only the transcript  "))
  await step(() => button("Reply", page).click())
  expect(answers()[1]).toEqual({ _tag: "Replied", text: "Use Temporal, and only the transcript" })
  await eventually(() =>
    expect(conversation()).toContain("Alice Kim replied: “Use Temporal, and only the transcript”"),
  )
})

test("× dismisses the question, and everyone sees who did", async () => {
  const { card, conversation, answers } = await asked()
  await step(() => button("Dismiss the question", card() ?? undefined).click())
  expect(answers()).toEqual([{ _tag: "Dismissed" }])
  await eventually(() => expect(card()).toBeNull())
  expect(conversation()).toContain("Alice Kim dismissed the question")
})

test("an image pasted into a reply goes with it, and shows under the question for everyone (#278)", async () => {
  const { hub, page, card, field, conversation } = await asked()
  const clipboardData = new DataTransfer()
  clipboardData.items.add(new File([new Uint8Array(8)], "shot.png", { type: "image/png" }))
  await step(() =>
    field("Reply").dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
    ),
  )
  await eventually(() =>
    expect(page.querySelector('[aria-label="Attachments"]')?.textContent).toContain("shot.png"),
  )
  // The image alone is no reply.
  expect(button("Reply", page).disabled).toBe(true)
  await step(() => typeInto(field("Reply"), "Like this one"))
  await eventually(() => expect(button("Reply", page).disabled).toBe(false))
  await step(() => button("Reply", page).click())

  const sent = hub.received.findLast((message) => message._tag === "AnswerQuestion")
  expect(sent).toMatchObject({
    answer: { _tag: "Replied", text: "Like this one" },
    attachments: [expect.any(String)],
  })
  await eventually(() => expect(card()).toBeNull())
  await eventually(() =>
    expect(conversation()).toContain("Alice Kim replied with 1 image: “Like this one”"),
  )
  expect(
    page.querySelector('[aria-label="The reply\'s attachments"] img[alt="shot.png"]'),
  ).not.toBeNull()
  expect(page.querySelector('[aria-label="Attachments"]')).toBeNull()
})

test("someone watching sees Claude's questions and the Creator's picks, with nothing to answer", async () => {
  // Bob watches Alice's demo Session as she asks Claude to ask first, from another tab.
  const hub = new FakeHub({ stepMs: 2, autoplay: false, you: bob })
  const client = new HubClient(hub, { retryDelay: () => 1 })
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [`/sessions/${demoSessionId}`] }),
  )
  const view = await render(
    <HubProvider client={client}>
      <RouterProvider router={router} />
    </HubProvider>,
  )
  cleanup = async () => {
    await view.unmount()
    client.stop()
    hub.dispose()
  }
  const page = view.container
  await eventually(() => expect(page.querySelector("h1")).not.toBeNull())
  hub.creatorPrompts(demoSessionId, "Add relative times, but ask me first")
  const card = () => page.querySelector<HTMLElement>('[aria-label="Question"]')
  await eventually(() => expect(card()).not.toBeNull())

  // It waits on Alice, who drives it: on its page and in the sidebar.
  expect(page.querySelector("h1")?.closest("header")?.textContent).toContain("Waiting on Alice Kim")
  expect(page.querySelector('[role="img"][aria-label="Waiting on Alice Kim"]')).not.toBeNull()
  expect(card()?.textContent).toContain(library)
  expect(card()?.textContent).toContain("Luxon")
  expect(card()?.textContent).toContain("Waiting on Alice Kim to answer")
  // Her pick shows; there's nothing to pick, type, skip, dismiss or submit.
  await eventually(() =>
    expect(card()?.querySelector('[aria-label="Picked by: Alice Kim"]')).not.toBeNull(),
  )
  const buttons = [...(card()?.querySelectorAll("button") ?? [])].map(
    (each) => each.getAttribute("aria-label") ?? each.textContent,
  )
  expect(buttons).toEqual(["Previous question", "Next question"])
  expect(card()?.querySelector("input")).toBeNull()
  // The prompt box doesn't reply for them either.
  const prompt = page.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')
  expect(prompt?.disabled).toBe(true)
  expect(page.querySelector('textarea[aria-label="Reply"]')).toBeNull()
  expect(
    hub.received.filter(({ _tag }) => _tag === "AnswerQuestion" || _tag === "PickAnswer"),
  ).toEqual([])
})
