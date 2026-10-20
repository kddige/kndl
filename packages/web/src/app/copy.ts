import { toast } from "../ui/index.ts"

/** Says an action didn't reach the Hub, and when to try again. */
export function notSent(what: string): void {
  toast.show({
    title: `${what} not sent`,
    description: "kndl is reconnecting to the Hub. Try again once it's back.",
    intent: "warning",
  })
}

/**
 * Whose accounts a Session's Turns, threads and agents run on: its Creator's (ADR 0026), whoever
 * drives it. "your accounts" for the Creator, "Alice's accounts" for anyone else.
 */
export function accountsOf(
  session: { readonly creator: { readonly id: string; readonly name: string } },
  you: { readonly id: string } | null | undefined,
): string {
  return you?.id === session.creator.id ? "your accounts" : `${session.creator.name}'s accounts`
}

/** Who pays for a Session, as its header says it: "Your accounts pay", "Alice's accounts pay". */
export function accountsPay(...of: Parameters<typeof accountsOf>): string {
  const accounts = accountsOf(...of)
  return `${accounts.charAt(0).toUpperCase()}${accounts.slice(1)} pay`
}

/** The reason as a sentence, with a space after it for the one that follows. */
export const sentence = (reason: string) => (/[.!?]$/.test(reason) ? `${reason} ` : `${reason}. `)

/** What each Session command does, for a title that names what failed: "Couldn't …". */
export const commandText: Partial<Record<string, string>> = {
  SleepSession: "put the Session to sleep",
  WakeSession: "wake the Session",
  RestartSession: "restart the Session",
  ArchiveSession: "delete the Session",
  RestoreSession: "restore the Session",
  RenameSession: "rename the Session",
  SetSessionModel: "change the Model",
  CreateThread: "start the thread",
  PromptThread: "post in the thread",
  StopThread: "stop the thread",
  SetThreadModel: "change the thread's Model",
  CompactConversation: "compact the conversation",
}

/** Copies a command to paste in a terminal, and says whether it could. */
export async function copyCommand(command: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(command)
    toast.show({ title: "Command copied" })
  } catch {
    toast.show({
      title: "Couldn't copy",
      description: "Select the command and copy it yourself.",
      intent: "warning",
    })
  }
}
