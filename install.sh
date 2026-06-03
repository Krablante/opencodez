#!/usr/bin/env sh
set -eu

REPOSITORY="${OPENCODEZ_UPDATE_REPOSITORY:-Krablante/opencodez}"
INSTALL_DIR="${OPENCODEZ_INSTALL_DIR:-"$HOME/.local/bin"}"

case "$(uname -s | tr '[:upper:]' '[:lower:]')" in
  linux) OS="linux" ;;
  darwin) OS="darwin" ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) ARCH="x64" ;;
  arm64 | aarch64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

ASSET="opencodez-${OS}-${ARCH}"
WORK="${TMPDIR:-/tmp}/opencodez-install.$$"
ARCHIVE="${WORK}/asset"
BIN="${WORK}/opencodez"

cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$INSTALL_DIR"
mkdir -p "$WORK"

FOUND=""
for suffix in ".tar.gz" ".zip" ""; do
  URL="https://github.com/${REPOSITORY}/releases/latest/download/${ASSET}${suffix}"
  echo "Trying ${URL}"
  if curl -fsSL "$URL" -o "$ARCHIVE"; then
    FOUND="${ASSET}${suffix}"
    break
  fi
done

if [ -z "$FOUND" ]; then
  echo "No matching OpenCodez release asset found for ${OS}/${ARCH}" >&2
  exit 1
fi

case "$FOUND" in
  *.tar.gz)
    tar -xzf "$ARCHIVE" -C "$WORK" opencodez
    ;;
  *.zip)
    unzip -p "$ARCHIVE" opencodez > "$BIN"
    ;;
  *)
    mv "$ARCHIVE" "$BIN"
    ;;
esac

chmod +x "$BIN"
mv "$BIN" "${INSTALL_DIR}/opencodez"
echo "Installed ${INSTALL_DIR}/opencodez"
