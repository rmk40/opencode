#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGET_REPO="rmk40/opencode"
TARGET_BRANCH="actualyze"
CHANNEL="aai"
NPM_SCOPE="@rmk40"
NPM_REGISTRY="https://npm.pkg.github.com"
WORKDIR="${FORK_RELEASE_WORKDIR:-${RUNNER_TEMP:-$ROOT/.scripts}/fork-release}"
DIST_DIR="${FORK_RELEASE_DIST_DIR:-packages/opencode/dist}"
METADATA_DIR="$WORKDIR/release-metadata"
ASSET_DIR="$WORKDIR/release-assets"
DIST_BUNDLE="$WORKDIR/opencode-cli-dist.tar"
NPM_DIR="$WORKDIR/npm-packages"
NPM_TARBALL_DIR="$WORKDIR/npm-tarballs"

EXPECTED_ARTIFACTS=(
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
)

COMMAND="${1:-}"
if [ $# -gt 0 ]; then shift; fi
if [ "$COMMAND" = "--" ]; then
  COMMAND="${1:-}"
  if [ $# -gt 0 ]; then shift; fi
fi

UPSTREAM_VERSION="${UPSTREAM_VERSION:-}"
SUFFIX="${SUFFIX:-}"
VERSION="${VERSION:-}"

usage() {
  printf '%s\n' "usage: bun run release:fork -- <validate|build|package|release|npm-package|npm-publish|self-test> [--upstream-version X.Y.Z] [--suffix aai.N] [--version X.Y.Z-aai.N]"
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --upstream-version)
      [ -n "${2:-}" ] || die "--upstream-version requires a value"
      UPSTREAM_VERSION="${2:-}"
      shift 2
      ;;
    --upstream-version=*)
      UPSTREAM_VERSION="${1#--upstream-version=}"
      shift
      ;;
    --suffix)
      [ -n "${2:-}" ] || die "--suffix requires a value"
      SUFFIX="${2:-}"
      shift 2
      ;;
    --suffix=*)
      SUFFIX="${1#--suffix=}"
      shift
      ;;
    --version)
      [ -n "${2:-}" ] || die "--version requires a value"
      VERSION="${2:-}"
      shift 2
      ;;
    --version=*)
      VERSION="${1#--version=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

repo_name() {
  printf '%s\n' "${GITHUB_REPOSITORY:-$TARGET_REPO}"
}

branch_name() {
  if [ -n "${GITHUB_REF_NAME:-}" ]; then
    printf '%s\n' "$GITHUB_REF_NAME"
    return
  fi
  git branch --show-current
}

sha_value() {
  if [ -n "${GITHUB_SHA:-}" ]; then
    printf '%s\n' "$GITHUB_SHA"
    return
  fi
  git rev-parse HEAD
}

actor_name() {
  if [ -n "${GITHUB_ACTOR:-}" ]; then
    printf '%s\n' "$GITHUB_ACTOR"
    return
  fi
  whoami
}

