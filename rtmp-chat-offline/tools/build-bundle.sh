#!/usr/bin/env bash
#
#  Rebuild the offline bundle in deps/.
#
#  THIS IS THE ONLY SCRIPT THAT NEEDS THE NETWORK. Run it on a machine with
#  internet, then carry the whole project folder to the offline Ubuntu host
#  and run ./rtmp-chat.sh install there.
#
#      ./tools/build-bundle.sh                 Linux x64 + arm64
#      ./tools/build-bundle.sh --all           also the Windows Node runtime
#      ./tools/build-bundle.sh --mtx v1.21.1   pin MediaMTX
#      ./tools/build-bundle.sh --node v24.12.0 pin Node
#      ./tools/build-bundle.sh --gz            use Node .tar.gz instead of .tar.xz
#      ./tools/build-bundle.sh --no-zip        skip the optional .zip deliverable
#
#  Produces in deps/:
#    node_modules.tar.gz                express + ws + transitive deps
#    node-vXX-linux-x64.tar.xz          bundled Node runtimes
#    node-vXX-linux-arm64.tar.xz
#    mediamtx_vX_linux_amd64.tar.gz     bundled MediaMTX
#    mediamtx_vX_linux_arm64.tar.gz
#    node-vXX-win-x64.zip               only with --all
#    SHA256SUMS                         checked by rtmp-chat.sh install/doctor
#
set -euo pipefail

TOOLS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd -- "$TOOLS_DIR/.." && pwd)"
DEPS_DIR="$APP_DIR/deps"
NODE_VERSION="${NODE_VERSION:-v24.12.0}"
MTX_VERSION="${MTX_VERSION:-v1.21.1}"
NODE_EXT="${NODE_EXT:-tar.xz}"
WITH_WINDOWS=0
MAKE_ZIP=1

usage() {
    sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        --all)   WITH_WINDOWS=1; shift ;;
        --gz)    NODE_EXT=tar.gz; shift ;;
        --xz)    NODE_EXT=tar.xz; shift ;;
        --mtx)   MTX_VERSION="${2:?--mtx needs a version}"; shift 2 ;;
        --node)  NODE_VERSION="${2:?--node needs a version}"; shift 2 ;;
        --no-zip) MAKE_ZIP=0; shift ;;
        -h|--help) usage; exit 0 ;;
        *) printf 'Unknown option: %s (try --help)\n' "$1" >&2; exit 1 ;;
    esac
done

case "$MTX_VERSION" in v*) ;; *) MTX_VERSION="v$MTX_VERSION" ;; esac
case "$NODE_VERSION" in v*) ;; *) NODE_VERSION="v$NODE_VERSION" ;; esac
case "$NODE_EXT" in
    tar.xz|tar.gz) ;;
    *) printf 'NODE_EXT must be tar.xz or tar.gz\n' >&2; exit 1 ;;
esac

fetch() {
    local url="$1" out="$2"
    local part="$out.part"
    rm -f "$part"
    if command -v curl >/dev/null 2>&1; then
        curl -fL --retry 3 --connect-timeout 20 -o "$part" "$url" || {
            rm -f "$part"
            printf 'Download failed: %s\n' "$url" >&2
            exit 1
        }
    elif command -v wget >/dev/null 2>&1; then
        wget -O "$part" "$url" || {
            rm -f "$part"
            printf 'Download failed: %s\n' "$url" >&2
            exit 1
        }
    else
        printf 'Neither curl nor wget is available.\n' >&2
        exit 1
    fi
    mv "$part" "$out"
}

cd "$APP_DIR"
mkdir -p "$DEPS_DIR"

# ------------------------------------------------------------- node_modules

step() { printf '\n==> %s\n' "$1"; }

step "Refreshing node_modules from package-lock.json"
# npm ci installs exactly what the lockfile pins. npm install is free to move
# versions around, which quietly breaks a bundle you already tested.
if [ -f package-lock.json ]; then
    npm ci --omit=dev --no-audit --no-fund
else
    npm install --omit=dev --no-audit --no-fund
fi

step "Packing node_modules"
rm -f "$DEPS_DIR/node_modules.tar.gz"
tar -czf "$DEPS_DIR/node_modules.tar.gz" -C "$APP_DIR" node_modules
printf '    %s  node_modules.tar.gz\n' "$(du -h "$DEPS_DIR/node_modules.tar.gz" | cut -f1)"

# ---------------------------------------------------------------- node runtimes

step "Downloading Node.js $NODE_VERSION runtimes"
NODE_BASE="https://nodejs.org/dist/$NODE_VERSION"
NODE_ASSETS=(
    "node-$NODE_VERSION-linux-x64.$NODE_EXT"
    "node-$NODE_VERSION-linux-arm64.$NODE_EXT"
)
if [ "$WITH_WINDOWS" -eq 1 ]; then
    NODE_ASSETS+=("node-$NODE_VERSION-win-x64.zip")
fi

