// Which tool calls hub-link lets through (ADR 0001). Claude Code runs on the Runner's host, but a
// Session's tools must never touch it: the file and command tools run in the Session's Sandbox,
// through the Runner's tool bridge, hub-link's own git tools run on the Runner (GitTools.ts), and
// every other tool is denied. The list is an allowlist, so a tool added to Claude Code later, an
// MCP tool, or a name nobody has heard of is denied too.

import { SandboxTools } from "@claude-hub/protocol"
import type { GitTool, SandboxTool } from "@claude-hub/protocol"
import { gitToolName, gitToolOf } from "./GitTools.ts"

/** What hub-link does with one tool call. */
export type ToolDecision =
  | { readonly _tag: "RunInSandbox"; readonly tool: SandboxTool }
  | { readonly _tag: "RunOnHost"; readonly tool: GitTool }
  | { readonly _tag: "Deny"; readonly reason: string }

const sandboxTools: ReadonlySet<string> = new Set(SandboxTools)

const isSandboxTool = (tool: string): tool is SandboxTool => sandboxTools.has(tool)

/** The keys Claude Code adds to a tool call's input that the tool itself never sees. */
const reservedKeys: ReadonlySet<string> = new Set(["tool", "tool_use_id", "agentId", "consent"])

/** A tool call's own arguments, without the keys Claude Code adds beside them. */
export const toolArguments = (input: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(input).filter(([key]) => !reservedKeys.has(key)))

export const notAvailable = (tool: string) =>
  `${tool} is not available in this Claude Hub Session. Only ${SandboxTools.join(", ")} can be ` +
  "used here, and they run inside the Session's Sandbox; git commits, pushes and pull requests " +
  `go through ${gitToolName("git_commit")}, ${gitToolName("git_push")}, ` +
  `${gitToolName("open_pr")} and ${gitToolName("review_pr")}.`

export const useGitTools = (verb: "commit" | "push") =>
  `\`git ${verb}\` doesn't run in this Claude Hub Session's Sandbox. Use ` +
  `${gitToolName("git_commit")} to commit on the Work branch (it adds the Session's co-authors) ` +
  `and ${gitToolName("git_push")} to push it; ${gitToolName("open_pr")} opens a pull request. ` +
  "Other git commands work as usual."

export const noBackground =
  "Background commands are not available in this Claude Hub Session. Run the command in the " +
  "foreground instead."

/**
 * Decides one tool call: run it in the Sandbox, or deny it. `input` is the call's input as
 * Claude Code passed it.
 */
export const decideTool = (
  tool: string,
  input: Readonly<Record<string, unknown>>,
): ToolDecision => {
  const gitTool = gitToolOf(tool)
  if (gitTool !== undefined) return { _tag: "RunOnHost", tool: gitTool }
  if (!isSandboxTool(tool)) return { _tag: "Deny", reason: notAvailable(tool) }
  if (tool === "Bash") {
    // A background command's output stays in the Sandbox, where Claude Code can't read it back
    // (spike #2). The launch flags turn background tasks off; this refuses one that slips through.
    if (input["run_in_background"] === true) return { _tag: "Deny", reason: noBackground }
    const command = input["command"]
    const verb = typeof command === "string" ? gitWriteIn(command) : undefined
    if (verb !== undefined) return { _tag: "Deny", reason: useGitTools(verb) }
  }
  return { _tag: "RunInSandbox", tool }
}

// ── `git commit` and `git push` in Bash ────────────────────────────────────
//
// Guidance, not a security boundary. The Sandbox holds no GitHub token, and none ever enters it,
// so a commit there has no co-authors and a push there has no credentials. Refusing the common
// forms points the model at the git tools instead of letting it fail or retry. A determined
// command (an alias, `eval`, a script file) gets past this check, and that's fine: it still has
// no credentials.

/** Commands that run the command after their own options and arguments. */
const wrappers: Readonly<Record<string, ReadonlySet<string>>> = {
  // The options of each that take a value, so the value isn't read as the command.
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-U"]),
  env: new Set(["-u", "-C", "-S", "--unset", "--chdir"]),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(["-a"]),
  nohup: new Set(),
  time: new Set(["-f", "-o"]),
  nice: new Set(["-n"]),
  ionice: new Set(["-c", "-n"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  xargs: new Set(["-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
}

/** Shells whose `-c <script>` is a command line of its own. */
const shells: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh"])

/** git's options before the subcommand that take a separate value. */
const gitValueOptions: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--config-env",
  "--list-cmds",
  "--attr-source",
])

const isAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)

const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1)

