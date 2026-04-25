# Release Artifact Pipeline Plan

## Goal

Create a fork-local GitHub Actions pipeline for `rmk40/opencode` that can reliably build OpenCode release artifacts and optionally publish scoped GitHub Packages npm packages before adding npmjs publishing, Homebrew, AUR, GHCR, signing, notarization, or updater promotion.

The first working version should answer one question: can the fork build the same core artifacts inside GitHub Actions in a repeatable way from the `actualyze` release branch?

Artifacts should be built in GitHub Actions, not prebuilt locally and uploaded. Upload steps only persist the build outputs from the same workflow run, either as Actions artifacts or draft release assets.

Only phases 1, 2, and fork-local GitHub Packages npm publishing are in scope for the foreseeable future. Desktop artifacts, signing, updater promotion, npmjs publishing, Docker/GHCR, Homebrew, and AUR remain explicitly deferred.

## Current State

The upstream `.github/workflows/publish.yml` is a production publishing workflow, not a portable artifact-only builder. It is currently coupled to:

- `github.repository == 'anomalyco/opencode'` guards.
- Custom Blacksmith runners and macOS runner labels.
- A GitHub App token from `OPENCODE_APP_ID` / `OPENCODE_APP_SECRET`.
- Apple signing and notarization secrets.
- Azure Trusted Signing secrets.
- Tauri updater signing secrets.
- AUR, Homebrew, GHCR, and npm publishing in `script/publish.ts`.
- Release scripts that create GitHub releases, mutate versions, push tags, and push back to `dev`.

That workflow should be left intact. The fork should add a separate artifact-only workflow first.

## Phase 1: CLI Artifacts Only

Add a reusable shell implementation plus a thin workflow. The canonical entry point is the root `package.json` script:

```bash
bun run release:fork -- <validate|build|package|release|npm-package|npm-publish|self-test> [...args]
```

The root `package.json` script is the only supported public entry point. The workflow and manual operators should both call `bun run release:fork -- ...`; they should not invoke `script/fork-release-artifacts.sh` or `packages/opencode/script/build.ts` directly. The shell file remains an implementation detail behind the package script so CI and manual usage share the same interface.

The `package` and `release` commands should use the phase 1 dist tar by default. Local packaging from an existing `packages/opencode/dist` should require an explicit development override such as `FORK_RELEASE_ALLOW_LOCAL_DIST=1`.

Add a new workflow, for example `.github/workflows/fork-release-artifacts.yml`, triggered manually:

```yaml
on:
  workflow_dispatch:
    inputs:
      upstream_version:
        required: true
        type: string
      suffix:
        required: true
        type: string
      create_release:
        required: false
        type: boolean
        default: false
      publish_npm:
        required: false
        type: boolean
        default: false
  push:
    tags:
      - "v*-aai.*"
```

Run this workflow from the long-lived `actualyze` branch in the `rmk40/opencode` fork. Merge upstream `dev` into `actualyze` as needed instead of recreating the branch. The workflow should fail early unless both are true:

- `github.repository == 'rmk40/opencode'`
- `github.ref_name == 'actualyze'`
- if present, `github.ref_type == 'branch'` and `github.ref == 'refs/heads/actualyze'`

Construct the release version in the workflow from the upstream version and suffix input. For example:

- `upstream_version=1.14.24`, `suffix=aai.1` produces `1.14.24-aai.1`.
- `upstream_version=1.14.24`, `suffix=aai.2` produces `1.14.24-aai.2`.
- `upstream_version=1.14.24`, `suffix=aai.3` produces `1.14.24-aai.3`.

For normal releases, push a tag matching `vX.Y.Z-aai.N`. CI derives the same values from the tag and does not require manual inputs:

```bash
git tag v1.14.24-aai.3
git push fork v1.14.24-aai.3
```

Validate inputs before building:

- `upstream_version` must match `X.Y.Z`, for example `1.14.24`.
- `suffix` must match `^aai\.[1-9][0-9]*$`, for example `aai.1`. This enforces no leading zeroes and rejects SemVer-invalid values like `aai.01` early.
- `version` must be exactly `${upstream_version}-${suffix}` and valid SemVer.
- `OPENCODE_CHANNEL` must be set explicitly to `aai` so fork builds do not embed the upstream `latest` channel.

For tag-triggered releases, the tag must be reachable from `actualyze`. Tag-triggered runs create a published GitHub release and publish GitHub Packages automatically. Manual `workflow_dispatch` runs keep draft release creation behind `create_release` and GitHub Packages publishing behind `publish_npm`.

