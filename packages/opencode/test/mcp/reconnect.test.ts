import { test, expect, mock, beforeEach, describe } from "bun:test"

// Track transport close handlers and connection attempts
let closeHandler: (() => void) | undefined
let connectionAttempts = 0
let shouldFailConnection = false

// Mock the stdio transport to simulate connection and close events
mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class MockStdioTransport {
    onclose: (() => void) | undefined

    constructor() {
      connectionAttempts++
    }

    async start() {
      if (shouldFailConnection) {
        throw new Error("Mock connection failed")
      }
      // Store the close handler for later triggering
      closeHandler = () => this.onclose?.()
    }

    async close() {
      // No-op
    }
  },
}))

// Mock the MCP client
mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    async connect(transport: { start: () => Promise<void> }) {
      await transport.start()
    }

    async close() {
      // No-op
    }

    async listTools() {
      return { tools: [] }
    }

    setNotificationHandler() {
      // No-op
    }
  },
}))

beforeEach(() => {
  closeHandler = undefined
  connectionAttempts = 0
  shouldFailConnection = false
})

// Import after mocking
const { MCP } = await import("../../src/mcp/index")
const { Instance } = await import("../../src/project/instance")
const { tmpdir } = await import("../fixture/fixture")

describe("MCP Reconnection", () => {
  test("reconnectMcp returns error for unknown server", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await MCP.reconnectMcp("nonexistent-server")
        expect(result.status).toBe("failed")
        if (result.status === "failed") {
          expect(result.error).toContain("not found")
        }
      },
    })
  })

  test("restart config defaults are applied", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          `${dir}/opencode.json`,
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            mcp: {
              "test-server": {
                type: "local",
                command: ["echo", "test"],
                // No restart config - should use defaults
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Add the server to trigger connection
        await MCP.add("test-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const status = await MCP.status()
        // Should be connected with default restart config
        expect(status["test-server"]?.status).toBe("connected")
      },
    })
  })

  test("restart can be disabled via config", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          `${dir}/opencode.json`,
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            mcp: {
              "test-server": {
                type: "local",
                command: ["echo", "test"],
                restart: {
                  enabled: false,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await MCP.add("test-server", {
          type: "local",
          command: ["echo", "test"],
          restart: { enabled: false },
        })

        const status = await MCP.status()
        expect(status["test-server"]?.status).toBe("connected")

        // Trigger close - should NOT reconnect since restart is disabled
        const initialAttempts = connectionAttempts
        closeHandler?.()

        // Wait a bit to ensure no reconnection attempt
        await new Promise((r) => setTimeout(r, 100))

        // No additional connection attempts should have been made
        expect(connectionAttempts).toBe(initialAttempts)
      },
    })
  })

  test("custom restart config is respected", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          `${dir}/opencode.json`,
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            mcp: {
              "test-server": {
                type: "local",
                command: ["echo", "test"],
                restart: {
                  enabled: true,
                  maxAttempts: 5,
                  delayMs: 500,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await MCP.add("test-server", {
          type: "local",
          command: ["echo", "test"],
          restart: {
            enabled: true,
            maxAttempts: 5,
            delayMs: 500,
          },
        })

        const status = await MCP.status()
        expect(status["test-server"]?.status).toBe("connected")
      },
    })
  })

  test("manual reconnect works for failed server", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          `${dir}/opencode.json`,
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            mcp: {
              "test-server": {
                type: "local",
                command: ["echo", "test"],
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // First, make connection fail
        shouldFailConnection = true
        await MCP.add("test-server", {
          type: "local",
          command: ["echo", "test"],
        }).catch(() => {})

        let status = await MCP.status()
        expect(status["test-server"]?.status).toBe("failed")

        // Now allow connections and manually reconnect
        shouldFailConnection = false
        const result = await MCP.reconnectMcp("test-server")

        expect(result.status).toBe("connected")

        status = await MCP.status()
        expect(status["test-server"]?.status).toBe("connected")
      },
    })
  })
})
