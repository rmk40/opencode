#!/usr/bin/env node

import fs from "fs"
import path from "path"
import os from "os"
import { fileURLToPath } from "url"
import { createRequire } from "module"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const optionalDependencies = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).optionalDependencies || {}
  } catch {
    return {}
  }
})()

function detectPlatformAndArch() {
  // Map platform names
  let platform
  switch (os.platform()) {
    case "darwin":
      platform = "darwin"
      break
    case "linux":
      platform = "linux"
      break
    case "win32":
      platform = "windows"
      break
    default:
      platform = os.platform()
      break
  }

  // Map architecture names
  let arch
  switch (os.arch()) {
    case "x64":
      arch = "x64"
      break
    case "arm64":
      arch = "arm64"
      break
    case "arm":
      arch = "arm"
      break
    default:
      arch = os.arch()
      break
  }

  return { platform, arch }
}

function supportsAvx2(platform, arch) {
  if (arch !== "x64") return false
  if (platform === "linux") {
    try {
      return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
    } catch {
      return false
    }
  }
  if (platform === "darwin") {
    try {
      const result = require("child_process").spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], {
        encoding: "utf8",
        timeout: 1500,
      })
      if (result.status !== 0) return false
      return (result.stdout || "").trim() === "1"
    } catch {
      return false
    }
  }
  return false
}

function isMusl() {
  try {
    if (fs.existsSync("/etc/alpine-release")) return true
  } catch {
    // ignore
  }
  try {
    const result = require("child_process").spawnSync("ldd", ["--version"], { encoding: "utf8" })
    return ((result.stdout || "") + (result.stderr || "")).toLowerCase().includes("musl")
  } catch {
    return false
  }
}

function packageBase(name) {
  return name.split("/").pop()
}

function packageCandidates(platform, arch) {
  const base = `opencode-${platform}-${arch}`
  const baseline = arch === "x64" && !supportsAvx2(platform, arch)
  const names = (() => {
    if (platform === "linux") {
      if (isMusl()) {
        if (arch === "x64") {
          if (baseline) return [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
          return [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`]
        }
        return [`${base}-musl`, base]
      }
      if (arch === "x64") {
        if (baseline) return [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`]
        return [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`]
      }
      return [base, `${base}-musl`]
    }
    if (arch === "x64") {
      if (baseline) return [`${base}-baseline`, base]
      return [base, `${base}-baseline`]
    }
    return [base]
  })()
  const optionalNames = Object.keys(optionalDependencies)
  return names.flatMap((name) => {
    const scoped = optionalNames.filter((item) => packageBase(item) === name)
    return scoped.length ? scoped : [name]
  })
}

function findBinary() {
  const { platform, arch } = detectPlatformAndArch()
  const binaryName = platform === "windows" ? "opencode.exe" : "opencode"

  for (const packageName of packageCandidates(platform, arch)) {
    try {
      const packageJsonPath = require.resolve(`${packageName}/package.json`)
      const packageDir = path.dirname(packageJsonPath)
      const binaryPath = path.join(packageDir, "bin", binaryName)

      if (!fs.existsSync(binaryPath)) continue
      return { binaryPath, binaryName }
    } catch {
      continue
    }
  }
  throw new Error(`Could not find a compatible opencode binary package for ${platform}-${arch}`)
}

async function main() {
  try {
    if (os.platform() === "win32") {
      // On Windows, the .exe is already included in the package and bin field points to it
      // No postinstall setup needed beyond verifying the optional dependency resolved.
      findBinary()
      console.log("Windows detected: binary setup not needed (using packaged .exe)")
      return
    }

    // On non-Windows platforms, just verify the binary package exists
    // Don't replace the wrapper script - it handles binary execution
    const { binaryPath } = findBinary()
    const target = path.join(__dirname, "bin", ".opencode")
    if (fs.existsSync(target)) fs.unlinkSync(target)
    try {
      fs.linkSync(binaryPath, target)
    } catch {
      fs.copyFileSync(binaryPath, target)
    }
    fs.chmodSync(target, 0o755)
  } catch (error) {
    console.error("Failed to setup opencode binary:", error.message)
    process.exit(1)
  }
}

try {
  void main()
} catch (error) {
  console.error("Postinstall script error:", error.message)
  process.exit(0)
}
