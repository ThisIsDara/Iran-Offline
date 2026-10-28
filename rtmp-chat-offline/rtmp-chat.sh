#!/usr/bin/env bash
#
#  RTMP Chat - one script for install, run and management.
#
#  Everything needed on the target machine is in this folder.  The install,
#  start, stop, status, logs and uninstall paths never use the network: no
#  apt, npm, curl, wget or DNS lookups.  Only tools/build-bundle.sh (on a
#  machine with internet) downloads anything.
#
#      sudo ./rtmp-chat.sh install --systemd
#      sudo ./rtmp-chat.sh start
#      sudo ./rtmp-chat.sh stop
#      sudo ./rtmp-chat.sh restart
#      sudo ./rtmp-chat.sh status
#      sudo ./rtmp-chat.sh logs
#      sudo ./rtmp-chat.sh doctor --full
#      sudo ./rtmp-chat.sh uninstall
#
#  Without systemd use --manual:
#      ./rtmp-chat.sh install --manual
#      ./rtmp-chat.sh start
#
set -euo pipefail
umask 077

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPS_DIR="$APP_DIR/deps"
RUNTIME_DIR="$APP_DIR/.runtime"
CONFIG_DIR="$APP_DIR/config"
LOG_DIR="$APP_DIR/logs"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
STATE_FILE="$RUNTIME_DIR/install.env"
ENV_FILE="$RUNTIME_DIR/env.sh"
SERVICE_ENV_FILE="$RUNTIME_DIR/service.env"
NODE_PATH_FILE="$RUNTIME_DIR/node-path.txt"
CHAT_PID_FILE="$APP_DIR/.server.pid"
MTX_PID_FILE="$RUNTIME_DIR/mediamtx.pid"
CHAT_SERVICE="rtmp-chat"
MTX_SERVICE="mediamtx"
MIN_NODE_MAJOR=18

# Defaults. Environment variables work for a first install; load_state()
# replaces these with the values chosen at install on later runs.
PORT="${PORT:-8080}"
RTMP_PORT="${RTMP_PORT:-1935}"
HLS_PORT="${HLS_PORT:-8888}"
WEBRTC_PORT="${WEBRTC_PORT:-8889}"
API_PORT="${API_PORT:-9997}"
WEBRTC_ENABLED="${WEBRTC_ENABLED:-1}"
DO_MTX="${DO_MTX:-1}"
MODE=""
STREAM_BASE="${STREAM_BASE:-}"
RTMP_BASE="${RTMP_BASE:-}"
NODE_BIN_OVERRIDE="${NODE_BIN:-}"
NODE_BIN=""
MTX_BIN=""
MTX_YML=""
SUDO=()
RUN_MTX_PID=""

if [ -t 1 ]; then
    BOLD=$'\033[1m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[0;31m'; NC=$'\033[0m'
else
    BOLD=''; GREEN=''; YELLOW=''; RED=''; NC=''
fi

step() { printf '\n%s==>%s %s\n' "$BOLD" "$NC" "$1"; }
ok()   { printf '    %sOK%s   %s\n' "$GREEN" "$NC" "$1"; }
warn() { printf '    %sWARN%s %s\n' "$YELLOW" "$NC" "$1"; }
info() { printf '    %s\n' "$1"; }
die()  { printf '    %sFAIL%s %s\n' "$RED" "$NC" "$1" >&2; exit 1; }

usage() {
    cat <<'EOF'
RTMP Chat - offline installer and manager

  ./rtmp-chat.sh setup               one-command install + start (recommended)
  ./rtmp-chat.sh install [options]   same, with install options
  ./rtmp-chat.sh start [chat|all]    start the chat server (and MediaMTX)
  ./rtmp-chat.sh stop [chat|all]     stop them
  ./rtmp-chat.sh restart [chat|all]  restart them
  ./rtmp-chat.sh status              show mode, processes, health and admin URL
  ./rtmp-chat.sh logs [chat|all]     follow logs (journalctl or logs/)
  ./rtmp-chat.sh urls                print the URLs to hand to viewers/streamers
  ./rtmp-chat.sh credentials         print the admin URL and password
  ./rtmp-chat.sh doctor [--full]     offline health/integrity check
  ./rtmp-chat.sh backup              back up data/ and config/
  ./rtmp-chat.sh uninstall [--purge] stop, remove services and .runtime/
  ./rtmp-chat.sh run [--with-mtx]    run in the foreground (Ctrl-C to stop)

Install options:
  --systemd             install and start systemd services (recommended)
  --manual, --no-systemd
                        no systemd; use PID files and logs/
  --port N              chat HTTP/WebSocket port (default 8080)
  --rtmp-port N         MediaMTX RTMP port (default 1935)
  --hls-port N          MediaMTX HLS/player port (default 8888)
  --webrtc-port N       MediaMTX WebRTC port (default 8889)
  --api-port N          MediaMTX control API on 127.0.0.1 (default 9997)
  --no-webrtc           disable MediaMTX WebRTC (HLS still works)
  --no-mtx, --with-mtx  skip / include the bundled MediaMTX
  --data-dir DIR        store keys and admin credentials in DIR
  --stream-base URL     viewer base, e.g. http://video.example.com
  --rtmp-base URL       streamer base, e.g. rtmp://ingest.example.com/live
  --force               re-extract Node, node_modules and MediaMTX
  --no-verify           skip the boot checks
  --no-start            install but do not start anything

The install and runtime paths are offline.  Rebuild the bundle on a machine
with internet using ./tools/build-bundle.sh.
EOF
}

# ---------------------------------------------------------------- utilities

have() { command -v "$1" >/dev/null 2>&1; }

setup_sudo() {
    SUDO=()
    if [ "$(id -u)" -ne 0 ]; then
        have sudo || die "this action needs root; re-run with sudo, or use --manual"
        SUDO=(sudo)
    fi
}

run_root() {
    if [ "${#SUDO[@]}" -eq 0 ]; then
        "$@"
    else
        "${SUDO[@]}" "$@"
    fi
}

systemd_available() {
    have systemctl && [ -d /run/systemd/system ]
}

systemd_units_exist() {
    [ -f "/etc/systemd/system/$CHAT_SERVICE.service" ] || [ -f "/etc/systemd/system/$MTX_SERVICE.service" ]
}

node_major() {
    "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

validate_port() {
    local name="$1" value="$2"
    case "$value" in
        ''|*[!0-9]*) die "$name must be a number, got '$value'" ;;
    esac
    if [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
        die "$name must be between 1 and 65535, got '$value'"
    fi
}

validate_path_value() {
    local name="$1" value="$2"
    case "$value" in
        *$'\n'*|*$'\r'*) die "$name cannot contain a newline" ;;
    esac
}

