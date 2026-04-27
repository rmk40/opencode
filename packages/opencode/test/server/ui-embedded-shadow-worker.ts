// Worker process for the "embedded non-null shadows disk mode" assertion.
//
// Runs in its own Bun process because `embeddedUIPromise` in
// `src/server/routes/ui.ts` is captured at module load time, and Bun's
// `mock.module` overrides persist for the lifetime of the test process. Co-
// locating this with the null-embedded tests in ui.test.ts would either
// invalidate the existing 503 fail-closed cases or get permanently shadowed
// by them.
//
// On success, exits 0 with "OK" on stdout. On any assertion failure or
// unexpected error, writes the failure to stderr and exits non-zero. The
// parent test (`ui.test.ts`) surfaces stderr in the failure message.

import { mock } from "bun:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oc-ui-embedded-"))
  const embeddedIndex = path.join(tmp, "embedded-index.html")
  const EMBEDDED_BODY = "<!doctype html><html><head><title>embedded</title></head><body>EMBEDDED-INDEX</body></html>"
  await fs.writeFile(embeddedIndex, EMBEDDED_BODY, "utf8")

  // Inject a non-null embedded map. The embedded branch resolves entries to
  // absolute file paths and reads them via fs, so the map values must point
  // at real files.
  void mock.module("opencode-web-ui.gen.ts", () => ({
    default: {
      "index.html": embeddedIndex,
    },
  }))

  // Seed a sentinel disk dir whose contents would be visible only if disk
  // mode were reached.
  const diskDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-ui-disk-shadow-"))
  const DISK_BODY = "<!doctype html><html><body>DISK-INDEX-SHOULD-NOT-APPEAR</body></html>"
  await fs.writeFile(path.join(diskDir, "index.html"), DISK_BODY, "utf8")

  process.env["OPENCODE_WEB_UI_DIR"] = diskDir

  // Import AFTER the mock and env are in place so ui.ts captures both.
  const { UIRoutes } = await import("../../src/server/routes/ui")
  const { Flag } = await import("@opencode-ai/core/flag/flag")
  // Mirror the env value into the cached Flag entry. `Flag.OPENCODE_WEB_UI_DIR`
  // is read from process.env once at flag.ts load; we need this set so the
  // disk branch WOULD activate if it were reachable. Combined with the embedded
  // mock, the test verifies the embedded branch shadows it.
  Flag.OPENCODE_WEB_UI_DIR = diskDir

  const rootRes = await UIRoutes().request("/")
  assert.equal(rootRes.status, 200, "root status")
  const rootBody = await rootRes.text()
  assert.equal(rootBody, EMBEDDED_BODY, "root body equals embedded")
  assert.ok(!rootBody.includes("DISK-INDEX-SHOULD-NOT-APPEAR"), "root body excludes disk sentinel")

  const unknownRes = await UIRoutes().request("/no/such/route")
  assert.equal(unknownRes.status, 200, "unknown status")
  const unknownBody = await unknownRes.text()
  assert.equal(unknownBody, EMBEDDED_BODY, "unknown body equals embedded (SPA fallback in embedded branch)")
  assert.ok(!unknownBody.includes("DISK-INDEX-SHOULD-NOT-APPEAR"), "unknown body excludes disk sentinel")

  // Best-effort cleanup; not strictly required since the OS reclaims tmp.
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  await fs.rm(diskDir, { recursive: true, force: true }).catch(() => undefined)

  console.log("OK")
}

main().catch((err) => {
  console.error("worker failed: " + (err instanceof Error ? (err.stack ?? err.message) : String(err)))
  process.exit(1)
})
