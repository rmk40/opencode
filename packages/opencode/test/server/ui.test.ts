import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { UIRoutes } from "../../src/server/routes/ui"
import { tmpdir } from "../fixture/fixture"

const DEFAULT_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' ws: wss: data:"

async function withWebUIDir<T>(dir: string | undefined, fn: () => Promise<T>): Promise<T> {
  // Flag.OPENCODE_WEB_UI_DIR is captured from process.env at module init,
  // so tests must mutate the cached value on the Flag object directly. Also
  // sync process.env so anything reading the env at runtime sees the same.
  const previousEnv = process.env["OPENCODE_WEB_UI_DIR"]
  const previousFlag = Flag.OPENCODE_WEB_UI_DIR
  if (dir === undefined) {
    delete process.env["OPENCODE_WEB_UI_DIR"]
    Flag.OPENCODE_WEB_UI_DIR = undefined
  } else {
    process.env["OPENCODE_WEB_UI_DIR"] = dir
    Flag.OPENCODE_WEB_UI_DIR = dir
  }
  try {
    return await fn()
  } finally {
    if (previousEnv === undefined) delete process.env["OPENCODE_WEB_UI_DIR"]
    else process.env["OPENCODE_WEB_UI_DIR"] = previousEnv
    Flag.OPENCODE_WEB_UI_DIR = previousFlag
  }
}

describe("UIRoutes", () => {
  // These tests verify the fail-closed branch when the embedded module is
  // unavailable AND OPENCODE_WEB_UI_DIR is unset. Wrap them in
  // withWebUIDir(undefined, ...) so they pass regardless of whether the
  // ambient environment (e.g. an `oc` wrapper shell) has the disk-mode env
  // var set.
  test("fails closed when embedded UI assets are unavailable", async () => {
    await withWebUIDir(undefined, async () => {
      const response = await UIRoutes().request("/")
      const body = await response.text()

      expect(response.status).toBe(503)
      expect(body).toContain("opencode web UI unavailable")
      expect(body).not.toContain("app.opencode.ai")
    })
  })

  test("sets the same restrictive CSP on unavailable UI responses", async () => {
    await withWebUIDir(undefined, async () => {
      const response = await UIRoutes().request("/")

      expect(response.headers.get("content-security-policy")).toContain("default-src 'self'")
    })
  })
})

