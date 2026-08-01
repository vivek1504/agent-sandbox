#!/bin/sh
set -e

mount -t tmpfs tmpfs /tmp
mount -t tmpfs -o size=32m,mode=0755 tmpfs /workspace

rm -f /tmp/runtime.sock

/bin/node /runtime/runtime.js &

NODE_PID=$!

while [ ! -S /tmp/runtime.sock ]; do
    sleep 0.05
done

/bin/socat \
    VSOCK-LISTEN:5000,fork \
    UNIX-CONNECT:/tmp/runtime.sock &

echo "READY"

wait $NODE_PID
