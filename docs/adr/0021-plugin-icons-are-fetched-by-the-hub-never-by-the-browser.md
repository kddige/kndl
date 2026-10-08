---
status: accepted
---

# Plugin icons are fetched by the hub, never by the browser

The Plugins page shows an icon beside each Plugin (#230). Where it comes from is a third party's choice: a package's manifest, or a favicon on the Plugin's MCP server's website. The Hub finds the icon and serves it itself.

Letting the browser load it from there would tell every site a Plugin points at who looks at the Plugins page, and when, from which address. It would also let a Plugin's author, or a server that changes what it answers, put content in people's browsers.

## How it works

- **Where the icon comes from, in order.** Every failure drops silently to the next step.
  1. The manifest's `icon` (packaged Plugins): an https URL, or a path to a file in the package. A broken one never blocks adding or Upgrading a package.
  2. A favicon of the Plugin's URL, at its origin first, then at its registrable apex domain, worked out with a public-suffix list (`tldts`). Real icons only, never `og:image`: an SVG `<link rel=icon>`, else the largest of the other `<link rel=icon>`s, `apple-touch-icon`s and web manifest icons, else `/favicon.ico`.
  3. None: the web shows the first letter of the Plugin's name on a tile colored from the Plugin's id.
- **How the Hub fetches.** https only, plus the loopback exception its other fetches of URLs it was given have. Up to 3 redirects, each hop checked against the same rules. 5 s per fetch. An icon is at most 512 KB, and so is the page read for `<link>` tags. PNG, ICO, WebP, JPEG and SVG are accepted, told apart by sniffing the bytes, never by `Content-Type`.
- **When.** After a Plugin is added, its URL is edited, or it is Upgraded. The fetch runs after the save, so saving never waits on it, and the web is sent the Plugins again when it finishes. A URL edit whose fetch finds nothing clears the old icon; an edit of anything but the URL leaves it. An Upgrade that finds nothing keeps the old icon unless its URL changed. There is no refresh on a timer and no backfill of Plugins added before.
- **Where it is kept and served.** The bytes, their type and a hash of them are columns of the Plugin. The `Plugin` the web receives carries only the hash, which the web puts in the icon's URL to bust its cache. The Hub serves it at `GET /plugins/<id>/icon`, the id URL-encoded, to people signed in, as the type its bytes were sniffed as, with `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`, so an SVG opened on its own runs no script and can't reach the Hub's origin.

## Considered options

- **The browser loads the icon from its URL.** Simplest, and no storage. It leaks who views the page to every Plugin's host, and makes third-party content part of the page.
- **A proxy that fetches on every request.** Nothing to store, but every page view makes the Hub fetch from third parties on demand, and it needs its own caching.
- **A favicon service such as Google's.** It tells that service every host the Hub's Members use, and fails for hosts on a private network.
- **`serverInfo.icons` from the MCP server, and `og:image`.** Left out of this: the first needs a connection to the server, which for a Plugin with credentials means an Installation; the second is a picture of a page, not an icon.
