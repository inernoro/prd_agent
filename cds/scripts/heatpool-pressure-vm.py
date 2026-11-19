#!/usr/bin/env python3
"""Offline file-backed Linux VM; no host devices, credentials or privileged Docker."""
import argparse
import datetime
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
parser.add_argument('--expected-daemon-name', required=True)
parser.add_argument('--expected-docker-root', required=True)
parser.add_argument('--base-image', default='cds-resource-native-vm:bookworm-node24')
parser.add_argument('--output-parent', type=pathlib.Path, required=True)
parser.add_argument('--exercise-driver-failure', action='store_true')
args = parser.parse_args()
repo = pathlib.Path(__file__).resolve().parents[2]
parent = args.output_parent.absolute()
assert parent.resolve() == parent and repo != parent and repo not in parent.parents
info = json.loads(subprocess.check_output(['docker', 'info', '--format', '{{json .}}'], text=True))
assert info['Name'] == args.expected_daemon_name and info['DockerRootDir'] == args.expected_docker_root
image = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{.Id}}', args.base_image], text=True).strip()
parent.mkdir(parents=True, exist_ok=True)
assert shutil.disk_usage(parent).free >= 5 * 1024**3, '5GiB local headroom required'
work = pathlib.Path(tempfile.mkdtemp(prefix='cds-heat-pressure-', dir=parent))
identity = (work.stat().st_dev, work.stat().st_ino)
owner = 'cds-pressure-' + uuid.uuid4().hex
manifest = {'provenance': 'integration-live', 'owner': owner, 'baseImageId': image,
            'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'passed': False,
            'driverFailureRequested': args.exercise_driver_failure}
born = {}
containers = []
print('Evidence: ' + str(work), flush=True)

def docker(*command, **kwargs):
    return subprocess.run(['docker', *command], check=True, **kwargs)

def remember(name):
    if os.path.lexists(work / name):
        born[name] = (work / name).lstat()

def stop_owned():
    complete = True
    for cid in reversed(containers):
        try:
            value = json.loads(subprocess.check_output(['docker', 'inspect', cid], text=True))[0]
            assert value['Id'] == cid and value['Config']['Labels'].get('cds.acceptance.owner') == owner
            if value['State']['Running']:
                docker('kill', cid, stdout=subprocess.DEVNULL)
                docker('wait', cid, timeout=20, stdout=subprocess.DEVNULL)
            docker('rm', cid, stdout=subprocess.DEVNULL)
        except Exception:
            complete = False
    return complete

def create(role, memory, command):
    cid = subprocess.check_output(['docker', 'create', '--name', owner + '-' + role,
        '--label', 'cds.acceptance.owner=' + owner, '--network', 'none', '--cpus', '2',
        '--memory', memory, '--mount', 'type=bind,source=' + str(work) + ',target=/input',
        '--entrypoint', 'sh', image, command], text=True).strip()
    containers.append(cid)
    return cid