dist_mount_path() {
  case "$DIST_DIR" in
    /*) printf '%s\n' "$DIST_DIR" ;;
    *) printf '%s\n' "$ROOT/$DIST_DIR" ;;
  esac
}

run_url() {
  if [ -n "${GITHUB_SERVER_URL:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ] && [ -n "${GITHUB_RUN_ID:-}" ]; then
    printf '%s\n' "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
    return
  fi
  printf '%s\n' "manual-local-run"
}

validate_context() {
  [ "${FORK_RELEASE_SKIP_CONTEXT_CHECK:-}" = "1" ] && return 0
  [ "$(repo_name)" = "$TARGET_REPO" ] || die "This workflow only runs in $TARGET_REPO"
  if [ -n "${GITHUB_REF_TYPE:-}" ]; then
    [ "$GITHUB_REF_TYPE" = "branch" ] || die "This workflow must run from a branch ref"
  fi
  if [ -n "${GITHUB_REF:-}" ]; then
    [ "$GITHUB_REF" = "refs/heads/$TARGET_BRANCH" ] || die "This workflow must run from refs/heads/$TARGET_BRANCH"
  fi
  [ "$(branch_name)" = "$TARGET_BRANCH" ] || die "This workflow must run from the $TARGET_BRANCH branch"
}

version_for() {
  [ -n "$UPSTREAM_VERSION" ] || die "--upstream-version is required"
  [ -n "$SUFFIX" ] || die "--suffix is required"
  [[ "$UPSTREAM_VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || die "upstream_version must match X.Y.Z without leading zeroes"
  [[ "$SUFFIX" =~ ^aai\.[1-9][0-9]*$ ]] || die "suffix must match aai.N, for example aai.1"
  printf '%s-%s\n' "$UPSTREAM_VERSION" "$SUFFIX"
}

validate_version() {
  local expected
  expected="$(version_for)"
  [ -n "$VERSION" ] || die "--version is required"
  [ "$VERSION" = "$expected" ] || die "version must be $expected, got $VERSION"
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-aai\.[1-9][0-9]*$ ]] || die "version is not a valid actualyze prerelease: $VERSION"
}

write_output() {
  [ -n "${GITHUB_OUTPUT:-}" ] || return 0
  printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
}

metadata_value() {
  local value
  value="$(jq -r ".$1 // empty" "$METADATA_DIR/metadata.json")"
  [ -n "$value" ] || die "metadata.$1 is missing"
  printf '%s\n' "$value"
}

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
    return
  fi
  shasum -a 256 "$1" | cut -d ' ' -f 1
}

npm_package_name() {
  printf '%s/%s\n' "$NPM_SCOPE" "$1"
}

npm_safe_filename() {
  printf '%s\n' "${1#@}" | tr '/' '-'
}

validate_artifacts() {
  mkdir -p "$WORKDIR"
  printf '%s\n' "${EXPECTED_ARTIFACTS[@]}" | sort > "$WORKDIR/expected-artifacts.txt"
  find "$DIST_DIR" -maxdepth 1 -mindepth 1 -type d -name 'opencode-*' -exec basename {} \; | sort > "$WORKDIR/artifacts.txt"
  if ! diff -u "$WORKDIR/expected-artifacts.txt" "$WORKDIR/artifacts.txt"; then
    die "artifact list did not match expected targets"
  fi
}

normalize_windows_artifacts() {
  local bin_dir
  for bin_dir in "$DIST_DIR"/opencode-windows-*/bin; do
    [ -d "$bin_dir" ] || continue
    if [ ! -f "$bin_dir/opencode.exe" ] && [ -f "$bin_dir/opencode" ]; then
      mv "$bin_dir/opencode" "$bin_dir/opencode.exe"
    fi
    [ -f "$bin_dir/opencode.exe" ] || die "$(basename "$(dirname "$bin_dir")") is missing bin/opencode.exe"
  done
}

validate_artifact_contents() {
  local name bin_dir
  while IFS= read -r dir; do
    name="$(basename "$dir")"
    bin_dir="$dir/bin"
    case "$name" in
      opencode-windows-*)
        [ -f "$bin_dir/opencode.exe" ] || die "$name is missing bin/opencode.exe"
        ;;
      *)
        [ -f "$bin_dir/opencode" ] || die "$name is missing bin/opencode"
        ;;
    esac
  done < <(find "$DIST_DIR" -maxdepth 1 -mindepth 1 -type d -name 'opencode-*' | sort)
}

validate_cmd() {
  validate_context
  VERSION="$(version_for)"
  write_output version "$VERSION"
  write_output channel "$CHANNEL"
  printf 'version=%s\n' "$VERSION"
  printf 'channel=%s\n' "$CHANNEL"
}

fetch_models_snapshot() {
  mkdir -p "$WORKDIR"
  curl --retry 3 --retry-delay 5 --retry-all-errors -fsSL https://models.dev/api.json -o "$WORKDIR/models.dev-api.json"
  MODELS_SNAPSHOT_SHA256="$(hash_file "$WORKDIR/models.dev-api.json")"
  MODELS_SNAPSHOT_ASSET="models.dev-api.${MODELS_SNAPSHOT_SHA256}.json"
  cp "$WORKDIR/models.dev-api.json" "$WORKDIR/$MODELS_SNAPSHOT_ASSET"
}

