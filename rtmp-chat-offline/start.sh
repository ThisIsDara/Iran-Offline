#!/usr/bin/env bash
#
#  Compatibility wrapper. The real installer/manager is rtmp-chat.sh.
#
#      ./start.sh              ->  ./rtmp-chat.sh run
#      ./start.sh --with-mtx   ->  ./rtmp-chat.sh run --with-mtx
#
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MANAGER="$APP_DIR/rtmp-chat.sh"

if [ -x "$MANAGER" ]; then
    RUN=("$MANAGER")
else
    RUN=(bash "$MANAGER")
fi

exec "${RUN[@]}" run "$@"
