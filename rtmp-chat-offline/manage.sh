#!/usr/bin/env bash
#
#  Compatibility wrapper. The real installer/manager is rtmp-chat.sh.
#
#      ./manage.sh start|stop|restart|status|logs [chat|all]
#
#  With no command it prints status, like the old script did.
#
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MANAGER="$APP_DIR/rtmp-chat.sh"

if [ -x "$MANAGER" ]; then
    RUN=("$MANAGER")
else
    RUN=(bash "$MANAGER")
fi

if [ $# -eq 0 ]; then
    exec "${RUN[@]}" status
fi

case "$1" in
    start|stop|restart|status|logs)
        exec "${RUN[@]}" "$@"
        ;;
    -h|--help)
        exec "${RUN[@]}" --help
        ;;
    *)
        printf 'Unknown command: %s (try: start, stop, restart, status, logs)\n' "$1" >&2
        exit 1
        ;;
esac