Run the version validation after constructing `${VERSION}` and before exporting it as `OPENCODE_VERSION`; `@opencode-ai/script` returns `OPENCODE_VERSION` verbatim.

Use minimal default permissions. The release job should widen permissions only when `create_release` is true:

```yaml
permissions:
  contents: read
```

Use a concurrency group keyed by branch and version inputs to prevent two workflow runs from racing on the same draft release:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref_name }}-${{ inputs.upstream_version }}-${{ inputs.suffix }}
  cancel-in-progress: false
```

Because `cancel-in-progress` is false, a stuck run should be cancelled manually from the GitHub Actions UI before dispatching the same version again.

If a duplicate run with the same inputs is already queued, it is expected to fast-fail at the release/tag preflight once the earlier run creates the draft release or tag.

If a run fails after creating the draft release, cancel any queued duplicate runs for the same concurrency group before cleaning up and dispatching a replacement run.

Do not call `script/version.ts` in the first pass. Set version values directly from the workflow input. Ignore the upstream `package.json` version for this workflow; `inputs.upstream_version` is the source of truth.

Use `actions/checkout@v4`, then `./.github/actions/setup-bun` from the repository root so the entire workspace, including `packages/app`, is installed. The build embeds the web UI by default through `packages/opencode/script/build.ts`; do not pass `--skip-embed-web-ui` unless the fork intentionally wants CLI artifacts without embedded web UI.

Before pushing the workflow, verify locally that `bun run --cwd packages/app build` succeeds. `build.ts` invokes that app build while embedding the web UI.

Build the CLI by calling the canonical root package script from a bash shell. The `build` command captures the models.dev snapshot first, then passes it through `MODELS_DEV_API_JSON` so all generated artifacts in a workflow run use the same snapshot. The `curl --retry-all-errors` flag used by the implementation assumes the GitHub-hosted runner's curl version is at least 7.71, which is true for current `ubuntu-latest` images:

```bash
bun run release:fork -- build \
  --upstream-version "${UPSTREAM_VERSION}" \
  --suffix "${SUFFIX}" \
  --version "${VERSION}"
