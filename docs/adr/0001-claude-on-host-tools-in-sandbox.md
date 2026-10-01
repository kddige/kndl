---
status: accepted
---

# Claude Code runs on the host; every file and command tool runs in the Sandbox

The Claude Code process for a Session runs on the Runner host, but its file and command tools (Bash, Read, Write, Edit, NotebookEdit, Glob, Grep) execute inside the Session's Sandbox. The mod intercepts each `tool.call` and answers it with `{ result }` from the Sandbox, so the model keeps the built-in tools it was trained on. It denies by default: any other tool that would touch the host filesystem or start processes is refused. This keeps Claude's credentials and configuration out of the Sandbox, while nothing the agent does touches the host.

## Considered options

- **Claude Code inside the Sandbox**: simplest isolation, but puts the Runner login inside the VM with whatever code the agent runs.
- **`CLAUDE_CODE_SHELL_PREFIX` / a custom shell**: only redirects Bash. Read, Edit and the rest still run in-process on the host.
- **Claude Code's built-in `sandbox` setting**: covers shell commands only, and reads anywhere on the host by default.
- **MCP replacement tools with the built-ins disabled**: tools get `mcp__` names the model isn't trained on, output is capped, and large results are written to host paths.

## Consequences

- Some things still run on the host regardless of tool routing: hooks, MCP servers, `CLAUDE.md` and `@`-mentions, the git status snapshot, skill shell injection and statusline commands. Runners therefore launch Claude Code with an explicit `--tools` list, `--strict-mcp-config`, minimal setting sources, `disableSkillShellExecution` and `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`, from an empty per-session host directory.
- File tools must not run on the host even though the Workspace lives there: a symlink created inside the Sandbox could point a host-side Read at `~/.ssh`.
- The first implementation forwards intercepted calls to `claude mcp serve` inside the Sandbox, to reuse the real tool code. That depends on a spike; the fallback is our own agent in the Sandbox.
