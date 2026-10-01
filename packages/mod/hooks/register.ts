import type { Register } from "claude-code"

// hub-link: the mod a Runner loads into each Session's Claude Code. It will stream the
// Session to the Hub and answer file and command tools from the Sandbox (ADR 0001).
// For now it only notes in the debug log that it loaded.

export const register: Register = (on) => {
  on("session.start", ($, e, next) => {
    $.ui.log("hub-link loaded; not linked to a Hub yet", { to: "debug" })
    return next(e)
  })
}
