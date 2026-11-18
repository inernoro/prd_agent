"""Prepare viewable browser evidence and the original-asset comparison in CI."""
import hashlib
import json
from pathlib import Path
import subprocess
from urllib.request import urlretrieve

import imageio_ffmpeg
from PIL import Image, ImageDraw


root = Path(__file__).resolve().parents[1]
out = root / 'work/entry-recut-headless'
evidence = json.loads((out / 'playback-evidence.json').read_text())
desktop = evidence['playback'][0]
original = out / 'original.mp4'
urlretrieve(desktop['source'], original)
assert hashlib.sha256(original.read_bytes()).hexdigest() == (
    '05c8a2d277469c57356b4e4427a4f118080e5d7729018056305c6c7cdda2a213'
)


def ffmpeg(*args):
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-loglevel', 'error',
                    '-y', *map(str, args)], check=True)


ffmpeg('-i', out / 'daylight-preflight.webm', '-an', '-c:v', 'libx264', '-crf', 20,
       '-preset', 'fast', '-threads', 2, '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
       out / 'gateway-daylight-browser.mp4')

samples = desktop['samples']
for start in range(0, len(samples), 4):
    rows = samples[start:start + 4]
    sheet = Image.new('RGB', (1280, len(rows) * 386), '#172336')
    labels = ImageDraw.Draw(sheet)
    for index, sample in enumerate(rows):
        t, actual = sample['time'], sample['at']
        sample_path = out / 'original-frame.jpg'
        ffmpeg('-ss', f'{min(t, 8.125):.3f}', '-i', original, '-frames:v', 1, sample_path)
        with Image.open(sample_path) as frame:
            frame.thumbnail((640, 360), Image.Resampling.LANCZOS)
            sheet.paste(frame, (0, index * 386 + 26))
        with Image.open(out / sample['file']) as frame:
            frame.thumbnail((640, 360), Image.Resampling.LANCZOS)
            sheet.paste(frame, (640, index * 386 + 26))
        labels.text((10, index * 386 + 7), f'{t:.2f}s | Approved source', fill='white')
        labels.text((650, index * 386 + 7), f'{actual:.2f}s | Browser capture', fill='white')
    sheet.save(out / f'source-browser-{start // 4:02}.jpg', quality=90)
original.unlink()
sample_path.unlink()