describe("UIRoutes disk mode (OPENCODE_WEB_UI_DIR)", () => {
  test("serves a real file from disk with the right mime type and CSP only on HTML", async () => {
    const html = "<!doctype html><html><head><title>disk</title></head><body>disk-html</body></html>"
    const js = "export const value = 42;\n"
    await using ui = await tmpdir({
      init: async (d) => {
        await fs.writeFile(path.join(d, "index.html"), html, "utf8")
        await fs.mkdir(path.join(d, "assets"))
        await fs.writeFile(path.join(d, "assets", "foo.js"), js, "utf8")
      },
    })

    await withWebUIDir(ui.path, async () => {
      const htmlRes = await UIRoutes().request("/index.html")
      expect(htmlRes.status).toBe(200)
      expect(htmlRes.headers.get("content-type")).toMatch(/^text\/html/)
      expect(htmlRes.headers.get("content-security-policy")).toBe(DEFAULT_CSP)
      expect(await htmlRes.text()).toBe(html)

      const jsRes = await UIRoutes().request("/assets/foo.js")
      expect(jsRes.status).toBe(200)
      expect(jsRes.headers.get("content-type")).toMatch(/^text\/javascript/)
      // Non-HTML responses must NOT receive the CSP header.
      expect(jsRes.headers.get("content-security-policy")).toBeNull()
      expect(await jsRes.text()).toBe(js)
    })
  })

  test("SPA fallback: unknown paths return index.html with 200", async () => {
    const html = "<!doctype html><html><head><title>spa</title></head><body>spa-root</body></html>"
    await using ui = await tmpdir({
      init: async (d) => {
        await fs.writeFile(path.join(d, "index.html"), html, "utf8")
      },
    })

    await withWebUIDir(ui.path, async () => {
      const res = await UIRoutes().request("/no/such/route")
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toMatch(/^text\/html/)
      expect(res.headers.get("content-security-policy")).toBe(DEFAULT_CSP)
      expect(await res.text()).toBe(html)
    })
  })

  test("path-traversal attempts fall through to SPA index.html, never serving outside the root", async () => {
    const html = "<!doctype html><html><head><title>guarded</title></head><body>safe-index</body></html>"
    const secret = "TOP_SECRET_OUTSIDE_ROOT"

    await using ui = await tmpdir({
      init: async (d) => {
        await fs.writeFile(path.join(d, "index.html"), html, "utf8")
      },
    })
    await using outside = await tmpdir({
      init: async (d) => {
        await fs.writeFile(path.join(d, "secret.txt"), secret, "utf8")
      },
    })

    await withWebUIDir(ui.path, async () => {
      // Construct a relative path from the UI root to the outside file.
      // Hono's request layer keeps c.req.path as-typed, so the route's
      // path.resolve() will collapse the .. segments and the inside
      // check will reject; the SPA fallback then returns index.html.
      const traversal = "/../../" + path.basename(outside.path) + "/secret.txt"
      const res = await UIRoutes().request("http://localhost" + traversal)
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toBe(html)
      expect(body).not.toContain(secret)
    })
  })

  test("503 when OPENCODE_WEB_UI_DIR has no index.html and HTML-escapes the configured root", async () => {
    // The directory does not need to exist on disk for the misconfig branch:
    // when there is no index.html, the route falls through to the 503 page and
    // interpolates the configured root. Use a path containing characters that
    // must be HTML-escaped to verify escapeHtml() is applied.
    const dangerous = "/tmp/<script>alert(1)</script>-not-a-real-dir"

    await withWebUIDir(dangerous, async () => {
      const res = await UIRoutes().request("/no-such-asset")
      expect(res.status).toBe(503)
      expect(res.headers.get("content-type")).toMatch(/^text\/html/)
      const body = await res.text()
      expect(body).toContain("OPENCODE_WEB_UI_DIR")
      // The dangerous substring MUST be HTML-escaped, never present literally.
      expect(body).not.toContain("<script>alert(1)</script>")
      expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    })
  })

  test("non-file paths (directories) are skipped and fall through to SPA index.html", async () => {
    const html = "<!doctype html><html><head><title>dir-fallback</title></head><body>spa</body></html>"
    await using ui = await tmpdir({
      init: async (d) => {
        await fs.writeFile(path.join(d, "index.html"), html, "utf8")
        // Create a directory at /assets with no index file inside.
        await fs.mkdir(path.join(d, "assets"))
      },
    })

    await withWebUIDir(ui.path, async () => {
      const res = await UIRoutes().request("/assets")
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toMatch(/^text\/html/)
      expect(await res.text()).toBe(html)
    })
  })

  test("disk mode is unreachable when OPENCODE_WEB_UI_DIR is unset (existing 503 path takes over)", async () => {
    // Even though the embedded promise is null in source mode, the disk
    // branch must only activate when OPENCODE_WEB_UI_DIR is set.
    await withWebUIDir(undefined, async () => {
      const res = await UIRoutes().request("/anything")
      expect(res.status).toBe(503)
      const body = await res.text()
      expect(body).toContain("opencode web UI unavailable")
      expect(body).toContain("OPENCODE_DISABLE_EMBEDDED_WEB_UI")
    })
  })

  test("embedded non-null shadows disk mode even when OPENCODE_WEB_UI_DIR is set", async () => {
    // Run in a sub-process: `embeddedUIPromise` is captured at module load,
    // and `mock.module` overrides persist for the test process. We cannot
    // toggle embedded null/non-null within this process without contaminating
    // the other tests in this file.
    //
    // Build a sanitized env: drop OPENCODE_DISABLE_EMBEDDED_WEB_UI (which
    // would force embeddedUIPromise to null and invalidate the test) and
    // unset OPENCODE_WEB_UI_DIR (worker sets its own).
    const childEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v !== "string") continue
      if (k === "OPENCODE_DISABLE_EMBEDDED_WEB_UI") continue
      if (k === "OPENCODE_WEB_UI_DIR") continue
      childEnv[k] = v
    }

    const worker = path.join(import.meta.dir, "ui-embedded-shadow-worker.ts")
    const proc = Bun.spawn({
      cmd: [process.execPath, worker],
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv,
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    if (code !== 0) {
      throw new Error(`worker exited ${code}: stderr=${stderr.trim()} stdout=${stdout.trim()}`)
    }
    expect(stdout).toContain("OK")
  }, 30000)
})