build_cmd() {
  validate_context
  validate_version
  fetch_models_snapshot

  unset OPENCODE_BUMP OPENCODE_RELEASE GH_REPO
  export OPENCODE_VERSION="$VERSION"
  export OPENCODE_CHANNEL="$CHANNEL"
  export MODELS_DEV_API_JSON="$WORKDIR/models.dev-api.json"

  [ "$OPENCODE_VERSION" = "$VERSION" ] || die "OPENCODE_VERSION was not set"
  [ "$OPENCODE_CHANNEL" = "$CHANNEL" ] || die "OPENCODE_CHANNEL was not set"
  [ -z "${OPENCODE_BUMP:-}" ] || die "OPENCODE_BUMP must be unset"
  [ -z "${OPENCODE_RELEASE:-}" ] || die "OPENCODE_RELEASE must be unset"

  ./packages/opencode/script/build.ts 2>&1 | tee "$WORKDIR/build.log"

  awk '
    /^opencode script / {
      capture = 1
      sub(/^opencode script /, "")
      print
      next
    }
    capture {
      print
      if ($0 == "}") exit
    }
  ' "$WORKDIR/build.log" > "$WORKDIR/opencode-script.json"
  jq -e --arg version "$VERSION" '.channel == "aai" and .version == $version' "$WORKDIR/opencode-script.json" >/dev/null

  if [ ! -d packages/app/dist ] || ! find packages/app/dist -type f -print -quit | grep -q .; then
    die "packages/app/dist is empty after build"
  fi

  "$DIST_DIR/opencode-linux-x64/bin/opencode" --version | grep -F "$VERSION"
  "$DIST_DIR/opencode-linux-x64-baseline/bin/opencode" --version | grep -F "$VERSION"

  docker --version
  docker run --rm \
    -e HOME=/tmp \
    -e XDG_CONFIG_HOME=/tmp/.config \
    -e XDG_DATA_HOME=/tmp/.local/share \
    -v "$(dist_mount_path)/opencode-linux-x64-musl/bin:/opt/opencode:ro" \
    alpine:3.20 \
    sh -lc 'apk add --no-cache libstdc++ libgcc >/dev/null && /opt/opencode/opencode --version' | grep -F "$VERSION"
  docker run --rm \
    -e HOME=/tmp \
    -e XDG_CONFIG_HOME=/tmp/.config \
    -e XDG_DATA_HOME=/tmp/.local/share \
    -v "$(dist_mount_path)/opencode-linux-x64-baseline-musl/bin:/opt/opencode:ro" \
    alpine:3.20 \
    sh -lc 'apk add --no-cache libstdc++ libgcc >/dev/null && /opt/opencode/opencode --version' | grep -F "$VERSION"

  mkdir -p "$METADATA_DIR"
  validate_artifacts
  normalize_windows_artifacts
  validate_artifact_contents
  cp "$WORKDIR/artifacts.txt" "$METADATA_DIR/artifacts.txt"
  printf '%s\n' "${RAW_INPUTS:-"{}"}" | jq . > "$METADATA_DIR/inputs.json"
  cp "$WORKDIR/$MODELS_SNAPSHOT_ASSET" "$METADATA_DIR/$MODELS_SNAPSHOT_ASSET"
  jq -n \
    --arg upstream_version "$UPSTREAM_VERSION" \
    --arg suffix "$SUFFIX" \
    --arg version "$VERSION" \
    --arg channel "$CHANNEL" \
    --arg branch "$(branch_name)" \
    --arg sha "$(sha_value)" \
    --arg run_url "$(run_url)" \
    --arg actor "$(actor_name)" \
    --arg models_snapshot_sha256 "$MODELS_SNAPSHOT_SHA256" \
    --arg models_snapshot_asset "$MODELS_SNAPSHOT_ASSET" \
    '{upstream_version:$upstream_version,suffix:$suffix,version:$version,channel:$channel,branch:$branch,sha:$sha,run_url:$run_url,actor:$actor,models_snapshot_sha256:$models_snapshot_sha256,models_snapshot_asset:$models_snapshot_asset}' \
    > "$METADATA_DIR/metadata.json"

  rm -f "$DIST_BUNDLE"
  (cd "$DIST_DIR" && tar -cf "$DIST_BUNDLE" opencode-*)

  write_output models_snapshot_sha256 "$MODELS_SNAPSHOT_SHA256"
  write_output models_snapshot_asset "$MODELS_SNAPSHOT_ASSET"
}

restore_dist_bundle() {
  [ -f "$DIST_BUNDLE" ] || return 0
  local bundle_abs dist_parent_abs dist_abs tmp
  bundle_abs="$(cd "$(dirname "$DIST_BUNDLE")" && pwd)/$(basename "$DIST_BUNDLE")"
  mkdir -p "$(dirname "$DIST_DIR")"
  dist_parent_abs="$(cd "$(dirname "$DIST_DIR")" && pwd)"
  dist_abs="$dist_parent_abs/$(basename "$DIST_DIR")"
  case "$dist_abs" in
    "$ROOT"/*|"$WORKDIR"/*) ;;
    *) die "DIST_DIR must be inside the repository or release workdir" ;;
  esac
  case "$bundle_abs" in
    "$dist_abs"/*) die "dist bundle must not be inside DIST_DIR" ;;
  esac
  while IFS= read -r member; do
    case "$member" in
      /*|*../*|../*|*..|.) die "unsafe dist bundle member: $member" ;;
      opencode-*|opencode-*/*) ;;
      *) die "unexpected dist bundle member: $member" ;;
    esac
  done < <(tar -tf "$DIST_BUNDLE")
  while IFS= read -r line; do
    case "${line:0:1}" in
      d|-) ;;
      *) die "unsafe dist bundle entry type: $line" ;;
    esac
  done < <(tar -tvf "$DIST_BUNDLE")
  tmp="$dist_parent_abs/.dist-extract.$$"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  tar -xf "$DIST_BUNDLE" -C "$tmp"
  rm -rf "$DIST_DIR"
  mv "$tmp" "$DIST_DIR"
}

