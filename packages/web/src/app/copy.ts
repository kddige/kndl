import { toast } from "../ui/index.ts"

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
