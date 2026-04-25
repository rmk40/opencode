import { describe, expect, test } from "bun:test"
import type { Config } from "../../src/config"
import {
  assertAuthenticatedNetwork,
  isLoopbackHostname,
  resolveNetworkOptionsNoConfig,
  type NetworkOptions,
} from "../../src/cli/network"

const baseArgs = (input: Partial<NetworkOptions> = {}): NetworkOptions => ({
  port: 0,
  hostname: "127.0.0.1",
  mdns: false,
  "mdns-domain": "opencode.local",
  cors: [],
  "allow-insecure-no-auth": false,
  ...input,
})

function withArgv<T>(flags: string[], run: () => T) {
  const previous = process.argv
  process.argv = ["bun", "opencode", ...flags]
  try {
    return run()
  } finally {
    process.argv = previous
  }
}

describe("network options authentication", () => {
  test("allows loopback binds without a server password", () => {
    const options = withArgv([], () => resolveNetworkOptionsNoConfig(baseArgs()))

    expect(isLoopbackHostname(options.hostname)).toBe(true)
    expect(() => assertAuthenticatedNetwork(options, undefined)).not.toThrow()
  })

  test("recognizes localhost and IPv6 loopback spellings", () => {
    expect(["localhost", "127.0.0.1", "::1", "[::1]"].every(isLoopbackHostname)).toBe(true)
  })

  test("rejects non-loopback binds without a server password", () => {
    const options = withArgv(["--hostname"], () => resolveNetworkOptionsNoConfig(baseArgs({ hostname: "0.0.0.0" })))

    expect(() => assertAuthenticatedNetwork(options, undefined)).toThrow("OPENCODE_SERVER_PASSWORD")
  })

  test("allows non-loopback binds with a server password", () => {
    const options = withArgv(["--hostname"], () => resolveNetworkOptionsNoConfig(baseArgs({ hostname: "0.0.0.0" })))

    expect(() => assertAuthenticatedNetwork(options, "secret")).not.toThrow()
  })

  test("requires auth for mDNS-driven non-loopback binds", () => {
    const options = withArgv(["--mdns"], () => resolveNetworkOptionsNoConfig(baseArgs({ mdns: true })))

    expect(options.hostname).toBe("0.0.0.0")
    expect(() => assertAuthenticatedNetwork(options, undefined)).toThrow("non-loopback")
  })

  test("allows explicit unsafe override from CLI or config", () => {
    const cli = withArgv(["--hostname", "--allow-insecure-no-auth"], () =>
      resolveNetworkOptionsNoConfig(baseArgs({ hostname: "0.0.0.0", "allow-insecure-no-auth": true })),
    )
    const config: Config.Info = { server: { hostname: "0.0.0.0", allowInsecureNoAuth: true } }
    const configured = withArgv([], () => resolveNetworkOptionsNoConfig(baseArgs(), config))

    expect(() => assertAuthenticatedNetwork(cli, undefined)).not.toThrow()
    expect(() => assertAuthenticatedNetwork(configured, undefined)).not.toThrow()
  })

  test("prefers explicit CLI unsafe override over safer config default", () => {
    const options = withArgv(["--hostname", "--allow-insecure-no-auth"], () =>
      resolveNetworkOptionsNoConfig(baseArgs({ hostname: "0.0.0.0", "allow-insecure-no-auth": true }), {
        server: { allowInsecureNoAuth: false },
      }),
    )

    expect(options.allowInsecureNoAuth).toBe(true)
  })

  test("allows CLI false to override unsafe config default", () => {
    const options = withArgv(["--hostname", "--no-allow-insecure-no-auth"], () =>
      resolveNetworkOptionsNoConfig(baseArgs({ hostname: "0.0.0.0", "allow-insecure-no-auth": false }), {
        server: { allowInsecureNoAuth: true },
      }),
    )

    expect(options.allowInsecureNoAuth).toBe(false)
    expect(() => assertAuthenticatedNetwork(options, undefined)).toThrow("OPENCODE_SERVER_PASSWORD")
  })

  test("treats --allow-insecure-no-auth=false as explicit override", () => {
    const options = withArgv(["--hostname", "--allow-insecure-no-auth=false"], () =>
      resolveNetworkOptionsNoConfig(baseArgs({ hostname: "0.0.0.0", "allow-insecure-no-auth": false }), {
        server: { allowInsecureNoAuth: true },
      }),
    )

    expect(options.allowInsecureNoAuth).toBe(false)
    expect(() => assertAuthenticatedNetwork(options, undefined)).toThrow("OPENCODE_SERVER_PASSWORD")
  })
})
