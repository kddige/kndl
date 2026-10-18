---
status: accepted
---

# Bun, Effect and SQLite on the backend; React and Base UI on the web

The code is one Bun workspace in TypeScript, so the Hub, Runner, mod, web UI and a shared protocol package all speak the same types:

- **Backend:** the Hub and Runner are built with Effect, for typed errors, resource safety around Sandboxes and processes, and structured concurrency for the many long-lived streams. The Hub stores data in SQLite, which is enough for a single Hub and keeps operations trivial. Postgres stays possible behind the data layer.
- **Web UI:** React, with Base UI as the source of unstyled primitives, composed into our own semantic component library rather than one-off components. Styling is StyleX, with one token theme: the design tokens are declared once with `defineVars`, and themes are `createTheme` overrides of them, so components use tokens rather than raw values. Routing is TanStack Router, for type-safe routes and search params. Its font is Inter Variable, bundled with the web UI and served by the Hub, so every weight renders the same on every system and nothing is fetched from another host.
- **Lint and format:** oxlint and oxfmt from the oxc project. oxlint's rules are close to ESLint's (core, typescript-eslint, React and React Hooks, import, unicorn), so the conventions carry over, and both are fast enough to run on every save and in CI.

The mod runs in Claude Code's sandboxed mod runtime, so it uses Effect only if the runtime allows it; otherwise it stays plain TypeScript.

This is a fresh start: the first prototype (`hub/`, `runner/`, `mod/`) is reference material, not a foundation.
