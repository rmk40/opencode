import { Flag } from "@/flag/flag"
import { Hono, type Context } from "hono"
import { getMimeType } from "hono/utils/mime"
import fs from "node:fs/promises"
import nodePath from "node:path"

const embeddedUIPromise = Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI
  ? Promise.resolve(null)
  : // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null)

const DEFAULT_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' ws: wss: data:"

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

async function serveFile(c: Context, file: string) {
  const mime = getMimeType(file) ?? "text/plain"
  c.header("Content-Type", mime)
  if (mime.startsWith("text/html")) {
    c.header("Content-Security-Policy", DEFAULT_CSP)
  }
  return c.body(new Uint8Array(await fs.readFile(file)))
}

async function serveFromDir(c: Context, root: string) {
  const requested = c.req.path.replace(/^\//, "")
  const candidate = nodePath.resolve(root, requested)
  // Path-traversal guard: refuse anything whose lexical path resolves
  // outside the configured root. Use path.sep so /foo and /foobar are
  // not confused. Symlink targets inside the root are NOT validated; the
  // operator is expected to point this at a directory they control (e.g.
  // packages/app/dist).
  const inside = candidate === root || candidate.startsWith(root + nodePath.sep)
  if (inside && (await fs.exists(candidate))) {
    const stat = await fs.stat(candidate).catch(() => null)
    if (stat?.isFile()) return serveFile(c, candidate)
  }
  // SPA fallback: unknown paths return index.html, mirroring the embedded
  // module branch which falls back to embeddedWebUI["index.html"]. Out-of-
  // root requests deliberately end up here too — the inside check fails,
  // so the response is the SPA shell, not the requested file. This is
  // acceptable for a single-tenant dev box; do not assume otherwise.
  const indexHtml = nodePath.join(root, "index.html")
  if (await fs.exists(indexHtml)) return serveFile(c, indexHtml)
  c.header("Content-Security-Policy", DEFAULT_CSP)
  return c.html(
    `<!doctype html><html><head><title>opencode web UI unavailable</title></head><body><h1>opencode web UI unavailable</h1><p>OPENCODE_WEB_UI_DIR is set to <code>${escapeHtml(root)}</code> but no <code>index.html</code> was found. Run <code>bun --cwd packages/app build</code> to populate it.</p></body></html>`,
    503,
  )
}

export const UIRoutes = (): Hono =>
  new Hono().all("/*", async (c) => {
    const embeddedWebUI = await embeddedUIPromise
    const path = c.req.path

    if (embeddedWebUI) {
      const match = embeddedWebUI[path.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
      if (!match) return c.json({ error: "Not Found" }, 404)
      if (await fs.exists(match)) return serveFile(c, match)
      return c.json({ error: "Not Found" }, 404)
    }

    if (Flag.OPENCODE_WEB_UI_DIR) {
      return serveFromDir(c, nodePath.resolve(Flag.OPENCODE_WEB_UI_DIR))
    }

    c.header("Content-Security-Policy", DEFAULT_CSP)
    return c.html(
      "<!doctype html><html><head><title>opencode web UI unavailable</title></head><body><h1>opencode web UI unavailable</h1><p>This binary was built without embedded web UI assets, or embedded assets were disabled with OPENCODE_DISABLE_EMBEDDED_WEB_UI.</p></body></html>",
      503,
    )
  })
