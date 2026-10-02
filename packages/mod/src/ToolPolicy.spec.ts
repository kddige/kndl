import { describe, expect, test } from "bun:test"
import { SandboxTools } from "@claude-hub/protocol"
import {
  decideTool,
  noBackground,
  notAvailable,
  startsShellMode,
  toolArguments,
} from "./ToolPolicy.ts"

/**
 * Every Claude Code tool name we could enumerate: the built-ins of 2.1.287 (from the API types it
 * lays beside a mod), names older and newer builds have used, and the shapes of MCP and plugin
 * tools.
 */
const otherTools = [
  "Agent",
  "AppifactRepl",
  "Artifact",
  "ArtifactCheck",
  "ArtifactComments",
  "ArtifactData",
  "AskUserQuestion",
  "BashOutput",
  "ClaudeDesign",
  "CronCreate",
  "CronDelete",
  "CronList",
  "DesignSync",
  "EndConversation",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "FetchInboxMessage",
  "GetTask",
  "KillShell",
  "LS",
  "LSP",
  "ListAgents",
  "ListConnectors",
  "ListMcpResourcesTool",
  "ListPlugins",
  "ListSkills",
  "Monitor",
  "MultiEdit",
  "NotebookRead",
  "Poll",
  "PowerShell",
  "Projects",
  "ProposeGoal",
  "PushNotification",
  "REPL",
  "ReadMcpResourceDirTool",
  "ReadMcpResourceTool",
  "ReadNotifications",
  "RemoteTrigger",
  "ReportFindings",
  "ScheduleWakeup",
  "SearchMcpRegistry",
  "SearchPlugins",
  "SearchSkills",
  "SendFeedback",
  "SendFile",
  "SendMessage",
  "SendUserFile",
  "SendUserMessage",
  "ShareOnboardingGuide",
  "ShowOnboardingRolePicker",
  "Skill",
  "SuggestConnectors",
  "SuggestPluginInstall",
  "SuggestSkills",
  "Task",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TodoRead",
  "TodoWrite",
  "ToolSearch",
  "WaitForMcpServers",
  "WebFetch",
  "WebSearch",
  "Workflow",
  // MCP and plugin tools, including ones named like a routed tool.
  "mcp__github__create_pull_request",
  "mcp__filesystem__read_file",
  "mcp__hub-link__Bash",
  "mcp__plugin_x__Read",
  "mcp__ide__executeCode",
  // Unknown names, and near misses of routed ones.
  "SomeFutureTool",
  "bash",
  "BASH",
  "read",
  " Bash",
  "Bash ",
  "Bash\u0000",
  "Edit2",
  "",
  "__proto__",
  "constructor",
  "toString",
]

describe("decideTool", () => {
  test("runs the file and command tools in the Sandbox", () => {
    for (const tool of SandboxTools)
      expect(decideTool(tool, {})).toEqual({ _tag: "RunInSandbox", tool })
  })

  test("denies every other tool, known or not", () => {
    for (const tool of otherTools)
      expect(decideTool(tool, {})).toEqual({ _tag: "Deny", reason: notAvailable(tool) })
  })

  test("allows exactly the Sandbox tools", () => {
    const allowed = [...SandboxTools, ...otherTools].filter(
      (tool) => decideTool(tool, {})._tag === "RunInSandbox",
    )
    expect(allowed).toEqual(["Bash", "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep"])
  })

  test("denies a background command", () => {
    expect(decideTool("Bash", { command: "sleep 9", run_in_background: true })).toEqual({
      _tag: "Deny",
      reason: noBackground,
    })
    expect(decideTool("Bash", { command: "ls", run_in_background: false })._tag).toBe(
      "RunInSandbox",
    )
  })
})

test("toolArguments drops the keys Claude Code adds beside a tool's own", () => {
  expect(
    toolArguments({
      tool: "Bash",
      tool_use_id: "toolu_1",
      agentId: "a1",
      consent: "yes",
      command: "ls",
      timeout: 5,
    }),
  ).toEqual({ command: "ls", timeout: 5 })
})

const edit = (text: string, start: number, end: number, inputText: string) => ({
  text,
  start,
  end,
  inputText,
})

describe("startsShellMode", () => {
  test("catches a ! typed or pasted at the start", () => {
    expect(startsShellMode(edit("", 0, 0, "!"))).toBe(true)
    expect(startsShellMode(edit("", 0, 0, "!rm -rf /"))).toBe(true)
    expect(startsShellMode(edit("ls", 0, 0, "!"))).toBe(true)
    expect(startsShellMode(edit("x ls", 0, 2, "!"))).toBe(true)
  })

  test("lets every other edit through", () => {
    expect(startsShellMode(edit("", 0, 0, "fix the bug!"))).toBe(false)
    expect(startsShellMode(edit("hi", 2, 2, "!"))).toBe(false)
    expect(startsShellMode(edit("!x", 0, 1, ""))).toBe(false)
  })
})
