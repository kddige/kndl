// One top bar on phones (#402): the page hands its title and primary action to the shell's bar,
// instead of a second header under it.

import { createContext, type ReactNode, useContext, useEffect, useState } from "react"

interface PageBar {
  title: string | null
  action: ReactNode
}

const Shown = createContext<PageBar>({ title: null, action: null })
const Setter = createContext<((bar: PageBar) => void) | null>(null)

export function PageBarProvider({ children }: { children: ReactNode }) {
  const [bar, setBar] = useState<PageBar>({ title: null, action: null })
  return (
    <Setter.Provider value={setBar}>
      <Shown.Provider value={bar}>{children}</Shown.Provider>
    </Setter.Provider>
  )
}

/** Puts the page's title, and its one primary action, in the phone's top bar while it's mounted. */
export function usePageBar(title: string | null, action: ReactNode = null): void {
  const set = useContext(Setter)
  useEffect(() => {
    if (!set) return
    set({ title, action })
    return () => set({ title: null, action: null })
  }, [set, title, action])
}

/** What the phone's top bar shows. */
export function usePageBarState(): PageBar {
  return useContext(Shown)
}
