# Release Artifact Pipeline Plan

## Goal

Create a fork-local GitHub Actions pipeline that can reliably build OpenCode release artifacts before adding any npm publishing, Homebrew, AUR, GHCR, signing, notarization, or updater promotion.

The first working version should answer one question: can the fork produce the same core artifacts from CI in a repeatable way?

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

Add a new workflow, for example `.github/workflows/fork-release-artifacts.yml`, triggered manually:

```yaml
on:
  workflow_dispatch:
    inputs:
      version:
        required: true
        type: string
      create_release:
        required: false
        type: boolean
        default: false
```

Use minimal permissions:

```yaml
permissions:
  contents: write
```

Do not call `script/version.ts` in the first pass. Set version values directly from the workflow input.

Build the CLI using the existing script:

```bash
OPENCODE_VERSION="${VERSION}" \
GH_REPO="${GITHUB_REPOSITORY}" \
./packages/opencode/script/build.ts
```

Do not set `OPENCODE_RELEASE` initially. This keeps `build.ts` from uploading to a GitHub Release and lets the workflow upload `packages/opencode/dist/opencode-*` as plain Actions artifacts.

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

Verification for phase 1:

- Workflow completes on `ubuntu-latest`.
- Artifacts download from the Actions run.
- At least the native Linux binary runs `opencode --version` in CI.
- A downloaded macOS or local-platform artifact runs manually outside CI.

## Phase 2: Draft GitHub Release Upload

After CLI artifacts are reliable, add an optional job gated by `create_release`.

This job should:

- Create or update a draft release for `v${version}`.
- Download CLI artifacts from the workflow run.
- Compress artifacts in the same shape upstream expects where needed.
- Upload them with `gh release upload --clobber`.

This still should not publish npm, Homebrew, AUR, GHCR, or desktop updater metadata.

## Phase 3: Desktop Artifacts, Unsigned First

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

## Phase 4: Signing And Promotion

Only after unsigned artifacts are reliable:

- Add Apple Developer ID signing and notarization.
- Add Azure Trusted Signing for Windows.
- Add Tauri updater signing.
- Add updater metadata upload.
- Add release note generation.
- Add tag creation and version sync automation.

## Phase 5: npm Packaging

Do not start npm work until artifact production is reliable.

When ready, design npm packaging around the artifact outputs:

- Wrapper package installs the `opencode` binary.
- Platform binary packages are optional dependencies.
- Package naming can be decided later.
- Trusted publishing via npm OIDC can be added after package contents are verified with `npm pack --dry-run`.

## Implementation Notes

- Keep the fork workflow separate from upstream `publish.yml` to reduce merge conflicts.
- Prefer artifact upload over release upload until build output is stable.
- Use manual `workflow_dispatch` first; add tag triggers later.
- Use the repo's `.github/actions/setup-bun` where possible because it follows `packageManager` from root `package.json`.
- Avoid GitHub App token setup in the first pass; `GITHUB_TOKEN` is sufficient for workflow artifacts and draft releases in the same repo.
- Avoid `script/publish.ts` in early phases because it publishes npm packages, Docker images, Homebrew tap changes, AUR updates, and release finalization.

## First Concrete PR Scope

The first PR should contain only:

- `.github/workflows/fork-release-artifacts.yml`
- Any small helper script needed to package CLI artifacts without publishing

It should not modify npm package names, binary names, desktop signing config, release scripts, or updater config.