/**
 * Splits a command line into simple commands, each a list of words: on `;`, `&`, `|`, newlines,
 * parentheses, braces and command substitutions, with quotes and backslashes taken off words.
 * Rough, as a guide needs no more.
 */
const simpleCommands = (line: string): Array<Array<string>> => {
  const commands: Array<Array<string>> = []
  let words: Array<string> = []
  let word = ""
  let inWord = false
  const endWord = () => {
    if (inWord) words.push(word)
    word = ""
    inWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? ""
    if (c === "'") {
      const end = line.indexOf("'", i + 1)
      word += line.slice(i + 1, end === -1 ? line.length : end)
      inWord = true
      i = end === -1 ? line.length : end
    } else if (c === '"') {
      let j = i + 1
      while (j < line.length && line[j] !== '"') {
        if (line[j] === "\\" && j + 1 < line.length) j++
        // A substitution inside double quotes is a command of its own.
        if (line[j] === "$" && line[j + 1] === "(") {
          const close = line.indexOf(")", j)
          commands.push(...simpleCommands(line.slice(j + 2, close === -1 ? line.length : close)))
        }
        word += line[j] ?? ""
        j++
      }
      inWord = true
      i = j
    } else if (c === "\\") {
      word += line[i + 1] ?? ""
      inWord = true
      i++
    } else if (c === "#" && !inWord) {
      const end = line.indexOf("\n", i)
      i = end === -1 ? line.length : end - 1
    } else if (/[;&|\n(){}`]/.test(c)) {
      endCommand()
    } else if (c === "$" && line[i + 1] === "(") {
      endCommand()
      i++
    } else if (/\s/.test(c)) {
      endWord()
    } else {
      word += c
      inWord = true
    }
  }
  endCommand()
  return commands
}

/** `commit` or `push` when `words` runs git's, else undefined. */
const gitWriteInCommand = (words: ReadonlyArray<string>): "commit" | "push" | undefined => {
  let i = 0
  // Variable assignments, then any wrapper and its options, then the command.
  for (;;) {
    while (i < words.length && isAssignment(words[i] ?? "")) i++
    const name = basename(words[i] ?? "")
    const valued = wrappers[name]
    if (valued !== undefined) {
      i++
      while (i < words.length) {
        const word = words[i] ?? ""
        if (word === "--") {
          i++
          break
        }
        if (isAssignment(word)) i++
        else if (word.startsWith("-")) i += valued.has(word) ? 2 : 1
        // `timeout 10 git push`: the duration.
        else if (name === "timeout" && /^[\d.]+[smhd]?$/.test(word)) i++
        else break
      }
      continue
    }
    if (shells.has(name)) {
      const script = words.indexOf("-c", i + 1)
      if (script === -1) return undefined
      return gitWriteIn(words[script + 1] ?? "")
    }
    if (name !== "git") return undefined
    i++
    break
  }
  while (i < words.length) {
    const word = words[i] ?? ""
    if (!word.startsWith("-")) break
    i += gitValueOptions.has(word) ? 2 : 1
  }
  const subcommand = words[i]
  return subcommand === "commit" || subcommand === "push" ? subcommand : undefined
}

/**
 * `commit` or `push` if the Bash command line runs `git commit` or `git push` anywhere in it:
 * after `cd x &&`, behind `git -C x` or other global options, with variables or `env` in front,
 * in a `;`, `&&` or `|` chain, or in `bash -c`.
 */
export const gitWriteIn = (line: string): "commit" | "push" | undefined => {
  for (const words of simpleCommands(line)) {
    const verb = gitWriteInCommand(words)
    if (verb !== undefined) return verb
  }
  return undefined
}

/**
 * Whether an edit to the prompt box would start Claude Code's `!` shell mode, which runs a
 * command on the host without a tool call (spike #2): a `!` typed or pasted at the start.
 */
export const startsShellMode = (edit: {
  readonly text: string
  readonly start: number
  readonly end: number
  readonly inputText: string
}) => {
  const after = edit.text.slice(0, edit.start) + edit.inputText + edit.text.slice(edit.end)
  return after.startsWith("!")
}
