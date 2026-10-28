#!/usr/bin/env bash
#
#  Compatibility wrapper. The real installer/manager is rtmp-chat.sh.
#
#      ./install.sh --systemd      ->  ./rtmp-chat.sh install --systemd
#      ./install.sh --uninstall    ->  ./rtmp-chat.sh uninstall
#
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MANAGER="$APP_DIR/rtmp-chat.sh"

if [ -x "$MANAGER" ]; then
    RUN=("$MANAGER")
else
    RUN=(bash "$MANAGER")
fi

if [ "${1:-}" = "--uninstall" ]; then
    shift
    exec "${RUN[@]}" uninstall "$@"
fi

exec "${RUN[@]}" install "$@"
