- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.

## `actualyze` Fork Release Branch

- `actualyze` is the long-lived release branch for the `rmk40/opencode` fork. Merge upstream `dev` into it as needed; do not recreate/reset it unless explicitly asked.
- The fork release pipeline is intentionally limited to CLI artifacts, optional draft GitHub releases, and optional GitHub Packages npm publishing under `@rmk40`. Do not add npmjs publishing, Homebrew, AUR, Docker/GHCR, desktop artifacts, signing, notarization, or updater promotion unless explicitly requested.

### Fork Maintenance Philosophy

The fork's mission (also stated in `README.md`) is to **dramatically improve the mobile and web UX** of opencode while **mirroring upstream OpenCode** rather than diverging from it. The decisions below operationalize that mission. Apply them to all work going forward unless the user explicitly says otherwise.

- **Stay close to upstream on the core.** The fork carries patches for bugs and key issues that haven't landed upstream yet, plus the mobile/web UX work that motivated the fork. The core (CLI, server, session lifecycle, schemas, plugin API) tracks upstream.
- **No API or schema breaking changes.** Sessions, plugins, and configurations that work against upstream `opencode` must work against this fork.
- **Willing to deviate on UX.** Mobile and web client surfaces are where the fork actively differs from upstream. That's the point of the fork.
- **Targeted, revertable commits.** Every commit going forward should be **scoped to one bug, one feature, or one refactor** — not necessarily one file, but one logical change. The reason: if upstream lands their own fix for the same problem, we **revert ours and take theirs**. We do not try to merge our version with upstream's; we replace ours wholesale. Targeted commits make that revert clean.
  - "One file per commit" is too granular and adds noise. "One bug, one commit" is the rule.
  - When the same bug touches several files, that's still one commit.
  - When two bugs happen to touch the same file, that's two commits.
- **Reference upstream linkage in commit messages.** When a commit addresses something with an open or merged upstream PR/issue, include `Refs upstream PR anomalyco/opencode#NNNNN` (or commit SHA) in the body. When upstream lands their version, future-you greps for that ref to find the fork commit to revert.
- **Lift the idea, not the diff, when porting.** When an upstream PR predates a refactor we already have (e.g. a pre-Effect PR against post-Effect code), translate the intent into our current shape rather than reverting the refactor. Cite the source PR in the commit body either way.
- **Upstream-merge cadence: release-tag-driven.** Merge upstream version tags (`vX.Y.Z`) into `actualyze` as they land. Don't merge arbitrary `origin/dev` HEAD; we want known-good upstream baselines. The merge process is documented in `docs/upstream-merge-process.md`.
- **Upstream version stays in our tag.** Fork tags are `vX.Y.Z-aai.N` where `X.Y.Z` is the upstream baseline we merged from. The `aai.N` suffix resets to `1` whenever the upstream baseline bumps.
- **Conflict resolution defaults during upstream merge.** Files we own (UI mobile/web work, fork-only scripts, fork docs, fork release pipeline): keep ours. Files upstream owns (CLI, server, plugin core, schemas): take theirs. Decision matrix is in `docs/upstream-merge-process.md`. When the matrix doesn't cover a case, default to **taking upstream** unless our divergence was explicitly intentional and documented.
- **Contributions welcome under the same criteria.** External PRs that fix bugs upstream hasn't gotten to yet, or improve mobile/web UX while preserving upstream compatibility, are in scope. PRs that break upstream API/schema compatibility are not.
- The implementation files are `.github/workflows/fork-release-artifacts.yml`, `script/fork-release-artifacts.sh`, the root `package.json` `release:fork` script, and `RELEASE_ARTIFACT_PIPELINE_PLAN.md`.
- The canonical interface is the root package script. CI and manual runs should call `bun run release:fork -- <validate|build|package|release|npm-package|npm-publish|self-test> ...`; do not call `script/fork-release-artifacts.sh` or `packages/opencode/script/build.ts` directly in docs/workflows.
- Valid versions are constructed from `--upstream-version X.Y.Z` and `--suffix aai.N`, producing `X.Y.Z-aai.N`. The suffix regex is `^aai\.[1-9][0-9]*$`; leading-zero suffixes like `aai.01` are invalid.
- Normal releases are tag-driven. Push a tag matching `vX.Y.Z-aai.N` from a commit reachable from `actualyze`; CI derives `upstream_version`, `suffix`, and `version` from the tag, builds artifacts, creates a published GitHub release, and publishes GitHub Packages with dist-tag `aai`.
- The release channel is always `OPENCODE_CHANNEL=aai`. The script unsets `OPENCODE_BUMP`, `OPENCODE_RELEASE`, and `GH_REPO` before building to avoid upstream version/publish behavior.
- The fork build also exports `OPENCODE_REPO=rmk40/opencode`, `OPENCODE_NPM_PACKAGE=@rmk40/opencode`, and `OPENCODE_NPM_REGISTRY=https://npm.pkg.github.com` before invoking `build.ts` so that `opencode upgrade` queries the fork rather than upstream npmjs.
- The workflow is guarded for `github.repository == 'rmk40/opencode'`. Manual `workflow_dispatch` runs must originate from the `actualyze` branch; tag-triggered runs must use a tag matching `vX.Y.Z-aai.N` whose commit is reachable from `actualyze`.

### Fork Release Commands

```bash
bun run release:fork -- validate --upstream-version 1.14.24 --suffix aai.1
bun run release:fork -- build --upstream-version 1.14.24 --suffix aai.1 --version 1.14.24-aai.1
bun run release:fork -- release --version 1.14.24-aai.1
bun run release:fork -- npm-package --version 1.14.24-aai.1
bun run release:fork -- npm-publish --version 1.14.24-aai.1
bun run release:fork -- self-test
```