check_release_available() {
  local release_status tag_status
  mkdir -p "$WORKDIR"
  [ -n "${GH_TOKEN:-}" ] || die "GH_TOKEN is required"
  release_status="$(curl -sS -o "$WORKDIR/release.json" -w "%{http_code}" \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$(repo_name)/releases/tags/v${VERSION}")"
  case "$release_status" in
    200) die "Release v${VERSION} already exists" ;;
    404) ;;
    401|403)
      cat "$WORKDIR/release.json" >&2
      die "Release preflight is unauthorized; check contents:write permissions and GH_TOKEN"
      ;;
    *)
      cat "$WORKDIR/release.json" >&2
      die "Release preflight failed with HTTP $release_status"
      ;;
  esac

  tag_status="$(curl -sS -o "$WORKDIR/tag.json" -w "%{http_code}" \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$(repo_name)/git/ref/tags/v${VERSION}")"
  case "$tag_status" in
    200) die "Tag v${VERSION} already exists" ;;
    404) ;;
    401|403)
      cat "$WORKDIR/tag.json" >&2
      die "Tag preflight is unauthorized; check contents:write permissions and GH_TOKEN"
      ;;
    *)
      cat "$WORKDIR/tag.json" >&2
      die "Tag preflight failed with HTTP $tag_status"
      ;;
  esac
}

package_cmd() {
  local metadata_version snapshot_asset snapshot_hash actual_snapshot_hash
  validate_context
  if [ ! -f "$DIST_BUNDLE" ] && [ "${FORK_RELEASE_ALLOW_LOCAL_DIST:-}" != "1" ]; then
    die "$DIST_BUNDLE is required for package; set FORK_RELEASE_ALLOW_LOCAL_DIST=1 to package an existing local dist"
  fi
  restore_dist_bundle
  [ -f "$METADATA_DIR/metadata.json" ] || die "$METADATA_DIR/metadata.json is missing"
  metadata_version="$(metadata_value version)"
  if [ -n "$VERSION" ] && [ "$VERSION" != "$metadata_version" ]; then
    die "requested version $VERSION does not match metadata version $metadata_version"
  fi
  VERSION="$metadata_version"
  UPSTREAM_VERSION="$(metadata_value upstream_version)"
  SUFFIX="$(metadata_value suffix)"
  validate_version
  validate_artifacts
  normalize_windows_artifacts
  validate_artifact_contents

  snapshot_asset="$(metadata_value models_snapshot_asset)"
  snapshot_hash="$(metadata_value models_snapshot_sha256)"
  [ -f "$METADATA_DIR/$snapshot_asset" ] || die "$METADATA_DIR/$snapshot_asset is missing"
  actual_snapshot_hash="$(hash_file "$METADATA_DIR/$snapshot_asset")"
  [ "$actual_snapshot_hash" = "$snapshot_hash" ] || die "models.dev snapshot hash mismatch"

  rm -rf "$ASSET_DIR"
  mkdir -p "$ASSET_DIR"
  find "$DIST_DIR" -maxdepth 2 -type d \( -path '*/opencode-darwin-*/bin' -o -path '*/opencode-linux-*/bin' \) -exec chmod 755 {} +
  for binary in "$DIST_DIR"/opencode-darwin-*/bin/opencode "$DIST_DIR"/opencode-linux-*/bin/opencode; do
    [ -f "$binary" ] || continue
    chmod 755 "$binary"
  done
  validate_artifact_contents

  while IFS= read -r dir; do
    artifact="$(basename "$dir")"
    bin_dir="$dir/bin"
    case "$artifact" in
      opencode-linux-*)
        (cd "$bin_dir" && tar -czf "$ASSET_DIR/${artifact}.tar.gz" *)
        ;;
      opencode-darwin-*)
        (cd "$bin_dir" && zip -r "$ASSET_DIR/${artifact}.zip" *)
        ;;
      opencode-windows-*)
        (cd "$bin_dir" && zip -r "$ASSET_DIR/${artifact}.zip" *)
        ;;
      *)
        die "Unexpected artifact directory: $artifact"
        ;;
    esac
  done < <(find "$DIST_DIR" -maxdepth 1 -mindepth 1 -type d -name 'opencode-*' | sort)

  cp "$METADATA_DIR/$snapshot_asset" "$ASSET_DIR/$snapshot_asset"
  find "$ASSET_DIR" -maxdepth 1 -type f \( -name 'opencode-*.zip' -o -name 'opencode-*.tar.gz' -o -name 'models.dev-api.*.json' \) -exec basename {} \; | sort | while IFS= read -r file; do
    printf '%s  %s\n' "$(hash_file "$ASSET_DIR/$file")" "$file"
  done > "$ASSET_DIR/SHA256SUMS"
}

