# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS node
FROM debian:bookworm-slim
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN --mount=type=secret,id=ca_bundle \
    if [ -f /run/secrets/ca_bundle ]; then export APT_CA="-o Acquire::https::CaInfo=/run/secrets/ca_bundle"; fi; \
    apt-get ${APT_CA:-} update && DEBIAN_FRONTEND=noninteractive apt-get ${APT_CA:-} install -y --no-install-recommends \
    python3 xfsprogs util-linux linux-image-amd64 busybox-static cpio gzip kmod docker.io git docker-registry \
    libstdc++6 libatomic1 libssl3 ca-certificates && rm -rf /var/lib/apt/lists/*
RUN cp /usr/bin/docker-registry /usr/local/bin/registry && mkdir -p /vm && cp /boot/vmlinuz-* /vm/vmlinuz && \
    (find . -xdev \( -path ./proc -o -path ./sys -o -path ./dev -o -path ./vm -o -path ./boot -o -path ./usr/share/doc -o -path ./usr/share/man \) -prune -o -print0 | cpio --null -o --format=newc | gzip -1 > /vm/initramfs.gz)
RUN --mount=type=secret,id=ca_bundle \
    if [ -f /run/secrets/ca_bundle ]; then export APT_CA="-o Acquire::https::CaInfo=/run/secrets/ca_bundle"; fi; \
    apt-get ${APT_CA:-} update && DEBIAN_FRONTEND=noninteractive apt-get ${APT_CA:-} install -y --no-install-recommends qemu-system-x86 && rm -rf /var/lib/apt/lists/*
