import { useLayoutEffect, useRef } from "react"

/**
 * Keeps the transcript scrolled to the bottom as it grows, unless the reader has scrolled up to
 * read something.
 */
export function useStickToBottom(content: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  useLayoutEffect(() => {
    const element = ref.current
    if (element && stuck.current) element.scrollTop = element.scrollHeight
  }, [content])
  return {
    ref,
    onScroll: () => {
      const element = ref.current
      if (!element) return
      stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64
    },
  }
}
