// Opening New Session from elsewhere than its button (#399), such as the command palette: one
// listening dialog, mounted by the shell, hears it.

const listeners = new Set<() => void>()

/** Opens New Session, where a dialog listens. */
export function openNewSession(): void {
  for (const listener of listeners) listener()
}

/** Calls `open` whenever New Session is asked for; returns how to stop. */
export function onNewSession(open: () => void): () => void {
  listeners.add(open)
  return () => {
    listeners.delete(open)
  }
}
