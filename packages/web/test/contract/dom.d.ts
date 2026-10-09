// oxlint-disable no-var -- a global the DOM declares is a var, a property of globalThis
// The little of the DOM that the web's Hub client and fake Hub name, for this directory's
// typecheck. The contract suite runs them under Bun against the real Hub, whose sources don't
// type-check with the DOM's globals: their WebSocket, fetch bodies and streams are Bun's.

interface Location {
  readonly host: string
  readonly protocol: string
  readonly origin: string
}

declare var location: Location | undefined
declare var window: { readonly location: Location }
