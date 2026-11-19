"""Cloud-only extraction of actual video frames; no temporal interpolation or time stretching."""
from pathlib import Path
import subprocess, json, re, statistics, html
from PIL import Image, ImageDraw
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'work/entry-motion'
REF = ROOT / 'e2e/fixtures/media/entry-reference.mp4'
OUT.mkdir(parents=True, exist_ok=True)
def run(args):
    return subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *map(str,args)], check=True, capture_output=True)
def grab(video, target, destination):
    run(['-ss', f'{target:.6f}', '-i', video, '-frames:v', '1', '-vf', 'scale=960:540', destination])
summary = {'referenceAnchor': 14.75, 'viewport': [1920,1080], 'samples': [], 'runs': {}}
for mode in ['cold','warm']:
    path = OUT / f'{mode}.json'
    if not path.exists(): continue
    data = json.loads(path.read_text())
    log = (OUT / f'{mode}-ffmpeg.log').read_text()
    epoch = float(re.search(r'start: ([\d.]+)', log)[1])
    start = statistics.median(f['epoch']/1000-f['t'] for f in data['frames'][:10])
    anchor = start - epoch
    assert 0 <= anchor <= 60, f'Unusable real capture anchor: {anchor}'
    assert all(f['width']==1920 and f['height']==1080 for f in data['frames']), 'Viewport changed during recording'
    folder = OUT / mode; folder.mkdir(exist_ok=True)
    summary['runs'][mode] = {'videoAnchor':anchor, 'sceneEpoch':start, 'videoEpoch':epoch, 'intermediateEyeFrames':sum(.1 < f['eye'] < .9 for f in data['frames'])}
    for index in range(23):
        elapsed = index / 4
        ref_time = min(19.25,14.75+elapsed)
        grab(REF, ref_time, folder/f'reference-{index:02}.jpg')
        grab(OUT/f'{mode}.mp4', anchor+elapsed, folder/f'current-{index:02}.jpg')
        for kind in ['reference','current']:
            Image.open(folder/f'{kind}-{index:02}.jpg').crop((640,150,960,380)).resize((640,460)).save(folder/f'{kind}-eye-{index:02}.jpg')
        summary['samples'].append({'mode':mode,'elapsed':elapsed,'reference':ref_time,'current':anchor+elapsed,'referenceEnded':elapsed>4.5})
    patch = Image.open(folder/'current-01.jpg').crop((80,80,160,160)).convert('RGB')
    summary['runs'][mode]['quarterDarkPatch'] = sum(sum(pixel) for pixel in patch.getdata()) / (80*80*3*255)
    for first in range(0,23,4):
        sheet=Image.new('RGB',(1920,4*574),'#10151c');draw=ImageDraw.Draw(sheet)
        for row,index in enumerate(range(first,min(first+4,23))):
            draw.text((12,row*574+8),f'+{index/4:.2f}s | reference left | actual {mode} right'+(' | reference ended' if index>18 else ''),fill='white')
            for col,kind in enumerate(['reference','current']):sheet.paste(Image.open(folder/f'{kind}-{index:02}.jpg'),(col*960,row*574+32))
        sheet.save(OUT/f'{mode}-sheet-{first//4:02}.jpg',quality=90)
        if first == 8: sheet.crop((0,0,1920,574)).save(OUT/f'{mode}-keyframe-2.00.jpg',quality=94)
    run(['-ss','14.75','-i',REF,'-ss',f'{anchor:.6f}','-i',OUT/f'{mode}.mp4','-filter_complex',
         '[0:v]scale=960:540,setsar=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=2,drawtext=text=Reference (holds after 4.57s):fontcolor=white:fontsize=18:x=12:y=12[a];[1:v]scale=960:540,setsar=1,setpts=PTS-STARTPTS,drawtext=text=Actual preview:fontcolor=white:fontsize=18:x=12:y=12[b];[a][b]hstack=inputs=2[v]',
         '-map','[v]','-t','5.5','-an','-c:v','libx264','-preset','fast','-crf','20','-movflags','+faststart',OUT/f'{mode}-comparison.mp4'])
(OUT/'comparison.json').write_text(json.dumps(summary,indent=2))
assert summary['runs'], 'No real recording available for comparison'
page='''<!doctype html><meta charset="utf-8"><title>登录动效逐 0.25 秒验收</title><style>body{background:#0c111a;color:#e6edf4;font:16px/1.8 system-ui;margin:24px}button,select{font:inherit;padding:8px}input{width:98%}.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}img,video{width:100%}small{color:#acbac8}</style><h1>真实预览 · 每 0.25 秒对照</h1><p>左侧原片，右侧修改后的真实预览。未变速、未补帧。原片结束后明确保持末帧。两个录像使用同一 1920×1080 视口，由云端原生屏幕录制。</p><select id="mode">MODES</select><button id="prev">前 0.25 秒</button><button id="next">后 0.25 秒</button><input id="time" type="range" min="0" max="22" step="1" value="0"><p id="caption"></p><div class="pair"><img id="ref"><img id="cur"></div><h2>眼部放大</h2><div class="pair"><img id="re"><img id="ce"></div><h2>连续对照视频</h2><video id="comparison" controls></video><h2>未经剪辑的真实登录录像</h2><video id="raw" controls></video><script>const el=id=>document.getElementById(id);function paint(){const m=el('mode').value,n=+el('time').value,s=String(n).padStart(2,'0');el('ref').src=m+'/reference-'+s+'.jpg';el('cur').src=m+'/current-'+s+'.jpg';el('re').src=m+'/reference-eye-'+s+'.jpg';el('ce').src=m+'/current-eye-'+s+'.jpg';el('caption').textContent='共同锚点后 +'+(n/4).toFixed(2)+' 秒'+(n>18?'；原片已结束，保持末帧':'')}el('mode').onchange=()=>{el('comparison').src=el('mode').value+'-comparison.mp4';el('raw').src=el('mode').value+'.mp4';paint()};el('time').oninput=paint;el('next').onclick=()=>{el('time').value=Math.min(22,+el('time').value+1);paint()};el('prev').onclick=()=>{el('time').value=Math.max(0,+el('time').value-1);paint()};el('mode').onchange();</script>'''
page=page.replace('MODES',''.join(f'<option value="{m}">{m}</option>' for m in summary['runs']))
(OUT/'comparison.html').write_text(page)
print(json.dumps(summary['runs'],indent=2))

if 'cold' in summary['runs']:
    assert summary['runs']['cold']['quarterDarkPatch'] < .08, 'Night entry contains an unexpected white or grey flash'
