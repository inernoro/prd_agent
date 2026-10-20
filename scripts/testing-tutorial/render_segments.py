#!/usr/bin/env python3
"""Render only built local chapter segments, retaining checked input and media hashes."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
CLI = Path(os.environ.get('HYPERFRAMES_CLI', '/home/agent/.cache/pnpm/dlx/d1bdaa63af0efae7392df70a2310781e/mvf9abj6-2cr/node_modules/.bin/hyperframes'))
ENV = {**os.environ, 'HYPERFRAMES_BROWSER_PATH': '/usr/bin/chromium'}
PHASES = ('lint', 'runtime', 'layout', 'motion', 'contrast')
EXCLUDED = {'.hyperframes', 'node_modules', 'renders', '.git'}


def emit(sid, phase, **kw):
    print(json.dumps({'id': sid, 'phase': phase, **kw}, ensure_ascii=False), flush=True)


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f'.tmp-{os.getpid()}')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    tmp.replace(path)


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def inputs_hash(project):
    rows = [(str(p.relative_to(project)), sha(p)) for p in sorted(project.rglob('*'))
            if p.is_file() and not any(part in EXCLUDED for part in p.relative_to(project).parts)]
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False).encode()).hexdigest()


def json_stdout(path):
    text = path.read_text(errors='replace')
    # Some CLI builds emit an update notice before their JSON result.
    decoder = json.JSONDecoder()
    for match in re.finditer(r'(?m)^\s*\{', text):
        try:
            obj, _ = decoder.raw_decode(text[match.start():].lstrip())
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass
    raise RuntimeError('CLI没有返回可读取的JSON，不能继续渲染')


def run_logged(cmd, cwd, logfile, stdout_path=None, allow_failure=False):
    started = time.monotonic()
    logfile.parent.mkdir(parents=True, exist_ok=True)
    with logfile.open('w') as log:
        log.write('command: ' + ' '.join(map(str, cmd)) + '\n'); log.flush()
        if stdout_path:
            with stdout_path.open('w') as out:
                p = subprocess.run(list(map(str, cmd)), cwd=cwd, env=ENV, stdout=out, stderr=log)
        else:
            p = subprocess.run(list(map(str, cmd)), cwd=cwd, env=ENV, stdout=log, stderr=subprocess.STDOUT)
    if p.returncode and not allow_failure:
        raise RuntimeError(f'执行失败 exit={p.returncode}；日志 {logfile.relative_to(ROOT)}')
    elapsed = round(time.monotonic() - started, 3)
    return (elapsed, p.returncode) if allow_failure else elapsed


def check_project(sid, project, allowed):
    raw = ROOT / 'logs' / f'{sid}-check.stdout.json'
    elapsed, check_exit = run_logged([CLI, 'check', project, '--json'], project,
                         ROOT / 'logs' / f'{sid}-check.log', raw, allow_failure=True)
    report = json_stdout(raw)
    save(ROOT / 'evidence' / f'{sid}-check.json', report)
    if report.get('browserSkipped'):
        raise RuntimeError('检查跳过浏览器，不准继续渲染')
    summaries, warnings = {}, []
    for phase in PHASES:
        item = report.get(phase)
        if not isinstance(item, dict) or 'errorCount' not in item:
            raise RuntimeError(f'缺少{phase}完整检查结果')
        errors = int(item['errorCount'])
        findings = item.get('findings', [])
        if any(f.get('severity') == 'error' for f in findings):
            errors = max(errors, 1)
        summaries[phase] = {'errors': errors, 'warnings': int(item.get('warningCount', 0))}
        warnings.extend({'phase': phase, **f} for f in findings if f.get('severity') == 'warning')
    if check_exit or not report.get('ok') or sum(v['errors'] for v in summaries.values()):
        raise RuntimeError('检查有真实错误，已阻断渲染：' + json.dumps(summaries, ensure_ascii=False))
    unexpected = [w for w in warnings if w.get('code') not in allowed]
    if unexpected:
        codes = sorted({w.get('code', '?') for w in unexpected})
        raise RuntimeError('需先审阅非结构提示：' + ','.join(codes))
    return {'seconds': elapsed, 'phases': summaries,
            'allowed_warning_codes': sorted(allowed), 'warnings': warnings}


def probe(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)],
                       capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


def normalize_audio_tail(sid, path):
    info = probe(path)
    videos = [s for s in info['streams'] if s.get('codec_type') == 'video']
    audios = [s for s in info['streams'] if s.get('codec_type') == 'audio']
    if not videos or not audios:
        return {'changed': False, 'reason': '缺音视频轨，由后续强制验证拒绝'}
    vd = float(videos[0].get('duration', info['format']['duration']))
    ad = float(audios[0].get('duration', info['format']['duration']))
    if abs(vd - ad) <= .06:
        return {'changed': False, 'video_duration': vd, 'audio_duration': ad}
    normalized = path.with_name(path.stem + '.avfixed.mp4')
    run_logged(['ffmpeg', '-v', 'error', '-y', '-i', path, '-map', '0:v:0', '-map', '0:a:0',
                '-c:v', 'copy', '-af', f'apad,atrim=duration={vd:.6f}', '-c:a', 'aac',
                '-b:a', '192k', '-ar', '48000', '-ac', '2', '-t', f'{vd:.6f}', normalized],
               ROOT, ROOT / 'logs' / f'{sid}-audio-tail.log')
    normalized.replace(path)
    return {'changed': True, 'video_duration': vd, 'original_audio_duration': ad,
            'note': '仅音轨补静音或截尾到视频长度，视频流copy，不改变画面'}


def validate_media(sid, path, expected_duration):
    info = probe(path)
    video = [s for s in info['streams'] if s.get('codec_type') == 'video']
    audio = [s for s in info['streams'] if s.get('codec_type') == 'audio']
    if len(video) != 1 or not audio:
        raise RuntimeError('成片必须有一条视频和至少一条中文音轨')
    v = video[0]
    n, d = map(float, v['avg_frame_rate'].split('/'))
    duration = float(info['format']['duration'])
    video_duration = float(v.get('duration', duration))
    if (v['width'], v['height']) != (1920, 1080) or abs(n / d - 30) > .001:
        raise RuntimeError('成片尺寸或帧率不符合1920x1080/30fps')
    if abs(duration - expected_duration) > .25 or abs(video_duration - expected_duration) > .15:
        raise RuntimeError(f'成片时长{duration}与分镜{expected_duration}不一致')
    audio_durations = [float(s.get('duration', duration)) for s in audio]
    timing_path = ROOT / 'projects' / sid / 'timing.json'
    timing = json.loads(timing_path.read_text()) if timing_path.is_file() else {}
    required_voice_end = max((float(c['end']) for c in timing.get('captions', [])), default=0)
    if any(x <= 0 or abs(x - video_duration) > .06 for x in audio_durations) or max(audio_durations) < required_voice_end - .25:
        raise RuntimeError('音轨时长异常或没有覆盖最后一句口播')
    decode_log = ROOT / 'logs' / f'{sid}-decode.log'
    run_logged(['ffmpeg', '-v', 'error', '-i', path, '-f', 'null', '-'], ROOT, decode_log)
    # The log's first command line is ours; any further lines are decode errors.
    if decode_log.read_text().splitlines()[1:]:
        raise RuntimeError('FFmpeg解码报告错误，不能交付')
    return {'format_duration': duration, 'video_duration': video_duration,
            'audio_durations': audio_durations, 'width': v['width'], 'height': v['height'],
            'fps': n / d, 'video_codec': v.get('codec_name'),
            'audio_codecs': [s.get('codec_name') for s in audio], 'full_decode_exit_code': 0,
            'probe': info}


def extract_frames(sid, path, duration):
    directory = ROOT / 'evidence' / 'frames'
    directory.mkdir(exist_ok=True)
    timing_path = ROOT / 'projects' / sid / 'timing.json'
    timing = json.loads(timing_path.read_text()) if timing_path.is_file() else {}
    points = {min(10., max(.1, duration - .2))}
    for scene in timing.get('scenes', [])[1:]:
        at = float(scene['start'])
        points.update([max(.1, at - .25), min(duration - .1, at + .25)])
    results = []
    for at in sorted(points):
        target = directory / f'{sid}-t{at:07.3f}.png'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(at), '-i', str(path),
                        '-frames:v', '1', str(target)], check=True, capture_output=True)
        results.append({'at': at, 'path': str(target.relative_to(ROOT)), 'sha256': sha(target)})
    return results


def render_one(sid, allowed, dry_run=False):
    project = ROOT / 'projects' / sid
    manifest_path = project / 'build-manifest.json'
    if not re.fullmatch(r'c\d+-s\d+', sid) or not manifest_path.is_file():
        raise RuntimeError(f'{sid}没有完整已build工程')
    manifest = json.loads(manifest_path.read_text())
    if manifest.get('id') != sid or not manifest.get('content_key') or not (project / 'index.html').is_file():
        raise RuntimeError(f'{sid}的build清单不完整')
    duration = float(manifest['duration_seconds'])
    if not duration > 0:
        raise RuntimeError('工程时长无效')
    record_path = ROOT / 'evidence' / f'{sid}-media.json'
    target = ROOT / 'videos' / f'{sid}.mp4'
    input_hash = inputs_hash(project)
    if dry_run:
        return {'id': sid, 'status': 'ready_not_rendered', 'content_key': manifest['content_key'],
                'input_sha256': input_hash, 'duration_seconds': duration}
    lockpath = ROOT / 'logs' / f'{sid}.lock'
    with lockpath.open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if record_path.is_file() and target.is_file():
            old = json.loads(record_path.read_text())
            if (old.get('status') == 'passed' and old.get('content_key') == manifest['content_key']
                    and old.get('input_sha256') == input_hash and old.get('video_sha256') == sha(target)):
                emit(sid, 'cache_verified', video=str(target.relative_to(ROOT)))
                return {**old, 'status': 'cached_verified'}
        emit(sid, 'checking')
        check = check_project(sid, project, allowed)
        emit(sid, 'rendering', duration_seconds=duration)
        pending = target.with_name(sid + '.rendering.mp4')
        elapsed = run_logged([CLI, 'render', project, '--workers', '1', '--fps', '30',
                              '--quality', 'standard', '--strict', '--output', pending],
                             project, ROOT / 'logs' / f'{sid}-render.log')
        emit(sid, 'decoding')
        tail_alignment = normalize_audio_tail(sid, pending)
        media = validate_media(sid, pending, duration)
        frames = extract_frames(sid, pending, duration)
        if inputs_hash(project) != input_hash:
            raise RuntimeError('渲染期间源素材变化，拒绝复用本次结果；请按新build重跑')
        pending.replace(target)
        record = {'id': sid, 'status': 'passed', 'verified_at': datetime.now(timezone.utc).isoformat(),
                  'content_key': manifest['content_key'], 'input_sha256': input_hash,
                  'video': str(target.relative_to(ROOT)), 'video_sha256': sha(target),
                  'bytes': target.stat().st_size, 'render_seconds': elapsed,
                  'expected_duration_seconds': duration, 'check': check, 'media': media, 'frames': frames, 'audio_tail_alignment': tail_alignment,
                  'scope': '本地字幕配音视频技术校验；不证明登录界面、内容正确性或真人跟做已通过'}
        save(record_path, record)
        (ROOT / 'evidence' / f'{sid}-render-failure.json').unlink(missing_ok=True)
        emit(sid, 'passed', video=record['video'], seconds=elapsed)
        return record


def main():
    global ROOT, CLI
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--only', nargs='+', help='Only specified built ids; comma-separated ids also accepted')
    group.add_argument('--all-ready', action='store_true', help='Snapshot all currently built segments')
    parser.add_argument('--jobs', type=int, choices=(1, 2), default=1)
    parser.add_argument('--allow-warning', action='append', default=[], help='Explicitly reviewed extra warning code')
    parser.add_argument('--dry-run', action='store_true', help='Verify build inventory and hashes without running checks/render')
    parser.add_argument('--root', type=Path, default=ROOT, help='Production root containing projects/videos/evidence')
    parser.add_argument('--cli', type=Path, default=CLI, help='Local cached HyperFrames CLI; also supports HYPERFRAMES_CLI env')
    a = parser.parse_args()
    ROOT = a.root.resolve(); CLI = a.cli.resolve()
    pause = ROOT / 'evidence' / 'audio-review-rejection.json'
    if not a.dry_run and pause.is_file() and json.loads(pause.read_text()).get('rendering_paused'):
        parser.error('当前中文配音已被用户否决，渲染暂停；更换配音并明确恢复前禁止新增渲染。')
    if not CLI.is_file(): parser.error('本机HyperFrames CLI不存在，不联网替代')
    for name in ('videos', 'logs', 'evidence'):
        (ROOT / name).mkdir(exist_ok=True)
    ids = sorted(p.parent.name for p in (ROOT / 'projects').glob('*/build-manifest.json')) if a.all_ready else list(dict.fromkeys(i for arg in a.only for i in arg.split(',')))
    if not ids:
        parser.error('没有已build工程；不会猜测或渲染未完成项目')
    allowed = {'nested_structure_needs_subcomposition', *a.allow_warning}
    results = []
    with ThreadPoolExecutor(max_workers=a.jobs) as pool:
        work = {pool.submit(render_one, sid, allowed, a.dry_run): sid for sid in ids}
        for future in as_completed(work):
            sid = work[future]
            try:
                results.append(future.result())
            except Exception as error:
                result = {'id': sid, 'status': 'failed', 'error': str(error)}
                results.append(result); save(ROOT / 'evidence' / f'{sid}-render-failure.json', result)
                emit(sid, 'failed', error=str(error))
    summary = {'jobs': a.jobs, 'dry_run': a.dry_run, 'results': results,
               'passed': all(r['status'] != 'failed' for r in results)}
    save(ROOT / 'evidence' / 'render-summary.json', summary)
    return 0 if summary['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