```

The package script implementation must set `OPENCODE_VERSION`, `OPENCODE_CHANNEL`, `MODELS_DEV_API_JSON`, `OPENCODE_REPO`, `OPENCODE_NPM_PACKAGE`, and `OPENCODE_NPM_REGISTRY` in the same process that runs `build.ts`, and `OPENCODE_BUMP` / `OPENCODE_RELEASE` must not be set at workflow, job, or step scope. The repo/package/registry values are baked into the built binary so `opencode upgrade` queries the fork instead of upstream npmjs.

`MODELS_DEV_API_JSON` is consumed by `packages/opencode/script/generate.ts`, which `build.ts` imports before compiling binaries. This is the contract that makes the captured snapshot, not a second live fetch, feed the generated model snapshot.

Before the package script invokes `build.ts`, it must fail unless `OPENCODE_VERSION == ${VERSION}` and `OPENCODE_CHANNEL == "aai"` in the same shell process, and unless `OPENCODE_BUMP` and `OPENCODE_RELEASE` are unset. If `OPENCODE_CHANNEL` is missing, `@opencode-ai/script` can fall back to detached-HEAD branch detection on `actions/checkout@v4`; if `OPENCODE_VERSION` is missing or `OPENCODE_BUMP` is set, it can fall back to the npm registry's `opencode-ai/latest` version. Neither fallback is acceptable for this workflow.

During the build, parse the `opencode script` JSON banner from `@opencode-ai/script` with `jq` and check that `channel == "aai"` and `version == ${VERSION}`. Capture the banner from the line starting with `opencode script ` through the next line that is exactly `}`, strip only the literal prefix `opencode script ` from the first line so `{` remains the first JSON character, then pass the JSON to `jq`. This relies on the current top-level `Script` banner shape; if `Script` later logs nested objects, replace this with explicit begin/end markers. This confirms the build process saw the intended values before `build.ts` passes them to `Bun.build`; it is build-time stdout, not output from the produced binary. After the build, run `opencode --version` smoke tests against the Linux binaries to verify the produced binary reports `${VERSION}`.

After the build, verify the embedded web UI source bundle was generated by checking that `packages/app/dist` exists and contains at least one file. `build.ts` passes the embedded map to `Bun.build` as a virtual file rather than writing `opencode-web-ui.gen.ts` to disk.

Do not set `OPENCODE_RELEASE` initially. This keeps `build.ts` from uploading to a GitHub Release. After building, the package script should create a tar bundle of `packages/opencode/dist/opencode-*` and upload that tar as the Actions artifact. The release job should unpack that bundle before packaging release assets. This avoids relying on `actions/upload-artifact` directory layout or Unix mode preservation for executable files.

Pass no extra flags to `build.ts` in phase 1. Do not use `--single`, `--baseline`, `--skip-install`, or `--skip-embed-web-ui` for release artifact runs.

Do not set `GH_REPO` in phase 1. `GH_REPO` is only used by `build.ts` when `OPENCODE_RELEASE` is set, and this workflow should avoid that path.

Expected artifacts:

- `opencode-darwin-arm64`
- `opencode-darwin-x64`
- `opencode-darwin-x64-baseline`
- `opencode-linux-arm64`
- `opencode-linux-x64`
- `opencode-linux-x64-baseline`
- `opencode-linux-arm64-musl`
- `opencode-linux-x64-musl`
- `opencode-linux-x64-baseline-musl`
- `opencode-windows-arm64`
- `opencode-windows-x64`
- `opencode-windows-x64-baseline`

Windows artifact directories contain `bin/opencode.exe`. Non-Windows artifact directories contain `bin/opencode`.

The phase 1 dist tar preserves each per-target `package.json`; release archives intentionally do not. Phase 2 archives only the contents of each target's `bin/` directory to match upstream release layout.

Verification for phase 1:

- Workflow completes on `ubuntu-latest`.
- Artifacts download from the Actions run.
- The native `opencode-linux-x64` binary runs `opencode --version` in CI. `build.ts` already performs this smoke test on an x64 `ubuntu-latest` runner; the workflow may repeat it explicitly for clarity.
- The `opencode-linux-x64-baseline` binary runs `opencode --version` in CI. `build.ts` already smoke-tests this variant on an x64 `ubuntu-latest` runner; the workflow may repeat it explicitly for clarity.
- Assert Docker is available, then run the `opencode-linux-x64-musl` binary with `opencode --version` in an Alpine container. `build.ts` does not smoke-test this variant automatically:

```bash
docker run --rm \
  -e HOME=/tmp \
  -e XDG_CONFIG_HOME=/tmp/.config \
  -e XDG_DATA_HOME=/tmp/.local/share \
  -v "$PWD/packages/opencode/dist/opencode-linux-x64-musl/bin:/opt/opencode:ro" \
  alpine:3.20 \
  sh -lc 'apk add --no-cache libstdc++ libgcc >/dev/null && /opt/opencode/opencode --version' | grep -F "$VERSION"
```

- Run the same Alpine smoke test for `opencode-linux-x64-baseline-musl`. The `apk add` step reflects the expected Alpine runtime libraries for the current musl artifacts; a bare Alpine image does not include `libstdc++.so.6` or `libgcc_s.so.1`.

- macOS, Windows, Linux arm64, and other non-native artifacts are build-verified but not native-smoke-tested in phase 1.
- A downloaded macOS or local-platform artifact runs manually outside CI before using draft releases for anything beyond internal testing.
- Draft releases should remain draft until manual cross-platform smoke testing is complete.

Build metadata should be uploaded as an Actions artifact alongside the CLI outputs:

- Final version.
- `OPENCODE_CHANNEL`.
- Branch and commit SHA.
- Workflow run URL.
- `models.dev` snapshot SHA256 and the captured `models.dev-api.<sha256>.json` file.
- Workflow actor.
- Raw workflow inputs JSON.
- Artifact directory names.
- SHA256 checksums for generated release archives when phase 2 packaging runs.

Binaries built with `OPENCODE_CHANNEL=aai` will look for an `aai` updater channel that does not exist until updater promotion is designed later. This is intentional for fork artifacts: they should not accidentally pull upstream `latest` updates.

Use the default GitHub Actions artifact retention period.

## Phase 2: Draft GitHub Release Upload

After CLI artifacts are reliable, add an optional job gated by `create_release`.

This job should:

- Run when `create_release == true` for manual dispatches or on every valid release tag push.
- Set job-level `permissions.contents: write`.
- Set `env.GH_TOKEN: ${{ github.token }}` only on the package-script release step. Do not expose the write-scoped token to checkout/setup steps, and do not set a conflicting `GITHUB_TOKEN` value in the same step.
- Download the phase 1 CLI dist tar from the workflow run and let `bun run release:fork -- release` unpack it.
- Download the build metadata artifact, including `models.dev-api.<sha256>.json`, from the workflow run.
- Do not invoke `packages/opencode/script/build.ts`; phase 2 only packages artifacts produced by phase 1 through `bun run release:fork -- release`.
- Restore executable bits defensively before packaging non-Windows release archives, even though the phase 1 dist tar preserves modes.
- Fail if a release named `v${version}` already exists; do not clobber an existing release. Manual dispatches also fail if the tag exists. Tag-triggered runs allow the triggering tag to exist.
- Compress artifacts into the same release-asset shape upstream expects.
- Generate `SHA256SUMS` for every release asset and upload it with the assets. Use GNU `sha256sum` output, one line per file.
- Manual dispatches create a draft release for `v${version}` in `rmk40/opencode`, targeting the workflow commit (`$GITHUB_SHA`). Tag-triggered releases create a published release for the triggering tag.
- Upload assets with `gh release upload` and no `--clobber`.
- Generate a release body using the fields listed below.

Use explicit release and tag preflight checks before creating anything:

```bash
release_status="$(curl -sS -o /tmp/release.json -w "%{http_code}" \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/tags/v${VERSION}")"
case "$release_status" in
  200)
    echo "Release v${VERSION} already exists" >&2
    exit 1
    ;;
  404) ;;
  401|403)
    cat /tmp/release.json >&2
    echo "Release preflight is unauthorized; check contents:write permissions and GH_TOKEN" >&2
    exit 1
    ;;
  *)
    cat /tmp/release.json >&2
    exit 1
    ;;
