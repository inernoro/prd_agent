"""Build independent chapter review projects from approved copy and measured speech.

Media and render output stay outside the repository. An individual segment key
includes only that segment, its audio/assets, and this renderer, so editing one
segment does not invalidate the others.
"""
from pathlib import Path
import argparse, hashlib, html, json, re, shutil
from fontTools import subset

P = argparse.ArgumentParser()
P.add_argument('--spec', type=Path, default=Path(__file__).with_name('production.json'))
P.add_argument('--out', type=Path, required=True)
P.add_argument('--shared-assets', type=Path, required=True)
P.add_argument('--source-assets', type=Path, help='Relocated original screenshots; defaults to OUT/source-assets')
P.add_argument('--audio-dir', type=Path, help='Measured official audio; defaults to OUT/official_audio for the current course')
P.add_argument('--only')
A = P.parse_args()
SPEC = json.loads(A.spec.read_text())
A.audio_dir=A.audio_dir or A.out/('official_audio' if SPEC.get('audio_policy') else 'audio')
A.out.mkdir(parents=True, exist_ok=True)
E = html.escape
PROMPTS = {
 'c1-s01-c':'请确认当前连接的账户和目标仓库，实际读取仓库规则，再告诉我连接是否可用。',
 'c1-s02-c':'请分别核对自动评审的触发记录和手动评审结果。未实际完成时，请说明卡在哪一步。',
 'c2-s01-c':'请根据这份启动提示词取得并安装所需技能，保留已有修改，再实际读取正文和依赖。',
}
CSS = '''@font-face{font-family:WenKai;src:url("assets/wenkai.ttf")}@font-face{font-family:Mono;src:url("assets/mono.ttf")}*{box-sizing:border-box;margin:0}html,body{width:100%;height:100%;overflow:hidden;background:#f6f1e7;color:#243a38;font-family:WenKai,serif}#root{position:relative;width:100%;height:100%;overflow:hidden}.scene{position:absolute;inset:0}.paper{position:absolute;inset:0;overflow:hidden;background:#f6f1e7}.eyebrow{position:absolute;left:120px;right:120px;top:52px;display:flex;justify-content:space-between;font-size:26px;color:#59635c}.title{position:absolute;left:120px;top:105px;font-size:64px;font-weight:400;line-height:90px;white-space:nowrap}.hint{position:absolute;left:120px;top:210px;font-size:33px;line-height:46px;color:#21745b}.url{position:absolute;left:120px;top:266px;font:23px/30px Mono,monospace;color:#243a38}.draw-stage{position:absolute;left:120px;top:330px;width:1680px;height:500px}.diagram{width:1680px;height:500px;overflow:visible}.drawing-arm{position:absolute;left:0;top:0;pointer-events:none;z-index:50}.drawing-arm img{width:100%;height:100%;display:block}.prompt{position:absolute;left:150px;right:150px;top:350px;height:435px;padding:42px 55px;border:3px solid #21745b;background:#e7ede2}.prompt-label{font-size:29px;color:#21745b;margin-bottom:25px}.prompt p{font-size:46px;line-height:1.75}.visual{position:absolute;left:120px;top:310px;width:1680px;height:520px;border:2px solid #d1d2c5;background:#fff;overflow:hidden}.picture{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}.source{position:absolute;left:120px;right:120px;top:848px;font-size:22px;line-height:32px;color:#79521e;text-align:center;z-index:100;background:#f6f1e7}.caption{position:absolute;left:110px;right:110px;bottom:87px;min-height:54px;padding:9px 20px;text-align:center;font-size:35px;line-height:1.45;background:#f6f1e7;color:#243a38;z-index:200;opacity:0}.footer{position:absolute;left:120px;right:120px;bottom:23px;display:flex;justify-content:space-between;font-size:22px;color:#59635c;z-index:210}.progress{position:absolute;left:120px;right:120px;bottom:72px;height:3px;background:#d1d2c5;z-index:210}.progress-line{height:3px;background:#21745b;transform-origin:left}.mono{font-family:Mono,monospace}'''

