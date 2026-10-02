import { describe, expect, test } from "bun:test"
import { GitTools } from "@claude-hub/protocol"
import { gitToolName, gitToolOf, gitToolSpecs, runGitTool } from "./GitTools.ts"

const socket = "/sessions/s1/tools.sock"

const answering =
  (status: number, reply: unknown) => async (_socketPath: string, _body: string) => ({
    status,
    text: JSON.stringify(reply),
  })

describe("the git tools", () => {
  test("are registered under hub-link, one spec each", () => {
    expect(gitToolSpecs.map((spec) => spec.name)).toEqual([...GitTools])
    expect(gitToolName("git_push")).toBe("mcp__hub-link__git_push")
    expect(gitToolOf("mcp__hub-link__open_pr")).toBe("open_pr")
    expect(gitToolOf("mcp__hub-link__Bash")).toBeUndefined()
    for (const spec of gitToolSpecs) expect(spec.inputSchema["type"]).toBe("object")
  })

  test("post the call to the Runner and answer with its result", async () => {
    const posted: Array<{ socketPath: string; body: string }> = []
    const answer = await runGitTool(
      async (socketPath, body) => {
        posted.push({ socketPath, body })
        return { status: 200, text: JSON.stringify({ _tag: "ToolRan", result: "Committed abc" }) }
      },
      socket,
      "git_commit",
      { message: "x", all: true },
    )

    expect(answer).toEqual({ _tag: "Ran", result: "Committed abc" })
    expect(posted).toEqual([
      {
        socketPath: socket,
        body: JSON.stringify({ tool: "git_commit", input: { message: "x", all: true } }),
      },
    ])
  })

  test("pass the Runner's error on to the model", async () => {
    expect(
      await runGitTool(
        answering(200, { _tag: "ToolFailed", message: "Nothing to commit" }),
        socket,
        "git_commit",
        {},
      ),
    ).toEqual({ _tag: "Failed", message: "Nothing to commit" })
  })

  test("refuse when there is no Runner, it is unreachable, or it answers nonsense", async () => {
    const refused = [
      await runGitTool(answering(200, {}), undefined, "git_push", {}),
      await runGitTool(
        async () => {
          throw new Error("ENOENT")
        },
        socket,
        "git_push",
        {},
      ),
      await runGitTool(answering(500, "boom"), socket, "git_push", {}),
      await runGitTool(
        answering(200, { _tag: "ToolRan", result: { not: "text" } }),
        socket,
        "git_push",
        {},
      ),
      await runGitTool(
        answering(503, { _tag: "BridgeUnavailable", message: "down" }),
        socket,
        "git_push",
        {},
      ),
    ]
    for (const answer of refused) {
      expect(answer._tag).toBe("Refused")
      expect(answer._tag === "Refused" && answer.message).toContain("nothing was committed, pushed")
    }
  })
})
