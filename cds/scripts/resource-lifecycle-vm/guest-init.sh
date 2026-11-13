#!/bin/sh
set -eu
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p /dev /proc /sys
mount -t devtmpfs devtmpfs /dev
mount -t proc proc /proc
mount -t sysfs sysfs /sys
modprobe virtio_pci; modprobe virtio_blk; modprobe xfs
[ "$(cat /sys/block/vda/serial)" = codex-cow-fixture-01 ] || { echo WRONG_FIXTURE; /bin/busybox poweroff -f; exit 1; }
mkdir -p /disk
if ! blkid /dev/vda; then mkfs.xfs -f /dev/vda; fi
mount /dev/vda /disk
if [ ! -f /disk/.fixture-root-prepared ]; then
  cp -a /usr /etc /bin /sbin /lib /lib64 /disk/
  mkdir -p /disk/proc /disk/sys /disk/run /disk/dev /disk/tmp /disk/data
  chmod 1777 /disk/tmp
  touch /disk/.fixture-root-prepared
fi
cp /driver.mjs /alpine.tar /disk-resource-native.py /backup-retention-native.py /init-real /disk/
mount --move /proc /disk/proc
mount --move /sys /disk/sys
mount --move /dev /disk/dev
exec /bin/busybox switch_root /disk /init-real
