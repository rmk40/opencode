import { describe, expect, test } from "bun:test"

describe("vite config", () => {
  test("keeps app development loopback-only and proxy-free", async () => {
    const config = await Bun.file(new URL("../vite.config.ts", import.meta.url)).text()

    expect(config).toContain('host: "127.0.0.1"')
    expect(config).not.toContain("allowedHosts: true")
    expect(config).not.toContain("proxy:")
  })
})
