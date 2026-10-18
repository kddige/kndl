import { toast } from "../ui/index.ts"

/** Says an action didn't reach the Hub, and when to try again. */
export function notSent(what: string): void {
  toast.show({
    title: `${what} not sent`,
    description: "kndl is reconnecting to the Hub. Try again once it's back.",
    intent: "warning",
  })
}

/** What each Session command does, for a title that names what failed: "Couldn't …". */
export const commandText: Partial<Record<string, string>> = {
  SleepSession: "put the Session to sleep",
  WakeSession: "wake the Session",
  RestartSession: "restart the Session",
  ArchiveSession: "delete the Session",
  RestoreSession: "restore the Session",
  RenameSession: "rename the Session",
  SetSessionModel: "change the Model",
}

/** Copies a command to paste in a terminal, and says whether it could. */
export async function copyCommand(command: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(command)
    toast.show({ title: "Copied the command" })
  } catch {
    toast.show({
      title: "Couldn't copy",
      description: "Select the command and copy it yourself.",
      intent: "warning",
    })
  }
}
