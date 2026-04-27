import { Effect, Layer, Schema, Context, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import path from "path"
import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Log } from "../util"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import semver from "semver"
import {
  InstallationChannel,
  InstallationNpmPackage,
  InstallationNpmRegistry,
  InstallationRepo,
  InstallationVersion,
} from "@opencode-ai/core/installation/version"

const log = Log.create({ service: "installation" })

export type Method = "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

export type ReleaseType = "patch" | "minor" | "major"

export const Event = {
  Updated: BusEvent.define(
    "installation.updated",
    Schema.Struct({
      version: Schema.String,
    }),
  ),
  UpdateAvailable: BusEvent.define(
    "installation.update-available",
    Schema.Struct({
      version: Schema.String,
    }),
  ),
}

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export const Info = z
  .object({
    version: z.string(),
    latest: z.string(),
  })
  .meta({
    ref: "InstallationInfo",
  })
export type Info = z.infer<typeof Info>

export const USER_AGENT = `opencode/${InstallationChannel}/${InstallationVersion}/${Flag.OPENCODE_CLIENT}`

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {}

// Response schemas for external version APIs
const GitHubRelease = Schema.Struct({ tag_name: Schema.String })
const GitHubReleaseList = Schema.Array(
  Schema.Struct({ tag_name: Schema.String, draft: Schema.Boolean, prerelease: Schema.Boolean }),
)
const NpmPackage = Schema.Struct({ version: Schema.String })
const BrewFormula = Schema.Struct({ versions: Schema.Struct({ stable: Schema.String }) })
const BrewInfoV2 = Schema.Struct({
  formulae: Schema.Array(Schema.Struct({ versions: Schema.Struct({ stable: Schema.String }) })),
})
const ChocoPackage = Schema.Struct({
  d: Schema.Struct({ results: Schema.Array(Schema.Struct({ Version: Schema.String })) }),
})
const ScoopManifest = NpmPackage

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Installation") {}

