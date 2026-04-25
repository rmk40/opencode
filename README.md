<p align="center">
  <picture>
    <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
    <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="opencode logo">
  </picture>
</p>
<p align="center"><b>opencode — <code>rmk40/opencode</code> fork (the <code>aai</code> channel)</b></p>
<p align="center">
  <a href="https://github.com/rmk40/opencode/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/rmk40/opencode?include_prereleases&style=flat-square&label=release"></a>
  <a href="https://github.com/rmk40/opencode/actions/workflows/fork-release-artifacts.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/rmk40/opencode/fork-release-artifacts.yml?style=flat-square&branch=actualyze&label=fork%20release"></a>
  <a href="https://github.com/rmk40/opencode/pkgs/npm/opencode"><img alt="GitHub Packages" src="https://img.shields.io/badge/npm-@rmk40/opencode-181717?style=flat-square&logo=github"></a>
</p>

[![opencode terminal UI](packages/web/src/assets/lander/screenshot.png)](https://github.com/rmk40/opencode)

---

This README is the fork's. For the upstream project (`anomalyco/opencode`),
see the upstream repository or the fork's `dev` branch. The upstream README
files are preserved as `README.<lang>.md` in this directory but are not the
canonical docs for this fork.

## Quick Facts

- **Repository:** `rmk40/opencode`
- **Release branch:** `actualyze`
- **Release channel:** `aai`
- **Tag format:** `vX.Y.Z-aai.N` (e.g. `v1.14.24-aai.4`)
- **npm package:** `@rmk40/opencode`
- **npm registry:** `https://npm.pkg.github.com` (GitHub Packages)
- **GitHub releases:** [`rmk40/opencode/releases`](https://github.com/rmk40/opencode/releases) (always `--prerelease`)
- **Distribution scope:** CLI only. No Homebrew, AUR, Docker, desktop bundles, signing, or notarization.

## Install

GitHub Packages requires a GitHub personal access token with the
`read:packages` scope, even for public packages. Set up `~/.npmrc` once:

```ini
@rmk40:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

Then install globally with whichever package manager you use:

```bash
# npm
npm install -g @rmk40/opencode@aai

# bun
bun install -g @rmk40/opencode@aai

# pnpm
pnpm install -g @rmk40/opencode@aai
```

One-off install without editing `~/.npmrc`:

```bash
NODE_AUTH_TOKEN=YOUR_GITHUB_TOKEN \
  npm install -g @rmk40/opencode@aai \
  --registry=https://npm.pkg.github.com
```

The `aai` dist-tag always points at the newest published fork version.

### Direct binary download (no npm)

Every release publishes per-platform archives plus `SHA256SUMS` to GitHub
Releases. Pick your platform from the
[releases page](https://github.com/rmk40/opencode/releases/latest)
or use `gh`:

```bash
gh release download --repo rmk40/opencode \
  --pattern 'opencode-*' --pattern 'SHA256SUMS' \
  --dir ./opencode-release
( cd ./opencode-release && sha256sum -c SHA256SUMS )
```

Linux archives are `.tar.gz`, macOS and Windows archives are `.zip`. The
contents are the binary plus its support files; extract somewhere on your
`PATH`.

Available targets:

| Platform      | Architectures            |
| ------------- | ------------------------ |
| macOS         | arm64, x64, x64-baseline |
| Linux (glibc) | x64, x64-baseline, arm64 |
| Linux (musl)  | x64, x64-baseline, arm64 |
| Windows       | x64, x64-baseline, arm64 |

The `-baseline` variants target older CPUs (no AVX2). The `-musl`
variants are for Alpine and other musl-libc distros.

## Upgrade

The fork build of `opencode` knows it came from this fork — the binary
has the fork repo, npm package, and registry baked in at build time, so
`opencode upgrade` queries `@rmk40/opencode@aai` on
`https://npm.pkg.github.com` instead of upstream npmjs.

```bash
opencode upgrade
```

It picks the upgrade method that matches how you installed it: `npm`,
`bun`, or `pnpm` (for global installs), or the GitHub releases fallback.
Upstream-only paths (`brew`, `scoop`, `choco`, the upstream `curl`
installer) are explicitly disabled in fork builds — they would resolve
to the upstream package and silently downgrade you off the fork channel.

If you see an auth error, your `~/.npmrc` token has expired or lacks
`read:packages`; the upgrade command will tell you what to fix.

## Verify a release

```bash
# Show the latest fork release
gh release view --repo rmk40/opencode

# Resolve the aai dist-tag against GitHub Packages
NODE_AUTH_TOKEN=YOUR_GITHUB_TOKEN \
  npm view @rmk40/opencode@aai version \
  --registry=https://npm.pkg.github.com
```

Both should report the same `X.Y.Z-aai.N` version. If they don't, a
publish failed mid-flight; see [Failure modes](#failure-modes).

## How the fork is structured

This fork tracks upstream `dev` and adds a long-lived release branch
plus a self-contained release pipeline. Nothing about the upstream
release infrastructure is reused.

```mermaid
flowchart LR
    Upstream["anomalyco/opencode (dev)"] -->|merge as needed| Actualyze["rmk40/opencode (actualyze)"]
    Actualyze -->|tag vX.Y.Z-aai.N| CI["fork-release-artifacts.yml"]
    CI --> Release["GitHub Release (prerelease)"]
    CI --> Pkgs["@rmk40/opencode (GitHub Packages)"]
    Release --> Users["users via gh release download"]
    Pkgs --> Users
```

- **`actualyze`** is the long-lived release branch. Merge upstream
  `dev` into it; never recreate or reset it.
- **Tags** drive releases. Push `vX.Y.Z-aai.N` from a commit reachable
  from `actualyze` and CI does the rest.
- **`workflow_dispatch`** is a manual fallback for testing CI without
  cutting a real release. Manual runs always produce drafts; tag pushes
  always produce published prereleases.

`X.Y.Z` is the upstream version this build is based on. `aai.N` is the
fork's monotonic suffix — once `aai.N` is published, it is never reused.

### What ships and what does not

```mermaid
mindmap
    root(("Fork pipeline scope"))
        In scope
            CLI binaries
                "linux x64/arm64 (glibc and musl)"
                "darwin x64 and arm64"
                "windows x64 and arm64"
                "baseline variants for older CPUs"
            "GitHub Releases (prerelease)"
            "GitHub Packages npm (@rmk40 scope)"
            "Captured models.dev/api.json snapshot"
        Out of scope
            "npmjs (registry.npmjs.org)"
            "Homebrew, AUR, Scoop, Chocolatey"
            "Docker / GHCR images"
            "Desktop app (Tauri / Electron)"
            "Code signing / notarization"
            "Updater channel promotion"
```

If you need anything in the right column, that is a separate change.
Do not bolt it onto the fork pipeline ad-hoc.

## The release pipeline

The pipeline is implemented by three files:

- `.github/workflows/fork-release-artifacts.yml` — the workflow.
- `script/fork-release-artifacts.sh` — all the actual logic.
- The root `package.json` script `release:fork` — the canonical entrypoint.

Always invoke the helper through the package script. Direct calls to
`script/fork-release-artifacts.sh` or `packages/opencode/script/build.ts`
are unsupported.

```bash
bun run release:fork -- <subcommand> [...args]
```

Subcommands:

| Subcommand    | What it does                                                               |
| ------------- | -------------------------------------------------------------------------- |
| `validate`    | Validates context, derives `version`/`channel`, writes job outputs.        |
| `build`       | Runs the upstream CLI build, captures models.dev, validates artifacts.     |
| `package`     | Stages release archives (`.tar.gz` / `.zip`) and writes `SHA256SUMS`.      |
| `release`     | Creates the GitHub release and uploads assets (binaries first, sums last). |
| `npm-package` | Stages wrapper + per-target `@rmk40/*` packages and tarballs locally.      |
| `npm-publish` | Preflights, publishes, verifies; `--ignore-scripts --tag aai`.             |
| `self-test`   | Offline regression suite. Touches no network, no registry.                 |

### Job graph

```mermaid
flowchart LR
    Tag["Push tag<br/>vX.Y.Z-aai.N"] --> Build["build-cli<br/>(release:fork build)"]
    Manual["workflow_dispatch"] --> Build
    Build -->|opencode-cli-dist.tar<br/>+ metadata| Release["release<br/>(release:fork release)"]
    Build --> Publish["publish-npm<br/>(release:fork npm-publish)"]
    Release --> GH["GitHub Release<br/>(prerelease)"]
    Publish --> GP["@rmk40/opencode@aai<br/>GitHub Packages"]
```

- `build-cli` runs the upstream `packages/opencode/script/build.ts`,
  smoke-tests the runner-native binaries, runs Alpine musl smoke tests
  inside `alpine:3.20` (after installing `libstdc++` and `libgcc`), and
  hands off `opencode-cli-dist.tar` to the downstream jobs. The dist
  tar preserves executable bits across the `actions/upload-artifact`
  boundary, which raw directory uploads do not.
- `release` requires `contents: write`, runs only on a tag push or
  when `inputs.create_release == true`, and publishes the release as
  prerelease. Tag pushes target the triggering tag; manual runs pass
  `--draft --target $GITHUB_SHA`.
- `publish-npm` requires `packages: write`, runs only on a tag push or
  when `inputs.publish_npm == true`, and depends on both `build-cli`
  and `release` so a failed release cannot leave npm published without
  a corresponding GitHub release.

The whole workflow runs on Node.js 24
(`FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"` plus explicit
`actions/setup-node@v4 { node-version: "24" }`).

### Cutting a release

```bash
git checkout actualyze
# ...do work, merge upstream as needed...
git push fork actualyze

git tag v1.14.24-aai.5
git push fork v1.14.24-aai.5
```

CI then:

1. Builds and smoke-tests every target.
2. Publishes the GitHub release as a prerelease.
3. Publishes `@rmk40/opencode@1.14.24-aai.5` and per-target packages
   to GitHub Packages, applying dist-tag `aai`.

Verify after CI is green:

```bash
gh release view v1.14.24-aai.5 --repo rmk40/opencode \
  --json tagName,isDraft,isPrerelease,assets

NODE_AUTH_TOKEN=YOUR_GITHUB_TOKEN \
  npm view @rmk40/opencode@aai version \
  --registry=https://npm.pkg.github.com
```

Manual fallback (only when needed, e.g. retesting CI behavior without
cutting a real release):

```bash
gh workflow run fork-release-artifacts.yml \
  --repo rmk40/opencode \
  --ref actualyze \
  -f upstream_version=1.14.24 \
  -f suffix=aai.5 \
  -f create_release=true \
  -f publish_npm=true
```

### Local validation

```bash
bash -n script/fork-release-artifacts.sh
bun run release:fork -- self-test
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/fork-release-artifacts.yml"); puts "ok"'
bun -e "JSON.parse(await Bun.file('package.json').text()); console.log('ok')"
git diff --check
```

For local debugging of `package` / `release` / `npm-publish` without
running CI:

```bash
export FORK_RELEASE_SKIP_CONTEXT_CHECK=1
export FORK_RELEASE_ALLOW_LOCAL_DIST=1
```

These overrides are intended for local debugging and must not appear
in CI runs.

## Build identity

The fork build bakes three install-identity values into the binary at
build time so `opencode upgrade` always queries the fork:

```text
OPENCODE_REPO=rmk40/opencode
OPENCODE_NPM_PACKAGE=@rmk40/opencode
OPENCODE_NPM_REGISTRY=https://npm.pkg.github.com
```

`script/fork-release-artifacts.sh build` exports these and aborts if
any is empty. They flow into the binary via
`packages/opencode/src/installation/version.ts` and are consumed by
`packages/opencode/src/installation/index.ts`. The release channel is
always `OPENCODE_CHANNEL=aai`.

The build also unsets `OPENCODE_BUMP`, `OPENCODE_RELEASE`, and `GH_REPO`
before invoking `build.ts` to prevent upstream version-bump or publish
side effects from leaking into a fork build.

## npm package layout

| Package                          | Role                                                       |
| -------------------------------- | ---------------------------------------------------------- |
| `@rmk40/opencode`                | Wrapper. Resolves the right per-target package at install. |
| `@rmk40/opencode-darwin-arm64`   | Per-target binary.                                         |
| `@rmk40/opencode-darwin-x64`     | Per-target binary.                                         |
| `@rmk40/opencode-linux-x64`      | Per-target binary.                                         |
| `@rmk40/opencode-linux-arm64`    | Per-target binary.                                         |
| `@rmk40/opencode-linux-x64-musl` | Per-target binary (Alpine).                                |
| `@rmk40/opencode-windows-x64`    | Per-target binary.                                         |
| ...                              | One per target listed under [Install](#install).           |

Wrapper metadata:

- `bin: { opencode: "./bin/opencode" }`
- `scripts.postinstall: "node ./postinstall.mjs"`
- `optionalDependencies` is set to every scoped per-target package at
  the same version. The wrapper bin and `postinstall.mjs` resolve the
  right one dynamically by reading `optionalDependencies` rather than
  hardcoding the `@rmk40` scope.
- `publishConfig.registry: https://npm.pkg.github.com`
- `repository.url: git+https://github.com/rmk40/opencode.git`

`npm-publish` always:

1. Stages packages from the dist tar (never the working tree).
2. Verifies the requested version matches the metadata.
3. Preflights every `@rmk40/*@<version>` against
   `https://npm.pkg.github.com`. If any version already exists, fails
   before publishing anything.
4. Publishes per-target packages first, then `@rmk40/opencode`, all
   with `--ignore-scripts --tag aai`.
5. Verifies post-publish that `@rmk40/opencode@aai` resolves to the
   new version.

## Failure modes

The pipeline is designed to fail closed.

| Failure                                            | Recovery                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| `validate` rejects the tag                         | Delete the tag, fix the input (`X.Y.Z-aai.N`, no leading zeros), re-tag. |
| Tag commit not reachable from `actualyze`          | Merge or rebase onto `actualyze`, re-tag from the new commit.            |
| `build-cli` fails                                  | Nothing was uploaded. Fix the build, push, retag.                        |
| `release` fails before publishing (manual draft)   | `gh release delete ... --cleanup-tag`, then rerun.                       |
| `release` fails after publishing                   | Don't retry the same version. Bump suffix, retag.                        |
| `publish-npm` fails after some packages are pushed | Don't retry the same version (immutable). Bump suffix, retag.            |

Never use the GitHub UI's "Re-run failed jobs" button on a partial
publish — always start a fresh tag.

## Reference

- [`docs/FORK_RELEASE_PIPELINE.md`](docs/FORK_RELEASE_PIPELINE.md) —
  detailed operator/agent reference for every subcommand and job.
- [`RELEASE_ARTIFACT_PIPELINE_PLAN.md`](RELEASE_ARTIFACT_PIPELINE_PLAN.md) —
  long-form design rationale.
- [`AGENTS.md`](AGENTS.md) — short operating notes for agents working
  in this repo.

## Contributing to the fork

The fork tracks upstream and adds release plumbing only. Contributions
that belong upstream should go upstream; the fork merges them in via
`actualyze`. Contributions that are fork-specific (release pipeline,
fork build identity, fork operational docs) belong on `actualyze`.

Standards:

- Every change to the release pipeline must keep
  `bun run release:fork -- self-test` green.
- Every public API or CLI behavior change should update
  `docs/FORK_RELEASE_PIPELINE.md` in the same change-set.
- Don't reuse a published `aai.N` suffix. Ever.

---

**Upstream project:** [`anomalyco/opencode`](https://github.com/anomalyco/opencode).
The fork exists to ship CLI-only release artifacts on a separate
channel; it is not a hostile fork and tracks upstream `dev` continuously.
