FROM alpine:3.20

RUN apk add --no-cache \
    busybox \
    socat \
    curl \
    git \
    ca-certificates \
    nodejs \
    tini \
    && rm -rf /var/cache/apk/*

COPY minimal-rootfs/start.sh /start.sh
COPY minimal-rootfs/runtime/runtime.js /runtime/runtime.js

RUN chmod +x /start.sh \
    && mkdir -p /workspace /tmp \
    && ln -sf /sbin/tini /init \
    && ln -sf /usr/bin/node /bin/node \
    && ln -sf /usr/bin/socat /bin/socat

