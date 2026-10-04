// A command that can't go on, with what to tell the person running it. main.ts prints the message
// and exits 1; nothing else about it is shown.
import { Data } from "effect"

export class CliFailure extends Data.TaggedError("CliFailure")<{ readonly message: string }> {}

export const fail = (message: string) => new CliFailure({ message })
