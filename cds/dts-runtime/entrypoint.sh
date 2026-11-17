#!/bin/sh
set -eu
umask 077
mkdir -p /data
chown node:node /data
exec gosu node node /runtime/bootstrap.mjs
