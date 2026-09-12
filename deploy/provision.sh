#!/usr/bin/env bash
#
# Provision a Debian/Ubuntu host to run agent-sandbox.
#
# Idempotent: safe to re-run. Every step checks for its own result first, so a
# partial run can simply be repeated.
#
#   sudo ./deploy/provision.sh                        # host setup only
#   sudo ./deploy/provision.sh --templates "node"     # also build templates
#   sudo ./deploy/provision.sh --install-service      # also install systemd unit
#   sudo ./deploy/provision.sh --skip-build           # re-provision, keep dist/
#
# What it deliberately does NOT do:
#   - create API keys (they must be created while the server is stopped; use
#     deploy/create-key.sh)
#   - start the service (you want to review the env file first)
#   - open any firewall port (the server speaks plain HTTP; keep it on loopback)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ARTIFACTS_DIR="${FIRECRACKER_ARTIFACTS_DIR:-/var/lib/agent-sandbox/artifacts}"
KERNEL_URL="${KERNEL_URL:-https://github.com/vivek1504/agent-sandbox/releases/download/Beta/vmlinux}"
FC_UID="${FIRECRACKER_UID:-997}"
FC_GID="${FIRECRACKER_GID:-982}"
SERVICE_USER="${SERVICE_USER:-$(stat -c '%U' "${PROJECT_ROOT}")}"
CONFIG_DIR=/etc/agent-sandbox

SKIP_PACKAGES=0
SKIP_KVM_CHECK=0
SKIP_BUILD=0
INSTALL_SERVICE=0
TEMPLATES=""

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
}

while [ $# -gt 0 ]; do
    case "$1" in
        --skip-packages)   SKIP_PACKAGES=1 ;;
        --skip-kvm-check)  SKIP_KVM_CHECK=1 ;;
        --skip-build)      SKIP_BUILD=1 ;;
        --install-service) INSTALL_SERVICE=1 ;;
        --templates)       TEMPLATES="${2:-}"; shift ;;
        -h|--help)         usage ;;
        *)                 die "unknown argument: $1 (try --help)" ;;
    esac
    shift
done

[ "$(id -u)" -eq 0 ] || die "run as root: sudo $0 $*"

# ---------------------------------------------------------------------------
# 1. Hardware virtualisation
# ---------------------------------------------------------------------------
if [ "${SKIP_KVM_CHECK}" -eq 0 ]; then
    if [ ! -e /dev/kvm ]; then
        die "/dev/kvm is missing. Firecracker needs hardware virtualisation.
On AWS this means a bare-metal (*.metal) instance — KVM is not exposed on
normal Nitro instances. On most other VPS providers, ask support to enable
nested virtualisation. Re-run with --skip-kvm-check only to stage a host you
will not actually run VMs on."
    fi
    log "/dev/kvm present"
fi

# ---------------------------------------------------------------------------
# 2. Packages
# ---------------------------------------------------------------------------
if [ "${SKIP_PACKAGES}" -eq 0 ]; then
    log "installing packages"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq \
        ca-certificates curl git iproute2 iptables e2fsprogs \
        dnsmasq-base docker.io jq

    if ! command -v node >/dev/null 2>&1; then
        log "installing Node.js 22"
        curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
        apt-get install -y -qq nodejs
    fi

    # The sandbox starts one dnsmasq per microVM. A system-wide resolver holding
    # port 53 collides with them, so the packaged service is disabled (the
    # binary from dnsmasq-base is what we actually need).
    if systemctl list-unit-files 2>/dev/null | grep -q '^dnsmasq\.service'; then
        systemctl disable --now dnsmasq >/dev/null 2>&1 || true
        log "disabled system-wide dnsmasq (per-VM instances are spawned by the server)"
    fi
else
    log "skipping package installation"
fi

command -v docker >/dev/null 2>&1 || die "docker is required for template builds"
command -v node   >/dev/null 2>&1 || die "node is required (v20+)"

NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "${NODE_MAJOR}" -ge 20 ] || die "node v20+ required, found v${NODE_MAJOR}"
log "node ${NODE_BIN} ($(node -v))"

# ---------------------------------------------------------------------------
# 3. Firecracker + jailer
# ---------------------------------------------------------------------------
if command -v firecracker >/dev/null 2>&1 && command -v jailer >/dev/null 2>&1; then
    log "firecracker already installed ($(firecracker --version | head -1))"
else
    log "installing firecracker and jailer"
    ARCH="$(uname -m)"
    RELEASE_URL="https://github.com/firecracker-microvm/firecracker/releases"
    LATEST="$(basename "$(curl -fsSLI -o /dev/null -w '%{url_effective}' "${RELEASE_URL}/latest")")"
    TMP="$(mktemp -d)"
    trap 'rm -rf "${TMP}"' EXIT

    curl -fsSL "${RELEASE_URL}/download/${LATEST}/firecracker-${LATEST}-${ARCH}.tgz" \
        | tar -xz -C "${TMP}"
    install -m 0755 "${TMP}/release-${LATEST}-${ARCH}/firecracker-${LATEST}-${ARCH}" /usr/local/bin/firecracker
    install -m 0755 "${TMP}/release-${LATEST}-${ARCH}/jailer-${LATEST}-${ARCH}"      /usr/local/bin/jailer
    rm -rf "${TMP}"
    trap - EXIT
    log "installed $(firecracker --version | head -1)"
fi

# ---------------------------------------------------------------------------
# 4. Unprivileged user the jailer drops into
# ---------------------------------------------------------------------------
# The UID/GID are not arbitrary: they are the defaults src/vm/jailer.ts passes to
# the jailer. Override with FIRECRACKER_UID/FIRECRACKER_GID in both places or
# neither.
if ! getent group firecracker >/dev/null; then
    groupadd -g "${FC_GID}" firecracker
    log "created group firecracker (gid ${FC_GID})"