Normal release command:

```bash
git tag v1.14.24-aai.2
git push fork v1.14.24-aai.2
```

- `validate` checks repo/branch context and writes `version` / `channel` outputs in GitHub Actions.
- `build` captures `https://models.dev/api.json`, writes a hashed `models.dev-api.<sha256>.json`, sets `MODELS_DEV_API_JSON`, runs the upstream CLI build, smoke-tests Linux x64/baseline and x64 musl/baseline-musl, validates all expected target dirs, normalizes Windows artifacts to `bin/opencode.exe`, writes release metadata, and creates an intra-workflow `opencode-cli-dist.tar`. The Alpine musl smoke tests install `libstdc++` and `libgcc`; bare Alpine does not include `libstdc++.so.6` or `libgcc_s.so.1`.
- `package` restores `opencode-cli-dist.tar`, validates tar member paths/types before extraction, validates artifact contents, restores executable bits defensively, packages Linux as `.tar.gz`, packages macOS/Windows as `.zip`, includes the models.dev snapshot asset, and writes `SHA256SUMS` with bare filenames.
- `release` requires `GH_TOKEN` and `GITHUB_REPOSITORY`, requires the phase 1 dist tar, verifies metadata version matches the requested version, fails if the release already exists, and uploads binary/model assets first, then `SHA256SUMS` last. Manual `workflow_dispatch` runs fail if `v<version>` tag already exists and create a draft release targeting the workflow commit. Tag-triggered runs require the tag commit to be reachable from `actualyze` and create a published prerelease anchored to the triggering tag. `release` never uses `--clobber` and always marks the release `--prerelease`.
- `npm-package` restores `opencode-cli-dist.tar` and stages scoped GitHub Packages npm tarballs in `${RUNNER_TEMP}/fork-release/npm-tarballs`: wrapper `@rmk40/opencode` plus platform packages like `@rmk40/opencode-darwin-arm64`.
- `npm-publish` requires `NODE_AUTH_TOKEN`, preflights every `@rmk40/*@<version>` package against `https://npm.pkg.github.com`, publishes platform packages first, publishes `@rmk40/opencode` last, and applies the `aai` dist-tag.
- For local package-only debugging, use `FORK_RELEASE_SKIP_CONTEXT_CHECK=1` to bypass repo/branch guards and `FORK_RELEASE_ALLOW_LOCAL_DIST=1` to package an existing `packages/opencode/dist` without the phase 1 tar. Do not use those overrides in CI or for real draft releases.
- Local `npm-publish` debugging also needs npm configured for `@rmk40:registry=https://npm.pkg.github.com`; CI gets this from `actions/setup-node`.

### Fork Release Operational Notes

- The workflow runs automatically on `v*-aai.*` tag pushes and also supports manual `workflow_dispatch` with inputs `upstream_version`, `suffix`, `create_release`, and `publish_npm`. Tag pushes publish the GitHub release and GitHub Packages automatically; manual runs keep release/npm publishing behind explicit booleans.
- The build job has read-only contents permissions. The draft release job has `contents: write`, uses `actions/checkout@v4` with `persist-credentials: false`, and exposes `GH_TOKEN` only to the package-script release step.
- The phase 1 artifact handoff is a tar file, not raw directory upload, so executable modes and layout survive across jobs. The metadata artifact must be downloaded to `${RUNNER_TEMP}/fork-release/release-metadata`.
- Release archives intentionally contain the contents of each target's `bin/` directory, not the surrounding target directory or its `package.json`. This matches upstream release asset shape.
- Draft releases (manual `create_release` path) must remain draft until manual cross-platform smoke testing is complete. Tag-triggered releases are intentionally published as prereleases after build-time verification only; CI only runtime-smoke-tests Linux x64, Linux x64 baseline, Linux x64 musl, and Linux x64 baseline musl.
- If draft creation or asset upload partially fails, delete the draft release and any `v<version>` tag before rerunning. Do not use GitHub's "Re-run failed jobs" button against a partial upload.
- The `aai` updater channel is intentionally not promoted yet. Audit `OPENCODE_CHANNEL` consumers before sharing artifacts outside internal testing.
- GitHub Packages install command is `npm install -g @rmk40/opencode@aai --registry=https://npm.pkg.github.com`. Consumers normally need a GitHub token in `.npmrc` for `npm.pkg.github.com`.
- GitHub Packages publishing is fork-local and private/internal by default. Keep package names scoped to `@rmk40` until explicitly moved to another GitHub org scope; do not publish these packages to npmjs unless explicitly requested.
- If GitHub Packages publishing partially fails after some platform packages are published, do not rerun with the same version. Package versions are immutable; bump the suffix, rebuild from CI, and publish a new version.

### Fork Release Validation

- Fast local checks for release-pipeline edits:

```bash
bash -n script/fork-release-artifacts.sh
bun run release:fork -- self-test
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/fork-release-artifacts.yml"); puts "workflow yaml ok"'
bun -e "JSON.parse(await Bun.file('package.json').text()); console.log('package.json ok')"
git diff --check
```

- When changing the workflow/script, run security and code review gates. Pay special attention to workflow input injection, token scope, tar extraction safety, GitHub Packages package scope, npm publish preflights, dist-tag selection, model snapshot hash verification, checksum generation, executable bits, Windows `.exe` normalization, no-clobber release uploads, and metadata path consistency.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly.
