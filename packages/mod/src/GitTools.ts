// The git tools hub-link registers (issue #13, ADR 0005): commit, push and pull requests, run on
// the Runner's host and never in the Sandbox. The mod only forwards a call to the Runner, on the
// Session's tool bridge socket (`POST /git/call`, the protocol's Git.ts): the Runner holds the
// Workspace and asks the Hub for a GitHub token, which the mod never sees.

import { GitTools, ToolBridgeReply } from "@claude-hub/protocol"
import type { GitTool } from "@claude-hub/protocol"
import { Exit, Schema } from "effect"
import type { BridgePost, ToolAnswer } from "./ToolBridgeClient.ts"

/** The plugin the tools are registered under; Claude Code names them `mcp__hub-link__<tool>`. */
export const ModPlugin = "hub-link"

/** The name the model calls a git tool by. */
export const gitToolName = (tool: GitTool) => `mcp__${ModPlugin}__${tool}`

const gitToolsByName: ReadonlyMap<string, GitTool> = new Map(
  GitTools.map((tool) => [gitToolName(tool), tool]),
)

/** The git tool `name` calls, if it is one. */
export const gitToolOf = (name: string): GitTool | undefined => gitToolsByName.get(name)

/** What `$.tool.register` takes for one tool. */
export interface GitToolSpec {
  readonly name: GitTool
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

/** The git tools, as the model reads them. */
export const gitToolSpecs: ReadonlyArray<GitToolSpec> = [
  {
    name: "git_commit",
    description:
      "Commit on this Session's Work branch. Stages `paths` (relative to the Workspace, or under " +
      "/workspace), or every change with `all: true`, or else commits what is already staged. " +
      "The commit credits everyone who prompted since the last commit with Co-authored-by " +
      "trailers. It runs on the host, outside the Sandbox, where plain `git commit` is refused. " +
      "It does not push: call git_push after.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The commit message." },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Files or directories to stage before committing, removals included.",
        },
        all: { type: "boolean", description: "Stage every change, untracked files included." },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    name: "git_push",
    description:
      "Push this Session's Work branch to the Repo's origin. It pushes the Work branch only, and " +
      "never forces: if the remote branch has commits the Workspace lacks, it fails and says so.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "open_pr",
    description:
      "Open a pull request from this Session's Work branch into its base branch, or return the " +
      "one already open. Push the Work branch first with git_push. The body gets a link back to " +
      "the Session.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string", description: "Markdown." },
        draft: { type: "boolean", description: "Open it as a draft." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "review_pr",
    description: "Post a review on a pull request of this Session's Repo.",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "integer", minimum: 1, description: "The pull request's number." },
        body: { type: "string", description: "The review comment, in Markdown." },
        event: {
          type: "string",
          enum: ["COMMENT", "APPROVE", "REQUEST_CHANGES"],
          description: "What the review does; COMMENT by default.",
        },
      },
      required: ["number", "body"],
      additionalProperties: false,
    },
  },
]

const decodeReply = Schema.decodeUnknownExit(Schema.fromJsonString(ToolBridgeReply))

export const gitRefusal = (tool: GitTool, why: string) =>
  `${tool} could not run (${why}), so nothing was committed, pushed or posted.`

/** Runs one git tool call on the Runner, through the Session's tool bridge. Never throws. */
export const runGitTool = async (
  post: BridgePost,
  socketPath: string | undefined,
  tool: GitTool,
  input: Readonly<Record<string, unknown>>,
): Promise<ToolAnswer> => {
  if (socketPath === undefined || socketPath === "")
    return { _tag: "Refused", message: gitRefusal(tool, "this Session has no Runner to run it") }
  let response: { readonly status: number; readonly text: string }
  try {
    response = await post(socketPath, JSON.stringify({ tool, input }))
  } catch (error) {
    return { _tag: "Refused", message: gitRefusal(tool, `the Runner is unreachable: ${error}`) }
  }
  const reply = decodeReply(response.text)
  if (Exit.isFailure(reply))
    return {
      _tag: "Refused",
      message: gitRefusal(tool, `the Runner answered ${response.status} with no tool reply`),
    }
  switch (reply.value._tag) {
    case "ToolRan":
      return response.status === 200 && typeof reply.value.result === "string"
        ? { _tag: "Ran", result: reply.value.result }
        : { _tag: "Refused", message: gitRefusal(tool, `the Runner answered ${response.status}`) }
    case "ToolFailed":
      return { _tag: "Failed", message: reply.value.message }
    case "BridgeUnavailable":
      return { _tag: "Refused", message: gitRefusal(tool, reply.value.message) }
  }
}
