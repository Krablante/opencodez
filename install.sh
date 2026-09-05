#!/usr/bin/env sh
set -eu

# Compatibility entrypoint. Keep all platform and binary validation in the
# canonical Bash installer so the two public URLs cannot drift.
REPOSITORY="${OPENCODEZ_UPDATE_REPOSITORY:-Krablante/opencodez}"
WORK="${TMPDIR:-/tmp}/opencodez-installer.$$"

cleanup() {
  rm -f "$WORK"
}
trap cleanup EXIT

curl -fsSL "https://raw.githubusercontent.com/${REPOSITORY}/main/install" -o "$WORK"
bash "$WORK" "$@"
