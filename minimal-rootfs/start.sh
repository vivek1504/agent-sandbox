#!/bin/sh
set -e

[ -f /etc/profile ] && . /etc/profile 2>/dev/null || true
if [ -f /etc/environment ]; then
    export $(cat /etc/environment | grep -v '^#' | xargs) 2>/dev/null || true
fi

mount -t tmpfs tmpfs /tmp
mount -t tmpfs -o size=512m,mode=0755 tmpfs /workspace

ip link set eth0 up 2>/dev/null || true

ip addr add 192.168.241.2/29 dev eth0 2>/dev/null || true
ip route add default via 192.168.241.1 dev eth0 2>/dev/null || true

echo "nameserver 8.8.8.8" >/etc/resolv.conf 2>/dev/null || true
echo "nameserver 1.1.1.1" >>/etc/resolv.conf 2>/dev/null || true

ip -family inet neigh flush any 2>/dev/null || true
ip -family inet6 neigh flush any 2>/dev/null || true

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
