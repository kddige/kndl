// Where "Back to Sessions" and "Settings" lead (#398): the last Session and the last settings page
// this tab showed. Per tab, in sessionStorage, so two tabs keep their own way back.

import { useEffect } from "react"

const lastSession = "kndl-last-session"
const recent = "kndl-recent-sessions"
const lastSettings = "kndl-last-settings"

/** The settings-style pages, which show the Settings nav in the sidebar. */
export function isSettingsPath(pathname: string): boolean {
  return (
    ["/account", "/runners", "/environments", "/variables", "/mcp", "/people", "/hub"].includes(
      pathname,
    ) || /^\/repos\/[^/]+\/[^/]+\/environment$/.test(pathname)
  )
}

function read(key: string, fallback: string): string {
  try {
    return sessionStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    // Storage off: the links fall back to their defaults.
  }
}

/** Remembers the page shown, if it's a Session or a settings page. */
export function useRememberPlace(pathname: string): void {
  useEffect(() => {
    if (pathname.startsWith("/sessions/")) {
      write(lastSession, pathname)
      const id = pathname.split("/")[2]
      if (id !== undefined) {
        write(
          recent,
          JSON.stringify([id, ...recentSessions().filter((other) => other !== id)].slice(0, 20)),
        )
      }
    } else if (isSettingsPath(pathname)) write(lastSettings, pathname)
  }, [pathname])
}

/** The last Session shown, or the start page. */
export const lastSessionPath = (): string => read(lastSession, "/")

/** The last settings page shown, or Runners. */
export const lastSettingsPath = (): string => read(lastSettings, "/runners")

/** The Sessions this tab showed, latest first, by id. */
export function recentSessions(): ReadonlyArray<string> {
  try {
    const parsed: unknown = JSON.parse(read(recent, "[]"))
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}