npm_stage_packages() {
  validate_context
  if [ ! -f "$DIST_BUNDLE" ] && [ "${FORK_RELEASE_ALLOW_LOCAL_DIST:-}" != "1" ]; then
    die "$DIST_BUNDLE is required for npm-package; set FORK_RELEASE_ALLOW_LOCAL_DIST=1 to package an existing local dist"
  fi
  restore_dist_bundle
  [ -f "$METADATA_DIR/metadata.json" ] || die "$METADATA_DIR/metadata.json is missing"
  local metadata_version
  metadata_version="$(metadata_value version)"
  if [ -n "$VERSION" ] && [ "$VERSION" != "$metadata_version" ]; then
    die "requested version $VERSION does not match metadata version $metadata_version"
  fi
  VERSION="$metadata_version"
  UPSTREAM_VERSION="$(metadata_value upstream_version)"
  SUFFIX="$(metadata_value suffix)"
  validate_version
  validate_artifacts
  normalize_windows_artifacts
  validate_artifact_contents

  rm -rf "$NPM_DIR" "$NPM_TARBALL_DIR"
  mkdir -p "$NPM_DIR" "$NPM_TARBALL_DIR"

  local optional_deps package_dirs artifact package_name package_dir src_pkg os_value cpu_value binary_name
  optional_deps="{}"
  package_dirs=()
  while IFS= read -r dir; do
    artifact="$(basename "$dir")"
    package_name="$(npm_package_name "$artifact")"
    package_dir="$NPM_DIR/$artifact"
    src_pkg="$dir/package.json"
    [ -f "$src_pkg" ] || die "$artifact is missing package.json"
    os_value="$(jq -r '.os[0] // empty' "$src_pkg")"
    cpu_value="$(jq -r '.cpu[0] // empty' "$src_pkg")"
    [ -n "$os_value" ] || die "$artifact package.json is missing os"
    [ -n "$cpu_value" ] || die "$artifact package.json is missing cpu"
    mkdir -p "$package_dir/bin"
    case "$artifact" in
      opencode-windows-*) binary_name="opencode.exe" ;;
      *) binary_name="opencode" ;;
    esac
    cp "$dir/bin/$binary_name" "$package_dir/bin/$binary_name"
    chmod 755 "$package_dir/bin/$binary_name" 2>/dev/null || true
    cp LICENSE "$package_dir/LICENSE"
    jq -n \
      --arg name "$package_name" \
      --arg version "$VERSION" \
      --arg os "$os_value" \
      --arg cpu "$cpu_value" \
      --arg registry "$NPM_REGISTRY" \
      '{name:$name,version:$version,license:"MIT",os:[$os],cpu:[$cpu],repository:{type:"git",url:"git+https://github.com/rmk40/opencode.git"},publishConfig:{registry:$registry}}' \
      > "$package_dir/package.json"
    optional_deps="$(printf '%s\n' "$optional_deps" | jq --arg name "$package_name" --arg version "$VERSION" '. + {($name): $version}')"
    package_dirs+=("$package_dir")
  done < <(find "$DIST_DIR" -maxdepth 1 -mindepth 1 -type d -name 'opencode-*' | sort)

  package_name="$(npm_package_name opencode)"
  package_dir="$NPM_DIR/opencode"
  mkdir -p "$package_dir/bin"
  cp packages/opencode/bin/opencode "$package_dir/bin/opencode"
  cp packages/opencode/script/postinstall.mjs "$package_dir/postinstall.mjs"
  cp LICENSE "$package_dir/LICENSE"
  chmod 755 "$package_dir/bin/opencode"
  jq -n \
    --arg name "$package_name" \
    --arg version "$VERSION" \
    --arg registry "$NPM_REGISTRY" \
    --argjson optionalDependencies "$optional_deps" \
    '{name:$name,version:$version,license:"MIT",bin:{opencode:"./bin/opencode"},scripts:{postinstall:"node ./postinstall.mjs"},optionalDependencies:$optionalDependencies,repository:{type:"git",url:"git+https://github.com/rmk40/opencode.git"},publishConfig:{registry:$registry}}' \
    > "$package_dir/package.json"
  package_dirs+=("$package_dir")

  rm -f "$WORKDIR/npm-packages.txt"
  for package_dir in "${package_dirs[@]}"; do
    npm pack "$package_dir" --dry-run --json --ignore-scripts --registry "$NPM_REGISTRY" > "$WORKDIR/$(basename "$package_dir")-pack-dry-run.json"
    npm pack "$package_dir" --pack-destination "$NPM_TARBALL_DIR" --ignore-scripts --registry "$NPM_REGISTRY" >/dev/null
    jq -r '.name + "@" + .version' "$package_dir/package.json" >> "$WORKDIR/npm-packages.txt"
  done
}

