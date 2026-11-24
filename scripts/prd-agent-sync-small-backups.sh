#!/bin/sh
set -eu
umask 077
host=${1:?usage: sync-small-backups.sh SSH_HOST PRIVATE_MIRROR}
mirror=${2:?private mirror required}
script_root="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
mkdir -p "$mirror"
chmod 700 "$mirror"
lock="$mirror.sync-lock"
mkdir "$lock" 2>/dev/null || exit 0
trap 'rmdir "$lock" 2>/dev/null || true' EXIT
rsync -az --max-size=100m --chmod=Du=rwx,Dgo=,Fu=rw,Fgo= -e 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes' "$host:/root/backups/" "$mirror/"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$host" python3 - <<'PY' > "$mirror.inventory.json.tmp"
import pathlib,hashlib,json,os
root=pathlib.Path('/root/backups');rows=[]
for p in sorted(root.rglob('*')):
 if p.is_symlink():rows.append({'path':str(p.relative_to(root)),'symlink':os.readlink(p)});continue
 if not p.is_file() or p.stat().st_size>100*1024*1024:continue
 before=p.stat();h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(4*1024*1024),b''):h.update(b)
 after=p.stat()
 if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise RuntimeError('Backup changed during inventory')
 rows.append({'path':str(p.relative_to(root)),'bytes':after.st_size,'mtime':after.st_mtime,'sha256':h.hexdigest()})
print(json.dumps(rows))
PY
mv "$mirror.inventory.json.tmp" "$mirror.inventory.json"
python3 "$script_root/prd-agent-verify-offsite-backups.py" --inventory "$mirror.inventory.json" --mirror "$mirror" --source-host "$host" --receipt "$mirror.receipt.json"
scp -q -o BatchMode=yes -o StrictHostKeyChecking=yes "$mirror.receipt.json" "$host:/var/lib/llmgw/offsite-backup-receipt.json.tmp"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$host" 'chmod 600 /var/lib/llmgw/offsite-backup-receipt.json.tmp && mv /var/lib/llmgw/offsite-backup-receipt.json.tmp /var/lib/llmgw/offsite-backup-receipt.json'
