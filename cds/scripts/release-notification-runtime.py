#!/usr/bin/env python3
"""同提交发布独立通知进程；只切换程序，保留原服务、配置、队列和唯一发送者。"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

FILES = ['cds/scripts/independent-monitor.py', 'cds/scripts/independent-alarm-relay.py',
         'cds/scripts/phone-dispatch.py', 'cds/src/shared/notification-templates.json']
UNIT = 'cds-independent-monitor.service'
LAUNCHER = b"from pathlib import Path\nimport runpy\nrunpy.run_path(str(Path(__file__).parent / 'notification-current/cds/scripts/independent-monitor.py'), run_name='__main__')\n"


def atomic_file(path, data, mode, uid, gid):
    tmp = path.with_name(path.name + '.next')
    tmp.write_bytes(data)
    os.chmod(tmp, mode)
    os.chown(tmp, uid, gid)
    os.replace(tmp, path)


def publish(root, source, revision, service):
    if not re.fullmatch('[a-f0-9]{40}', revision):
        raise ValueError('发布必须锚定完整提交')
    launcher = root / 'independent-monitor.py'
    original = launcher.read_bytes()
    stat = launcher.stat()
    current = root / 'notification-current'
    previous = os.readlink(current) if current.is_symlink() else None
    if current.exists() and not current.is_symlink():
        raise ValueError('版本入口不是预期的符号链接，未覆盖')
    release = root / 'notification-releases' / revision
    if release.exists():
        for file in FILES:
            if (release / file).read_bytes() != (source / file).read_bytes():
                raise ValueError('同一提交已有不同程序，拒绝覆盖')
    else:
        stage = release.with_name(revision + '.staging')
        if stage.exists(): shutil.rmtree(stage)
        for file in FILES:
            src = source / file
            if src.is_symlink() or not src.is_file(): raise ValueError('发布程序必须是普通文件')
            dest = stage / file
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dest)
        for file in FILES:
            if file.endswith('.py'): compile((stage / file).read_text(), file, 'exec')
        catalog = json.loads((stage / FILES[-1]).read_text())
        if len(catalog['templates']) != 30: raise ValueError('通知模板目录不完整')
        for path in [stage, *stage.rglob('*')]:
            os.chmod(path, 0o755 if path.is_dir() else 0o644)
            os.chown(path, stat.st_uid, stat.st_gid)
        os.replace(stage, release)
        os.chown(release.parent, stat.st_uid, stat.st_gid)
    backup = release / 'previous-launcher.py'
    if not backup.exists():
        atomic_file(backup, original, 0o600, stat.st_uid, stat.st_gid)
        atomic_file(release / 'previous-version.json', json.dumps({'previous': previous}).encode(), 0o600, stat.st_uid, stat.st_gid)
    stopped = False
    try:
        service('stop'); stopped = True
        # 发送者停止后核对私有数据；切换过程不写入这些文件。
        private = {p: (p.read_bytes(), p.stat().st_mode & 0o777) for p in root.glob('*.json')}
        link = root / 'notification-current.next'
        if link.is_symlink(): link.unlink()
        link.symlink_to(release.relative_to(root))
        os.replace(link, current)
        atomic_file(launcher, LAUNCHER, stat.st_mode & 0o777, stat.st_uid, stat.st_gid)
        if any(p.read_bytes() != data or p.stat().st_mode & 0o777 != mode for p, (data, mode) in private.items()):
            raise RuntimeError('切换时私有配置或队列发生非预期变化')
        service('start'); service('verify')
    except BaseException:
        if stopped:
            service('stop')
            atomic_file(launcher, original, stat.st_mode & 0o777, stat.st_uid, stat.st_gid)
            if current.is_symlink(): current.unlink()
            if previous:
                current.symlink_to(previous)
            service('start'); service('verify')
        raise
    manifest = {'commit': revision, 'service': UNIT, 'previous': previous,
                'templateSha256': hashlib.sha256((release / FILES[-1]).read_bytes()).hexdigest(),
                'privateDataPreserved': True}
    atomic_file(release / 'release.json', json.dumps(manifest).encode(), 0o600, stat.st_uid, stat.st_gid)
    return manifest


def main():
    mode = sys.argv[1] if len(sys.argv) == 2 else ''
    if mode not in ('check', 'deploy'): raise SystemExit('只支持 check 或 deploy')
    revision = os.environ.get('CDS_COMMIT_SHA', '')
    source = Path(__file__).resolve().parents[2]
    actual = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != actual: raise SystemExit('发布工作区与锚定提交不一致')
    root = Path(subprocess.check_output(['systemctl', 'show', UNIT, '--property=WorkingDirectory', '--value'], text=True).strip())
    if not root.is_absolute() or not (root / 'config.json').is_file() or not (root / 'independent-monitor.py').is_file():
        raise SystemExit('未找到既有独立通知服务，本次没有创建新发送者')
    if mode == 'check':
        subprocess.run(['systemctl', 'is-active', '--quiet', UNIT], check=True)
        for file in FILES:
            if not (source / file).is_file() or (source / file).is_symlink(): raise SystemExit('提交中的程序不完整')
        print('既有服务与同提交发布程序核对通过；私有数据不迁移')
        return
    def service(action):
        if action == 'verify':
            import time
            time.sleep(2)
            subprocess.run(['systemctl', 'is-active', '--quiet', UNIT], check=True)
        else: subprocess.run(['systemctl', action, UNIT], check=True)
    print(json.dumps(publish(root, source, revision, service), ensure_ascii=False))


if __name__ == '__main__': main()
