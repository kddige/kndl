import * as stylex from "@stylexjs/stylex"
import { useHubState } from "../app/hub.tsx"
import { isListed } from "../hub/store.ts"
import { EmptyState, InboxIcon, Spinner, useDocumentTitle } from "../ui/index.ts"
import { srOnly } from "../ui/shared.ts"
import { space } from "../ui/tokens.stylex.ts"
import { CreateSessionDialog } from "./CreateSessionDialog.tsx"

const styles = stylex.create({
  page: {
    display: "grid",
    placeItems: "center",
    flex: 1,
    overflowY: "auto",
    padding: space.s4,
  },
})

/** `/`: the Sessions are in the sidebar, so this only points there, or to starting the first. */
export function Home() {
  const anyListed = useHubState((state) =>
    state.sessions === null ? null : state.sessions.some(isListed),
  )
  useDocumentTitle("Home · kndl")

  return (
    <main {...stylex.props(styles.page)}>
      {/* Every page has an h1, for focus to land on and headings to start from. */}
      <h1 tabIndex={-1} {...stylex.props(srOnly.root)}>
        Home
      </h1>
      {anyListed === null ? (
        <Spinner size="lg" label="Loading Sessions" />
      ) : anyListed ? (
        <EmptyState
          size="page"
          icon={<InboxIcon />}
          title="Pick a Session from the sidebar or start one"
          description="Everyone with access to a Session's Repo can join it."
          action={<CreateSessionDialog />}
        />
      ) : (
        <EmptyState
          size="page"
          icon={<InboxIcon />}
          title="No Sessions yet"
          description="Start one on any Repo you can access. Everyone with access can join it."
          action={<CreateSessionDialog />}
        />
      )}
    </main>
  )
}
