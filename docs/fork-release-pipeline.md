# Fork Release Pipeline

This document is the canonical operational reference for the
`rmk40/opencode` fork release pipeline. It is written for future agents
or operators who need to understand, run, debug, or extend the
pipeline. Every claim below is grounded in files in this repository.

If you change the pipeline, update this document in the same change-set.

## 1. Goals and Non-Goals

The fork pipeline produces:

- CLI binaries for every supported target via the upstream
  `packages/opencode/script/build.ts`.
- A published GitHub release on `rmk40/opencode` for every release
  version, with artifacts and a `SHA256SUMS` manifest.
- Scoped GitHub Packages npm packages for every release version, with
  dist-tag `aai`.

The pipeline does not produce:

- npmjs (registry.npmjs.org) packages.
- Homebrew, AUR, Docker/GHCR, or desktop artifacts.
- Code signing, notarization, or updater promotion.

If you need any of those, that is a separate change. Do not bolt them
into the fork pipeline ad-hoc.

## 2. Branch and Tag Model

- `actualyze` is the long-lived release branch on `rmk40/opencode`.
- Merge upstream `dev` into `actualyze` as needed. Do not recreate or
  reset the branch.
- Releases are driven by tags. Push a tag matching
  `vX.Y.Z-aai.N` from a commit that is reachable from `actualyze`.
  CI does the rest.
- Manual `workflow_dispatch` runs are also supported. They take
  `upstream_version` + `suffix` inputs and have explicit
  `create_release` / `publish_npm` toggles.

Version format:

- `upstream_version` matches `X.Y.Z` with no leading zeros.
- `suffix` matches `^aai\.[1-9][0-9]*$` (no `aai.01`).
- Final `version` is exactly `${upstream_version}-${suffix}`.
- Channel is always `aai` and is baked into the binary at build time.

## 3. Files That Implement The Pipeline

```
.github/workflows/fork-release-artifacts.yml   workflow definition
script/fork-release-artifacts.sh               release helper (canonical via package script)
package.json (root)                            exposes "release:fork": "bash script/fork-release-artifacts.sh"
release-artifact-pipeline-plan.md              long-form design plan
AGENTS.md                                      day-to-day operating notes
docs/fork-release-pipeline.md                  this document
```

The canonical interface is the root package script. Always invoke the
helper as:

```bash
bun run release:fork -- <subcommand> [...args]
```

Do not invoke `script/fork-release-artifacts.sh` directly in CI or in
documentation. Do not invoke `packages/opencode/script/build.ts`
directly. Both are implementation details behind `release:fork`.

## 4. Release Helper Subcommands

`bun run release:fork -- <subcommand>` accepts:

- `validate` — Validates repo/branch/tag context, derives version
  from inputs or tag, writes `version` and `channel` to
  `$GITHUB_OUTPUT` for downstream jobs.
- `build` — Runs the upstream CLI build, captures the
  `https://models.dev/api.json` snapshot once, validates each platform
  artifact, normalizes Windows artifacts to `bin/opencode.exe`, writes
  release metadata, and creates `${WORKDIR}/opencode-cli-dist.tar` and
  `${WORKDIR}/release-metadata/` for downstream jobs.
- `package` — Restores the dist tar, packages each platform target
  into the upstream-shaped archive (Linux `.tar.gz`, macOS/Windows
  `.zip`), copies the models.dev snapshot asset, and writes
  `SHA256SUMS`.
- `release` — Requires `GH_TOKEN` and `GITHUB_REPOSITORY`. Restores
  dist tar and metadata. Verifies metadata version matches the
  requested `--version`. Preflights the GitHub release (and tag, if
  not in tag context). Calls `package`. Uploads binary and model
  assets first, then `SHA256SUMS` last. Always uploads as
  `--prerelease`. Tag-triggered runs publish; manual runs use
  `--draft --target <sha>`.
- `npm-package` — Restores dist tar. Stages a wrapper package
  `@rmk40/opencode` and per-target `@rmk40/opencode-<artifact>`
  packages under `${WORKDIR}/npm-packages/`, writes tarballs to
  `${WORKDIR}/npm-tarballs/` using `npm pack --ignore-scripts`.
