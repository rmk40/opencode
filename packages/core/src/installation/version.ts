declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
  const OPENCODE_REPO: string
  const OPENCODE_NPM_PACKAGE: string
  const OPENCODE_NPM_REGISTRY: string
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
export const InstallationRepo =
  typeof OPENCODE_REPO === "string" && OPENCODE_REPO ? OPENCODE_REPO : "anomalyco/opencode"
export const InstallationNpmPackage =
  typeof OPENCODE_NPM_PACKAGE === "string" && OPENCODE_NPM_PACKAGE ? OPENCODE_NPM_PACKAGE : "opencode-ai"
export const InstallationNpmRegistry =
  typeof OPENCODE_NPM_REGISTRY === "string" && OPENCODE_NPM_REGISTRY ? OPENCODE_NPM_REGISTRY : ""
