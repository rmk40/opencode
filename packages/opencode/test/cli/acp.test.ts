import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import * as Bootstrap from "../../src/cli/bootstrap"
import * as Network from "../../src/cli/network"
import { Server } from "../../src/server/server"

describe("acp command", () => {
  afterEach(() => {
    mock.restore()
  })

  test("rejects unauthenticated non-loopback server options", async () => {
    spyOn(Bootstrap, "bootstrap").mockImplementation(async (_directory, run) => run())
    spyOn(Network, "resolveNetworkOptions").mockResolvedValue({
      hostname: "0.0.0.0",
      port: 0,
      mdns: false,
      mdnsDomain: "opencode.local",
      cors: [],
      allowInsecureNoAuth: false,
    })
    const listen = spyOn(Server, "listen").mockImplementation(async () => {
      throw new Error("Server.listen should not be called")
    })
    const { AcpCommand } = await import("../../src/cli/cmd/acp")

    await expect(
      AcpCommand.handler?.({
        _: [],
        $0: "opencode",
        cwd: process.cwd(),
        port: 0,
        hostname: "0.0.0.0",
        mdns: false,
        "mdns-domain": "opencode.local",
        mdnsDomain: "opencode.local",
        cors: [],
        "allow-insecure-no-auth": false,
        allowInsecureNoAuth: false,
      }),
    ).rejects.toThrow("OPENCODE_SERVER_PASSWORD")
    expect(listen).not.toHaveBeenCalled()
  })
})