- `npm-publish` — Requires `NODE_AUTH_TOKEN`. Calls `npm-package`,
  preflights every staged `@rmk40/*@<version>` against
  `https://npm.pkg.github.com` (treating only `E404` / `404 Not Found`
  / `ETARGET` / `notarget` / `No matching version found` as missing),
  publishes platform packages first, then `@rmk40/opencode`, all with
  dist-tag `aai` and `--ignore-scripts`. Verifies after publish.
- `self-test` — Self-contained offline regression test. Stages fake
  artifacts, exercises `validate`, `package`, `npm-package`, and
  invalid-input paths. Does not touch the network or any registry.

Helper exits non-zero on any failure (`set -euo pipefail`). All
network calls use retries where applicable.

## 5. Workflow Triggers

`.github/workflows/fork-release-artifacts.yml` triggers on:

```yaml
on:
  workflow_dispatch:
    inputs:
      upstream_version: { required: true, type: string }
      suffix: { required: true, type: string }
      create_release: { required: false, type: boolean, default: false }
      publish_npm: { required: false, type: boolean, default: false }
  push:
    tags:
      - "v[0-9]*.[0-9]*.[0-9]*-aai.[0-9]*"
```

Concurrency:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref_name }}
  cancel-in-progress: false
```

Concurrent same-tag pushes serialize. Concurrent manual dispatches on
`actualyze` also serialize. `cancel-in-progress: false` prevents
mid-flight cancellation that would corrupt a partial publish.

The whole workflow runs on Node.js 24:

- Workflow-level
  `env: FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"` opts every JS
  action onto Node 24.
- `actions/setup-node@v4` is invoked explicitly with `node-version:
"24"` in each job.

Default permissions are read-only. Each job escalates only what it
needs.

## 6. Jobs

### 6.1 build-cli

- Runs on `ubuntu-latest`.
- Permissions: `contents: read`.
- Steps:
  1. `actions/checkout@v4` with `fetch-depth: 0` and
     `persist-credentials: false`. The checkout token is not persisted
     because no step needs to push.
  2. `actions/setup-node@v4` with `node-version: "24"`.
  3. `./.github/actions/setup-bun`.
  4. `bun run release:fork -- validate` (sets `version`, `channel`
     outputs).
  5. `bun run release:fork -- build --version "$VERSION"` (uses
     metadata derived in step 4 for tag context).
  6. Uploads two artifacts:
     - `opencode-cli-dist`: the `${WORKDIR}/opencode-cli-dist.tar`.
       This is the source of truth for downstream jobs.
     - `opencode-build-metadata`: contents of
       `${WORKDIR}/release-metadata/`, including `metadata.json`,
       `inputs.json`, `artifacts.txt`, and the captured models.dev
       snapshot file.

The build runs `./packages/opencode/script/build.ts`. That script
embeds the web UI, performs cross-target installs of optional
dependencies, builds every target with `Bun.build`, and runs
`opencode --version` smoke tests on the runner-native binary
(`opencode-linux-x64`, `opencode-linux-x64-baseline`).

Additional smoke tests run inside an `alpine:3.20` container after
installing `libstdc++` and `libgcc` from `apk`, for both
`opencode-linux-x64-musl` and `opencode-linux-x64-baseline-musl`.

`models.dev/api.json` is fetched once with retries, hashed with
SHA-256, and saved as `models.dev-api.<sha256>.json`. The path is
exposed via `MODELS_DEV_API_JSON` so `script/generate.ts` reads the
captured snapshot rather than refetching.

### 6.2 release

- Runs on `ubuntu-latest`.
- Permissions: `contents: write`.
- `if`: tag context, OR manual `inputs.create_release == true`.
- Steps:
  1. Checkout with `persist-credentials: false`.
  2. `actions/setup-node@v4` with `node-version: "24"`.
  3. `./.github/actions/setup-bun`.
  4. Download `opencode-cli-dist` and `opencode-build-metadata`.
  5. `bun run release:fork -- release --version "$VERSION"` with
     `GH_TOKEN: ${{ github.token }}` set on that step only.

Behavior of `release`:

