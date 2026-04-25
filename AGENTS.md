- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.

## `actualyze` Fork Release Branch

- `actualyze` is the long-lived release branch for the `rmk40/opencode` fork. Merge upstream `dev` into it as needed; do not recreate/reset it unless explicitly asked.
- The fork release pipeline is intentionally limited to CLI artifacts and optional draft GitHub releases. Do not add npm, Homebrew, AUR, Docker/GHCR, desktop artifacts, signing, notarization, or updater promotion unless explicitly requested.
- The implementation files are `.github/workflows/fork-release-artifacts.yml`, `script/fork-release-artifacts.sh`, the root `package.json` `release:fork` script, and `RELEASE_ARTIFACT_PIPELINE_PLAN.md`.
- The canonical interface is the root package script. CI and manual runs should call `bun run release:fork -- <validate|build|package|release|self-test> ...`; do not call `script/fork-release-artifacts.sh` or `packages/opencode/script/build.ts` directly in docs/workflows.
- Valid versions are constructed from `--upstream-version X.Y.Z` and `--suffix aai.N`, producing `X.Y.Z-aai.N`. The suffix regex is `^aai\.[1-9][0-9]*$`; leading-zero suffixes like `aai.01` are invalid.
- The release channel is always `OPENCODE_CHANNEL=aai`. The script unsets `OPENCODE_BUMP`, `OPENCODE_RELEASE`, and `GH_REPO` before building to avoid upstream version/publish behavior.
- The workflow is guarded for `github.repository == 'rmk40/opencode'`, `github.ref_name == 'actualyze'`, and branch refs (`refs/heads/actualyze`) when GitHub exposes ref metadata.

### Fork Release Commands

```bash
bun run release:fork -- validate --upstream-version 1.14.24 --suffix aai.1
bun run release:fork -- build --upstream-version 1.14.24 --suffix aai.1 --version 1.14.24-aai.1
bun run release:fork -- release --version 1.14.24-aai.1
bun run release:fork -- self-test
```

- `validate` checks repo/branch context and writes `version` / `channel` outputs in GitHub Actions.
- `build` captures `https://models.dev/api.json`, writes a hashed `models.dev-api.<sha256>.json`, sets `MODELS_DEV_API_JSON`, runs the upstream CLI build, smoke-tests Linux x64/baseline and x64 musl/baseline-musl, validates all expected target dirs, normalizes Windows artifacts to `bin/opencode.exe`, writes release metadata, and creates an intra-workflow `opencode-cli-dist.tar`.
- `package` restores `opencode-cli-dist.tar`, validates tar member paths/types before extraction, validates artifact contents, restores executable bits defensively, packages Linux as `.tar.gz`, packages macOS/Windows as `.zip`, includes the models.dev snapshot asset, and writes `SHA256SUMS` with bare filenames.
- `release` requires `GH_TOKEN` and `GITHUB_REPOSITORY`, requires the phase 1 dist tar, verifies metadata version matches the requested version, fails if the release or tag already exists, creates a draft release, uploads binary/model assets first, then uploads `SHA256SUMS` last. It never uses `--clobber`.
- For local package-only debugging, use `FORK_RELEASE_SKIP_CONTEXT_CHECK=1` to bypass repo/branch guards and `FORK_RELEASE_ALLOW_LOCAL_DIST=1` to package an existing `packages/opencode/dist` without the phase 1 tar. Do not use those overrides in CI or for real draft releases.

### Fork Release Operational Notes

- The workflow is manual (`workflow_dispatch`) with inputs `upstream_version`, `suffix`, and `create_release`.
- The build job has read-only contents permissions. The draft release job has `contents: write`, uses `actions/checkout@v4` with `persist-credentials: false`, and exposes `GH_TOKEN` only to the package-script release step.
- The phase 1 artifact handoff is a tar file, not raw directory upload, so executable modes and layout survive across jobs. The metadata artifact must be downloaded to `${RUNNER_TEMP}/fork-release/release-metadata`.
- Release archives intentionally contain the contents of each target's `bin/` directory, not the surrounding target directory or its `package.json`. This matches upstream release asset shape.
- Draft releases must remain draft until manual cross-platform smoke testing is complete. CI only runtime-smoke-tests Linux x64, Linux x64 baseline, Linux x64 musl, and Linux x64 baseline musl.
- If draft creation or asset upload partially fails, delete the draft release and any `v<version>` tag before rerunning. Do not use GitHub's "Re-run failed jobs" button against a partial upload.
- The `aai` updater channel is intentionally not promoted yet. Audit `OPENCODE_CHANNEL` consumers before sharing artifacts outside internal testing.

### Fork Release Validation

- Fast local checks for release-pipeline edits:

```bash
bash -n script/fork-release-artifacts.sh
bun run release:fork -- self-test
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/fork-release-artifacts.yml"); puts "workflow yaml ok"'
bun -e "JSON.parse(await Bun.file('package.json').text()); console.log('package.json ok')"
git diff --check
```

- When changing the workflow/script, run security and code review gates. Pay special attention to workflow input injection, token scope, tar extraction safety, model snapshot hash verification, checksum generation, executable bits, Windows `.exe` normalization, no-clobber release uploads, and metadata path consistency.

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
