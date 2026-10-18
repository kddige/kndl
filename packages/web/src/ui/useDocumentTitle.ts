import { useEffect } from "react"

/**
 * Names the browser tab and the history entry after the page, so each page reads as a place of
 * its own: "Runners · kndl". Sets exactly what it's given.
 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title
  }, [title])
}
