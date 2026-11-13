#!/bin/sh
set -eu
qemu-system-x86_64 -machine q35,accel=tcg -cpu max -smp 2 -m 3072 -nodefaults -no-reboot -display none -serial stdio -nic none \
  -sandbox on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny \
  -kernel /input/vmlinuz -initrd /input/initramfs.gz -append 'console=ttyS0 rdinit=/init panic=-1 quiet' \
  -drive file=/input/owned-root.img,format=raw,if=none,id=owned-disk -device virtio-blk-pci,drive=owned-disk,serial=codex-cow-fixture-01