npm_package_exists() {
  local package_name package_version log_file
  package_name="$1"
  package_version="$2"
  log_file="$WORKDIR/npm-view-$(npm_safe_filename "$package_name")-$package_version.log"
  if npm view "$package_name@$package_version" version --registry "$NPM_REGISTRY" > "$log_file" 2>&1; then
    return 0
  fi
  if grep -Eq 'E404|404 Not Found|ETARGET|notarget|No matching version found' "$log_file"; then
    return 1
  fi
  cat "$log_file" >&2
  die "npm preflight failed for $package_name@$package_version"
}

npm_publish_cmd() {
  validate_context
  [ -n "${NODE_AUTH_TOKEN:-}" ] || die "NODE_AUTH_TOKEN is required for GitHub Packages publish"
  npm_stage_packages

  local package package_name package_version tarball
  while IFS= read -r package; do
    package_name="${package%@*}"
    package_version="${package##*@}"
    if npm_package_exists "$package_name" "$package_version"; then
      die "$package_name@$package_version already exists in $NPM_REGISTRY"
    fi
  done < "$WORKDIR/npm-packages.txt"

  local wrapper_tarball
  wrapper_tarball="$NPM_TARBALL_DIR/$(npm_safe_filename "$(npm_package_name opencode)")-$VERSION.tgz"
  [ -f "$wrapper_tarball" ] || die "wrapper tarball is missing: $wrapper_tarball"
  find "$NPM_TARBALL_DIR" -maxdepth 1 -type f -name '*.tgz' | sort | while IFS= read -r tarball; do
    [ "$tarball" = "$wrapper_tarball" ] && continue
    npm publish "$tarball" --ignore-scripts --registry "$NPM_REGISTRY" --tag "$CHANNEL"
  done

  npm publish "$wrapper_tarball" --ignore-scripts --registry "$NPM_REGISTRY" --tag "$CHANNEL"

  npm view "$(npm_package_name opencode)@$CHANNEL" version --registry "$NPM_REGISTRY" | grep -F "$VERSION"
  npm view "$(npm_package_name opencode)@$VERSION" optionalDependencies --json --registry "$NPM_REGISTRY" | jq -e 'length > 0' >/dev/null
}

release_notes() {
  {
    printf '%s\n\n' "## Actualyze Release"
    printf '%s\n' "- Upstream version: $(metadata_value upstream_version)"
    printf '%s\n' "- Suffix: $(metadata_value suffix)"
    printf '%s\n' "- Final version: $(metadata_value version)"
    printf '%s\n' "- Channel: $(metadata_value channel)"
    printf '%s\n' "- Branch: $(metadata_value branch)"
    printf '%s\n' "- Commit: $(metadata_value sha)"
    printf '%s\n' "- Workflow run: $(metadata_value run_url)"
    printf '%s\n' "- Actor: $(metadata_value actor)"
    printf '%s\n' "- models.dev snapshot SHA256: $(metadata_value models_snapshot_sha256)"
    printf '%s\n\n' "- models.dev snapshot asset: $(metadata_value models_snapshot_asset)"
    printf '%s\n\n' "## Verification"
    printf '%s\n' "- Linux x64 and Linux x64 baseline smoke-tested with opencode --version."
    printf '%s\n' "- Linux x64 musl and Linux x64 baseline musl smoke-tested in Alpine."
    printf '%s\n' "- macOS, Windows, Linux arm64, and other non-native artifacts are build-verified only."
    printf '%s\n\n' "- Keep this release as draft until manual cross-platform smoke testing is complete."
    printf '%s\n\n' "## Workflow Inputs"
    printf '%s\n' '```json'
    cat "$METADATA_DIR/inputs.json"
    printf '%s\n\n' '```'
    printf '%s\n\n' "## Checksums"
    printf '%s\n' '```text'
    cat "$ASSET_DIR/SHA256SUMS"
    printf '%s\n' '```'
  } > "$WORKDIR/release-notes.md"
}