esac

tag_status="$(curl -sS -o /tmp/tag.json -w "%{http_code}" \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${GITHUB_REPOSITORY}/git/ref/tags/v${VERSION}")"
case "$tag_status" in
  200)
    echo "Tag v${VERSION} already exists" >&2
    exit 1
    ;;
  404) ;;
  401|403)
    cat /tmp/tag.json >&2
    echo "Tag preflight is unauthorized; check contents:write permissions and GH_TOKEN" >&2
    exit 1
    ;;
  *)
    cat /tmp/tag.json >&2
    exit 1
    ;;
esac
```

For the release and tag checks, treat HTTP 200 as "exists", HTTP 404 as "absent", and any other status as a workflow error.

There is still a small time-of-check/time-of-use window between preflight and `gh release create`. This is acceptable for a fork workflow with serialized same-version runs; if `gh release create` fails because another actor created the release first, fail the job and inspect manually.

Create the draft release only after artifacts are packaged and checksummed:

```bash
gh release create "v${VERSION}" \
  --draft \
  --target "$GITHUB_SHA" \
  --title "OpenCode ${VERSION}" \
  --notes-file release-notes.md \
  --repo "$GITHUB_REPOSITORY"
```

`--target "$GITHUB_SHA"` should be the `actualyze` workflow commit. GitHub accepts any reachable SHA, not only default-branch SHAs.

The draft release may not create a remote git tag until it is published. The release and tag preflight checks still run before draft creation because they catch manually pushed tags, previously published releases, and partial recovery attempts from earlier runs.

Expected phase 2 release asset names:

- `opencode-darwin-arm64.zip`
- `opencode-darwin-x64.zip`
- `opencode-darwin-x64-baseline.zip`
- `opencode-linux-arm64.tar.gz`
- `opencode-linux-x64.tar.gz`
- `opencode-linux-x64-baseline.tar.gz`
- `opencode-linux-arm64-musl.tar.gz`
- `opencode-linux-x64-musl.tar.gz`
- `opencode-linux-x64-baseline-musl.tar.gz`
- `opencode-windows-arm64.zip`
- `opencode-windows-x64.zip`
- `opencode-windows-x64-baseline.zip`
- `models.dev-api.<sha256>.json`
- `SHA256SUMS`

Package each archive from the corresponding `packages/opencode/dist/<artifact>/bin/*` directory. Linux artifacts use `.tar.gz`; macOS and Windows artifacts use `.zip`. Match upstream archive layout by changing into the `bin/` directory before archiving so archive entries do not include a `bin/` prefix:

```bash
(cd "$bin_dir" && tar -czf "$asset_dir/${artifact}.tar.gz" *)
(cd "$bin_dir" && zip -r "$asset_dir/${artifact}.zip" *)
```

Generate `SHA256SUMS` from the release-asset staging directory before uploading assets. Include all `opencode-*.zip`, `opencode-*.tar.gz`, and `models.dev-api.*.json` files. Do not include `SHA256SUMS` itself. Use bare filenames so `sha256sum -c SHA256SUMS` works from the asset directory:

```bash
(cd "$asset_dir" && sha256sum opencode-*.zip opencode-*.tar.gz models.dev-api.*.json > SHA256SUMS)
```

Upload in two steps: first upload the binary and model-snapshot assets, then upload `SHA256SUMS` last. If any asset upload fails, stop immediately; do not attempt the checksum upload against a partial release.

The generated draft release body should include:

- Upstream version input.
- Suffix input.
- Final version.
- `OPENCODE_CHANNEL`.
- Branch name.
- Commit SHA.
- Workflow run URL.
- `models.dev` snapshot SHA256.
- `models.dev` snapshot release asset name.
- Workflow actor.
- Raw workflow inputs JSON.
- Verification summary.
- Artifact names and SHA256 checksums.

If draft release creation succeeds but asset upload fails, delete the draft release before rerunning. Also delete `v${version}` if a previous publish, manual push, or partial recovery attempt created the tag. Do not rerun with the same version while either the release or tag still exists.

Do not use GitHub's "Re-run failed jobs" button after a partial asset upload. Delete the draft release and any tag first, then dispatch a fresh workflow run with the same inputs.

Manual cleanup commands:

```bash
gh release delete "v${VERSION}" --yes --cleanup-tag --repo "$GITHUB_REPOSITORY"
git push "https://github.com/${GITHUB_REPOSITORY}.git" ":refs/tags/v${VERSION}" || true
```

The `git push :refs/tags/...` fallback handles the common draft-release case where no published-release tag exists but a tag was manually pushed or left over from partial recovery. `gh release delete --cleanup-tag` handles tags for releases that were published before deletion.

Do not use `OPENCODE_RELEASE` for phase 2. The workflow should package and upload release assets itself so it can fail on existing releases and avoid `build.ts`'s `--clobber` upload path.

If `https://models.dev/api.json` is unreachable after retries, fail the workflow. Do not soft-fail or build with an unknown model snapshot for release artifacts.

Audit `OPENCODE_CHANNEL` consumers during implementation before creating or sharing the first draft release. The expected phase 1/2 impact is updater-channel selection, but any additional channel-gated behavior should be documented before broader use.

This still should not publish npmjs, Homebrew, AUR, GHCR, or desktop updater metadata.

## Phase 3: GitHub Packages npm Publishing

After CLI artifacts are reliable, optionally publish scoped npm packages to GitHub Packages. This is for internal/private npm-style installs and intentionally does not publish to npmjs.

Use package names under the current fork owner scope:

- Wrapper package: `@rmk40/opencode`
- Platform packages: `@rmk40/opencode-darwin-arm64`, `@rmk40/opencode-linux-x64`, and so on for every `packages/opencode/dist/opencode-*` artifact.

The workflow input is `publish_npm`, defaulting to `false`. The npm job must depend on the build job and consume only the phase 1 `opencode-cli-dist.tar` and metadata artifacts. It must call `npm-publish`, which stages tarballs before publishing. It must not invoke `packages/opencode/script/build.ts`, must not use local prebuilt artifacts, and must not publish to npmjs.

The package-script interface is:

```bash
bun run release:fork -- npm-package --version 1.14.24-aai.2
bun run release:fork -- npm-publish --version 1.14.24-aai.2
```

`npm-package` should restore and validate `opencode-cli-dist.tar`, stage package directories under `${RUNNER_TEMP}/fork-release/npm-packages`, and write tarballs under `${RUNNER_TEMP}/fork-release/npm-tarballs`. Platform packages preserve each artifact's generated `os` and `cpu` metadata. The wrapper `@rmk40/opencode` keeps the `opencode` bin name and exact-version `optionalDependencies` on all scoped platform packages.

`npm-publish` should require `NODE_AUTH_TOKEN`, preflight every `@rmk40/*@${VERSION}` with `npm view --registry https://npm.pkg.github.com`, fail before publishing anything if any package already exists, publish platform packages first, publish `@rmk40/opencode` last, apply the `aai` dist-tag, and verify `@rmk40/opencode@aai` resolves to the requested version.

If publishing partially fails after some platform packages are published, do not rerun with the same version. GitHub Packages package versions are immutable; bump the suffix, rebuild from CI, and publish a new version.

Workflow permissions for the npm job:

```yaml
permissions:
  contents: read
  packages: write
```

Use `actions/setup-node@v4` with `registry-url: https://npm.pkg.github.com` and `scope: "@rmk40"`. Set `NODE_AUTH_TOKEN: ${{ github.token }}` only on the publish step. The package scope should remain `@rmk40` until explicitly moved to another GitHub org scope.

Consumers install with:

```bash
npm install -g @rmk40/opencode@aai --registry=https://npm.pkg.github.com
```

Most consumers need a GitHub token in `.npmrc` for GitHub Packages:

```ini
@rmk40:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

The CLI wrapper and `postinstall.mjs` must resolve platform packages from the wrapper package's `optionalDependencies` rather than hardcoding unscoped names. This lets the same wrapper work with scoped GitHub Packages now and a different org scope later.

## Phase 4: Desktop Artifacts, Unsigned First

Once CLI artifacts are reliable, add desktop artifact jobs. Keep signing disabled at first.

Use GitHub-hosted runners only initially:

- `ubuntu-latest`
- `macos-latest`
- `windows-2025`

Avoid Blacksmith-specific labels until a replacement runner strategy exists.

### Tauri Desktop

The upstream Tauri build depends on the CLI artifact through `packages/desktop/scripts/prepare.ts`, which downloads the CLI artifact from the current workflow run.

Start with Linux x64 first because it has the least signing/notarization friction.

Then add macOS and Windows after confirming how to disable or bypass signing for fork artifacts.

### Electron Desktop

Electron is likely easier to produce unsigned artifacts for than Tauri, but the current config signs/notarizes in production paths.

Start with package-only mode:

```bash
npx electron-builder --linux --publish never --config electron-builder.config.ts
```

Then add Windows and macOS once unsigned build behavior is confirmed.

## Phase 5: Signing And Promotion

Only after unsigned artifacts are reliable:

- Add Apple Developer ID signing and notarization.
- Add Azure Trusted Signing for Windows.
- Add Tauri updater signing.
- Add updater metadata upload.
- Add release note generation.
- Add tag creation and version sync automation.

## Phase 6: npmjs Publishing

Do not start npmjs publishing until GitHub Packages installs are proven.

When ready, adapt the GitHub Packages layout around the same artifact outputs:

- Wrapper package installs the `opencode` binary.
- Platform binary packages are optional dependencies.
- Package naming should move to the intended public npmjs scope.
- Trusted publishing via npm OIDC can be added after package contents are verified with GitHub Packages.

## Implementation Notes

- Keep the fork workflow separate from upstream `publish.yml` to reduce merge conflicts.
- Prefer artifact upload over release upload until build output is stable.
- Use manual `workflow_dispatch` first; add tag triggers later.
- Keep `actualyze` as a long-lived branch and merge upstream `dev` into it as needed.
- Use the repo's `.github/actions/setup-bun` where possible because it follows `packageManager` from root `package.json`.
- Avoid GitHub App token setup in the first pass; `GITHUB_TOKEN` is sufficient for workflow artifacts and draft releases in the same repo.
- Avoid upstream `script/publish.ts` because it publishes npmjs packages, Docker images, Homebrew tap changes, AUR updates, and release finalization. Fork GitHub Packages publishing must stay in `script/fork-release-artifacts.sh`.
- Expect `build.ts` to reach the network for cross-target optional dependencies via `bun install --os="*" --cpu="*"`; registry outages should fail the workflow rather than producing partial artifacts.
- Phase 2 must read only the phase 1 artifact bundle and metadata artifact. It must not rebuild from the working tree or a fresh `packages/opencode/dist/`.

## First Concrete PR Scope

The first artifact-pipeline PR should contain only:

- `.github/workflows/fork-release-artifacts.yml`
- `script/fork-release-artifacts.sh`
- The root `package.json` script that exposes `script/fork-release-artifacts.sh` as `bun run release:fork -- ...`

GitHub Packages support may add scoped `@rmk40` package metadata and wrapper resolution changes, but should not modify desktop signing config, upstream publish scripts, or updater config.

It can include both phase 1 and phase 2 in one workflow if phase 2 is strictly gated behind `create_release`. This keeps the implementation practical while preserving the artifact-only default path.

The first implementation branch should be `actualyze`, not a branch named after the fork suffix. The `-aai.N` suffix belongs in the workflow version input and draft release tag, not in the branch name.