for asset in "${NODE_ASSETS[@]}"; do
    if [ -f "$DEPS_DIR/$asset" ]; then
        printf '    have     %s\n' "$asset"
        continue
    fi
    printf '    fetching %s\n' "$asset"
    fetch "$NODE_BASE/$asset" "$DEPS_DIR/$asset"
done

# ------------------------------------------------------------------- mediamtx

step "Downloading MediaMTX $MTX_VERSION runtimes"
MTX_BASE="https://github.com/bluenviron/mediamtx/releases/download/$MTX_VERSION"
for arch in amd64 arm64; do
    asset="mediamtx_${MTX_VERSION}_linux_${arch}.tar.gz"
    if [ -f "$DEPS_DIR/$asset" ]; then
        printf '    have     %s\n' "$asset"
        continue
    fi
    printf '    fetching %s\n' "$asset"
    fetch "$MTX_BASE/$asset" "$DEPS_DIR/$asset"
done

# --------------------------------------------------------------- stale cleanup

# The manager picks archives with globs. Leaving an older Node or MediaMTX
# tarball next to the new one makes the selected version depend on filename
# sort order, so remove everything that this run did not produce.
step "Removing stale bundle archives"
KEEP_NODE=(
    "node-$NODE_VERSION-linux-x64.$NODE_EXT"
    "node-$NODE_VERSION-linux-arm64.$NODE_EXT"
)
if [ "$WITH_WINDOWS" -eq 1 ]; then
    KEEP_NODE+=("node-$NODE_VERSION-win-x64.zip")
fi
KEEP_MTX=(
    "mediamtx_${MTX_VERSION}_linux_amd64.tar.gz"
    "mediamtx_${MTX_VERSION}_linux_arm64.tar.gz"
)

prune_stale() {
    local file base want keep
    for file in "$@"; do
        [ -f "$file" ] || continue
        base="$(basename "$file")"
        keep=0
        for want in "${KEEP[@]}"; do
            if [ "$base" = "$want" ]; then
                keep=1
                break
            fi
        done
        if [ "$keep" -eq 0 ]; then
            rm -f "$file"
            printf '    removed  %s\n' "$base"
        fi
    done
}

KEEP=("${KEEP_NODE[@]}")
prune_stale "$DEPS_DIR"/node-v*.tar.xz "$DEPS_DIR"/node-v*.tar.gz \
    "$DEPS_DIR"/node-v*.zip "$DEPS_DIR"/node-v*.7z
KEEP=("${KEEP_MTX[@]}")
prune_stale "$DEPS_DIR"/mediamtx_*.tar.gz

# ------------------------------------------------------------------ checksums

step "Writing checksums"
tmp="$DEPS_DIR/SHA256SUMS.tmp"
: > "$tmp"
for file in "$DEPS_DIR"/*.tar.gz "$DEPS_DIR"/*.tar.xz "$DEPS_DIR"/*.zip; do
    [ -f "$file" ] || continue
    case "$(basename "$file")" in
        SHA256SUMS*) continue ;;
    esac
    ( cd "$DEPS_DIR" && sha256sum "$(basename "$file")" ) >> "$tmp"
done
if [ ! -s "$tmp" ]; then
    rm -f "$tmp"
    printf 'No archives were produced - nothing to checksum.\n' >&2
    exit 1
fi
LC_ALL=C sort -k2 "$tmp" > "$DEPS_DIR/SHA256SUMS"
rm -f "$tmp"
cat "$DEPS_DIR/SHA256SUMS"

# ---------------------------------------------------------------------- pack

if [ "$MAKE_ZIP" -eq 1 ] && command -v zip >/dev/null 2>&1; then
    step "Building the offline zip"
    # Zip from the parent so the archive contains a single rtmp-chat-offline/
    # folder instead of spraying files into whatever directory it is
    # extracted in. Keep the output outside that folder so zip cannot include
    # the archive it is writing.
    ZIP="$(dirname "$APP_DIR")/$(basename "$APP_DIR").zip"
    rm -f "$ZIP"
    (
        cd "$(dirname "$APP_DIR")"
        zip -qr "$ZIP" "$(basename "$APP_DIR")" \
            -x '*/node_modules/*' '*/data/*' '*/.runtime/*' '*/config/*' \
               '*/logs/*' '*/backups/*' '*/.server.pid' '*.log' '*.zip'
    )
    printf '    %s  %s\n' "$(du -h "$ZIP" | cut -f1)" "$(basename "$ZIP")"
elif [ "$MAKE_ZIP" -eq 1 ]; then
    printf '\n    (zip not installed - skipping the .zip archive)\n'
fi

cat <<EOF

Done. deps/ is $(du -sh "$DEPS_DIR" | cut -f1).

Ship the whole project (deps/ included) to the offline Ubuntu server, then:

    chmod +x rtmp-chat.sh tools/build-bundle.sh
    sudo ./rtmp-chat.sh install --systemd

EOF