try:
    subprocess.run([str(repo / 'cds/node_modules/.bin/esbuild'), 'scripts/heatpool-pressure-vm-probe.ts',
        '--bundle', '--platform=node', '--format=esm', '--outfile=' + str(work / 'driver.mjs')], cwd=repo / 'cds', check=True)
    vm = repo / 'cds/scripts/resource-lifecycle-vm'
    for name in ['prepare.sh', 'guest-init.sh', 'run.sh']:
        shutil.copy2(vm / name, work / name)
    (work / 'run.sh').write_text((work / 'run.sh').read_text().replace('-m 3072', '-m 4096'))
    driver = "echo CDS_PRESSURE_DRIVER_FAILURE; status=42" if args.exercise_driver_failure else "status=0; node --expose-gc /driver.mjs || status=$?"
    (work / 'init-real').write_text('''#!/bin/sh
set -eu
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
mount --make-rprivate /
/bin/busybox ip link set lo up
mkdir -p /pressure
mount -t tmpfs -o size=64m tmpfs /pressure
export CDS_VM_PRESSURE_DRILL=1
''' + driver + '''
echo CDS_PRESSURE_DRIVER_EXIT=$status
sync
/bin/busybox poweroff -f
''')
    for name in ['guest-init.sh', 'init-real']:
        (work / name).chmod(0o755)
    for name in ['disk-resource-native.py', 'backup-retention-native.py']:
        (work / name).write_text('# unused in this pressure-only guest\n')
    subprocess.run(['tar', '-cf', str(work / 'alpine.tar'), '--files-from', '/dev/null'], check=True)
    remember('alpine.tar')
    with (work / 'owned-root.img').open('xb') as disk:
        disk.truncate(32 * 1024**3)
    remember('owned-root.img')
    cid = create('prepare', '2g', '/input/prepare.sh')
    try:
        docker('start', '-a', cid, timeout=180)
        value = json.loads(subprocess.check_output(['docker', 'inspect', cid], text=True))[0]
        if value['State']['ExitCode'] != 0:
            raise RuntimeError('Owned VM preparation failed')
    finally:
        # These names were absent in the new 0700 directory and created only by our worker.
        if stop_owned():
            containers.clear()
            for name in ['extra.gz', 'initramfs.gz', 'vmlinuz']:
                remember(name)
    manifest['sourceHead'] = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
    manifest['sourceDirty'] = bool(subprocess.check_output(['git', '-C', str(repo), 'status', '--porcelain'], text=True).strip())
    manifest['sourceHashes'] = {name: hashlib.sha256((repo / 'cds/src/services' / name).read_bytes()).hexdigest()
        for name in ['scheduler.ts', 'scheduler-pressure.ts', 'deployment-phase-budget.ts', 'build-gate.ts', 'disk-guard.ts']}
    cid = create('guest', '5g', '/input/run.sh')
    with (work / 'guest.log').open('w') as output:
        process = subprocess.Popen(['docker', 'start', '-a', cid], stdout=output, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 900
        announced = time.monotonic()
        while process.poll() is None:
            if time.monotonic() > deadline:
                stop_owned()
                process.wait(timeout=20)
                raise TimeoutError('Guest pressure drill exceeded 15 minutes')
            if time.monotonic() - announced > 45:
                print('Native guest running; ' + str(work / 'guest.log'), flush=True)
                announced = time.monotonic()
            time.sleep(.5)
    body = (work / 'guest.log').read_text(errors='replace')
    line = next((line.split('DRILL_COMPLETE=', 1)[1] for line in body.splitlines() if 'DRILL_COMPLETE=' in line), None)
    if process.returncode or not line:
        raise RuntimeError('Native pressure proof missing; preserved guest.log')
    manifest['result'] = json.loads(line)
    manifest['passed'] = True
finally:
    stopped = stop_owned()
    assert work.resolve() == work and (work.stat().st_dev, work.stat().st_ino) == identity
    manifest['artifactRetirement'] = []
    fd = os.open(work, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name, initial in born.items():
            current = os.stat(name, dir_fd=fd, follow_symlinks=False)
            unchanged = stat.S_ISREG(current.st_mode) and current.st_nlink == 1 and (current.st_dev, current.st_ino) == (initial.st_dev, initial.st_ino)
            if stopped and unchanged:
                os.unlink(name, dir_fd=fd)
                manifest['artifactRetirement'].append({'name': name, 'status': 'removed-owned-identity'})
            else:
                manifest['artifactRetirement'].append({'name': name, 'status': 'held-identity-or-worker-unconfirmed'})
        os.fsync(fd)
    finally:
        os.close(fd)
    for name in ['extra.gz', 'initramfs.gz', 'vmlinuz']:
        if name not in born and os.path.lexists(work / name):
            manifest['artifactRetirement'].append({'name': name, 'status': 'held-preparation-worker-unconfirmed'})
    manifest['workersStopped'] = stopped
    manifest['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    manifest['driverSha256'] = hashlib.sha256((work / 'driver.mjs').read_bytes()).hexdigest() if (work / 'driver.mjs').exists() else None
    (work / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest), flush=True)
