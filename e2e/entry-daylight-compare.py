"""Compare quarter-second frames of the two actual cloud browser recordings."""
from argparse import ArgumentParser
from pathlib import Path
import json
import math
import os
import re
import subprocess
from PIL import Image, ImageDraw

if os.environ.get('CI') != 'true':
    raise SystemExit('Run media comparison in cloud CI')
parser = ArgumentParser()
parser.add_argument('--fixture', action='store_true')
mode = parser.parse_args()
root = Path(__file__).resolve().parents[1]
out = root / ('work/entry-daylight' if mode.fixture else 'work/entry-motion')
if mode.fixture:
    evidence = json.loads((out / 'fixture-evidence.json').read_text())
    anchors = {
        name: evidence['entries'][name] - float(re.search(r'start: ([\d.]+)', (out / f'{name}-ffmpeg.log').read_text())[1])
        for name in ('dark', 'light')
    }
else:
    evidence = json.loads((out / 'comparison.json').read_text())
    anchors = {name: evidence['runs'][name]['videoAnchor'] for name in ('cold', 'warm')}
assert all(0 <= anchor <= 60 for anchor in anchors.values()), 'Unusable capture anchor'
night, day = anchors
manifest = json.loads((root / 'e2e/fixtures/media/gateway-portrait-cdn.json').read_text())
duration = manifest['light']['motion'].get('durationSeconds', 5.15)
quarter_samples = math.ceil(duration * 4) + 1
comparison_duration = quarter_samples / 4

def ffmpeg(*args):
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *map(str, args)], check=True)

ffmpeg('-ss', f'{anchors[night]:.6f}', '-i', out / f'{night}.mp4', '-ss', f'{anchors[day]:.6f}', '-i', out / f'{day}.mp4',
       '-filter_complex', '[0:v]scale=960:540,setsar=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=4,drawtext=text=Night (holds after entry):fontcolor=white:box=1:boxcolor=black@0.65:fontsize=20:x=12:y=12[a];'
       '[1:v]scale=960:540,setsar=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=1,drawtext=text=Daylight:fontcolor=white:box=1:boxcolor=black@0.65:fontsize=20:x=12:y=12[b];[a][b]hstack=inputs=2:shortest=1[v]',
       '-map', '[v]', '-t', comparison_duration, '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-threads', '2', '-movflags', '+faststart', out/'night-vs-daylight-entry.mp4')
for first in range(0, quarter_samples, 4):
    rows = min(4, quarter_samples-first)
    sheet = Image.new('RGB', (1920, rows * 568), '#162130')
    labels = ImageDraw.Draw(sheet)
    for row in range(rows):
        t = (first+row)/4
        pair = out / f'day-night-{first+row:02}.jpg'
        ffmpeg('-ss', f'{t:.2f}', '-i', out/'night-vs-daylight-entry.mp4', '-frames:v', '1', pair)
        labels.text((12, row*568+7), f'{t:.2f}s | Night (left) / Daylight (right)', fill='white')
        with Image.open(pair) as frame:
            sheet.paste(frame, (0,row*568+28))
        pair.unlink()
    sheet.save(out/f'day-night-sheet-{first//4:02}.jpg',quality=91)
