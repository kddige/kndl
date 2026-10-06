// Keep awake (ADR 0016), as the web UI says it: who keeps a Session awake.

import type { KeepAwake, ParticipantId } from "@kndl/protocol"

/** "Kept awake by Alice", or "by you" when it's you who turned it on. */
export const keptAwakeText = (keepAwake: KeepAwake, you: ParticipantId | undefined): string =>
  `Kept awake by ${keepAwake.by.id === you ? "you" : keepAwake.by.name}`