# `uninstall --purge` removes DATA_DIR recursively. Refuse paths where a typo
# (or a stale state file) would take out the project, a home directory, a
# mount point or a system directory.
guard_data_dir() {
    local dir="${DATA_DIR:-}" rest
    [ -n "$dir" ] || die "DATA_DIR is empty"
    case "$dir" in
        /*) ;;
        *) dir="$APP_DIR/$dir" ;;
    esac
    while [ "$dir" != "/" ] && [ "${dir%/}" != "$dir" ]; do
        dir="${dir%/}"
    done
    case "$dir" in
        /|"$APP_DIR")
            die "refusing unsafe DATA_DIR: $dir"
            ;;
        /bin|/boot|/dev|/etc|/home|/lib|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var)
            die "refusing unsafe DATA_DIR: $dir (choose a dedicated directory)"
            ;;
    esac
    # A direct child of these is often a home directory, a mount point or a
    # system directory. Require one more level, e.g. /home/alice/rtmp-data.
    case "$dir" in
        /home/*|/mnt/*|/media/*|/var/*|/usr/*|/etc/*|/boot/*|/lib/*|/lib64/*|/bin/*|/sbin/*|/run/*|/sys/*|/proc/*|/dev/*)
            rest="${dir#/*/}"
            case "$rest" in
                */*) ;;
                *) die "refusing unsafe DATA_DIR: $dir (choose a dedicated subdirectory)" ;;
            esac
            ;;
    esac
}

detect_node_arch() {
    case "$(uname -m)" in
        x86_64|amd64)   printf 'x64' ;;
        aarch64|arm64)  printf 'arm64' ;;
        armv7l|armv6l)  printf 'armv7l' ;;
        *)              printf '%s' "$(uname -m)" ;;
    esac
}

detect_mtx_arch() {
    case "$(uname -m)" in
        x86_64|amd64)   printf 'amd64' ;;
        aarch64|arm64)  printf 'arm64' ;;
        armv7l|armv6l)  printf 'armv7' ;;
        *)              printf '%s' "$(uname -m)" ;;
    esac
}

# tar needs an external xz/gzip on GNU systems when the archive is compressed.
extract_tar() {
    local archive="$1" dest="$2" strip="${3:-0}"
    mkdir -p "$dest"
    case "$archive" in
        *.tar.xz)
            if tar -xJf "$archive" -C "$dest" --strip-components="$strip" 2>/dev/null; then
                return 0
            fi
            have xz || die "cannot extract $(basename "$archive"): install xz-utils or use a .tar.gz bundle"
            xz -dc "$archive" | tar -xf - -C "$dest" --strip-components="$strip"
            ;;
        *.tar.gz|*.tgz)
            if tar -xzf "$archive" -C "$dest" --strip-components="$strip" 2>/dev/null; then
                return 0
            fi
            have gzip || die "cannot extract $(basename "$archive"): gzip is missing"
            gzip -dc "$archive" | tar -xf - -C "$dest" --strip-components="$strip"
            ;;
        *.tar)
            tar -xf "$archive" -C "$dest" --strip-components="$strip"
            ;;
        *)
            die "unsupported archive: $archive"
            ;;
    esac
}

find_bundled_node() {
    local arch="$1" file
    # Prefer a .tar.gz when xz is unavailable; both are produced by the builder
    # if requested, and the xz archive is the normal (smaller) one.
    if ! have xz; then
        for file in "$DEPS_DIR"/node-*-"$arch".tar.gz; do
            [ -f "$file" ] && { printf '%s\n' "$file"; return 0; }
        done
    fi
    for file in "$DEPS_DIR"/node-*-"$arch".tar.xz; do
        [ -f "$file" ] && { printf '%s\n' "$file"; return 0; }
    done
    for file in "$DEPS_DIR"/node-*-"$arch".tar.gz; do
        [ -f "$file" ] && { printf '%s\n' "$file"; return 0; }
    done
    return 1
}

find_mediamtx_archive() {
    local arch="$1" file
    for file in "$DEPS_DIR"/mediamtx_*_linux_"$arch".tar.gz; do
        [ -f "$file" ] && { printf '%s\n' "$file"; return 0; }
    done
    return 1
}

# ------------------------------------------------------------- state / env

load_state() {
    if [ -f "$STATE_FILE" ]; then
        # shellcheck disable=SC1090
        . "$STATE_FILE"
    fi
    # Compatibility with older installs that only stored STREAM_PORT.
    HLS_PORT="${HLS_PORT:-${STREAM_PORT:-8888}}"
    # server.js and lib/stream-keys.js read STREAM_PORT, not HLS_PORT.
    STREAM_PORT="$HLS_PORT"
    API_PORT="${API_PORT:-9997}"
    WEBRTC_ENABLED="${WEBRTC_ENABLED:-1}"
    DO_MTX="${DO_MTX:-1}"
    # Old state files may not have recorded these paths.
    if [ -z "${MTX_BIN:-}" ] && [ -x "$RUNTIME_DIR/mediamtx/mediamtx" ]; then
        MTX_BIN="$RUNTIME_DIR/mediamtx/mediamtx"
    fi
    if [ -z "${MTX_YML:-}" ] && [ -f "$CONFIG_DIR/mediamtx.yml" ]; then
        MTX_YML="$CONFIG_DIR/mediamtx.yml"
    fi
}

save_state() {
    mkdir -p "$RUNTIME_DIR"
    {
        printf '# generated by rtmp-chat.sh - safe to delete and reinstall\n'
        printf 'PORT=%q\n' "$PORT"
        printf 'RTMP_PORT=%q\n' "$RTMP_PORT"
        printf 'HLS_PORT=%q\n' "$HLS_PORT"
        printf 'WEBRTC_PORT=%q\n' "$WEBRTC_PORT"
        printf 'API_PORT=%q\n' "$API_PORT"
        printf 'WEBRTC_ENABLED=%q\n' "$WEBRTC_ENABLED"
        printf 'DO_MTX=%q\n' "$DO_MTX"
        printf 'MODE=%q\n' "$MODE"
        printf 'DATA_DIR=%q\n' "$DATA_DIR"
        printf 'STREAM_BASE=%q\n' "$STREAM_BASE"
        printf 'RTMP_BASE=%q\n' "$RTMP_BASE"
        printf 'NODE_BIN=%q\n' "$NODE_BIN"
        printf 'MTX_BIN=%q\n' "$MTX_BIN"
        printf 'MTX_YML=%q\n' "$MTX_YML"
        # Keep explicitly supplied credentials across a reinstall; otherwise
        # an install without the same environment would mint new ones.
        printf 'ADMIN_PATH=%q\n' "${ADMIN_PATH:-}"
        printf 'ADMIN_PASSWORD=%q\n' "${ADMIN_PASSWORD:-}"
        printf 'DEFAULT_STREAM=%q\n' "${DEFAULT_STREAM:-}"
    } > "$STATE_FILE"
    chmod 600 "$STATE_FILE" 2>/dev/null || true
}

escape_env_value() {
    # printf %q emits shell-safe quoting, including for empty values.
    printf '%q' "$1"
}

save_env() {
    mkdir -p "$RUNTIME_DIR"
    {
        printf '# shell environment for start/manage/run\n'
        printf 'export PORT=%s\n' "$(escape_env_value "$PORT")"
        printf 'export RTMP_PORT=%s\n' "$(escape_env_value "$RTMP_PORT")"
        printf 'export HLS_PORT=%s\n' "$(escape_env_value "$HLS_PORT")"
        printf 'export STREAM_PORT=%s\n' "$(escape_env_value "$HLS_PORT")"
        printf 'export WEBRTC_PORT=%s\n' "$(escape_env_value "$WEBRTC_PORT")"
        printf 'export WEBRTC_ENABLED=%s\n' "$(escape_env_value "$WEBRTC_ENABLED")"
        printf 'export DATA_DIR=%s\n' "$(escape_env_value "$DATA_DIR")"
        printf 'export STREAM_BASE=%s\n' "$(escape_env_value "$STREAM_BASE")"
        printf 'export RTMP_BASE=%s\n' "$(escape_env_value "$RTMP_BASE")"
        printf 'export MTX_API=%s\n' "$(escape_env_value "http://127.0.0.1:$API_PORT")"
        printf 'export NODE_ENV=%s\n' "$(escape_env_value 'production')"
        printf 'export NODE_BIN=%s\n' "$(escape_env_value "$NODE_BIN")"
        printf 'export MTX_BIN=%s\n' "$(escape_env_value "$MTX_BIN")"
        printf 'export MTX_YML=%s\n' "$(escape_env_value "$MTX_YML")"
        if [ -n "${ADMIN_PATH:-}" ]; then
            printf 'export ADMIN_PATH=%s\n' "$(escape_env_value "$ADMIN_PATH")"
        fi
        if [ -n "${ADMIN_PASSWORD:-}" ]; then
            printf 'export ADMIN_PASSWORD=%s\n' "$(escape_env_value "$ADMIN_PASSWORD")"
        fi
        if [ -n "${DEFAULT_STREAM:-}" ]; then
            printf 'export DEFAULT_STREAM=%s\n' "$(escape_env_value "$DEFAULT_STREAM")"
        fi
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE" 2>/dev/null || true

    # systemd reads this one. It is deliberately not shell syntax: no
    # substitutions, no command execution, just KEY=value lines.
    {
        printf 'PORT=%s\n' "$PORT"
        printf 'RTMP_PORT=%s\n' "$RTMP_PORT"
        printf 'HLS_PORT=%s\n' "$HLS_PORT"
        printf 'STREAM_PORT=%s\n' "$HLS_PORT"
        printf 'WEBRTC_PORT=%s\n' "$WEBRTC_PORT"
        printf 'WEBRTC_ENABLED=%s\n' "$WEBRTC_ENABLED"
        printf 'DATA_DIR=%s\n' "$DATA_DIR"
        printf 'STREAM_BASE=%s\n' "$STREAM_BASE"
        printf 'RTMP_BASE=%s\n' "$RTMP_BASE"
        printf 'MTX_API=http://127.0.0.1:%s\n' "$API_PORT"
        printf 'NODE_ENV=production\n'
        if [ -n "${ADMIN_PATH:-}" ]; then
            printf 'ADMIN_PATH=%s\n' "$ADMIN_PATH"
        fi
        if [ -n "${ADMIN_PASSWORD:-}" ]; then
            printf 'ADMIN_PASSWORD=%s\n' "$ADMIN_PASSWORD"
        fi
        if [ -n "${DEFAULT_STREAM:-}" ]; then
            printf 'DEFAULT_STREAM=%s\n' "$DEFAULT_STREAM"
        fi
    } > "$SERVICE_ENV_FILE"
    chmod 600 "$SERVICE_ENV_FILE" 2>/dev/null || true
    printf '%s\n' "$NODE_BIN" > "$NODE_PATH_FILE"
    chmod 600 "$NODE_PATH_FILE" 2>/dev/null || true
}

export_runtime_env() {
    STREAM_PORT="$HLS_PORT"
    export PORT RTMP_PORT HLS_PORT STREAM_PORT WEBRTC_PORT WEBRTC_ENABLED
    export DATA_DIR STREAM_BASE RTMP_BASE NODE_ENV NODE_BIN MTX_BIN MTX_YML
    export MTX_API="http://127.0.0.1:$API_PORT"
    export NODE_ENV=production
    if [ -n "${ADMIN_PATH:-}" ]; then export ADMIN_PATH; fi
    if [ -n "${ADMIN_PASSWORD:-}" ]; then export ADMIN_PASSWORD; fi
    if [ -n "${DEFAULT_STREAM:-}" ]; then export DEFAULT_STREAM; fi
}

# --------------------------------------------------------------- preflight

verify_bundle() {
    step "Verifying the offline bundle"
    [ -d "$DEPS_DIR" ] || die "deps/ is missing - copy the whole project folder, not just the scripts"

    if have sha256sum && [ -f "$DEPS_DIR/SHA256SUMS" ]; then
        # --ignore-missing keeps a working install valid after the operator
        # deletes the architecture they do not need.
        if ( cd "$DEPS_DIR" && sha256sum -c --quiet --ignore-missing SHA256SUMS ); then
            ok "SHA256SUMS match"
        else
            die "checksum mismatch in deps/ - the bundle is incomplete or corrupt"
        fi
    else
        warn "no sha256sum or no deps/SHA256SUMS - skipping integrity check"
    fi
}

install_node_runtime() {
    step "Locating Node.js"

    local arch archive major
    arch="$(detect_node_arch)"

    if [ -n "${NODE_BIN_OVERRIDE:-}" ]; then
        [ -x "$NODE_BIN_OVERRIDE" ] || die "NODE_BIN=$NODE_BIN_OVERRIDE is not executable"
        major="$(node_major "$NODE_BIN_OVERRIDE")"
        [ "$major" -ge "$MIN_NODE_MAJOR" ] || die "NODE_BIN=$NODE_BIN_OVERRIDE is v$("$NODE_BIN_OVERRIDE" -v), need $MIN_NODE_MAJOR+"
        NODE_BIN="$NODE_BIN_OVERRIDE"
        ok "using NODE_BIN $("$NODE_BIN" -v) at $NODE_BIN"
        return 0
    fi

    if [ "${FORCE:-0}" -eq 0 ] && [ -x "$RUNTIME_DIR/bin/node" ]; then
        major="$(node_major "$RUNTIME_DIR/bin/node")"
        if [ "$major" -ge "$MIN_NODE_MAJOR" ]; then
            NODE_BIN="$RUNTIME_DIR/bin/node"
            ok "using bundled Node $("$NODE_BIN" -v)"
            return 0
        fi
    fi

    if archive="$(find_bundled_node "$arch")"; then
        extract_tar "$archive" "$RUNTIME_DIR" 1
        NODE_BIN="$RUNTIME_DIR/bin/node"
        [ -x "$NODE_BIN" ] || die "bundled Node archive did not contain bin/node"
        major="$(node_major "$NODE_BIN")"
        [ "$major" -ge "$MIN_NODE_MAJOR" ] || die "bundled Node is v$("$NODE_BIN" -v), need $MIN_NODE_MAJOR+"
        ok "unpacked bundled Node $("$NODE_BIN" -v)"
        return 0
    fi

    if have node; then
        NODE_BIN="$(command -v node)"
        major="$(node_major "$NODE_BIN")"
        if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
            die "system Node is v$("$NODE_BIN" -v), need $MIN_NODE_MAJOR+, and no bundled build for $arch exists"
        fi
        warn "no bundled Node for $arch - using system Node $("$NODE_BIN" -v)"
        ok "using system Node $NODE_BIN"
        return 0
    fi

    die "no Node.js found and no bundled build for linux-$arch in deps/"
}

install_node_modules() {
    step "Installing node dependencies (offline)"
    local bundle="$DEPS_DIR/node_modules.tar.gz"

    if [ "${FORCE:-0}" -eq 0 ] && [ -d "$APP_DIR/node_modules/express" ] && [ -d "$APP_DIR/node_modules/ws" ]; then
        ok "node_modules already present (--force to reinstall)"
    else
        [ -f "$bundle" ] || die "missing $bundle"
        rm -rf "$APP_DIR/node_modules"
        # The archive root is node_modules/, so strip it into node_modules/.
        extract_tar "$bundle" "$APP_DIR/node_modules" 1
        ok "extracted node_modules.tar.gz"
    fi

    ( cd "$APP_DIR" && NODE_PATH="$APP_DIR/node_modules" "$NODE_BIN" -e '
        require("express"); require("ws");
        console.log("    OK   express " + require("express/package.json").version +
                    ", ws " + require("ws/package.json").version + " load correctly");
    ' ) || die "dependency verification failed"
}

install_mediamtx() {
    local arch archive version
    MTX_BIN=""
    MTX_YML=""

    if [ "$DO_MTX" -eq 0 ]; then
        step "Skipping MediaMTX (--no-mtx)"
        warn "stream keys will not be enforced unless you run MediaMTX yourself"
        return 0
    fi

    step "Installing MediaMTX (offline)"
    arch="$(detect_mtx_arch)"
    archive="$(find_mediamtx_archive "$arch")" || die "no bundled MediaMTX for linux/$arch in deps/
       Use --no-mtx if MediaMTX is already installed elsewhere."

    if [ "${FORCE:-0}" -eq 1 ] || [ ! -x "$RUNTIME_DIR/mediamtx/mediamtx" ]; then
        rm -rf "$RUNTIME_DIR/mediamtx"
        mkdir -p "$RUNTIME_DIR/mediamtx"
        extract_tar "$archive" "$RUNTIME_DIR/mediamtx" 0
        rm -f "$RUNTIME_DIR/mediamtx/mediamtx.yml"
    fi

    MTX_BIN="$RUNTIME_DIR/mediamtx/mediamtx"
    [ -x "$MTX_BIN" ] || die "MediaMTX did not unpack to $MTX_BIN"
    chmod +x "$MTX_BIN"
    version="$("$MTX_BIN" --version 2>&1 | head -1 || true)"
    [ -n "$version" ] || die "bundled MediaMTX cannot run on this machine (wrong architecture or missing libc)"
    ok "$version at $MTX_BIN"
}

prepare_data() {
    step "Preparing data directory"
    mkdir -p "$DATA_DIR"
    chmod 700 "$DATA_DIR" 2>/dev/null || true
    DATA_DIR="$(cd -- "$DATA_DIR" && pwd)"
    ok "data directory ready: $DATA_DIR"

    (
        cd "$APP_DIR"
        export DATA_DIR NODE_PATH="$APP_DIR/node_modules"
        if [ -n "${ADMIN_PATH:-}" ]; then export ADMIN_PATH; fi
        if [ -n "${ADMIN_PASSWORD:-}" ]; then export ADMIN_PASSWORD; fi
        "$NODE_BIN" -e '
            const keys = require("./lib/stream-keys");
            keys.ensurePassword();
            keys.ensureAdminPath();
        '
    ) || warn "could not pre-generate admin credentials (they will be generated on first start)"

    chmod 600 "$DATA_DIR"/*.txt "$DATA_DIR"/*.json 2>/dev/null || true
}

write_mediamtx_config() {
    [ "$DO_MTX" -eq 1 ] || return 0

    step "Generating MediaMTX config"
    mkdir -p "$CONFIG_DIR"
    chmod 700 "$CONFIG_DIR" 2>/dev/null || true
    MTX_YML="$CONFIG_DIR/mediamtx.yml"
    local new="$MTX_YML.new"
    local webrtc="true"
    [ "$WEBRTC_ENABLED" -eq 1 ] || webrtc="false"

    cat > "$new" <<EOF
# =============================================================
#  Generated by rtmp-chat.sh. Re-running the installer regenerates
#  this file and keeps any changed previous version as .bak.
# =============================================================
#
#  Publish:  rtmp://<this-host>:$RTMP_PORT/live/<room>?key=<STREAM KEY>
#  Viewers:  http://<this-host>:$HLS_PORT/live/<room>/
#
#  MediaMTX asks the chat server before every publish. If the chat
#  server is down, publishing is rejected (fail closed). Viewing is
#  always allowed, so a chat outage never breaks an existing stream.

logLevel: info
logDestinations: [stdout]

# RTSP and SRT are not used by this app. Turning them off avoids
# opening ports nobody needs.
rtsp: false
srt: false

rtmp: true
rtmpAddress: :$RTMP_PORT

hls: true
hlsAddress: :$HLS_PORT

webrtc: $webrtc
webrtcAddress: :$WEBRTC_PORT

api: true
apiAddress: 127.0.0.1:$API_PORT

metrics: false
pprof: false
playback: false

# --- stream key gate ---
authMethod: http
authHTTPAddress: "http://127.0.0.1:$PORT/mediamtx/auth"

# Only publishing is gated. Everything else is always allowed so
# viewers keep working even if the chat server is down.
authHTTPExclude:
  - action: read
  - action: playback
  - action: api
  - action: metrics
  - action: pprof

# Any room may be published to; the stream key decides who may.
paths:
  all_others:
    source: publisher
EOF

    if [ -f "$MTX_YML" ]; then
        if ! have cmp || ! cmp -s "$MTX_YML" "$MTX_YML.new"; then
            cp "$MTX_YML" "$MTX_YML.bak" 2>/dev/null || true
            warn "existing mediamtx.yml differed - previous version kept as mediamtx.yml.bak"
        fi
    fi
    mv "$MTX_YML.new" "$MTX_YML"
    chmod 600 "$MTX_YML" 2>/dev/null || true
    ok "wrote $MTX_YML"
}

verify_chat() {
    step "Verifying the chat server starts"
    local log="$RUNTIME_DIR/verify-chat.log" pid i
    : > "$log"
    # Keep the real runtime environment (ADMIN_PATH/ADMIN_PASSWORD included)
    # so a verification run can never change which admin URL/password the
    # installed service will use. PORT=0 avoids fighting a live instance.
    (
        cd "$APP_DIR"
        export_runtime_env
        PORT=0
        export PORT
        exec "$NODE_BIN" "$APP_DIR/server.js"
    ) >"$log" 2>&1 &
    pid=$!

    i=0
    while [ "$i" -lt 60 ]; do
        kill -0 "$pid" 2>/dev/null || break
        grep -q 'Chat server running' "$log" 2>/dev/null && break
        sleep 0.1
        i=$((i + 1))
    done

    if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
        if grep -q 'Chat server running' "$log" 2>/dev/null; then
            ok "chat server boots cleanly"
        else
            cat "$log" >&2
            die "chat server did not report a clean start"
        fi
    else
        wait "$pid" 2>/dev/null || true
        cat "$log" >&2
        die "chat server failed to start"
    fi
    rm -f "$log"
}

verify_mediamtx() {
    [ "$DO_MTX" -eq 1 ] || return 0
    step "Verifying MediaMTX starts"
    local log="$RUNTIME_DIR/verify-mtx.log" pid
    : > "$log"
    (
        cd "$CONFIG_DIR"
        exec "$MTX_BIN" "$MTX_YML"
    ) >"$log" 2>&1 &
    pid=$!
    sleep 2

    if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
        ok "MediaMTX boots cleanly and accepted the config"
    elif grep -qiE 'address already in use|bind:|already listening' "$log" 2>/dev/null; then
        warn "ports already in use - MediaMTX is probably already running"
    else
        cat "$log" >&2
        die "MediaMTX failed to start"
    fi
    rm -f "$log"
}

# --------------------------------------------------------------- systemd

write_systemd_units() {
    step "Installing systemd units"
    setup_sudo
    systemd_available || die "systemd is not available on this machine; use --manual"

    run_root tee "/etc/systemd/system/$CHAT_SERVICE.service" >/dev/null <<EOF
[Unit]
Description=RTMP Chat (chat server + stream key admin)
After=network.target

[Service]
Type=simple
WorkingDirectory="$APP_DIR"
EnvironmentFile=-"$SERVICE_ENV_FILE"
ExecStart="$NODE_BIN" "$APP_DIR/server.js"
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

    if [ "$DO_MTX" -eq 1 ]; then
        run_root tee "/etc/systemd/system/$MTX_SERVICE.service" >/dev/null <<EOF
[Unit]
Description=MediaMTX (RTMP ingest, bundled with RTMP Chat)
Wants=$CHAT_SERVICE.service
After=network.target $CHAT_SERVICE.service

[Service]
Type=simple
WorkingDirectory="$CONFIG_DIR"
ExecStart="$MTX_BIN" "$MTX_YML"
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
    else
        if [ -f "/etc/systemd/system/$MTX_SERVICE.service" ]; then
            run_root systemctl disable --now "$MTX_SERVICE" >/dev/null 2>&1 || true
            run_root rm -f "/etc/systemd/system/$MTX_SERVICE.service"
        fi
    fi

    run_root systemctl daemon-reload
    run_root systemctl enable "$CHAT_SERVICE" >/dev/null 2>&1 || true
    if [ "$DO_START" -eq 1 ]; then
        run_root systemctl restart "$CHAT_SERVICE"
        if [ "$DO_MTX" -eq 1 ]; then
            run_root systemctl enable "$MTX_SERVICE" >/dev/null 2>&1 || true
            run_root systemctl restart "$MTX_SERVICE"
        fi
        ok "services installed and started"
    else
        if [ "$DO_MTX" -eq 1 ]; then
            run_root systemctl enable "$MTX_SERVICE" >/dev/null 2>&1 || true
        fi
        ok "services installed (not started: --no-start)"
    fi
}

remove_systemd_units() {
    local unit
    if ! systemd_units_exist; then
        return 0
    fi
    setup_sudo
    for unit in "$MTX_SERVICE" "$CHAT_SERVICE"; do
        if [ -f "/etc/systemd/system/$unit.service" ]; then
            run_root systemctl disable --now "$unit" >/dev/null 2>&1 || true
            run_root rm -f "/etc/systemd/system/$unit.service"
        fi
    done
    run_root systemctl daemon-reload >/dev/null 2>&1 || true
    ok "removed systemd units"
}

# --------------------------------------------------------------- processes

pid_is_ours() {
    local pid="$1" marker="$2"
    case "$pid" in
        ''|*[!0-9]*) return 1 ;;
    esac
    [ "$pid" -ge 2 ] || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    # /proc is not available on every Unix, but this project targets Linux.
    [ -r "/proc/$pid/cmdline" ] || return 0
    tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -Fq -- "$marker" 2>/dev/null
}

read_pid() {
    tr -cd '0-9' 2>/dev/null < "$1" || true
}

running() {
    local pidfile="$1" marker="$2" pid
    [ -f "$pidfile" ] || return 1
    pid="$(read_pid "$pidfile")"
    pid_is_ours "$pid" "$marker" || { rm -f "$pidfile"; return 1; }
    return 0
}

start_one() {
    local name="$1" pidfile="$2" marker="$3"; shift 3
    if running "$pidfile" "$marker"; then
        warn "$name already running (PID $(read_pid "$pidfile"))"
        return 0
    fi
    mkdir -p "$LOG_DIR"
    chmod 700 "$LOG_DIR" 2>/dev/null || true
    local log="$LOG_DIR/$name.log"
    if [ -f "$log" ] && [ "$(wc -c < "$log" 2>/dev/null || echo 0)" -gt 10485760 ]; then
        mv "$log" "$log.1" 2>/dev/null || true
    fi
    nohup "$@" >> "$log" 2>&1 &
    echo $! > "$pidfile"
    sleep 1
    if ! running "$pidfile" "$marker"; then
        printf '%sFAIL%s %s did not start:\n' "$RED" "$NC" "$name" >&2
        tail -30 "$log" >&2 || true
        return 1
    fi
    ok "$name started (PID $(read_pid "$pidfile"))"
}

stop_one() {
    local name="$1" pidfile="$2" marker="$3" pid i
    if ! running "$pidfile" "$marker"; then
        warn "$name is not running"
        rm -f "$pidfile"
        return 0
    fi
    pid="$(read_pid "$pidfile")"
    kill "$pid" 2>/dev/null || true
    i=0
    while [ "$i" -lt 20 ]; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.2
        i=$((i + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
    ok "$name stopped (PID $pid)"
}

start_chat_manual() {
    export_runtime_env
    start_one chat "$CHAT_PID_FILE" 'server.js' "$NODE_BIN" "$APP_DIR/server.js"
}

start_mtx_manual() {
    [ "$DO_MTX" -eq 1 ] || return 0
    [ -x "$MTX_BIN" ] && [ -f "$MTX_YML" ] || die "MediaMTX is not installed here (run install or use --no-mtx)"
    ( cd "$CONFIG_DIR" && start_one mediamtx "$MTX_PID_FILE" 'mediamtx' "$MTX_BIN" "$MTX_YML" )
}

start_manual_all() {
    start_chat_manual
    start_mtx_manual
}

stop_manual_all() {
    stop_one mediamtx "$MTX_PID_FILE" 'mediamtx' || true
    stop_one chat "$CHAT_PID_FILE" 'server.js' || true
}

health_ok() {
    [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || return 1
    "$NODE_BIN" -e '
        const http = require("http");
        const req = http.get({ host: "127.0.0.1", port: Number(process.argv[1]), path: "/healthz", timeout: 1200 }, (res) => {
            res.resume();
            process.exit(res.statusCode === 200 ? 0 : 1);
        });
        req.on("error", () => process.exit(1));
        req.on("timeout", () => { req.destroy(); process.exit(1); });
    ' "$PORT" >/dev/null 2>&1
}

wait_health() {
    local tries="${1:-40}" i=0
    while [ "$i" -lt "$tries" ]; do
        health_ok && return 0
        sleep 0.25
        i=$((i + 1))
    done
    return 1
}

effective_mode() {
    if [ "$MODE" = "systemd" ] || { [ -z "$MODE" ] && systemd_units_exist; }; then
        printf 'systemd'
    else
        printf 'manual'
    fi
}

ensure_installed() {
    [ -f "$STATE_FILE" ] || die "not installed yet - run ./rtmp-chat.sh install --systemd"
}

target_all() {
    case "${1:-all}" in
        chat) printf 'chat' ;;
        all)  printf 'all' ;;
        *)    die "unknown target '$1' (use chat or all)" ;;
    esac
}

# ------------------------------------------------------------------ install

cmd_install() {
    if [ "${1:-}" = "--uninstall" ]; then
        shift
        cmd_uninstall "$@"
        return
    fi

    local had_state=0
    if [ -f "$STATE_FILE" ]; then
        had_state=1
    fi
    load_state

    local force=0 do_verify=1 do_start=1 mode_set=0 p seen

    while [ $# -gt 0 ]; do
        case "$1" in
            --systemd)       MODE=systemd; mode_set=1; shift ;;
            --manual|--no-systemd) MODE=manual; mode_set=1; shift ;;
            --no-mtx)        DO_MTX=0; shift ;;
            --with-mtx)      DO_MTX=1; shift ;;
            --force)         force=1; shift ;;
            --no-verify)     do_verify=0; shift ;;
            --no-start)      do_start=0; shift ;;
            --no-webrtc)     WEBRTC_ENABLED=0; shift ;;
            --webrtc)        WEBRTC_ENABLED=1; shift ;;
            --port)          PORT="${2:?--port needs a value}"; shift 2 ;;
            --rtmp-port)     RTMP_PORT="${2:?--rtmp-port needs a value}"; shift 2 ;;
            --hls-port)      HLS_PORT="${2:?--hls-port needs a value}"; shift 2 ;;
            --webrtc-port)   WEBRTC_PORT="${2:?--webrtc-port needs a value}"; shift 2 ;;
            --api-port)      API_PORT="${2:?--api-port needs a value}"; shift 2 ;;
            --data-dir)      DATA_DIR="${2:?--data-dir needs a value}"; shift 2 ;;
            --stream-base)   STREAM_BASE="${2:?--stream-base needs a value}"; shift 2 ;;
            --rtmp-base)     RTMP_BASE="${2:?--rtmp-base needs a value}"; shift 2 ;;
            -h|--help)       usage; return 0 ;;
            *) die "unknown install option: $1 (try --help)" ;;
        esac
    done

    FORCE="$force"
    DO_START="$do_start"

    if [ "$mode_set" -eq 0 ]; then
        if [ "$had_state" -eq 0 ]; then
            if systemd_available && { [ "$(id -u)" -eq 0 ] || have sudo; }; then
                MODE=systemd
            else
                MODE=manual
            fi
        else
            [ -n "$MODE" ] || MODE=manual
        fi
    fi
    if [ "$MODE" = "systemd" ] && ! systemd_available; then
        die "systemd is not available here; re-run with --manual"
    fi
    if [ "$MODE" = "systemd" ]; then
        setup_sudo
    fi

    validate_port PORT "$PORT"
    validate_port RTMP_PORT "$RTMP_PORT"
    validate_port HLS_PORT "$HLS_PORT"
    validate_port WEBRTC_PORT "$WEBRTC_PORT"
    validate_port API_PORT "$API_PORT"
    validate_path_value APP_DIR "$APP_DIR"
    validate_path_value DATA_DIR "$DATA_DIR"
    validate_path_value STREAM_BASE "$STREAM_BASE"
    validate_path_value RTMP_BASE "$RTMP_BASE"
    validate_path_value ADMIN_PATH "${ADMIN_PATH:-}"
    validate_path_value ADMIN_PASSWORD "${ADMIN_PASSWORD:-}"
    validate_path_value DEFAULT_STREAM "${DEFAULT_STREAM:-}"
    if [ -n "$STREAM_BASE" ]; then
        STREAM_BASE="${STREAM_BASE%/}"
    fi
    if [ -n "$RTMP_BASE" ]; then
        RTMP_BASE="${RTMP_BASE%/}"
    fi

    if [ "$DO_MTX" -eq 1 ]; then
        seen=""
        for p in "$PORT" "$RTMP_PORT" "$HLS_PORT" "$WEBRTC_PORT" "$API_PORT"; do
            case " $seen " in
                *" $p "*) die "ports must be distinct; $p is configured twice" ;;
            esac
            seen="$seen $p"
        done
    fi

    case "$DATA_DIR" in
        /*) ;;
        *)  DATA_DIR="$APP_DIR/$DATA_DIR" ;;
    esac
    # Refuse destructive typos before creating anything (and long before
    # `uninstall --purge` could act on this value).
    guard_data_dir
    mkdir -p "$DATA_DIR"
    DATA_DIR="$(cd -- "$DATA_DIR" && pwd)"
    guard_data_dir

    printf '\n%sRTMP Chat - offline install%s\n' "$BOLD" "$NC"
    printf '    directory: %s\n' "$APP_DIR"
    printf '    platform:  linux-%s\n' "$(detect_node_arch)"
    printf '    mode:      %s\n' "$MODE"

    have tar || die "required tool not found: tar"
    have gzip || warn "gzip not found - MediaMTX cannot be unpacked"
    verify_bundle
    install_node_runtime
    install_node_modules
    install_mediamtx
    prepare_data
    write_mediamtx_config
    save_state
    save_env

    # Avoid two copies fighting over the same ports when switching modes.
    if [ "$MODE" = "manual" ] && systemd_units_exist; then
        warn "systemd units exist - removing them so manual mode owns the ports"
        remove_systemd_units
    fi
    if [ "$MODE" = "systemd" ]; then
        stop_manual_all
    fi

    if [ "$do_verify" -eq 1 ]; then
        verify_chat
        verify_mediamtx
    else
        step "Skipping boot verification (--no-verify)"
    fi

    if [ "$MODE" = "systemd" ]; then
        DO_START="$do_start"
        write_systemd_units
    else
        if [ "$do_start" -eq 1 ]; then
            start_manual_all
        else
            step "Installed (not started: --no-start)"
        fi
    fi

    if [ "$do_start" -eq 1 ]; then
        if wait_health; then
            ok "chat health check passed"
        else
            warn "chat health check did not answer yet - see ./rtmp-chat.sh logs"
        fi
    fi

    print_summary "$do_start"
}

print_summary() {
    local started="$1" admin_url password_path ip
    ip="$(primary_ip)"
    admin_url="$(admin_url_text "$ip")"
    password_path="$DATA_DIR/admin-password.txt"

    cat <<EOF

${GREEN}${BOLD}Install complete.${NC}

  Mode:       $MODE
  Chat:       http://$ip:$PORT/
  Admin:      $admin_url
  Streamer:   $(streamer_base_text "$ip")/<room>?key=<STREAM KEY>
  Viewer:     $(viewer_base_text "$ip")/live/<room>/

${BOLD}Admin password${NC}
EOF
    if [ -n "${ADMIN_PASSWORD:-}" ]; then
        printf '  %s  (from ADMIN_PASSWORD)\n' "$ADMIN_PASSWORD"
    elif [ -f "$password_path" ]; then
        printf '  %s  (saved in %s)\n' "$(cat "$password_path")" "$password_path"
    else
        printf '  (generated on first start - see data/admin-password.txt)\n'
    fi

    cat <<EOF

${BOLD}Manage it${NC}
  ./rtmp-chat.sh status
  ./rtmp-chat.sh logs
  ./rtmp-chat.sh restart
  ./rtmp-chat.sh doctor --full

EOF

    if [ "$DO_MTX" -eq 1 ]; then
        cat <<EOF
${BOLD}Stream keys are enforced.${NC} A publish without a valid key is rejected.
Create a key in the admin panel, then give the streamer:

  Server:     $(streamer_base_text "$ip")
  Stream Key: <room>?key=<THE KEY>

EOF
    else
        cat <<EOF
${BOLD}Note:${NC} --no-mtx was used, so MediaMTX was not installed and keys are
not enforced. Point your own MediaMTX at:
  POST http://127.0.0.1:$PORT/mediamtx/auth

EOF
    fi

    if [ "$started" -eq 0 ]; then
        printf 'Nothing was started. Start it with: ./rtmp-chat.sh start\n\n'
    fi
    if [ "$MODE" = "systemd" ]; then
        if [ "$DO_MTX" -eq 1 ]; then
            printf 'Services: systemctl status %s %s\n\n' "$CHAT_SERVICE" "$MTX_SERVICE"
        else
            printf 'Service:  systemctl status %s\n\n' "$CHAT_SERVICE"
        fi
    fi
}

# ------------------------------------------------------------------ runtime

primary_ip() {
    local ip=""
    if have hostname; then
        # Prefer the first IPv4 address; hostname -I also lists IPv6.
        ip="$(hostname -I 2>/dev/null | tr ' ' '\n' \
            | grep -E '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' \
            | grep -Ev '^(127\.|169\.254\.|0\.0\.0\.0$)' | head -1 || true)"
    fi
    [ -n "$ip" ] || ip="127.0.0.1"
    printf '%s' "$ip"
}

admin_path_text() {
    local path=""
    if [ -n "${ADMIN_PATH:-}" ]; then
        path="$ADMIN_PATH"
    elif [ -f "$DATA_DIR/admin-path.txt" ]; then
        path="$(tr -d '[:space:]' < "$DATA_DIR/admin-path.txt" 2>/dev/null || true)"
    fi
    # Match the characters stream-keys.js accepts, so a hand-edited file can
    # never inject a different URL into the status output.
    path="$(printf '%s' "$path" | tr -cd 'A-Za-z0-9._~-')"
    [ -n "$path" ] || return 1
    printf '/%s' "$path"
}

admin_url_text() {
    local ip="$1" path
    if path="$(admin_path_text)"; then
        printf 'http://%s:%s%s/' "$ip" "$PORT" "$path"
    else
        printf 'http://%s:%s/<admin path not generated yet>' "$ip" "$PORT"
    fi
}

viewer_base_text() {
    local ip="$1"
    if [ -n "$STREAM_BASE" ]; then
        printf '%s' "$STREAM_BASE"
    else
        printf 'http://%s:%s' "$ip" "$HLS_PORT"
    fi
}

streamer_base_text() {
    local ip="$1"
    if [ -n "$RTMP_BASE" ]; then
        printf '%s' "$RTMP_BASE"
    else
        printf 'rtmp://%s:%s/live' "$ip" "$RTMP_PORT"
    fi
}

cmd_start() {
    load_state
    ensure_installed
    local target mode
    target="$(target_all "${1:-all}")"
    mode="$(effective_mode)"
    export_runtime_env

    if [ "$mode" = "systemd" ]; then
        setup_sudo
        run_root systemctl start "$CHAT_SERVICE"
        if [ "$target" = "all" ] && [ "$DO_MTX" -eq 1 ]; then
            run_root systemctl start "$MTX_SERVICE"
        fi
        ok "systemd services started"
    else
        [ -n "$NODE_BIN" ] || die "Node not found - run ./rtmp-chat.sh install"
        start_chat_manual
        if [ "$target" = "all" ] && [ "$DO_MTX" -eq 1 ]; then
            start_mtx_manual
        fi
    fi
    if wait_health; then
        ok "chat health check passed"
    else
        warn "chat health check did not answer yet - see ./rtmp-chat.sh logs"
    fi
    printf '\n'
    cmd_urls
}

cmd_stop() {
    load_state
    local target mode
    target="$(target_all "${1:-all}")"
    mode="$(effective_mode)"

    if [ "$mode" = "systemd" ]; then
        setup_sudo
        if [ "$target" = "all" ] && [ "$DO_MTX" -eq 1 ]; then
            run_root systemctl stop "$MTX_SERVICE" >/dev/null 2>&1 || true
        fi
        run_root systemctl stop "$CHAT_SERVICE" >/dev/null 2>&1 || true
        ok "systemd services stopped"
    else
        if [ "$target" = "all" ] && [ "$DO_MTX" -eq 1 ]; then
            stop_one mediamtx "$MTX_PID_FILE" 'mediamtx' || true
        fi
        stop_one chat "$CHAT_PID_FILE" 'server.js' || true
    fi
}

cmd_restart() {
    cmd_stop "${1:-all}"
    cmd_start "${1:-all}"
}

cmd_status() {
    if [ ! -f "$STATE_FILE" ]; then
        printf '%sRTMP Chat is not installed.%s\n' "$YELLOW" "$NC"
        printf 'Run: sudo ./rtmp-chat.sh install --systemd\n'
        return 0
    fi
    load_state
    local mode ip admin
    mode="$(effective_mode)"
    ip="$(primary_ip)"
    admin="$(admin_url_text "$ip")"

    printf 'RTMP Chat\n'
    printf '  mode:      %s\n' "$mode"
    printf '  directory: %s\n' "$APP_DIR"
    printf '  data:      %s\n' "$DATA_DIR"
    printf '  chat:      http://%s:%s/\n' "$ip" "$PORT"
    printf '  admin:     %s\n' "$admin"
    if [ "$DO_MTX" -eq 1 ]; then
        printf '  streamer:  %s/<room>?key=<STREAM KEY>\n' "$(streamer_base_text "$ip")"
        printf '  viewer:    %s/live/<room>/\n' "$(viewer_base_text "$ip")"
    else
        printf '  streamer:  (MediaMTX not installed)\n'
    fi
    printf '\n'

    if [ "$mode" = "systemd" ]; then
        local unit state
        for unit in "$CHAT_SERVICE" "$MTX_SERVICE"; do
            [ "$unit" = "$MTX_SERVICE" ] && [ "$DO_MTX" -eq 0 ] && continue
            if [ ! -f "/etc/systemd/system/$unit.service" ]; then
                printf '  %-10s not installed\n' "$unit"
                continue
            fi
            if systemctl is-active --quiet "$unit" 2>/dev/null; then
                state="running"
            else
                state="stopped"
            fi
            printf '  %-10s %s\n' "$unit" "$state"
        done
    else
        if running "$CHAT_PID_FILE" 'server.js'; then
            printf '  chat       running (PID %s)\n' "$(read_pid "$CHAT_PID_FILE")"
        else
            printf '  chat       stopped\n'
        fi
        if [ "$DO_MTX" -eq 1 ]; then
            if running "$MTX_PID_FILE" 'mediamtx'; then
                printf '  mediamtx   running (PID %s)\n' "$(read_pid "$MTX_PID_FILE")"
            else
                printf '  mediamtx   stopped\n'
            fi
        fi
    fi

    if health_ok; then
        printf '  health     OK (HTTP %s/healthz)\n' "$PORT"
    else
        printf '  health     not reachable\n'
    fi
    printf '\n  logs:      ./rtmp-chat.sh logs\n'
}

cmd_logs() {
    load_state
    local target mode follow=1 arg
    target="all"
    for arg in "$@"; do
        case "$arg" in
            chat|all) target="$arg" ;;
            --no-follow|-n) follow=0 ;;
            *) die "unknown logs option: $arg" ;;
        esac
    done
    mode="$(effective_mode)"

    if [ "$mode" = "systemd" ]; then
        local args=(-u "$CHAT_SERVICE" -n 200)
        if [ "$target" = "all" ] && [ "$DO_MTX" -eq 1 ]; then
            args=(-u "$CHAT_SERVICE" -u "$MTX_SERVICE" -n 200)
        fi
        if [ "$follow" -eq 1 ]; then
            args+=(-f)
        fi
        # journalctl is readable without root on most installs; use sudo only
        # when it is available, otherwise let journalctl report the problem.
        if [ "$(id -u)" -ne 0 ] && have sudo; then
            SUDO=(sudo)
        fi
        run_root journalctl "${args[@]}"
    else
        mkdir -p "$LOG_DIR"
        local files=("$LOG_DIR/chat.log")
        if [ "$target" = "all" ] && [ "$DO_MTX" -eq 1 ]; then
            files+=("$LOG_DIR/mediamtx.log")
        fi
        local i
        for i in "${files[@]}"; do
            [ -f "$i" ] || : > "$i"
        done
        if [ "$follow" -eq 1 ]; then
            tail -n 200 -f "${files[@]}"
        else
            tail -n 200 "${files[@]}"
        fi
    fi
}

cmd_urls() {
    load_state
    local ip
    ip="$(primary_ip)"
    printf 'Chat:      http://%s:%s/\n' "$ip" "$PORT"
    printf 'Admin:     %s\n' "$(admin_url_text "$ip")"
    if [ "$DO_MTX" -eq 1 ]; then
        printf 'Viewer:    %s/live/<room>/\n' "$(viewer_base_text "$ip")"
        printf 'Streamer:  %s/<room>?key=<STREAM KEY>\n' "$(streamer_base_text "$ip")"
    else
        printf 'Viewer:    (MediaMTX not installed)\n'
        printf 'Streamer:  (MediaMTX not installed)\n'
    fi
}

cmd_credentials() {
    load_state
    if [ -z "${ADMIN_PASSWORD:-}" ] && [ -f "$ENV_FILE" ]; then
        # shellcheck disable=SC1090
        . "$ENV_FILE"
    fi
    local ip
    ip="$(primary_ip)"
    printf 'Admin URL: %s\n' "$(admin_url_text "$ip")"
    if [ -n "${ADMIN_PASSWORD:-}" ]; then
        printf 'Password:  %s\n' "$ADMIN_PASSWORD"
    elif [ -f "$DATA_DIR/admin-password.txt" ]; then
        printf 'Password:  %s\n' "$(cat "$DATA_DIR/admin-password.txt")"
    else
        printf 'Password:  (not generated yet - start the server once)\n'
    fi
    printf '\nKeep these private. The admin URL is not linked from the chat page.\n'
}

cmd_run() {
    load_state
    ensure_installed
    local with_mtx=0 arg
    for arg in "$@"; do
        case "$arg" in
            --with-mtx) with_mtx=1 ;;
            --help|-h) usage; return 0 ;;
            *) die "unknown run option: $arg" ;;
        esac
    done
    export_runtime_env
    if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
        die "Node not found - run ./rtmp-chat.sh install"
    fi

    if [ "$with_mtx" -eq 1 ]; then
        [ "$DO_MTX" -eq 1 ] || die "MediaMTX was not installed (--no-mtx)"
        [ -x "$MTX_BIN" ] || die "MediaMTX binary not found"
        (
            cd "$CONFIG_DIR"
            exec "$MTX_BIN" "$MTX_YML"
        ) &
        RUN_MTX_PID=$!
        cleanup_run_mtx() {
            if [ -n "${RUN_MTX_PID:-}" ]; then
                kill "$RUN_MTX_PID" 2>/dev/null || true
                RUN_MTX_PID=""
            fi
        }
        trap cleanup_run_mtx EXIT
        trap 'exit 130' INT
        trap 'exit 143' TERM
        sleep 1
        "$NODE_BIN" "$APP_DIR/server.js"
    else
        exec "$NODE_BIN" "$APP_DIR/server.js"
    fi
}

# ------------------------------------------------------------------ doctor

cmd_doctor() {
    load_state
    local full=0 arg failures=0
    for arg in "$@"; do
        case "$arg" in
            --full) full=1 ;;
            -h|--help) usage; return 0 ;;
            *) die "unknown doctor option: $arg" ;;
        esac
    done

    doctor_ok()   { printf '    %sOK%s   %s\n' "$GREEN" "$NC" "$1"; }
    doctor_warn() { printf '    %sWARN%s %s\n' "$YELLOW" "$NC" "$1"; }
    doctor_fail() { printf '    %sFAIL%s %s\n' "$RED" "$NC" "$1" >&2; failures=$((failures + 1)); }

    step "Offline integrity check"

    if [ -f "$DEPS_DIR/SHA256SUMS" ] && have sha256sum; then
        if ( cd "$DEPS_DIR" && sha256sum -c --quiet --ignore-missing SHA256SUMS ); then
            doctor_ok "deps/SHA256SUMS match"
        else
            doctor_fail "deps/SHA256SUMS do not match"
        fi
    else
        doctor_warn "cannot verify deps/SHA256SUMS (sha256sum or file missing)"
    fi

    local node="${NODE_BIN:-}"
    if [ -n "$node" ] && [ ! -x "$node" ]; then
        node=""
    fi
    if [ -z "$node" ] && [ -x "$RUNTIME_DIR/bin/node" ]; then
        node="$RUNTIME_DIR/bin/node"
    fi
    if [ -z "$node" ] && have node; then
        node="$(command -v node)"
    fi
    if [ -n "$node" ] && [ -x "$node" ]; then
        local major; major="$(node_major "$node")"
        if [ "$major" -ge "$MIN_NODE_MAJOR" ]; then
            doctor_ok "Node $("$node" -v) at $node"
        else
            doctor_fail "Node $("$node" -v) is older than $MIN_NODE_MAJOR"
        fi
        if ( cd "$APP_DIR" && NODE_PATH="$APP_DIR/node_modules" "$node" -e 'require("express"); require("ws")' ) >/dev/null 2>&1; then
            doctor_ok "express and ws load from node_modules"
        else
            doctor_fail "express/ws are missing - run ./rtmp-chat.sh install"
        fi
    elif find_bundled_node "$(detect_node_arch)" >/dev/null 2>&1; then
        doctor_fail "bundled Node is present but not unpacked - run ./rtmp-chat.sh install"
    else
        doctor_fail "no usable Node runtime found"
    fi

    if [ "$DO_MTX" -eq 1 ]; then
        if [ -z "${MTX_BIN:-}" ] && [ -x "$RUNTIME_DIR/mediamtx/mediamtx" ]; then
            MTX_BIN="$RUNTIME_DIR/mediamtx/mediamtx"
        fi
        if [ -z "${MTX_YML:-}" ] && [ -f "$CONFIG_DIR/mediamtx.yml" ]; then
            MTX_YML="$CONFIG_DIR/mediamtx.yml"
        fi
        if [ -n "${MTX_BIN:-}" ] && [ -x "$MTX_BIN" ]; then
            doctor_ok "MediaMTX binary present"
        else
            doctor_fail "MediaMTX binary missing - run install or use --no-mtx"
        fi
        if [ -n "${MTX_YML:-}" ] && [ -f "$MTX_YML" ]; then
            if grep -q '^authMethod: http' "$MTX_YML" && grep -q '127.0.0.1' "$MTX_YML"; then
                doctor_ok "mediamtx.yml gates publishes through this server"
            else
                doctor_fail "mediamtx.yml is missing the auth gate"
            fi
        else
            doctor_fail "config/mediamtx.yml is missing"
        fi
    else
        doctor_warn "MediaMTX is disabled (--no-mtx)"
    fi

    if [ -d "$DATA_DIR" ]; then
        local data_mode
        data_mode="$(stat -c '%a' "$DATA_DIR" 2>/dev/null || true)"
        if [ -z "$data_mode" ] || [ "$data_mode" = "700" ]; then
            doctor_ok "data directory is private"
        else
            doctor_warn "data directory mode is $data_mode (expected 700)"
        fi
        if [ -f "$DATA_DIR/admin-path.txt" ]; then
            doctor_ok "admin path generated"
        else
            doctor_warn "admin path not generated yet (first start does it)"
        fi
    else
        doctor_warn "data directory does not exist yet"
    fi

    local hits
    hits="$(grep -RInE 'https?://|//cdn|@import' "$APP_DIR/public" "$APP_DIR/admin" \
        --include='*.html' --include='*.css' --include='*.js' 2>/dev/null || true)"
    if [ -n "$hits" ]; then
        doctor_fail "external references found in the web UI:"
        printf '%s\n' "$hits" >&2
    else
        doctor_ok "web UI has no external assets or CDNs"
    fi

    if [ -f "$STATE_FILE" ]; then
        local run_mode
        run_mode="$(effective_mode)"
        if [ "$run_mode" = "systemd" ]; then
            if systemctl is-active --quiet "$CHAT_SERVICE" 2>/dev/null; then
                doctor_ok "rtmp-chat service is running"
            else
                doctor_warn "rtmp-chat service is not running"
            fi
            if [ "$DO_MTX" -eq 1 ]; then
                if systemctl is-active --quiet "$MTX_SERVICE" 2>/dev/null; then
                    doctor_ok "mediamtx service is running"
                else
                    doctor_warn "mediamtx service is not running"
                fi
            fi
        else
            if running "$CHAT_PID_FILE" 'server.js'; then
                doctor_ok "chat process is running"
            else
                doctor_warn "chat process is not running"
            fi
            if [ "$DO_MTX" -eq 1 ] && running "$MTX_PID_FILE" 'mediamtx'; then
                doctor_ok "mediamtx process is running"
            fi
        fi
        if health_ok; then
            doctor_ok "health endpoint answers on port $PORT"
        else
            doctor_warn "health endpoint is not reachable"
        fi
    else
        doctor_warn "not installed yet"
    fi

    if [ "$full" -eq 1 ]; then
        step "Running the offline smoke test"
        if [ -n "$node" ] && ( cd "$APP_DIR" && NODE_PATH="$APP_DIR/node_modules" "$node" "$APP_DIR/smoke-test.js" ); then
            doctor_ok "smoke test passed"
        else
            doctor_fail "smoke test failed"
        fi
    fi

    printf '\n'
    if [ "$failures" -eq 0 ]; then
        printf '%sNo blockers found.%s\n' "$GREEN" "$NC"
        return 0
    fi
    printf '%s%s check(s) failed.%s\n' "$RED" "$failures" "$NC"
    return 1
}

# ------------------------------------------------------------------ backup

cmd_backup() {
    load_state
    local stamp dir archive
    local args=()
    stamp="$(date +%Y%m%d-%H%M%S)"
    dir="$APP_DIR/backups"
    archive="$dir/rtmp-chat-$stamp.tar.gz"
    mkdir -p "$dir"
    chmod 700 "$dir" 2>/dev/null || true

    # tar accepts -C per member, so data may live outside APP_DIR.
    if [ -d "$CONFIG_DIR" ]; then
        args+=(-C "$APP_DIR" "config")
    fi
    if [ -d "$DATA_DIR" ]; then
        guard_data_dir
        args+=(-C "$(dirname -- "$DATA_DIR")" "$(basename -- "$DATA_DIR")")
    fi
    [ "${#args[@]}" -gt 0 ] || die "nothing to back up yet"
    if ! tar -czf "$archive" "${args[@]}" 2>/dev/null; then
        rm -f "$archive"
        die "backup failed"
    fi
    chmod 600 "$archive" 2>/dev/null || true
    ok "backup written to $archive"
}

# --------------------------------------------------------------- uninstall

cmd_uninstall() {
    load_state
    case "$DATA_DIR" in
        /*) ;;
        *)  DATA_DIR="$APP_DIR/$DATA_DIR" ;;
    esac
    if [ -d "$DATA_DIR" ]; then
        DATA_DIR="$(cd -- "$DATA_DIR" && pwd)"
    fi
    local purge=0 arg
    for arg in "$@"; do
        case "$arg" in
            --purge) purge=1 ;;
            -h|--help) usage; return 0 ;;
            *) die "unknown uninstall option: $arg" ;;
        esac
    done

    step "Uninstalling"
    remove_systemd_units
    stop_manual_all
    rm -rf "$RUNTIME_DIR" "$CONFIG_DIR" "$LOG_DIR"
    rm -f "$CHAT_PID_FILE"
    ok "removed services, .runtime/, config/ and logs/"

    if [ "$purge" -eq 1 ]; then
        guard_data_dir
        rm -rf "$DATA_DIR" "$APP_DIR/node_modules" "$APP_DIR/backups"
        ok "removed data/, node_modules/ and backups/ (--purge)"
    else
        printf '\n    Kept: %s (stream keys and admin credentials)\n' "$DATA_DIR"
        printf '    Remove it with: ./rtmp-chat.sh uninstall --purge\n\n'
    fi
}

# --------------------------------------------------------------------- main

main() {
    local cmd="${1:-}"
    if [ -z "$cmd" ]; then
        if [ -f "$STATE_FILE" ]; then
            cmd_status
        else
            usage
        fi
        return 0
    fi
    [ $# -gt 0 ] && shift

    case "$cmd" in
        install|setup)       cmd_install "$@" ;;
        start)               cmd_start "$@" ;;
        stop)                cmd_stop "$@" ;;
        restart)             cmd_restart "$@" ;;
        status)              cmd_status ;;
        logs)                cmd_logs "$@" ;;
        urls)                cmd_urls ;;
        credentials|admin)   cmd_credentials ;;
        doctor|verify)       cmd_doctor "$@" ;;
        backup)              cmd_backup ;;
        uninstall)           cmd_uninstall "$@" ;;
        run)                 cmd_run "$@" ;;
        help|-h|--help)      usage ;;
        *) die "unknown command '$cmd' (try --help)" ;;
    esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    main "$@"
fi
