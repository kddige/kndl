import { afterAll, setDefaultTimeout } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { createStylexBunPlugin } from "@stylexjs/unplugin/bun"

// Set-up for the web package's component tests, which run under the repo-wide `bun test`.
//
// StyleX has no runtime: `stylex.create()` throws unless the compiler rewrote it. So this registers
// StyleX's Bun plugin, which compiles each source file as it loads. Only modules loaded after that
// are compiled, so a test imports this first and loads components with a dynamic `import()`.

declare global {
  var stylexCompilerRegistered: boolean | undefined
}

if (!globalThis.stylexCompilerRegistered) {
  globalThis.stylexCompilerRegistered = true
  const stylex = createStylexBunPlugin({
    dev: true,
    // The plugin writes the collected CSS to a file; keep it out of the repo.
    bunDevCssOutput: join(tmpdir(), "claude-hub-web-test-stylex.css"),
  })
  // Only this package's sources use StyleX. The plugin's own filter matches every JS file,
  // Babel's included, which would make the compiler try to compile itself as it loads.
  const sources = new RegExp(`^${escape(join(import.meta.dir, "..", "src"))}/.*\\.tsx?$`)
  Bun.plugin({
    name: stylex.name,
    setup(build) {
      // A runtime plugin gets only onLoad/onResolve, not the bundler's onStart/onEnd hooks.
      stylex.setup({
        onStart: () => {},
        onEnd: () => {},
        onLoad: (_options: unknown, callback: Parameters<typeof build.onLoad>[1]) =>
          build.onLoad({ filter: sources }, callback),
      })
    },
  })
}

function escape(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Puts happy-dom's window on the globals for this test file, and takes it off again at the end so
 * the hub's and runner's tests in the same process still see plain Bun. It registers straight
 * away, because React DOM and Base UI look for `window` when they load, not when they render.
 * `teardown` runs first at the end, while the DOM is still there (e.g. to unmount).
 */
export function installDom(teardown?: () => unknown): void {
  GlobalRegistrator.register({ url: "http://localhost/" })
  // Longer than the tests' own 5 s waits for what they expect, so on a slow machine (a Sandbox)
  // a check that never comes fails its own test. Bun's 5 s timeout would end the test while its
  // wait goes on, overlapping React's act() in every test after it, which then all fail (#112).
  setDefaultTimeout(30_000)
  // A failed expect() prints what it got. For a node, Bun would print happy-dom's whole object
  // graph: its parents, the document and the window. That took seconds per failure, so a check
  // retried until an element goes was slow, and the last failure wrote millions of lines (#112).
  Object.defineProperty(window.Node.prototype, Bun.inspect.custom, {
    configurable: true,
    value(this: Node) {
      return describeNode(this)
    },
  })
  afterAll(async () => {
    await teardown?.()
    await GlobalRegistrator.unregister()
  })
}

/** A node as a failed expect() shows it: its HTML, cut short. */
function describeNode(node: Node): string {
  const text = node instanceof Element ? node.outerHTML : `${node.nodeName} ${node.textContent}`
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}
