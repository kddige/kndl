import { expect, test } from "claude-code/testing"

test("notes in the debug log that it loaded when a Session starts", async ($, on) => {
  const lines: Array<{ text: string; to: string }> = []
  on("ui.log", (_, e) => {
    lines.push({ text: e.text, to: e.to })
    return { value: undefined }
  })
  on("session.start", (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: false })

  expect(lines).toEqual([{ text: "hub-link loaded; not linked to a Hub yet", to: "debug" }])
})
