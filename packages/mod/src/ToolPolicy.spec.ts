import { describe, expect, test } from "bun:test"
import { GitTools, SandboxTools } from "@claude-hub/protocol"
import { gitToolName } from "./GitTools.ts"
import {
  decideTool,
  gitWriteIn,
  noBackground,
  notAvailable,
  startsShellMode,
  toolArguments,
  useGitTools,
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
  "mcp__hub-link__git_status",
  "mcp__hub-link__git_commit ",
  "mcp__hublink__git_commit",
  "mcp__other__git_push",
  "git_commit",
  "git_push",
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

  test("runs exactly hub-link's git tools on the host", () => {
    for (const tool of GitTools)
      expect(decideTool(gitToolName(tool), {})).toEqual({ _tag: "RunOnHost", tool })
    const onHost = [...SandboxTools, ...otherTools, ...GitTools.map(gitToolName)].filter(
      (tool) => decideTool(tool, {})._tag === "RunOnHost",
    )
    expect(onHost).toEqual([
      "mcp__hub-link__git_commit",
      "mcp__hub-link__git_push",
      "mcp__hub-link__open_pr",
      "mcp__hub-link__review_pr",
    ])
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

describe("git commit and git push in Bash", () => {
  const denied = {
    commit: [
      "git commit -m 'x'",
      "git commit",
      "git -C /workspace commit -am x",
      "git -c user.name=x -c commit.gpgsign=false commit -m x",
      "git --git-dir=/workspace/.git --work-tree /workspace commit -m x",
      "git --no-pager -P commit",
      "/usr/bin/git commit -m x",
      "cd /workspace && git commit -m 'fix'",
      "cd sub; git add . ; git commit -m fix",
      "npm test || git commit -m wip",
      "GIT_AUTHOR_NAME=x GIT_AUTHOR_EMAIL=y git commit -m x",
      "env GIT_DIR=.git git commit -m x",
      "env -u HOME git commit",
      "sudo -u me git commit",
      "command git commit",
      "nohup git commit -m x &",
      "timeout 30 git commit -m x",
      "(cd /workspace && git commit -m x)",
      "{ git add .; git commit -m x; }",
      "echo $(git commit -m x)",
      'echo "$(git commit -m x)"',
      "echo `git commit -m x`",
      "bash -c 'git add -A && git commit -m x'",
      'sh -c "cd /workspace; git commit"',
      "git add .\ngit commit -m x",
      "g\\it commit",
      "'git' \"commit\" -m x",
    ],
    push: [
      "git push",
      "git push --force origin HEAD:main",
      "git -C x push",
      "cd x && git push origin claude/w-1",
      "git status | git push",
      "FOO=1 git push",
      "git status || true; git push",
    ],
  }

  test("denies the common forms, pointing to the git tools", () => {
    for (const [verb, commands] of Object.entries(denied))
      for (const command of commands) {
        expect([command, gitWriteIn(command)]).toEqual([command, verb])
        expect(decideTool("Bash", { command })).toEqual({
          _tag: "Deny",
          reason: useGitTools(verb as "commit" | "push"),
        })
      }
    expect(useGitTools("push")).toContain("mcp__hub-link__git_push")
  })

  test("lets every other git command and lookalike through", () => {
    for (const command of [
      "git status",
      "git log --oneline -5",
      "git diff HEAD",
      "git add -A",
      "git stash push -m x",
      "git show HEAD:commit.txt",
      "git -C commit status",
      "git -c alias.x=commit status",
      "git log --grep 'git commit'",
      "echo 'git commit'",
      'echo "git push"',
      "echo git commit",
      "grep -r 'git push' docs",
      "cat commit push",
      "ls # git commit",
      "gitk commit",
      "git commit-tree HEAD^{tree}",
      "git-lfs push",
      "",
    ]) {
      expect([command, gitWriteIn(command)]).toEqual([command, undefined])
      expect(decideTool("Bash", { command })._tag).toBe("RunInSandbox")
    }
    expect(decideTool("Bash", {})._tag).toBe("RunInSandbox")
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