def digest(path):
 return hashlib.sha256(path.read_bytes()).hexdigest()

def stroke(sid, d, at=0, color='#243a38'):
 return f'<path id="{sid}" class="draw" data-at="{at}" d="{d}" fill="none" stroke="{color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>'

def box(sid,x,y,w,h,at=0,color='#243a38'):
 return stroke(sid,f'M{x+16} {y} Q{x} {y} {x} {y+16} L{x} {y+h-16} Q{x} {y+h} {x+16} {y+h} L{x+w-16} {y+h} Q{x+w} {y+h} {x+w} {y+h-16} L{x+w} {y+16} Q{x+w} {y} {x+w-16} {y} L{x+16} {y}',at,color)

def diagram(scene):
 result=''
 for j,label in enumerate(scene['bullets']):
  x=60+j*850;sid=scene['id']+'-box'+str(j)
  result+=box(sid,x,65,700,230,j*3,'#243a38' if not j else '#21745b')
  lines=[];line='';units=0
  for token in re.findall(r'[A-Za-z]+|[0-9]+|[^A-Za-z0-9]',label):
   width=sum(1 if '\u3400'<=ch<='\u9fff' else .55 for ch in token)
   if line and units+width>15:lines.append(line.strip());line='';units=0
   line+=token;units+=width
  if line:lines.append(line.strip())
  text=''.join(f'<text x="{x+350}" y="{181+(n-(len(lines)-1)/2)*55}" text-anchor="middle" font-size="42" fill="#243a38">{E(line)}</text>' for n,line in enumerate(lines))
  result+=f'<g class="reveal" data-after-stroke="{sid}">{text}</g>'
 result+=stroke(scene['id']+'-arrow','M760 180 L910 180',6.1)+stroke(scene['id']+'-tip','M886 158 L910 180 L886 202',6.5)
 sid=scene['id']+'-line'
 result+=stroke(sid,'M100 370 Q840 390 1580 370',7.0,'#21745b')
 result+=f'<g class="reveal" data-after-stroke="{sid}"><text x="840" y="450" text-anchor="middle" font-size="31" fill="#21745b">人：登录、授权、确认　　Agent：安装、配置、执行与验证</text></g>'
 return result

def stamp(t):
 n=round(t*1000);return f'{n//3600000:02d}:{n//60000%60:02d}:{n//1000%60:02d},{n%1000:03d}'