export const layer: Layer.Layer<Service, never, HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner> =
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const text = Effect.fnUntraced(
        function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
          const proc = ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          })
          const handle = yield* spawner.spawn(proc)
          const out = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          yield* handle.exitCode
          return out
        },
        Effect.scoped,
        Effect.catch(() => Effect.succeed("")),
      )

      const run = Effect.fnUntraced(
        function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
          const proc = ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          })
          const handle = yield* spawner.spawn(proc)
          const [stdout, stderr] = yield* Effect.all(
            [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
            { concurrency: 2 },
          )
          const code = yield* handle.exitCode
          return { code, stdout, stderr }
        },
        Effect.scoped,
        Effect.catch(() => Effect.succeed({ code: ChildProcessSpawner.ExitCode(1), stdout: "", stderr: "" })),
      )

      const registryArgs = (): string[] => (InstallationNpmRegistry ? [`--registry=${InstallationNpmRegistry}`] : [])

      const npmAuthHint = (stderr: string): string => {
        if (!InstallationNpmRegistry) return stderr
        if (!/E401|401\s|EAUTHENTICATE|EUNAUTHENTICATE|Unauthorized|ENEEDAUTH|need.*auth|requires.*auth/i.test(stderr))
          return stderr
        if (!InstallationNpmPackage.startsWith("@")) return stderr
        const scope = InstallationNpmPackage.split("/")[0]
        let host: string
        try {
          host = new URL(InstallationNpmRegistry).host
        } catch {
          return stderr
        }
        return [
          stderr,
          "",
          "GitHub Packages requires a GitHub token with read:packages scope.",
          "Add the following to ~/.npmrc:",
          `${scope}:registry=${InstallationNpmRegistry}`,
          `//${host}/:_authToken=YOUR_GITHUB_TOKEN`,
        ].join("\n")
      }

      // Use the package manager's resolver so registries, mirrors, auth, proxies, and dist-tags match upgrade behavior.
      // Fork-only: required for GitHub Packages auth via ~/.npmrc; upstream uses NpmConfig + direct HTTP for the npmjs.org case.
      const viewVersion = Effect.fnUntraced(function* (method: "npm" | "pnpm" | "bun", spec: string) {
        const baseArgs =
          method === "bun" ? ["pm", "view", spec, "version", "--json"] : ["view", spec, "version", "--json"]
        const args = [...baseArgs, ...registryArgs()]
        const result = yield* run([method, ...args])
        if (result.code !== 0 || !result.stdout.trim()) {
          return yield* new UpgradeFailedError({
            stderr: npmAuthHint(result.stderr || result.stdout || `Failed to resolve ${spec}`),
          })
        }
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.String))(result.stdout)
      })

      const getBrewFormula = Effect.fnUntraced(function* () {
        const tapFormula = yield* text(["brew", "list", "--formula", "anomalyco/tap/opencode"])
        if (tapFormula.includes("opencode")) return "anomalyco/tap/opencode"
        const coreFormula = yield* text(["brew", "list", "--formula", "opencode"])
        if (coreFormula.includes("opencode")) return "opencode"
        return "opencode"
      })

      const upgradeCurl = Effect.fnUntraced(
        function* (target: string) {
          const response = yield* httpOk.execute(HttpClientRequest.get("https://opencode.ai/install"))
          const body = yield* response.text
          const bodyBytes = new TextEncoder().encode(body)
          const proc = ChildProcess.make("bash", [], {
            stdin: Stream.make(bodyBytes),
            env: { VERSION: target },
            extendEnv: true,
          })
          const handle = yield* spawner.spawn(proc)
          const [stdout, stderr] = yield* Effect.all(
            [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
            { concurrency: 2 },
          )
          const code = yield* handle.exitCode
          return { code, stdout, stderr }
        },
        Effect.scoped,
        Effect.orDie,
      )

      const result: Interface = {
        info: Effect.fn("Installation.info")(function* () {
          return {
            version: InstallationVersion,
            latest: yield* result.latest(),
          }
        }),
        method: Effect.fn("Installation.method")(function* () {
          // Builds that publish to a custom npm registry (forks) cannot rely on
          // the upstream curl installer. Treat .opencode/bin and .local/bin paths
          // as curl only when the binary is upstream-published.
          if (!InstallationNpmRegistry) {
            if (process.execPath.includes(path.join(".opencode", "bin"))) return "curl" as Method
            if (process.execPath.includes(path.join(".local", "bin"))) return "curl" as Method
          }
          const exec = process.execPath.toLowerCase()

          const allChecks: Array<{ name: Method; command: () => Effect.Effect<string> }> = [
            { name: "npm", command: () => text(["npm", "list", "-g", "--depth=0"]) },
            { name: "yarn", command: () => text(["yarn", "global", "list"]) },
            { name: "pnpm", command: () => text(["pnpm", "list", "-g", "--depth=0"]) },
            { name: "bun", command: () => text(["bun", "pm", "ls", "-g"]) },
            { name: "brew", command: () => text(["brew", "list", "--formula", "opencode"]) },
            { name: "scoop", command: () => text(["scoop", "list", "opencode"]) },
            { name: "choco", command: () => text(["choco", "list", "--limit-output", "opencode"]) },
          ]
          // Fork builds only ship through the configured npm registry. Skip
          // detection paths that would resolve to upstream distribution channels.
          const checks = InstallationNpmRegistry
            ? allChecks.filter((c) => c.name !== "brew" && c.name !== "scoop" && c.name !== "choco")
            : allChecks

          checks.sort((a, b) => {
            const aMatches = exec.includes(a.name)
            const bMatches = exec.includes(b.name)
            if (aMatches && !bMatches) return -1
            if (!aMatches && bMatches) return 1
            return 0
          })

          for (const check of checks) {
            const output = yield* check.command()
            const installedName =
              check.name === "brew" || check.name === "choco" || check.name === "scoop"
                ? "opencode"
                : InstallationNpmPackage
            if (output.includes(installedName)) {
              return check.name
            }
          }

          return "unknown" as Method
        }),
        latest: Effect.fn("Installation.latest")(function* (installMethod?: Method) {
          const detectedMethod = installMethod || (yield* result.method())

          if (detectedMethod === "brew") {
            const formula = yield* getBrewFormula()
            if (formula.includes("/")) {
              const infoJson = yield* text(["brew", "info", "--json=v2", formula])
              const info = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(BrewInfoV2))(infoJson)
              return info.formulae[0].versions.stable
            }
            const response = yield* httpOk.execute(
              HttpClientRequest.get("https://formulae.brew.sh/api/formula/opencode.json").pipe(
                HttpClientRequest.acceptJson,
              ),
            )
            const data = yield* HttpClientResponse.schemaBodyJson(BrewFormula)(response)
            return data.versions.stable
          }

          if (detectedMethod === "npm" || detectedMethod === "bun" || detectedMethod === "pnpm") {
            return yield* viewVersion(detectedMethod, `${InstallationNpmPackage}@${InstallationChannel}`)
          }

          if (detectedMethod === "choco") {
            const response = yield* httpOk.execute(
              HttpClientRequest.get(
                "https://community.chocolatey.org/api/v2/Packages?$filter=Id%20eq%20%27opencode%27%20and%20IsLatestVersion&$select=Version",
              ).pipe(HttpClientRequest.setHeaders({ Accept: "application/json;odata=verbose" })),
            )
            const data = yield* HttpClientResponse.schemaBodyJson(ChocoPackage)(response)
            return data.d.results[0].Version
          }

          if (detectedMethod === "scoop") {
            const response = yield* httpOk.execute(
              HttpClientRequest.get(
                "https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/opencode.json",
              ).pipe(HttpClientRequest.setHeaders({ Accept: "application/json" })),
            )
            const data = yield* HttpClientResponse.schemaBodyJson(ScoopManifest)(response)
            return data.version
          }

          // GitHub releases fallback. Channels other than "latest" only exist as
          // prereleases, which /releases/latest excludes. List recent releases and
          // pick the newest tag matching the configured channel pattern.
          if (InstallationChannel !== "latest") {
            const escapedChannel = InstallationChannel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            const channelPattern = new RegExp(`^v\\d+\\.\\d+\\.\\d+-${escapedChannel}\\.\\d+$`)
            const listResponse = yield* httpOk.execute(
              HttpClientRequest.get(`https://api.github.com/repos/${InstallationRepo}/releases?per_page=30`).pipe(
                HttpClientRequest.acceptJson,
              ),
            )
            const releases = yield* HttpClientResponse.schemaBodyJson(GitHubReleaseList)(listResponse)
            const matching = releases.filter((r) => !r.draft && channelPattern.test(r.tag_name))
            if (matching.length > 0) {
              // GitHub returns releases newest-first; pick the first match.
              return matching[0].tag_name.replace(/^v/, "")
            }
          }
          const response = yield* httpOk.execute(
            HttpClientRequest.get(`https://api.github.com/repos/${InstallationRepo}/releases/latest`).pipe(
              HttpClientRequest.acceptJson,
            ),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(GitHubRelease)(response)
          return data.tag_name.replace(/^v/, "")
        }, Effect.orDie),
        upgrade: Effect.fn("Installation.upgrade")(function* (m: Method, target: string) {
          // target is interpolated into argv. cross-spawn does not invoke a shell,
          // but a malformed target can confuse package manager argv parsing for
          // scoop/choco. Reject anything that does not look like a SemVer or
          // dist-tag identifier.
          if (!/^[A-Za-z0-9._+-]+$/.test(target)) {
            return yield* new UpgradeFailedError({ stderr: `invalid upgrade target: ${target}` })
          }
          const forkOnlyMethods = new Set<Method>(["brew", "choco", "scoop", "curl"])
          if (InstallationNpmRegistry && forkOnlyMethods.has(m)) {
            return yield* new UpgradeFailedError({
              stderr: `${m} upgrades are not supported for builds published to ${InstallationNpmRegistry}. Reinstall with: npm install -g ${InstallationNpmPackage}@${target} --registry=${InstallationNpmRegistry}`,
            })
          }
          let upgradeResult: { code: ChildProcessSpawner.ExitCode; stdout: string; stderr: string } | undefined
          switch (m) {
            case "curl":
              upgradeResult = yield* upgradeCurl(target)
              break
            case "npm":
              upgradeResult = yield* run([
                "npm",
                "install",
                "-g",
                `${InstallationNpmPackage}@${target}`,
                ...registryArgs(),
              ])
              break
            case "pnpm":
              upgradeResult = yield* run([
                "pnpm",
                "install",
                "-g",
                `${InstallationNpmPackage}@${target}`,
                ...registryArgs(),
              ])
              break
            case "bun":
              upgradeResult = yield* run([
                "bun",
                "install",
                "-g",
                `${InstallationNpmPackage}@${target}`,
                ...registryArgs(),
              ])
              break
            case "brew": {
              const formula = yield* getBrewFormula()
              const env = { HOMEBREW_NO_AUTO_UPDATE: "1" }
              if (formula.includes("/")) {
                const tap = yield* run(["brew", "tap", "anomalyco/tap"], { env })
                if (tap.code !== 0) {
                  upgradeResult = tap
                  break
                }
                const repo = yield* text(["brew", "--repo", "anomalyco/tap"])
                const dir = repo.trim()
                if (dir) {
                  const pull = yield* run(["git", "pull", "--ff-only"], { cwd: dir, env })
                  if (pull.code !== 0) {
                    upgradeResult = pull
                    break
                  }
                }
              }
              upgradeResult = yield* run(["brew", "upgrade", formula], { env })
              break
            }
            case "choco":
              upgradeResult = yield* run(["choco", "upgrade", "opencode", `--version=${target}`, "-y"])
              break
            case "scoop":
              upgradeResult = yield* run(["scoop", "install", `opencode@${target}`])
              break
            default:
              return yield* new UpgradeFailedError({ stderr: `Unknown method: ${m}` })
          }
          if (!upgradeResult || upgradeResult.code !== 0) {
            const rawStderr = m === "choco" ? "not running from an elevated command shell" : upgradeResult?.stderr || ""
            const stderr = m === "npm" || m === "bun" || m === "pnpm" ? npmAuthHint(rawStderr) : rawStderr
            return yield* new UpgradeFailedError({ stderr })
          }
          log.info("upgraded", {
            method: m,
            target,
            stdout: upgradeResult.stdout,
            stderr: upgradeResult.stderr,
          })
          yield* text([process.execPath, "--version"])
        }),
      }

      return Service.of(result)
    }),
  )

export const defaultLayer = layer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
)

const { runPromise } = makeRuntime(Service, defaultLayer)

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

export * as Installation from "."
