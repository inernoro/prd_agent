#!/usr/bin/env python3
"""Reproduce native drills without host root, host devices or privileged Docker.

Requires local Docker, pnpm and installed CDS dependencies. All mutations occur
in a new file-backed VM. Evidence and the disk are preserved for review.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import shutil
import stat
import subprocess
import tempfile
import time
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('mode', choices=['resources', 'images', 'backups'])
parser.add_argument('--cycles', type=int, default=40)
parser.add_argument('--base-image', help='Explicit prebuilt compatible Debian /vm image; otherwise build the public recipe')
parser.add_argument('--ca-bundle', type=pathlib.Path, help='Optional build-time CA secret, never written into the guest')
parser.add_argument('--output-parent', type=pathlib.Path, default=pathlib.Path(tempfile.gettempdir()))
args = parser.parse_args()
if not 1 <= args.cycles <= 1000:
    parser.error('--cycles must be 1..1000')
here = pathlib.Path(__file__).resolve().parent
repo = here.parents[2]
parent = args.output_parent.absolute()
if parent.resolve() != parent or parent == repo or repo in parent.parents:
    parser.error('Evidence parent must be a canonical directory outside the repository')
parent.mkdir(parents=True, exist_ok=True)
work = pathlib.Path(tempfile.mkdtemp(prefix='cds-native-'+args.mode+'-', dir=parent))
workspace_identity = (work.stat().st_dev, work.stat().st_ino)
owner = 'cds-native-'+uuid.uuid4().hex
image = args.base_image or 'cds-resource-native-vm:bookworm-node24'
driver = {'resources': 'resource-lifecycle-native-drill.ts', 'images': 'image-cache-native-drill.ts', 'backups': 'backup-mount-native-drill.ts'}[args.mode]
manifest = {'provenance': 'integration-live', 'mode': args.mode, 'cycles': args.cycles if args.mode == 'resources' else None,
            'owner': owner, 'baseImage': image, 'startedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'passed': False}
print('Evidence: '+str(work), flush=True)
def run(command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)
if not args.base_image:
    command = ['docker', 'build', '-t', image, '-f', str(here/'Dockerfile')]
    if args.ca_bundle:
        command += ['--secret', 'id=ca_bundle,src='+str(args.ca_bundle.resolve(strict=True))]
    run(command+[str(here)])
manifest['baseImageId'] = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{.Id}}', image], text=True).strip()
manifest['sourceHead'] = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
run(['pnpm', '-C', str(repo/'cds'), 'exec', 'esbuild', 'scripts/'+driver, '--bundle', '--platform=node', '--format=esm', '--packages=external', '--outfile='+str(work/'driver.mjs')])
for name in ['disk-resource-native.py', 'backup-retention-native.py']:
    shutil.copy2(repo/'cds/src/services'/name, work/name)
for name in ['prepare.sh', 'guest-init.sh', 'run.sh']:
    shutil.copy2(here/name, work/name)
run(['docker', 'image', 'inspect', 'alpine:3.21'], stdout=subprocess.DEVNULL)
run(['docker', 'save', '-o', str(work/'alpine.tar'), 'alpine:3.21'])
(work/'owned-root.img').touch(mode=0o600)
with (work/'owned-root.img').open('r+b') as disk:
    disk.truncate(8*1024**3)
extra = "if [ -f /data/reboot-checkpoint.json ]; then node /driver.mjs --after-reboot; else node /driver.mjs; fi" if args.mode == 'resources' else 'node /driver.mjs'
(work/'init-real').write_text('''#!/bin/sh
set -eu
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin DOCKER_API_VERSION=1.41 CDS_NATIVE_RESOURCE_DRILL=1
export CDS_DRILL_CYCLES='''+str(args.cycles)+'''
mount --make-rprivate /
/bin/busybox ip link set lo up
mkdir -p /dev/pts /sys/fs/cgroup /run /data /var
mount -t tmpfs tmpfs /run
[ -e /var/run ] || ln -s /run /var/run
mount -t devpts devpts /dev/pts
mount -t cgroup2 cgroup2 /sys/fs/cgroup
dockerd --data-root=/data/docker --exec-root=/run/outer-docker --pidfile=/run/outer-docker.pid --host=unix:///run/docker.sock --storage-driver=vfs --iptables=false --bridge=none --exec-opt native.cgroupdriver=cgroupfs > /data/docker.log 2>&1 &
i=0
until timeout 10 docker info >/dev/null 2>&1; do sleep 1; i=$((i+1)); [ "$i" -lt 45 ] || exit 1; done
docker image inspect alpine:3.21 >/dev/null 2>&1 || docker load -i /alpine.tar
'''+extra+'''
sync
kill $(cat /run/outer-docker.pid)
sleep 2
/bin/busybox poweroff -f
''')
for name in ['guest-init.sh', 'init-real']:
    (work/name).chmod(0o755)
bind = ['--mount', 'type=bind,source='+str(work)+',target=/input']
run(['docker', 'run', '--rm', '--network', 'none', '--cpus', '2', '--memory', '2g', *bind, '--entrypoint', 'sh', image, '/input/prepare.sh'])
large_artifacts = {name: (work/name).lstat() for name in ['owned-root.img', 'alpine.tar', 'extra.gz', 'initramfs.gz', 'vmlinuz']}
def stop_own():
    observed = subprocess.run(['docker', 'inspect', owner], capture_output=True, text=True)
    if observed.returncode == 0:
        assert json.loads(observed.stdout)[0]['Config']['Labels'].get('cds.acceptance.owner') == owner
        run(['docker', 'kill', '--signal', 'KILL', owner], stdout=subprocess.DEVNULL)
try:
    for phase in ['before-reboot', 'after-reboot']:
        log = work/(phase+'.log')
        with log.open('w') as output:
            process = subprocess.Popen(['docker', 'run', '--rm', '--name', owner, '--label', 'cds.acceptance.owner='+owner, '--label', 'cds.resource.lease-until='+(dt.datetime.now(dt.timezone.utc)+dt.timedelta(hours=2)).isoformat(), '--network', 'none', '--memory', '4g', '--cpus', '2', *bind, '--entrypoint', 'sh', image, '/input/run.sh'], stdout=output, stderr=subprocess.STDOUT)
            announced = time.monotonic()
            while process.poll() is None:
                body = log.read_text(errors='replace')
                if phase == 'before-reboot' and 'REBOOT_READY' in body:
                    stop_own();process.wait();break
                if time.monotonic()-announced > 45:
                    print('Running '+phase+'; native evidence remains in '+str(log), flush=True);announced = time.monotonic()
                time.sleep(.5)
        body = log.read_text(errors='replace')
        if 'REBOOT_READY' in body and phase == 'before-reboot':
            continue
        if process.returncode or 'DRILL_COMPLETE' not in body:
            raise RuntimeError('Native drill did not pass; preserved evidence: '+str(log))
        manifest['passed'] = True
        break
finally:
    stop_own()
    manifest['artifactRetirement'] = []
    if manifest['passed']:
        # Preserve bounded evidence, not another permanent VM/registry cache.
        assert work.resolve() == work and (work.stat().st_dev, work.stat().st_ino) == workspace_identity
        fd = os.open(work, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for name, before in large_artifacts.items():
                current = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if not stat.S_ISREG(current.st_mode) or current.st_nlink != 1 or (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino):
                    manifest['artifactRetirement'].append({'name': name, 'result': 'held-identity-unconfirmed'})
                    continue
                os.unlink(name, dir_fd=fd)
                manifest['artifactRetirement'].append({'name': name, 'result': 'removed'})
            os.fsync(fd)
        finally:
            os.close(fd)
    manifest['driverSha256'] = hashlib.sha256((work/'driver.mjs').read_bytes()).hexdigest()
    manifest['finishedAt'] = dt.datetime.now(dt.timezone.utc).isoformat()
    (work/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
print(json.dumps(manifest), flush=True)