fi
if ! getent passwd firecracker >/dev/null; then
    # -r marks it a system account, which also suppresses the UID_MIN warning
    # useradd would otherwise print for an explicit uid below 1000.
    useradd -r -u "${FC_UID}" -g "${FC_GID}" -M -s /usr/sbin/nologin firecracker
    log "created user firecracker (uid ${FC_UID})"
fi

# ---------------------------------------------------------------------------
# 5. IPv4 forwarding (guest internet access)
# ---------------------------------------------------------------------------
# Not fatal: on container-backed or otherwise restricted hosts /proc/sys is
# read-only, and the operator needs to be told rather than have provisioning
# abort after every other step has already succeeded.
if sysctl -qw net.ipv4.ip_forward=1 2>/dev/null; then
    printf 'net.ipv4.ip_forward = 1\n' > /etc/sysctl.d/99-agent-sandbox.conf
    log "ipv4 forwarding enabled"
else
    warn "could not set net.ipv4.ip_forward — guests will have no internet access.
     On a restricted host, set it from the hypervisor side or ask the provider."
fi

# ---------------------------------------------------------------------------
# 6. Artifacts directory and guest kernel
# ---------------------------------------------------------------------------
mkdir -p "${ARTIFACTS_DIR}"
if [ -f "${ARTIFACTS_DIR}/vmlinux" ]; then
    log "guest kernel already present"
else
    log "downloading guest kernel"
    curl -fsSL "${KERNEL_URL}" -o "${ARTIFACTS_DIR}/vmlinux"
fi
chown -R "root:firecracker" "${ARTIFACTS_DIR}"
chmod 750 "${ARTIFACTS_DIR}"
log "artifacts at ${ARTIFACTS_DIR}"

# ---------------------------------------------------------------------------
# 7. Build the project
# ---------------------------------------------------------------------------
if [ "${SKIP_BUILD}" -eq 0 ]; then
    if [ ! -d "${PROJECT_ROOT}/node_modules" ]; then
        log "installing npm dependencies"
        sudo -u "${SERVICE_USER}" -H bash -lc "cd '${PROJECT_ROOT}' && npm install"
    fi
    # Built as the repo's owner rather than root: a root-owned dist/ breaks the
    # next plain `npm run build` the operator runs.
    log "compiling TypeScript"
    sudo -u "${SERVICE_USER}" -H bash -lc "cd '${PROJECT_ROOT}' && npm run build"
else
    log "skipping npm install/build"
fi

# ---------------------------------------------------------------------------
# 8. Config directory and env file
# ---------------------------------------------------------------------------
mkdir -p "${CONFIG_DIR}"
if [ ! -f "${CONFIG_DIR}/sandbox.env" ]; then
    install -m 0640 "${SCRIPT_DIR}/sandbox.env.example" "${CONFIG_DIR}/sandbox.env"
    log "wrote ${CONFIG_DIR}/sandbox.env — review it before starting the service"
else
    log "${CONFIG_DIR}/sandbox.env already exists, left untouched"
fi

# ---------------------------------------------------------------------------
# 9. Templates (optional — these take several minutes each)
# ---------------------------------------------------------------------------
if [ -n "${TEMPLATES}" ]; then
    for tpl in ${TEMPLATES}; do
        log "building template: ${tpl}"
        # build.sh must run as root and resolves its own node; NODE_BIN is
        # passed because sudo's secure_path hides a node installed under a user
        # home (nvm, fnm, volta).
        NODE_BIN="${NODE_BIN}" "${PROJECT_ROOT}/templates/build.sh" "${tpl}"
    done
    warn "rebuilding any template rebuilds the shared base image — rebuild ALL templates you use, or the others are left stale"
fi

# ---------------------------------------------------------------------------
# 10. systemd unit (optional)
# ---------------------------------------------------------------------------
if [ "${INSTALL_SERVICE}" -eq 1 ]; then
    log "installing systemd unit"
    mkdir -p /etc/systemd/system
    sed -e "s|@PROJECT_ROOT@|${PROJECT_ROOT}|g" \
        -e "s|@NODE_BIN@|${NODE_BIN}|g" \
        "${SCRIPT_DIR}/agent-sandbox.service" > /etc/systemd/system/agent-sandbox.service

    # The unit is written either way; only activation needs systemd to be the
    # running init (it is not, inside a container or a chroot).
    if command -v systemctl >/dev/null 2>&1; then
        systemctl daemon-reload
        systemctl enable agent-sandbox >/dev/null
        log "unit installed and enabled (not started)"
    else
        warn "systemctl not available — unit written to /etc/systemd/system/agent-sandbox.service but not enabled"
    fi
fi

cat <<EOF

$(log "provisioning complete")

Next steps:

  1. Review the configuration:
       \$EDITOR ${CONFIG_DIR}/sandbox.env

  2. Build at least one template (if you did not pass --templates):
       sudo ${PROJECT_ROOT}/templates/build.sh node

  3. Create an API key. The key store is read once at process start, so this
     must happen while the server is stopped — deploy/create-key.sh handles the
     stop/create/start cycle for you:
       sudo ${SCRIPT_DIR}/create-key.sh my-key exec,admin,metrics

  4. Start it:
       sudo systemctl start agent-sandbox
       sudo journalctl -u agent-sandbox -f

  5. From your workstation, tunnel rather than exposing the port — the server
     speaks plain HTTP and the API key is a bearer token:
       ssh -N -L 3000:localhost:3000 ${SERVICE_USER}@<host>

EOF
