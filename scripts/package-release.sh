#!/usr/bin/env bash
#
# Build downloadable release archives for alsegno.
#
#   scripts/package-release.sh            # package the current commit (HEAD), version from package.json
#   scripts/package-release.sh v1.2.0     # package a tag/ref, version taken from the ref name
#
# Output goes to dist/ :
#   dist/alsegno-<version>.zip
#   dist/alsegno-<version>.tar.gz
#
# Both extract to a single `alsegno/` folder. Contents are exactly the committed files
# (git archive), so .env, data/, uploads/ and node_modules/ are never included — which is
# why "extract the new release over your old folder" preserves a user's data and config.
#
# This is the single source of truth for release artifacts: the GitHub Actions release
# workflow (.github/workflows/release.yml) just runs this script and uploads dist/.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

REF="${1:-HEAD}"
git rev-parse --verify --quiet "$REF^{commit}" >/dev/null \
  || { printf 'error: no such git ref: %s\n' "$REF" >&2; exit 1; }

# Read the version from the *committed* package.json at this ref (not the worktree), so the
# label always matches what's actually inside the archive.
PKGVER="$(git show "$REF:package.json" | node -p 'JSON.parse(require("fs").readFileSync(0)).version')"
if [ "$REF" = "HEAD" ]; then
  VERSION="$PKGVER"
else
  VERSION="${REF#v}"            # strip a leading "v" from tag names like v1.2.0
  # Guard the easy mistake: tagging without bumping package.json would ship a mislabeled archive.
  [ "$VERSION" = "$PKGVER" ] || {
    printf 'error: tag %s (version %s) does not match package.json (%s).\n       Bump package.json to %s and commit before tagging.\n' \
      "$REF" "$VERSION" "$PKGVER" "$VERSION" >&2
    exit 1
  }
fi

OUT="dist"
PREFIX="alsegno/"              # fixed folder name: extract-over-to-update keeps data/ & .env in place
NAME="alsegno-${VERSION}"
mkdir -p "$OUT"

git archive --format=tar.gz --prefix="$PREFIX" -o "$OUT/${NAME}.tar.gz" "$REF"
git archive --format=zip    --prefix="$PREFIX" -o "$OUT/${NAME}.zip"    "$REF"

printf '\nBuilt from %s (version %s):\n' "$REF" "$VERSION"
for f in "$OUT/${NAME}.tar.gz" "$OUT/${NAME}.zip"; do
  size="$(du -h "$f" | cut -f1)"
  if command -v sha256sum >/dev/null 2>&1; then
    sum="$(sha256sum "$f" | cut -d' ' -f1)"
  else
    sum="$(shasum -a 256 "$f" | cut -d' ' -f1)"   # macOS
  fi
  printf '  %-28s %6s  sha256:%s\n' "$(basename "$f")" "$size" "$sum"
done