release_cmd() {
  validate_context
  [ -n "${GITHUB_REPOSITORY:-}" ] || die "GITHUB_REPOSITORY is required for release"
  [ -n "${GH_TOKEN:-}" ] || die "GH_TOKEN is required"
  if [ -n "${GITHUB_TOKEN:-}" ] && [ "$GITHUB_TOKEN" != "${GH_TOKEN:-}" ]; then
    die "GITHUB_TOKEN conflicts with GH_TOKEN"
  fi
  metadata_version="$(metadata_value version)"
  if [ -n "$VERSION" ] && [ "$VERSION" != "$metadata_version" ]; then
    die "requested version $VERSION does not match metadata version $metadata_version"
  fi
  VERSION="$metadata_version"
  UPSTREAM_VERSION="$(metadata_value upstream_version)"
  SUFFIX="$(metadata_value suffix)"
  validate_version
  check_release_available
  [ -f "$DIST_BUNDLE" ] || die "$DIST_BUNDLE is required for release; download the phase 1 dist artifact first"
  package_cmd
  release_notes

  gh release create "v${VERSION}" \
    --draft \
    --target "$(sha_value)" \
    --title "OpenCode ${VERSION}" \
    --notes-file "$WORKDIR/release-notes.md" \
    --repo "$(repo_name)"

  gh release upload "v${VERSION}" \
    "$ASSET_DIR"/opencode-*.zip \
    "$ASSET_DIR"/opencode-*.tar.gz \
    "$ASSET_DIR"/models.dev-api.*.json \
    --repo "$(repo_name)"

  gh release upload "v${VERSION}" "$ASSET_DIR/SHA256SUMS" --repo "$(repo_name)"
}

