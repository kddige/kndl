// A WebSocket close frame carries at most 123 bytes of reason: longer ones are cut, at a whole
// character, with an ellipsis.

export const closeReason = (reason: string) => {
  const bytes = new TextEncoder().encode(reason)
  if (bytes.byteLength <= 123) return reason
  return new TextDecoder().decode(bytes.slice(0, 120)).replace(/�$/, "") + "..."
}