- Tag context: the tag commit must be reachable from
  `refs/heads/actualyze`. Reachability is verified by calling the
  GitHub `compare/${TARGET_BRANCH}...${SHA}` API anonymously. Status
  must be `identical` or `behind`.
- Tag context: creates a published prerelease anchored to the
  triggering tag. Does not pass `--target`.
- Manual context: creates a draft prerelease anchored to the workflow
  commit (`--target $GITHUB_SHA`).
- In both cases the release is `--prerelease`.
- Uploads binary and model assets first, then `SHA256SUMS` last. Never
  uses `--clobber`.

### 6.3 publish-npm

- Runs on `ubuntu-latest`.
- Permissions: `contents: read`, `packages: write`.
- `if`: `(github.ref_type == 'tag' || inputs.publish_npm) && build-cli
succeeded && (release succeeded or was skipped)`.
- `needs: [build-cli, release]` so that a release-job failure on tag
  pushes does not allow npm to publish a version with no GitHub
  release.
- Steps:
  1. Checkout with `persist-credentials: false`.
  2. `./.github/actions/setup-bun`.
  3. `actions/setup-node@v4` with `registry-url:
https://npm.pkg.github.com` and `scope: "@rmk40"` so that
     `NODE_AUTH_TOKEN` is wired into `.npmrc` automatically.
  4. Download `opencode-cli-dist` and `opencode-build-metadata`.
  5. `bun run release:fork -- npm-publish --version "$VERSION"` with
     `NODE_AUTH_TOKEN: ${{ github.token }}` set on that step only.

`npm-publish` always:

- Stages packages from the dist tar (never from the working tree).
- Verifies the requested version matches metadata before publishing.
- Preflights each `@rmk40/*@<version>`. If any already exist, fails
  before publishing anything.
- Publishes platform packages first, then `@rmk40/opencode`, with
  `--ignore-scripts` and `--tag aai`.
- Verifies post-publish that `@rmk40/opencode@aai` resolves.

GitHub Packages versions are immutable. If a publish fails after some
platform packages were already published, do not rerun with the same
version. Bump the suffix and rebuild from CI.

## 7. Artifact Layout And Asset Names

Each per-target artifact directory has the layout
`opencode-<platform>-<arch>[-baseline][-musl]/bin/...`.

Expected directory names (set in
`script/fork-release-artifacts.sh:EXPECTED_ARTIFACTS`):

```
opencode-darwin-arm64
opencode-darwin-x64
opencode-darwin-x64-baseline
opencode-linux-arm64
opencode-linux-x64
opencode-linux-x64-baseline
opencode-linux-arm64-musl
opencode-linux-x64-musl
opencode-linux-x64-baseline-musl
opencode-windows-arm64
opencode-windows-x64
opencode-windows-x64-baseline
```

Linux artifacts contain `bin/opencode`. Windows artifacts contain
`bin/opencode.exe`. macOS artifacts contain `bin/opencode`.

Release archive names match upstream layout: Linux uses `.tar.gz`,
macOS and Windows use `.zip`. Archive contents are the contents of
each `bin/` directory, not the `bin/` directory itself, and not the
parent `package.json`.

`SHA256SUMS` is generated from the release-asset staging directory
with bare filenames, so `sha256sum -c SHA256SUMS` works from the same
directory after `gh release download`.

The models.dev snapshot is uploaded as
`models.dev-api.<sha256>.json` to make the snapshot reproducible
without a separate API call at install time.

## 8. GitHub Packages npm Layout

Wrapper package: `@rmk40/opencode`.

Per-target packages: `@rmk40/opencode-<artifact>` (one per directory
in the list above), with the artifact's generated `os` and `cpu`
fields preserved.

Wrapper package metadata:

- `bin: { opencode: "./bin/opencode" }`.
- `scripts.postinstall: "node ./postinstall.mjs"`.
- `optionalDependencies` set to every scoped platform package at the
  exact same version.
- `publishConfig.registry: https://npm.pkg.github.com`.
- `repository.url:
git+https://github.com/rmk40/opencode.git`.

Wrapper bin script (`packages/opencode/bin/opencode`) and
`postinstall.mjs` resolve scoped optional dependencies dynamically by
reading `optionalDependencies` from the wrapper package.json. They do
not hardcode the `@rmk40` scope. This lets the same source build
work after a future scope change with no code edits.