self_test_cmd() {
  local tmp output_file
  mkdir -p "${RUNNER_TEMP:-$ROOT/.scripts}"
  tmp="$(mktemp -d "${RUNNER_TEMP:-$ROOT/.scripts}/fork-release-test.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  output_file="$tmp/github-output.txt"

  mkdir -p "$tmp/dist" "$tmp/work/release-metadata"
  printf '%s\n' "${EXPECTED_ARTIFACTS[@]}" | while IFS= read -r artifact; do
    mkdir -p "$tmp/dist/$artifact/bin"
    case "$artifact" in
      opencode-windows-*)
        printf 'fake windows binary\n' > "$tmp/dist/$artifact/bin/opencode.exe"
        os_value="win32"
        ;;
      opencode-darwin-*)
        printf '#!/usr/bin/env bash\nprintf '\''opencode 1.2.3-aai.4\\n'\''\n' > "$tmp/dist/$artifact/bin/opencode"
        os_value="darwin"
        ;;
      *)
        printf '#!/usr/bin/env bash\nprintf '\''opencode 1.2.3-aai.4\\n'\''\n' > "$tmp/dist/$artifact/bin/opencode"
        os_value="linux"
        ;;
    esac
    case "$artifact" in
      *-arm64*) cpu_value="arm64" ;;
      *) cpu_value="x64" ;;
    esac
    jq -n --arg name "$artifact" --arg version 1.2.3-aai.4 --arg os "$os_value" --arg cpu "$cpu_value" '{name:$name,version:$version,os:[$os],cpu:[$cpu]}' > "$tmp/dist/$artifact/package.json"
  done
  chmod 755 "$tmp"/dist/opencode-{darwin,linux}-*/bin/opencode

  GITHUB_REPOSITORY="$TARGET_REPO" \
  GITHUB_REF_NAME="$TARGET_BRANCH" \
  GITHUB_OUTPUT="$output_file" \
  FORK_RELEASE_WORKDIR="$tmp/work" \
  FORK_RELEASE_DIST_DIR="$tmp/dist" \
    bash "$ROOT/script/fork-release-artifacts.sh" validate --upstream-version 1.2.3 --suffix aai.4 > "$tmp/validate.log"

  grep -Fx 'version=1.2.3-aai.4' "$tmp/validate.log" >/dev/null || die "self-test validate did not print expected version"
  grep -Fx 'channel=aai' "$output_file" >/dev/null || die "self-test validate did not write channel output"

  if GITHUB_REPOSITORY="$TARGET_REPO" \
    GITHUB_REF_NAME="$TARGET_BRANCH" \
    FORK_RELEASE_WORKDIR="$tmp/work" \
    FORK_RELEASE_DIST_DIR="$tmp/dist" \
      bash "$ROOT/script/fork-release-artifacts.sh" validate --upstream-version 1.2.3 --suffix aai.0 > "$tmp/invalid.log" 2>&1; then
    die "self-test invalid suffix unexpectedly passed"
  fi
  grep -F 'suffix must match aai.N' "$tmp/invalid.log" >/dev/null || die "self-test invalid suffix did not explain failure"

  printf 'models snapshot\n' > "$tmp/work/release-metadata/models.dev-api.fakehash.json"
  snapshot_hash="$(hash_file "$tmp/work/release-metadata/models.dev-api.fakehash.json")"
  mv "$tmp/work/release-metadata/models.dev-api.fakehash.json" "$tmp/work/release-metadata/models.dev-api.${snapshot_hash}.json"
  jq -n \
    --arg upstream_version 1.2.3 \
    --arg suffix aai.4 \
    --arg version 1.2.3-aai.4 \
    --arg channel "$CHANNEL" \
    --arg branch "$TARGET_BRANCH" \
    --arg sha "self-test-sha" \
    --arg run_url "self-test" \
    --arg actor "self-test" \
    --arg models_snapshot_sha256 "$snapshot_hash" \
    --arg models_snapshot_asset "models.dev-api.${snapshot_hash}.json" \
    '{upstream_version:$upstream_version,suffix:$suffix,version:$version,channel:$channel,branch:$branch,sha:$sha,run_url:$run_url,actor:$actor,models_snapshot_sha256:$models_snapshot_sha256,models_snapshot_asset:$models_snapshot_asset}' \
    > "$tmp/work/release-metadata/metadata.json"

  GITHUB_REPOSITORY="$TARGET_REPO" \
  GITHUB_REF_NAME="$TARGET_BRANCH" \
  FORK_RELEASE_WORKDIR="$tmp/work" \
  FORK_RELEASE_DIST_DIR="$tmp/dist" \
  FORK_RELEASE_ALLOW_LOCAL_DIST=1 \
    bash "$ROOT/script/fork-release-artifacts.sh" package

  [ "$(find "$tmp/work/release-assets" -maxdepth 1 -type f \( -name 'opencode-*.zip' -o -name 'opencode-*.tar.gz' \) | wc -l | tr -d ' ')" = "12" ] || die "self-test package did not create all platform assets"
  grep -F "models.dev-api.${snapshot_hash}.json" "$tmp/work/release-assets/SHA256SUMS" >/dev/null || die "self-test package did not checksum models snapshot"

  GITHUB_REPOSITORY="$TARGET_REPO" \
  GITHUB_REF_NAME="$TARGET_BRANCH" \
  FORK_RELEASE_WORKDIR="$tmp/work" \
  FORK_RELEASE_DIST_DIR="$tmp/dist" \
  FORK_RELEASE_ALLOW_LOCAL_DIST=1 \
    bash "$ROOT/script/fork-release-artifacts.sh" npm-package

  [ "$(find "$tmp/work/npm-tarballs" -maxdepth 1 -type f -name '*.tgz' | wc -l | tr -d ' ')" = "13" ] || die "self-test npm-package did not create all npm tarballs"
  [ -f "$tmp/work/npm-tarballs/rmk40-opencode-1.2.3-aai.4.tgz" ] || die "self-test npm-package did not create wrapper tarball"
  jq -e '
    .name == "@rmk40/opencode" and
    .version == "1.2.3-aai.4" and
    .publishConfig.registry == "https://npm.pkg.github.com" and
    (.optionalDependencies | length == 12) and
    (.optionalDependencies | to_entries | all(.key | startswith("@rmk40/opencode-"))) and
    (.optionalDependencies | to_entries | all(.value == "1.2.3-aai.4"))
  ' "$tmp/work/npm-packages/opencode/package.json" >/dev/null || die "self-test wrapper package metadata is invalid"
  jq -e '.name == "@rmk40/opencode-windows-x64" and .os == ["win32"] and .cpu == ["x64"]' "$tmp/work/npm-packages/opencode-windows-x64/package.json" >/dev/null || die "self-test windows package metadata is invalid"
  [ -f "$tmp/work/npm-packages/opencode-windows-x64/bin/opencode.exe" ] || die "self-test windows package is missing opencode.exe"
  jq -e '.name == "@rmk40/opencode-linux-arm64-musl" and .os == ["linux"] and .cpu == ["arm64"]' "$tmp/work/npm-packages/opencode-linux-arm64-musl/package.json" >/dev/null || die "self-test linux musl package metadata is invalid"

  if GITHUB_REPOSITORY="$TARGET_REPO" \
    GITHUB_REF_NAME="$TARGET_BRANCH" \
    FORK_RELEASE_WORKDIR="$tmp/work" \
    FORK_RELEASE_DIST_DIR="$tmp/dist" \
    FORK_RELEASE_ALLOW_LOCAL_DIST=1 \
      bash "$ROOT/script/fork-release-artifacts.sh" npm-package --version 9.9.9-aai.9 > "$tmp/npm-version-mismatch.log" 2>&1; then
    die "self-test npm-package version mismatch unexpectedly passed"
  fi
  grep -F 'does not match metadata version' "$tmp/npm-version-mismatch.log" >/dev/null || die "self-test npm-package version mismatch did not explain failure"

  printf '%s\n' "fork release artifact self-test passed"
}

case "$COMMAND" in
  validate) validate_cmd ;;
  build) build_cmd ;;
  package) package_cmd ;;
  release) release_cmd ;;
  npm-package) npm_stage_packages ;;
  npm-publish) npm_publish_cmd ;;
  self-test) self_test_cmd ;;
  *)
    usage >&2
    exit 1
    ;;
esac
