// `hub.env` and `runner.env`: KEY=value lines, as Bun's `--env-file` reads them, which is how the
// services load them. Onboard and doctor change the variables they manage in place and keep every
// other line, comments and variables someone added by hand, as it was.

/** One line of an env file: a variable, or anything else (blank, comment), kept verbatim. */
export type EnvLine =
  | { readonly _tag: "Variable"; readonly key: string; readonly value: string }
  | { readonly _tag: "Other"; readonly text: string }

export type EnvFile = ReadonlyArray<EnvLine>

const Assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/

/** Parses an env file. Lines that aren't assignments are kept as they are. */
export function parseEnv(text: string): EnvFile {
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === "") lines.pop()
  return lines.map((line) => {
    const match = Assignment.exec(line)
    if (!match?.[1]) return { _tag: "Other", text: line }
    return { _tag: "Variable", key: match[1], value: unquote(match[2] ?? "") }
  })
}

/** The file's variables; a later assignment wins, as in Bun. */
export function envValues(file: EnvFile): Readonly<Record<string, string>> {
  const values: Record<string, string> = {}
  for (const line of file) if (line._tag === "Variable") values[line.key] = line.value
  return values
}

/**
 * Sets each variable in `updates` where it is first assigned, or appends it; `undefined` removes
 * it. Repeated assignments of an updated variable go. Every other line stays.
 */
export function updateEnv(
  file: EnvFile,
  updates: Readonly<Record<string, string | undefined>>,
): EnvFile {
  const written = new Set<string>()
  const out: Array<EnvLine> = []
  for (const line of file) {
    if (line._tag === "Variable" && Object.hasOwn(updates, line.key)) {
      if (written.has(line.key)) continue
      written.add(line.key)
      const value = updates[line.key]
      if (value !== undefined) out.push({ _tag: "Variable", key: line.key, value })
    } else {
      out.push(line)
    }
  }
  for (const [key, value] of Object.entries(updates)) {
    if (!written.has(key) && value !== undefined) out.push({ _tag: "Variable", key, value })
  }
  return out
}

/** Writes the file back out, quoting values only where Bun needs it. */
export function renderEnv(file: EnvFile): string {
  if (file.length === 0) return ""
  return `${file.map((line) => (line._tag === "Other" ? line.text : `${line.key}=${quote(line.value)}`)).join("\n")}\n`
}

function quote(value: string): string {
  if (/^[\w@%+=:,./~-]*$/.test(value)) return value
  if (!value.includes("'")) return `'${value}'`
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`
}

function unquote(raw: string): string {
  const value = raw.trim()
  const first = value[0]
  if ((first === '"' || first === "'" || first === "`") && value.length >= 2) {
    const end = closingQuote(value, first)
    if (end > 0) {
      const inner = value.slice(1, end)
      return first === '"' ? inner.replaceAll("\\n", "\n").replace(/\\(["\\])/g, "$1") : inner
    }
  }
  // An unquoted value ends at a comment.
  return value.replace(/\s+#.*$/, "")
}

/** Where a quoted value ends; in double quotes a backslash escapes the next character. */
function closingQuote(value: string, mark: string): number {
  for (let i = 1; i < value.length; i++) {
    if (mark === '"' && value[i] === "\\") i++
    else if (value[i] === mark) return i
  }
  return -1
}