manifest=[]
for seg in SPEC['segments']:
 if A.only and A.only!=seg['id']:continue
 missing=[s['id'] for s in seg['scenes'] if s.get('voice') and not (A.audio_dir/(s['id']+'.json')).exists()]
 if missing:raise SystemExit('配音尚未生成：'+', '.join(missing))
 root=A.out/'projects'/seg['id'];assets=root/'assets';assets.mkdir(parents=True,exist_ok=True)
 for name in ['gsap.min.js','handdraw-runtime.js','teacher-pen.png','mono.ttf','wenkai-OFL.txt','sweety-LICENSE.txt']:
  shutil.copy2(A.shared_assets/name,assets/name)
 template=A.out/'template'
 for name in ['hyperframes.json','package.json','AGENTS.md']:
  if (template/name).exists():shutil.copy2(template/name,root/name)
 scenes=[];caps=[];sections=[];audios=[];clock=0;input_assets=[]
 for i,source in enumerate(seg['scenes']):
  s=dict(source);meta=json.loads((A.audio_dir/(s['id']+'.json')).read_text()) if s.get('voice') else {'seconds':0,'captions':[]}
  if s.get('voice') and SPEC.get('audio_policy') and meta.get('engine')!='openai-speech':raise SystemExit('旧本地中文配音已拒绝；必须提供官方语音实测音频。')
  s['start']=round(clock,5);s['voice_start']=round(clock+.7,5)
  s['duration']=round(.7+meta['seconds']+s['pause_seconds'],5);clock+=s['duration']
  if s.get('voice'):
   media=Path(meta['audio'])
   if not media.exists():media=A.audio_dir/(s['id']+'.wav')
   shutil.copy2(media,assets/media.name);input_assets.append(media)
   audios.append(f'<audio id="audio-{s["id"]}" src="assets/{media.name}" data-start="{s["voice_start"]}" data-duration="{meta["seconds"]}" data-track-index="20"></audio>')
  for c in meta['captions']:caps.append({'start':s['voice_start']+c['start'],'end':s['voice_start']+c['end'],'text':c['text']})
  pics=[Path(x) if Path(x).exists() else (A.source_assets or A.out/'source-assets')/Path(x).name for x in s.get('asset_candidates',[])];body=''
  if pics:
   images=[];slot=(s['duration']-.7)/len(pics)
   for j,p in enumerate(pics):
    if not p.is_file():raise RuntimeError('缺少真实素材 '+str(p))
    shutil.copy2(p,assets/p.name);input_assets.append(p)
    framing='style="object-fit:cover;object-position:center top" data-report-pan="true"' if s['kind']=='report' else ''
    images.append(f'<img id="img-{s["id"]}-{j}" class="picture" src="assets/{p.name}" data-start="{s["start"]+j*slot}" data-duration="{slot+.7}" {framing} alt="{E(s["source_note"])}">')
   body='<div class="visual">'+''.join(images)+'</div>';s['visual_kind']='asset'
  elif s['kind']=='prompt':
   body='<div class="prompt"><div class="prompt-label">直接告诉 Codex</div><p>'+E(PROMPTS.get(s['id'],s['voice']))+'</p></div>';s['visual_kind']='prompt'
  else:
   body='<div class="draw-stage"><svg class="diagram" viewBox="0 0 1680 500">'+diagram(s)+'</svg></div><div class="drawing-arm" data-layout-ignore="true"><img id="arm-'+s['id']+'" src="assets/teacher-pen.png" data-start="'+str(s['start'])+'" data-duration="'+str(s['duration'])+'" alt="逐笔讲解"></div>';s['visual_kind']='draw'
  url='<div class="url">'+E(s['display_url'])+'</div>' if s.get('display_url') else ''
  sections.append(f'<section id="{s["id"]}" class="clip scene" data-start="{s["start"]}" data-duration="{s["duration"]+(.5 if i<len(seg["scenes"])-1 else 0)}" data-track-index="{i+1}" style="z-index:{i+1}"><div class="paper"><div class="eyebrow"><span>第{seg["chapter"]}章 · {E(seg["title"])}</span><span>{seg["id"]} / {i+1:02d}</span></div><h1 class="title">{E(s["headline"])}</h1><p class="hint">{E("　/　".join(s["bullets"]))}</p>{url}{body}<p class="source">{E(s["source_note"])}</p></div></section>')
  scenes.append(s)
 duration=round(clock,5)
 script='''window.__timelines=window.__timelines||{};const tl=gsap.timeline({paused:true});const SCENES=__SCENES__,CAPS=__CAPS__;SCENES.forEach((s,i)=>{const scene=document.getElementById(s.id);if(s.visual_kind==='draw'){const child=Handdraw.build(scene,s.duration,s.id,{origin:{x:120,y:330},arm:{width:887,height:1774,nib:[109,36],scale:.48}});child.paused(false);tl.add(child,s.start);}else{tl.from(scene.querySelector('.title'),{opacity:0,y:12,duration:.55,ease:'power3.out'},s.start+.12);tl.from(scene.querySelector('.visual,.prompt'),{opacity:0,y:12,duration:.6,ease:'sine.out'},s.start+.35)}tl.from(scene.querySelector('.eyebrow'),{opacity:0,x:-10,duration:.42,ease:'power2.out'},s.start+.1);tl.from(scene.querySelector('.hint'),{opacity:0,y:8,duration:.6,ease:'sine.out'},s.start+.25);if(i)tl.fromTo(scene.querySelector('.paper'),{opacity:0},{opacity:1,duration:.5,ease:'sine.inOut',immediateRender:false},s.start);});document.querySelectorAll('.picture').forEach(el=>{tl.fromTo(el,{opacity:0},{opacity:1,duration:.3,ease:'sine.inOut',immediateRender:false},Number(el.dataset.start));if(el.dataset.reportPan)tl.fromTo(el,{objectPosition:'center top'},{objectPosition:'center bottom',duration:Math.max(1,Number(el.dataset.duration)-9),ease:'sine.inOut',immediateRender:false},Number(el.dataset.start)+4)});CAPS.forEach((c,i)=>{const el=document.getElementById('cap-'+i);tl.fromTo(el,{opacity:0},{opacity:1,duration:.1,ease:'power1.out',immediateRender:false},c.start);tl.set(el,{opacity:0},c.end)});tl.from('.footer',{opacity:0,duration:.6,ease:'power2.out'},.2);tl.fromTo('.progress-line',{scaleX:0},{scaleX:1,duration:__DURATION__,ease:'none'},0);window.__timelines['__ID__']=tl;'''.replace('__SCENES__',json.dumps(scenes,ensure_ascii=False)).replace('__CAPS__',json.dumps(caps,ensure_ascii=False)).replace('__DURATION__',str(duration)).replace('__ID__',seg['id'])
 caphtml=''.join(f'<p id="cap-{i}" class="clip caption" data-start="{c["start"]}" data-duration="{c["end"]-c["start"]}" data-track-index="10" data-track-kind="captions">{E(c["text"])}</p>' for i,c in enumerate(caps))
 markup=f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>{E(seg["title"])}</title><script src="assets/gsap.min.js"></script><script src="assets/handdraw-runtime.js"></script><style>{CSS}</style></head><body><div id="root" data-composition-id="{seg["id"]}" data-start="0" data-duration="{duration}" data-width="1920" data-height="1080" data-fps="30">'+''.join(sections)+caphtml+''.join(audios)+'<div class="progress"><div class="progress-line"></div></div><div class="footer"><span>分段审阅版 · 中文机器配音 · 证据状态见画面</span><span>'+seg['id']+' · 第一、二章</span></div></div><script>'+script+'</script></body></html>'
 (root/'index.html').write_text(markup)
 options=subset.Options();font=subset.load_font(str(A.shared_assets/'wenkai.ttf'),options);subsetter=subset.Subsetter(options=options);subsetter.populate(text=markup);subsetter.subset(font);subset.save_font(font,str(assets/'wenkai.ttf'),options)
 (root/'timing.json').write_text(json.dumps({'id':seg['id'],'duration_seconds':duration,'scenes':scenes,'captions':caps},ensure_ascii=False,indent=2)+'\n')
 (root/'subtitles.srt').write_text('\n\n'.join(f'{i+1}\n{stamp(c["start"])} --> {stamp(c["end"])}\n{c["text"]}' for i,c in enumerate(caps))+'\n')
 (root/'narration.txt').write_text('\n\n'.join(s['voice'] for s in scenes)+'\n')
 key=hashlib.sha256(json.dumps(seg,ensure_ascii=False,sort_keys=True).encode()+Path(__file__).read_bytes())
 for p in input_assets:key.update(p.name.encode());key.update(bytes.fromhex(digest(p)))
 for name in ['gsap.min.js','handdraw-runtime.js','teacher-pen.png','mono.ttf','wenkai.ttf']:key.update(bytes.fromhex(digest(A.shared_assets/name)))
 entry={'id':seg['id'],'title':seg['title'],'chapter':seg['chapter'],'duration_seconds':duration,'content_key':key.hexdigest(),'video':'videos/'+seg['id']+'.mp4','review_status':'awaiting_user_review','evidence_gaps':seg['evidence_gaps'],'source_commit':SPEC['source_commit']}
 (root/'build-manifest.json').write_text(json.dumps(entry,ensure_ascii=False,indent=2)+'\n');manifest.append(entry)
 print(json.dumps(entry,ensure_ascii=False),flush=True)
if not A.only:(A.out/'delivery-manifest.json').write_text(json.dumps({'goal':SPEC['goal'],'segments':manifest,'actual_total_seconds':sum(x['duration_seconds'] for x in manifest),'status':'rendering','other_chapters':'pending_user_review'},ensure_ascii=False,indent=2)+'\n')
