#!/usr/bin/env bash
#
#  Compatibility wrapper for the online bundle builder.
#
#  The real builder is tools/build-bundle.sh. It is the ONLY script in this
#  project that needs internet access. Do not run it on the offline host.
#
#      ./download-deps.sh                 same as ./tools/build-bundle.sh
#      ./download-deps.sh --all           also the Windows Node runtime
#      ./download-deps.sh --mtx v1.21.1   pin MediaMTX
#
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BUILDER="$APP_DIR/tools/build-bundle.sh"

[ -f "$BUILDER" ] || {
    printf 'Missing %s\n' "$BUILDER" >&2
    exit 1
}

if [ -x "$BUILDER" ]; then
    RUN=("$BUILDER")
else
    RUN=(bash "$BUILDER")
fi

exec "${RUN[@]}" "$@"
