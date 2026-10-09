import { useState } from "react"

/** `value`, or while it is null (a dialog closing), the last value it wasn't. */
export function useLastOpened<T>(value: T | null): T | null {
  const [last, setLast] = useState(value)
  if (value !== null && value !== last) setLast(value)
  return value ?? last
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
