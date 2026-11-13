#!/bin/sh
set -eu
: "${DEEPAUDIT_ADMIN_USERNAME:?Set the dedicated management username}"
: "${DEEPAUDIT_ADMIN_PASSWORD_HASH:?Set an htpasswd bcrypt hash for the management interface}"
case "$DEEPAUDIT_ADMIN_USERNAME" in *[!A-Za-z0-9_.-]*|'') echo 'Invalid management username' >&2; exit 1;; esac
case "$DEEPAUDIT_ADMIN_PASSWORD_HASH" in '$2y$'*|'$2b$'*) ;; *) echo 'Management password requires a bcrypt htpasswd hash' >&2; exit 1;; esac
umask 077
printf '%s:%s\n' "$DEEPAUDIT_ADMIN_USERNAME" "$DEEPAUDIT_ADMIN_PASSWORD_HASH" > /etc/nginx/.cds-htpasswd
# nginx workers need read permission; only this container receives the file.
chmod 644 /etc/nginx/.cds-htpasswd
