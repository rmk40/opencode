import { describe, expect, test } from "bun:test"
import { UIRoutes } from "../../src/server/routes/ui"

describe("UIRoutes", () => {
  test("fails closed when embedded UI assets are unavailable", async () => {
    const response = await UIRoutes().request("/")
    const body = await response.text()

    expect(response.status).toBe(503)
    expect(body).toContain("opencode web UI unavailable")
    expect(body).not.toContain("app.opencode.ai")
  })

  test("sets the same restrictive CSP on unavailable UI responses", async () => {
    const response = await UIRoutes().request("/")

    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'")
  })
})