## 9. End-To-End Release Flow

Default path (recommended):

```bash
git checkout actualyze
# (do work, merge upstream, etc.)
git push fork actualyze

git tag v1.14.24-aai.5
git push fork v1.14.24-aai.5
```

CI then:

1. Runs `build-cli` against the tag commit.
2. Runs `release` to publish a prerelease at
   `https://github.com/rmk40/opencode/releases/tag/v1.14.24-aai.5`.
3. Runs `publish-npm` to publish `@rmk40/opencode@1.14.24-aai.5` and
   the platform packages to GitHub Packages, applying dist-tag `aai`.

Verify after the run:

```bash
gh release view v1.14.24-aai.5 --repo rmk40/opencode \
  --json tagName,isDraft,isPrerelease,assets

gh api repos/rmk40/opencode/actions/runs/<run-id>/jobs \
  --jq '.jobs[] | "\(.name)\t\(.conclusion)"'
```

Manual fallback path (only when needed, e.g. retesting CI behavior
without cutting a release):

```bash
gh workflow run fork-release-artifacts.yml \
  --repo rmk40/opencode \
  --ref actualyze \
  -f upstream_version=1.14.24 \
  -f suffix=aai.5 \
  -f create_release=true \
  -f publish_npm=true
```

The manual path produces a draft GitHub release. The tag path
produces a published prerelease.

## 10. Installing The Result

GitHub Packages npm requires authentication for pulls, even for
public packages. Users need a GitHub personal access token with
`read:packages` scope.

`~/.npmrc` example:

```ini
@rmk40:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

Install:

```bash
npm install -g @rmk40/opencode@aai
```

Or for a one-off:

```bash
NODE_AUTH_TOKEN=YOUR_TOKEN npm install -g @rmk40/opencode@aai \
  --registry=https://npm.pkg.github.com
```

If you want unauthenticated installs, that requires either moving to
npmjs (public scope) or adding a separate “github-release” install
path that downloads tarballs from public GitHub Release assets. Both
are out of scope for this pipeline as currently designed.

## 11. `opencode upgrade`

The fork build embeds three install-identity values at build time so
`opencode upgrade` knows where to look:

- `OPENCODE_REPO=rmk40/opencode`
- `OPENCODE_NPM_PACKAGE=@rmk40/opencode`
- `OPENCODE_NPM_REGISTRY=https://npm.pkg.github.com`

These come from environment variables exported by
`script/fork-release-artifacts.sh build`. The build fails if any of
them is missing. They are surfaced into the binary by
`packages/opencode/src/installation/version.ts` and consumed by
`packages/opencode/src/installation/index.ts`.

`opencode upgrade` for fork builds:

- For `npm | bun | pnpm`: queries
  `npm view ${OPENCODE_NPM_PACKAGE}@aai version --registry=${OPENCODE_NPM_REGISTRY}`
  and installs the resolved version with the same package manager and
  `--registry` flag.
- For the GitHub releases fallback: queries
  `https://api.github.com/repos/${OPENCODE_REPO}/releases` and selects
  the newest tag matching `^v\d+\.\d+\.\d+-aai\.\d+$`.

If the user has no token configured for GitHub Packages, the upgrade
fails with a clear error pointing them at `~/.npmrc`. The pipeline
does not silently fall back to npmjs or the upstream package.

## 12. Local Development Tooling

Fast local checks for any change to the pipeline:

```bash
bash -n script/fork-release-artifacts.sh
bun run release:fork -- self-test
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/fork-release-artifacts.yml"); puts "workflow yaml ok"'
bun -e "JSON.parse(await Bun.file('package.json').text()); console.log('package.json ok')"
git diff --check
```

For deeper debugging of `package` / `release` / `npm-publish`
without running CI, set both:

```bash
export FORK_RELEASE_SKIP_CONTEXT_CHECK=1
export FORK_RELEASE_ALLOW_LOCAL_DIST=1
```

These are intended for local-only debugging and must not leak into
CI.

`FORK_RELEASE_SKIP_REACHABILITY_CHECK=1` skips the GitHub compare API
call. Useful only when working offline and never in CI.

