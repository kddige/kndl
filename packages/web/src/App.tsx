import { Collapsible } from "@base-ui/react/collapsible"

export function App() {
  return (
    <main className="app">
      <h1>Claude Hub</h1>
      <p>Run Claude Code Sessions in Sandboxes and work in them together.</p>

      <Collapsible.Root className="about">
        <Collapsible.Trigger className="about-trigger">What is a Session?</Collapsible.Trigger>
        <Collapsible.Panel className="about-panel">
          <p>
            One ongoing Claude Code conversation working on one Repo, on its own Work branch. A
            Session belongs to its Repo, not to a person: every Participant has equal rights.
          </p>
        </Collapsible.Panel>
      </Collapsible.Root>
    </main>
  )
}
