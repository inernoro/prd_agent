"""Retime approved silent visuals to official speech; Pillow subtitles need no libass.

The archive's original scene timing is retained for repeatable reruns. Each scene
is quantized to whole video frames, with PCM padded to the same duration; audio is
encoded once per segment to avoid accumulated AAC seam offsets.
"""
from pathlib import Path
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import shutil
import subprocess
import wave

from PIL import Image, ImageDraw, ImageFont
from batch_official_tts import wav_data

HERE = Path(__file__).resolve().parent
FPS = 30
LEAD = .7
PAPER = (245, 241, 230)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(path)


def call(command, log):
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open('w') as target:
        subprocess.run(list(map(str, command)), stdout=target, stderr=subprocess.STDOUT, check=True)


def caption_image(text, path, font_path):
    font = ImageFont.truetype(str(font_path), 35)
    lines, current = [], ''
    for char in text:
        if font.getlength(current + char) > 1680:
            lines.append(current)
            current = ''
        current += char
    if current:
        lines.append(current)
    if len(lines) > 2:
        raise ValueError('Caption exceeds the reserved two-line region')
    image = Image.new('RGB', (1920, 120), PAPER)
    draw = ImageDraw.Draw(image)
    for i, line in enumerate(lines):
        y = 60 + (i - (len(lines) - 1) / 2) * 43
        draw.text((960, y), line, font=font, fill=(36, 58, 56), anchor='mm')
    image.save(path)


