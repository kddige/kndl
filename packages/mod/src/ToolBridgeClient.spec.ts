import { describe, expect, test } from "bun:test"
import { ReadBeforeEdit, runInSandbox } from "./ToolBridgeClient.ts"
import type { BridgePost } from "./ToolBridgeClient.ts"

const socket = "/sessions/s1/tools.sock"
const answering =
  (status: number, text: string): BridgePost =>
  async () => ({ status, text })

const refusedBy = async (post: BridgePost, socketPath: string | null = socket) => {
  const answer = await runInSandbox(post, socketPath ?? undefined, "Bash", {
    command: "rm -rf ~",
  })
  expect(answer._tag).toBe("Refused")
  if (answer._tag === "Refused") expect(answer.message).toContain("never runs on the host")
  return answer
}

describe("runInSandbox", () => {
  test("posts the call to the socket and hands back the tool's record", async () => {
    const posted: Array<{ socketPath: string; body: string }> = []
    const answer = await runInSandbox(
      async (socketPath, body) => {
        posted.push({ socketPath, body })
        return { status: 200, text: JSON.stringify({ _tag: "ToolRan", result: { stdout: "hi" } }) }
      },
      socket,
      "Bash",
      { command: "echo hi" },
    )
    expect(answer).toEqual({ _tag: "Ran", result: { stdout: "hi" } })
    expect(posted).toEqual([
      { socketPath: socket, body: JSON.stringify({ tool: "Bash", input: { command: "echo hi" } }) },
    ])
  })

  test("passes on a tool's own error", async () => {
    const answer = await runInSandbox(
      answering(200, JSON.stringify({ _tag: "ToolFailed", message: "File does not exist." })),
      socket,
      "Read",
      { file_path: "/workspace/nope" },
    )
    expect(answer).toEqual({ _tag: "Failed", message: "File does not exist." })
  })

  describe("fails closed", () => {
    test("without a socket", async () => {
      let posted = false
      await refusedBy(async () => {
        posted = true
        return { status: 200, text: "" }
      }, null)
      await refusedBy(answering(200, ""), "")
      expect(posted).toBe(false)
    })

    test("when the bridge is unreachable", async () => {
      await refusedBy(async () => {
        throw new Error("connect ENOENT /sessions/s1/tools.sock")
      })
    })

    test("when the bridge is unavailable", async () => {
      const answer = await refusedBy(
        answering(
          503,
          JSON.stringify({ _tag: "BridgeUnavailable", message: "the Sandbox is stopped" }),
        ),
      )
      expect(answer).toMatchObject({ message: expect.stringContaining("the Sandbox is stopped") })
    })

    test("when the bridge answers something that isn't a reply", async () => {
      await refusedBy(answering(200, ""))
      await refusedBy(answering(200, "not json"))
      await refusedBy(answering(200, "{}"))
      await refusedBy(
        answering(200, JSON.stringify({ _tag: "ToolRan" }).replace("ToolRan", "Other")),
      )
      await refusedBy(answering(500, "Internal Server Error"))
      await refusedBy(answering(502, "<html>bad gateway</html>"))
    })

    test("when a ToolRan comes with an error status", async () => {
      await refusedBy(answering(500, JSON.stringify({ _tag: "ToolRan", result: {} })))
    })
  })
})

describe("ReadBeforeEdit", () => {
  test("refuses an edit of a file not read yet, and allows it once read", () => {
    const rule = new ReadBeforeEdit()
    const edit = { file_path: "/workspace/a.ts", old_string: "a", new_string: "b" }
    expect(rule.check("Edit", edit)).toBeDefined()
    rule.record(
      "Read",
      { file_path: "/workspace/a.ts" },
      { type: "text", file: { filePath: "/workspace/a.ts" } },
    )
    expect(rule.check("Edit", edit)).toBeUndefined()
  })

  test("counts a file written as known", () => {
    const rule = new ReadBeforeEdit()
    rule.record(
      "Write",
      { file_path: "/workspace/b.ts", content: "x" },
      { filePath: "/workspace/b.ts" },
    )
    expect(rule.check("Edit", { file_path: "/workspace/b.ts" })).toBeUndefined()
  })

  test("leaves the other tools alone", () => {
    const rule = new ReadBeforeEdit()
    expect(rule.check("Write", { file_path: "/workspace/c.ts" })).toBeUndefined()
    expect(rule.check("Bash", { command: "ls" })).toBeUndefined()
  })
})
