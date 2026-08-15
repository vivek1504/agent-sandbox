#!/bin/bash
set -euo pipefail

TEMPLATE=${1:-node}
ARTIFACTS_DIR=${FIRECRACKER_ARTIFACTS_DIR:-/var/lib/agent-sandbox/artifacts}
TEMPLATE_DIR="${ARTIFACTS_DIR}/templates/${TEMPLATE}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "=== Building template: ${TEMPLATE} ==="

echo "[1/4] Building base Docker image..."
docker build --no-cache -t agent-sandbox-base \
  -f "${SCRIPT_DIR}/base/Dockerfile" \
  "${PROJECT_ROOT}"

echo "[2/4] Building ${TEMPLATE} Docker image..."
docker build --no-cache -t "agent-sandbox-${TEMPLATE}" \
  -f "${SCRIPT_DIR}/${TEMPLATE}/Dockerfile" \
  "${PROJECT_ROOT}"

echo "[3/4] Exporting rootfs.ext4..."
ROOTFS_SIZE=${ROOTFS_SIZE:-1024} 
ROOTFS_PATH="/tmp/rootfs-${TEMPLATE}.ext4"

if mountpoint -q /tmp/mnt-* 2>/dev/null || grep -q "${ROOTFS_PATH}" /proc/mounts 2>/dev/null; then
  umount -l "${ROOTFS_PATH}" 2>/dev/null || true
fi

dd if=/dev/zero of="${ROOTFS_PATH}" bs=1M count=${ROOTFS_SIZE}
mkfs.ext4 -F "${ROOTFS_PATH}"

MOUNT_DIR=$(mktemp -d /tmp/mnt-XXXXXX)
cleanup() {
  if mountpoint -q "${MOUNT_DIR}" 2>/dev/null; then
    umount -l "${MOUNT_DIR}" 2>/dev/null || true
  fi
  rm -rf "${MOUNT_DIR}"
}
trap cleanup EXIT

mount -o loop "${ROOTFS_PATH}" "${MOUNT_DIR}"

CONTAINER_ID=$(docker create "agent-sandbox-${TEMPLATE}")
docker export "${CONTAINER_ID}" | tar -x -C "${MOUNT_DIR}"
docker rm "${CONTAINER_ID}" > /dev/null

umount "${MOUNT_DIR}"
trap - EXIT
rmdir "${MOUNT_DIR}"


echo "[4/4] Creating Firecracker snapshot..."
mkdir -p "${TEMPLATE_DIR}"
cp "${ROOTFS_PATH}" "${TEMPLATE_DIR}/rootfs.ext4"
rm "${ROOTFS_PATH}"

cd "${PROJECT_ROOT}"
npx tsc -b
sudo rm -rf "/var/lib/agent-sandbox/jailer/firecracker/snap-${TEMPLATE}"
sudo node dist/create_snapshot.js "${TEMPLATE}" "${TEMPLATE_DIR}/rootfs.ext4"

echo "=== Template '${TEMPLATE}' ready at ${TEMPLATE_DIR} ==="
ls -lh "${TEMPLATE_DIR}"