def encode_scene(scene, source, work, font):
    sid = scene['id']
    target = work / (sid + '.mp4')
    signature = hashlib.sha256(json.dumps(scene, sort_keys=True).encode()).hexdigest()
    record = target.with_suffix('.json')
    if target.exists() and record.exists():
        cached = json.loads(record.read_text())
        if cached.get('signature') == signature and cached.get('sha256') == sha(target):
            print(json.dumps({'scene': sid, 'status': 'cached'}), flush=True)
            return target
    command = ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'warning', '-threads', '2',
               '-ss', str(scene['old_start']), '-t', str(scene['old_duration']), '-i', source]
    filters = [f'[0:v]setpts={scene["factor"]:.12f}*(PTS-STARTPTS),fps=30,'
               f'tpad=stop_mode=clone:stop_duration=1,trim=end_frame={scene["frames"]},'
               'drawbox=x=0:y=900:w=iw:h=120:color=0xf5f1e6:t=fill[base]']
    prior = 'base'
    for i, caption in enumerate(scene['captions']):
        png = work / (sid + f'-{i:02}.png')
        caption_image(caption['text'], png, font)
        command += ['-loop', '1', '-framerate', '30', '-i', png]
        following = f'caption{i}'
        start, end = caption['start'] + LEAD, caption['end'] + LEAD
        filters.append(f'[{prior}][{i+1}:v]overlay=0:900:enable=\'gte(t,{start:.9f})*lt(t,{end:.9f})\'[{following}]')
        prior = following
    filters.append(f'[{prior}]format=yuv420p[out]')
    pending = target.with_name(sid + '.pending.mp4')
    command += ['-filter_complex_threads', '1', '-filter_complex', ';'.join(filters),
                '-map', '[out]', '-an', '-frames:v', str(scene['frames']),
                '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-threads', '2',
                '-movflags', '+faststart', pending]
    call(command, work / (sid + '-encode.log'))
    pending.replace(target)
    save(record, {'signature': signature, 'sha256': sha(target)})
    print(json.dumps({'scene': sid, 'status': 'encoded', 'seconds': scene['duration']}), flush=True)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--official-manifest', type=Path, required=True)
    parser.add_argument('--only', nargs='*')
    args = parser.parse_args()
    root = args.root.resolve()
    official = json.loads(args.official_manifest.read_text())
    approval = json.loads((root / 'evidence/official-audition-approved.json').read_text())
    if not official.get('complete') or official.get('engine') != 'openai-speech':
        raise ValueError('A complete official speech manifest is required')
    if not approval.get('approved') or any(approval[k] != official[k] for k in ('model', 'voice', 'engine')):
        raise ValueError('Exact official audition approval is required')
    audio = {row['id']: row for row in official['segments']}
    spec = json.loads((root / 'segments.json').read_text())
    ids = {segment['id'] for segment in spec['segments']}
    if args.only and set(args.only) - ids:
        raise ValueError('Unknown segment selection')
    module_spec = importlib.util.spec_from_file_location('media_checks', HERE / 'render_segments.py')
    checks = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(checks)
    checks.ROOT = root
    for name in ('videos', 'logs', 'evidence', 'replacement-work'):
        (root / name).mkdir(exist_ok=True)
    for segment in spec['segments']:
        sid = segment['id']
        if args.only and sid not in args.only:
            continue
        project = root / 'projects' / sid
        archive = root / 'evidence/preofficial-timings' / sid
        archive.mkdir(parents=True, exist_ok=True)
        for name in ('timing.json', 'build-manifest.json'):
            if not (archive / name).exists():
                shutil.copyfile(project / name, archive / name)
        original = json.loads((archive / 'timing.json').read_text())
        old = {scene['id']: scene for scene in original['scenes']}
        source = root / 'visual-materials' / (sid + '-silent.mp4')
        source_sha = sha(source)
        work = root / 'replacement-work' / sid
        work.mkdir(exist_ok=True)
        scenes, all_captions, pcm_parts = [], [], []
        parameters = (1, 2, 24000)
        position = 0
        for scene in segment['scenes']:
            cid = scene['id']
            captions, raw = [], b''
            if scene.get('voice', '').strip():
                row = audio[cid]
                path = Path(row['audio'])
                if sha(path) != row['sha256'] or row['instructions_sha256'] != approval['instructions_sha256']:
                    raise ValueError('Official speech hash or style mismatch')
                current, samples, raw = wav_data(path.read_bytes())
                if current != parameters:
                    raise ValueError('Expected mono PCM16 24 kHz official speech')
                captions = row['captions']
                if ''.join(c['text'] for c in captions) != scene['voice']:
                    raise ValueError('Captions differ from approved source narration')
                seconds = samples / parameters[2]
                if any(not 0 <= c['start'] < c['end'] <= seconds for c in captions):
                    raise ValueError('Caption exceeds official speech samples')
                if any(a['end'] > b['start'] for a,b in zip(captions,captions[1:])):
                    raise ValueError('Overlapping captions')
                frames = math.ceil((seconds + LEAD + scene.get('pause_seconds', 3)) * FPS)
                raw = b'\0' * round(LEAD * parameters[2]) * 2 + raw
            else:
                frames = math.ceil(old[cid]['duration'] * FPS)
            duration = frames / FPS
            expected_samples = frames * (parameters[2] // FPS)
            pcm_parts.append(raw + b'\0' * (expected_samples * 2 - len(raw)))
            item = {**scene, 'old_start': old[cid]['start'], 'old_duration': old[cid]['duration'],
                    'factor': duration / old[cid]['duration'], 'duration': duration, 'frames': frames,
                    'start': position / FPS, 'voice_start': position / FPS + LEAD,
                    'captions': captions, 'source_sha256': source_sha,
                    'audio_sha256': audio[cid]['sha256'] if cid in audio else None,
                    'renderer_sha256': sha(Path(__file__)), 'font_sha256': sha(root / 'shared-assets/wenkai.ttf')}
            scenes.append(item)
            all_captions.extend({**c, 'start': c['start'] + item['voice_start'],
                                 'end': c['end'] + item['voice_start']} for c in captions)
            position += frames
        font = root / 'shared-assets/wenkai.ttf'
        # Render independent scenes concurrently; no shared project files are mutated here.
        with ThreadPoolExecutor(max_workers=2) as pool:
            paths = list(pool.map(lambda scene: encode_scene(scene, source, work, font), scenes))
        listing = work / 'concat.txt'
        listing.write_text(''.join("file '" + str(path).replace("'", "'\\''") + "'\n" for path in paths))
        wav_path = work / 'segment.wav'
        with wave.open(str(wav_path), 'wb') as writer:
            writer.setparams((*parameters, 0, 'NONE', 'not compressed'))
            writer.writeframes(b''.join(pcm_parts))
        pending = root / 'videos' / (sid + '.pending.mp4')
        call(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'warning', '-f', 'concat', '-safe', '0',
              '-i', listing, '-i', wav_path, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
              '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-t', str(position / FPS),
              '-movflags', '+faststart', pending], work / 'concat.log')
        timing = {'id': sid, 'duration_seconds': position / FPS, 'scenes': scenes, 'captions': all_captions}
        save(project / 'timing.json', timing)
        checks.normalize_audio_tail(sid, pending)
        media = checks.validate_media(sid, pending, timing['duration_seconds'])
        target = root / 'videos' / (sid + '.mp4')
        pending.replace(target)
        content_key = hashlib.sha256(json.dumps(timing, sort_keys=True).encode()).hexdigest()
        build = {**json.loads((archive / 'build-manifest.json').read_text()),
                 'visual_only': False,
                 'duration_seconds': position / FPS, 'content_key': content_key,
                 'audio_engine': 'openai-speech', 'model': official['model'], 'voice': official['voice'],
                 'production_method': 'retimed approved silent visuals; Pillow caption overlay; frame-aligned PCM'}
        save(project / 'build-manifest.json', build)
        save(root / 'evidence' / (sid + '-media.json'), {
            'id': sid, 'status': 'passed', 'verified_at': datetime.now(timezone.utc).isoformat(),
            'content_key': content_key, 'video_sha256': sha(target), 'media': media,
            'source_silent_video_sha256': source_sha, 'official_audio_only': True,
            'scope': '技术媒体检查；不等于登录实录、完整课程审阅或真人跟做通过'})
        save(work / 'replacement-plan.json', timing)
        print(json.dumps({'segment': sid, 'status': 'passed', 'seconds': position / FPS}), flush=True)


if __name__ == '__main__':
    main()
