from pathlib import Path
import json
import subprocess

from PIL import Image, ImageDraw
import imageio_ffmpeg

out = Path('work/entry-handoff')

def blue_fraction(path):
    with Image.open(path) as screenshot:
        w, h = screenshot.size
        pixels = screenshot.convert('RGB').crop((int(w*.62), int(h*.07), int(w*.95), int(h*.37)))
        blue = sum(b > r + 35 and b > g + 12 for r, g, b in pixels.getdata())
        return round(blue / (pixels.width * pixels.height), 4)

checks = ['before-password-handoff', 'fixed-password-handoff', 'fixed-password-waiting',
          'fixed-password-first-stroke', 'fixed-map-sso-handoff', 'fixed-map-sso-first-stroke', 'fixed-password-settled']
blue = {name: blue_fraction(out / f'{name}.png') for name in checks}
print(json.dumps(blue, indent=2))
assert blue[checks[0]] > .08, 'The old colored flash must be reproduced'
assert all(blue[name] < .02 for name in checks[1:-1]), 'Blue artwork appeared before the film turned to color'
assert blue[checks[-1]] > .08, 'The renderer still needs to show the complete colored portrait'

names = ['before-password-handoff', 'fixed-password-handoff', 'fixed-password-waiting', 'fixed-password-first-stroke']
labels = ['Before | Password accepted', 'Fixed | Password accepted', 'Fixed | Video still loading', 'Fixed | First stroke']
sheet = Image.new('RGB', (1440, 852), '#182133')
text = ImageDraw.Draw(sheet)
for index, (name, title) in enumerate(zip(names, labels)):
    x = (index % 2) * 720
    y = (index // 2) * 426
    text.text((x + 12, y + 5), title, fill='white')
    with Image.open(out / f'{name}.png') as screenshot:
        sheet.paste(screenshot.resize((720, 405), Image.Resampling.LANCZOS), (x, y + 21))
sheet.save(out / 'handoff-before-after.jpg', quality=93)

for name in ('fixed-password', 'fixed-map-sso'):
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-loglevel', 'error', '-y',
                    '-i', str(out / f'{name}.webm'), '-c:v', 'libx264', '-threads', '2', '-preset', 'fast',
                    '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
                    str(out / f'{name}.mp4')], check=True)
(out / 'pixel-check.json').write_text(json.dumps(blue, indent=2))
