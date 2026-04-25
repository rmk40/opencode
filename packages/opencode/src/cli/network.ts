import type { Argv, InferredOptionTypes } from "yargs"
import { Config } from "../config"
import { AppRuntime } from "@/effect/app-runtime"

const options = {
  port: {
    type: "number" as const,
    describe: "port to listen on",
    default: 0,
  },
  hostname: {
    type: "string" as const,
    describe: "hostname to listen on",
    default: "127.0.0.1",
  },
  mdns: {
    type: "boolean" as const,
    describe: "enable mDNS service discovery (defaults hostname to 0.0.0.0)",
    default: false,
  },
  "mdns-domain": {
    type: "string" as const,
    describe: "custom domain name for mDNS service (default: opencode.local)",
    default: "opencode.local",
  },
  cors: {
    type: "string" as const,
    array: true,
    describe: "additional domains to allow for CORS",
    default: [] as string[],
  },
  "allow-insecure-no-auth": {
    type: "boolean" as const,
    describe: "allow non-loopback server binds without OPENCODE_SERVER_PASSWORD (unsafe)",
    default: false,
  },
}

export type NetworkOptions = InferredOptionTypes<typeof options>
export type ResolvedNetworkOptions = ReturnType<typeof resolveNetworkOptionsNoConfig>

export function withNetworkOptions<T>(yargs: Argv<T>) {
  return yargs.options(options)
}
export async function resolveNetworkOptions(args: NetworkOptions) {
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  return resolveNetworkOptionsNoConfig(args, config)
}

function hasArg(name: string) {
  const flag = `--${name}`
  return process.argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`) || arg === `--no-${name}`)
}

export function resolveNetworkOptionsNoConfig(args: NetworkOptions, config?: Config.Info) {
  const portExplicitlySet = hasArg("port")
  const hostnameExplicitlySet = hasArg("hostname")
  const mdnsExplicitlySet = hasArg("mdns")
  const mdnsDomainExplicitlySet = hasArg("mdns-domain")
  const allowInsecureNoAuthExplicitlySet = hasArg("allow-insecure-no-auth")
  const mdns = mdnsExplicitlySet ? args.mdns : (config?.server?.mdns ?? args.mdns)
  const mdnsDomain = mdnsDomainExplicitlySet ? args["mdns-domain"] : (config?.server?.mdnsDomain ?? args["mdns-domain"])
  const port = portExplicitlySet ? args.port : (config?.server?.port ?? args.port)
  const hostname = hostnameExplicitlySet
    ? args.hostname
    : mdns && !config?.server?.hostname
      ? "0.0.0.0"
      : (config?.server?.hostname ?? args.hostname)
  const configCors = config?.server?.cors ?? []
  const argsCors = Array.isArray(args.cors) ? args.cors : args.cors ? [args.cors] : []
  const cors = [...configCors, ...argsCors]
  const allowInsecureNoAuth = allowInsecureNoAuthExplicitlySet
    ? args["allow-insecure-no-auth"]
    : (config?.server?.allowInsecureNoAuth ?? args["allow-insecure-no-auth"])

  return { hostname, port, mdns, mdnsDomain, cors, allowInsecureNoAuth }
}

export function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]"
}

export function buildServerAuthHeader(
  password: string | undefined = process.env["OPENCODE_SERVER_PASSWORD"],
  username: string = process.env["OPENCODE_SERVER_USERNAME"] ?? "opencode",
) {
  if (!password) return undefined
  return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
}

export function assertAuthenticatedNetwork(
  options: Pick<ResolvedNetworkOptions, "hostname" | "allowInsecureNoAuth">,
  password: string | undefined = process.env["OPENCODE_SERVER_PASSWORD"],
) {
  if (password) return
  if (options.allowInsecureNoAuth) return
  if (isLoopbackHostname(options.hostname)) return
  throw new Error(
    `Refusing to start an unauthenticated opencode server on non-loopback host ${options.hostname}. Set OPENCODE_SERVER_PASSWORD or pass --allow-insecure-no-auth to accept the risk.`,
  )
}
