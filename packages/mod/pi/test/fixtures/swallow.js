// A Repo's own pi extension that handles some input itself, as a `/command` of its own would: pi
// then runs no Turn with it, and says so only in its own log. For the pi extension's e2e test.

export default function swallow(pi) {
  pi.on("input", (event) => (event.text.includes("[swallow]") ? { action: "handled" } : undefined))
}
