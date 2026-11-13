#!/bin/sh
set -eu
mkdir -p /extra
if [ -d /guest-layer ]; then cp -a /guest-layer/. /extra/; fi
cp /input/driver.mjs /input/disk-resource-native.py /input/backup-retention-native.py /input/alpine.tar /extra/
cp /input/guest-init.sh /extra/init
cp /input/init-real /extra/init-real
(cd /extra && find . -print0 | cpio --null -o -H newc 2>/dev/null | gzip -1) > /input/extra.gz
cat /vm/initramfs.gz /input/extra.gz > /input/initramfs.gz
cp /vm/vmlinuz /input/vmlinuz
