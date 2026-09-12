#!/usr/bin/env bash
#
# Create an API key safely on a host where agent-sandbox runs under systemd.
#
#   sudo ./deploy/create-key.sh <name> [scopes]
#   sudo ./deploy/create-key.sh webui exec,admin,metrics
#
# Why this script exists rather than calling the CLI directly:
#
#   The key store is read ONCE at process start and never re-read. A key created
#   while the server is running is invisible to it — every request with that key
#   answers 401 until a restart, which reads like a bad key rather than a stale
#   process. So: stop, create, start.
#
# The key is printed once and only its hash is stored. There is no way to
# recover it afterwards; losing it means creating another.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SERVICE="${SERVICE:-agent-sandbox}"

NAME="${1:-}"
SCOPES="${2:-exec}"

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ -n "${NAME}" ] || die "usage: sudo $0 <name> [scopes]   (scopes: exec,admin,metrics)"
[ "$(id -u)" -eq 0 ] || die "run as root: sudo $0 $*"
[ -f "${PROJECT_ROOT}/dist/auth/cli.js" ] || die "dist/auth/cli.js missing — run 'npm run build' first"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -n "${NODE_BIN}" ] || die "node not found. Pass it explicitly: NODE_BIN=/path/to/node sudo $0 $*"

WAS_ACTIVE=0
if systemctl is-active --quiet "${SERVICE}" 2>/dev/null; then
    WAS_ACTIVE=1
    log "stopping ${SERVICE} (the key store is only read at startup)"
    systemctl stop "${SERVICE}"
fi

# Restart the service even if key creation fails, so a typo does not leave the
# host with the sandbox down.
restore_service() {
    if [ "${WAS_ACTIVE}" -eq 1 ]; then
        log "starting ${SERVICE}"
        systemctl start "${SERVICE}"
    fi
}
trap restore_service EXIT

log "creating key '${NAME}' with scopes: ${SCOPES}"
cd "${PROJECT_ROOT}"
"${NODE_BIN}" dist/auth/cli.js create "${NAME}" --scopes "${SCOPES}"

cat <<EOF

Copy the key above now — only its hash is stored on disk.

Verify once the service is back up:

  curl -s -H "Authorization: Bearer <key>" http://localhost:${PORT:-3000}/exec/templates

EOF
