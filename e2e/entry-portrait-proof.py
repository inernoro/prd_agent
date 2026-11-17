"""Cloud authoring proof. Real public-preview acceptance remains a separate recording."""
from pathlib import Path
import subprocess, json
from PIL import Image, ImageDraw, ImageStat
root = Path(__file__).resolve().parents[1]
out = root / 'work/entry-portrait'
times = [.75,1.25,1.75,2,2.25,2.5,3.25,3.75,4.25]
for first in range(0,len(times),3):
    sheet = Image.new('RGB',(1920,3*574),'#10151c')
    draw = ImageDraw.Draw(sheet)
    for row,t in enumerate(times[first:first+3]):
        ref = out / f'reference-{t:.2f}.jpg'
        subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-ss',str(14.75+t),'-i',str(root/'e2e/fixtures/media/entry-reference.mp4'),'-frames:v','1','-vf','scale=960:540',str(ref)],check=True)
        current = Image.open(out/f'frames/frame-{round(t*60):04}.png').convert('RGB').resize((960,540))
        sheet.paste(Image.open(ref),(0,row*574+32));sheet.paste(current,(960,row*574+32))
        draw.text((12,row*574+8),f'+{t:.2f}s | reference left | new authored portrait right (no product UI)',fill='white')
    sheet.save(out/f'preview-{first//3:02}.jpg',quality=94)
# Regression for the reported horizontal cut: forehead AND lower cheek must have material together.
middle = Image.open(out/'frames/frame-0120.png').convert('RGB')
final = Image.open(out/'frames/frame-0309.png').convert('RGB')
probes = {}
for name,(x,y) in {'forehead':(1490,335),'cheek':(1480,640)}.items():
    region=(x-10,y-10,x+10,y+10)
    probes[name]=ImageStat.Stat(middle.crop(region)).mean[0]/max(1,ImageStat.Stat(final.crop(region)).mean[0])
(out/'composition-proof.json').write_text(json.dumps({'time':2,'materialRedRatios':probes,'meaning':'Both upper and lower face retain material beneath the lattice; no horizontal split.'},indent=2))
assert min(probes.values())>.2, f'Material still absent in part of the face: {probes}'