## 13. Failure Modes And Recovery

The pipeline is designed to fail closed. The common failure modes
and their correct recovery:

- **Validate fails on tag**: tag does not match
  `vX.Y.Z-aai.N`, leading-zero suffix, or commit not reachable from
  `actualyze`. Fix: delete the tag, fix the source, re-tag.
  ```bash
  git push fork :refs/tags/vX.Y.Z-aai.N
  git tag -d vX.Y.Z-aai.N
  ```
- **Build fails**: typically upstream `build.ts` regressions or the
  Alpine musl smoke tests breaking due to libstdc++/libgcc upgrades.
  No artifacts are uploaded, so there is nothing to clean up.
- **Release job fails after creating a draft (manual mode only)**:
  delete the draft and the tag (if a tag was pushed), then rerun.
  ```bash
  gh release delete vX.Y.Z-aai.N --yes --cleanup-tag --repo rmk40/opencode
  git push "https://github.com/rmk40/opencode.git" :refs/tags/vX.Y.Z-aai.N || true
  ```
- **Release job fails after publishing**: do not retry the same
  version. The release is permanent. Bump suffix and tag again.
- **npm-publish fails after partial publish**: GitHub Packages
  versions are immutable. Do not retry the same version. Bump suffix,
  rebuild from CI, and publish a new version.

Never use the GitHub UI's "Re-run failed jobs" button against a
partially-published run. Always start a fresh run with a clean tag.

## 14. What Future Agents Must Not Do

The following are common temptations that are explicitly out of scope.
Do not add them to this pipeline without an explicit instruction:

- npmjs publishing.
- Homebrew tap updates.
- AUR updates.
- Docker / GHCR image publishing.
- Apple/Microsoft signing or notarization.
- Tauri or Electron desktop artifacts.
- Updater channel promotion.
- Calling upstream `script/publish.ts` from this pipeline.
- Running tests against the working tree from CI (the build job is
  the only place that should reach the network for cross-target
  installs).
- Using `actions/upload-artifact` for raw directories of
  per-platform binaries; the executable bit needs the dist tar.
- Re-using a release suffix (`aai.N`). Suffixes are append-only.
- Touching the upstream `.github/workflows/publish.yml`.

## 15. Quick Reference Commands

Inspect last run:

```bash
gh run list --repo rmk40/opencode --limit 5 \
  --json databaseId,event,headBranch,status,conclusion,url \
  --jq '.[] | "\(.databaseId)\t\(.event)\t\(.headBranch)\t\(.status)\t\(.conclusion)"'
```

Watch a specific run:

```bash
gh run watch <run-id> --repo rmk40/opencode --exit-status --interval 30
```

List release assets:

```bash
gh release view vX.Y.Z-aai.N --repo rmk40/opencode \
  --json assets --jq '.assets[].name'
```

Verify a downloaded archive:

```bash
gh release download vX.Y.Z-aai.N --repo rmk40/opencode \
  --pattern 'opencode-*' --pattern 'SHA256SUMS' --dir /tmp/release
( cd /tmp/release && sha256sum -c SHA256SUMS )
```

List published GitHub Packages npm versions:

```bash
NODE_AUTH_TOKEN=YOUR_TOKEN \
  npm view @rmk40/opencode versions --registry=https://npm.pkg.github.com
```

## 16. Where The Source Of Truth Lives

If this document and the implementation disagree, the implementation
wins, and this document must be updated in the same change-set that
introduced the disagreement. Do not let drift accumulate.

Implementation files referenced by this document:

- `.github/workflows/fork-release-artifacts.yml`
- `script/fork-release-artifacts.sh`
- `package.json` (root, `scripts.release:fork`)
- `packages/opencode/script/build.ts`
- `packages/opencode/script/postinstall.mjs`
- `packages/opencode/bin/opencode`
- `packages/opencode/src/installation/index.ts`
- `packages/opencode/src/installation/version.ts`

Adjacent design documents:

- `release-artifact-pipeline-plan.md` — long-form design rationale
  for the pipeline.
- `AGENTS.md` — short operating notes shared with the rest of the
  agent ecosystem.
