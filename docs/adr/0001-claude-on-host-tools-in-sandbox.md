---
status: accepted
---

# Claude Code runs on the host; every file and command tool runs in the Sandbox

The Claude Code process for a Session runs on the Runner host, but its file and command tools (Bash, Read, Write, Edit, NotebookEdit, Glob, Grep) execute inside the Session's Sandbox. The mod intercepts each `tool.call` and answers it with `{ result }` from the Sandbox, so the model keeps the built-in tools it was trained on. It denies by default: any other tool that would touch the host filesystem or start processes is refused. WebSearch, which runs at Anthropic, is the one tool it leaves to Claude Code (amended in #126, below). This keeps Claude's credentials and configuration out of the Sandbox, while nothing the agent does touches the host.

## Considered options

- **Claude Code inside the Sandbox**: simplest isolation, but puts the Runner login inside the VM with whatever code the agent runs.
- **`CLAUDE_CODE_SHELL_PREFIX` / a custom shell**: only redirects Bash. Read, Edit and the rest still run in-process on the host.
- **Claude Code's built-in `sandbox` setting**: covers shell commands only, and reads anywhere on the host by default.
- **MCP replacement tools with the built-ins disabled**: tools get `mcp__` names the model isn't trained on, output is capped, and large results are written to host paths.

## Consequences

- Some things still run on the host regardless of tool routing: hooks, MCP servers, `CLAUDE.md` and `@`-mentions, the git status snapshot, skill shell injection and statusline commands. Runners therefore launch Claude Code with an explicit `--tools` list, `--strict-mcp-config`, minimal setting sources, `disableSkillShellExecution` and `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`, from an empty per-session host directory. The Repo's `CLAUDE.md` and skills are read in the Sandbox instead (amended in #125, below).
- File tools must not run on the host even though the Workspace lives there: a symlink created inside the Sandbox could point a host-side Read at `~/.ssh`.
- The first implementation forwards intercepted calls to `claude mcp serve` inside the Sandbox, to reuse the real tool code. That depends on a spike; the fallback is our own agent in the Sandbox.

## Web search (amended in #126)

The tool list has one tool that doesn't run in the Sandbox: WebSearch. The mod passes it on to Claude Code and allows it without asking. It is a server tool: Claude Code sends the query to the Anthropic API it already talks to, as a request carrying the API's web search tool, and the search runs at Anthropic. Only titles, URLs and text come back, so nothing on the host fetches a page or runs a command. Claude Code 2.1.289's debug log shows a WebSearch call as one more `/v1/messages` request and nothing else.

WebFetch stays denied. It fetches the URL from the host, which can reach the Runner's local network and the Hub, the boundary ADR 0004 draws around the Sandbox. Its denial tells Claude to fetch the page with `curl` through Bash, which runs in the Sandbox.

## Repo skills and CLAUDE.md (amended in #125)

A Session loads the Repo's own instructions and skills, read in the Sandbox. Claude Code still loads nothing from a project on the host.

**Why not a setting source.** In Claude Code 2.1.289, `--setting-sources project` loads project skills and `CLAUDE.md` together with the project's `.claude/settings.json`, hooks included. The two can't be had apart, so Runners keep `--setting-sources ""`, which loads nothing from the project. `--add-dir` with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` loads `CLAUDE.md` but not skills. The variable would also load the `CLAUDE.md` of any directory a Participant adds with `/add-dir`, so it isn't used.

**What is loaded.** At each start and wake, the Runner reads these from `/workspace` through the Sandbox (`exec` and `readFile`, never a mount):

- **Instructions:** `CLAUDE.md` and `.claude/CLAUDE.md`, and the files they import.
- **Skills:** each `.claude/skills/<name>/SKILL.md`.

Only regular files are read. A path with a symbolic link anywhere along it is skipped. So is a file that isn't UTF-8 text, or one over 64 KiB. All instruction files together are capped at 256 KiB, and the skills at 64.

The Runner writes what it read to `<session>/repo/`, replacing what was there:

- `instructions.json` holds the instruction files, by their paths in the Sandbox. The mod's `prompt.context` hook puts them in the context as project instructions (`/workspace/CLAUDE.md` and so on). In the same hook it drops every other instruction file Claude Code found on the host, except the organization's managed policy.
- `.claude/` is a plugin named `repo`, which Claude Code loads with a second `--plugin-dir`. Its skills are the Repo's (`/repo:<name>`). A plugin's skills are all Claude Code takes from that directory: it loads no `settings.json` from a plugin root.

The mod's `skill.prompt` hook points a skill's base directory at `/workspace/.claude/skills/<name>`. The skill's other files are read there, by tools that run in the Sandbox.

**`@` imports.** The Runner resolves them itself, against the Workspace. It finds them as Claude Code does: `@path` in a file's prose, not in code or HTML comments. It follows them depth first, up to 5 deep and 32 in all. An import that leaves `/workspace` is skipped (`..`, `~/`, or an absolute path elsewhere), so Claude Code never resolves one against the host:

- **Instruction files:** Claude Code doesn't resolve `@` in files a `prompt.context` hook supplies (verified with 2.1.289). As a second guard, the Runner still puts a zero-width space (U+200B) before every `@` in their prose. A zero-width space isn't whitespace to Claude Code's import pattern. Code blocks and code spans are left as written, so `bun add @scope/pkg` can still be copied.
- **Skills:** Claude Code looks through a skill's whole text for `@` file mentions and attaches the files from the host. It runs `` !`command` `` and ```` ```! ```` blocks unless `disableSkillShellExecution` is set, which it still is. So in a skill, every `@` gets a zero-width space, and so does every `!` next to a backtick. The mod tells the model, so it leaves them out of what it writes.
- **Verified with 2.1.289:** with the zero-width spaces, neither imports, `@` mentions nor shell injection took effect. Without them, all three did.

A skill keeps only its name (its directory's) and the frontmatter that describes it: `description`, `when_to_use`, `argument-hint`, `disable-model-invocation` and `user-invocable`. Fields that change what runs are dropped, such as `hooks`, `allowed-tools`, `model`, `context`, `agent` and `shell`.

**What is never loaded, and why:**

- **`settings.json`, hooks, MCP config, agents, commands and output styles:** each runs something or changes what runs. Commands are the older form of skills, and a Repo can move them to skills.
- **`CLAUDE.local.md`:** it is personal and gitignored. The model can write it in the Workspace, so loading it would let one Session leave standing instructions for the next.
- **Nested `CLAUDE.md` files and `.claude/rules/`:** Claude Code loads these as the model reads files under their directories, and those reads happen in the Sandbox, so they would need the Runner's reading done mid-Turn. Left for later.
- **The person's own `~/.claude/CLAUDE.md` and the Runner host's project files:** the Session's project is the Repo, not the host.

**When it is read.** The copy is taken at each start and wake, from the Workspace as it is then. Skills are reloaded each time Claude Code starts. A resumed conversation already carries the instructions it started with, so new ones take effect after `/clear` or compaction.
