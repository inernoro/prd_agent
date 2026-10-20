"""Generate offline textbook from the exact storyboard, course cards and rendered timing.
Run again after rendering / frame extraction; no guessed timestamps or instance URLs.
"""
from pathlib import Path
from html import escape as esc
import json,re,hashlib,math
import argparse
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root',type=Path,default=Path.cwd(),help='制作根目录，默认当前工作目录')
parser.add_argument('--repo',type=Path,default=Path.cwd(),help='包含scripts/testing-tutorial/course.json的课程仓库根目录，默认当前工作目录')
parser.add_argument('--link-record',type=Path,default=None,help='真实链接核验记录，默认制作根/evidence/review-link-check.json')
args=parser.parse_args()
ROOT=args.root.resolve()
REPO=args.repo.resolve()
LINK_RECORD=args.link_record.resolve() if args.link_record else ROOT/'evidence/review-link-check.json'
course_path=REPO/'scripts/testing-tutorial/course.json'
if not course_path.is_file():parser.error('找不到课程操作卡，请用--repo指定课程仓库根目录：'+str(course_path))
if not (ROOT/'segments.json').is_file():parser.error('找不到segments.json，请用--root指定制作根目录：'+str(ROOT))
story=json.loads((ROOT/'segments.json').read_text())
course=json.loads(course_path.read_text())
cards={x['id']:x for ch in course['chapters'] for x in ch['steps']}
record_path=LINK_RECORD
record=json.loads(record_path.read_text()) if record_path.exists() else {}
verified={x['url']:{**x,'checked_at':record.get('checked_at','未记录')} for x in record.get('links',[])}
delivery_path=ROOT/'delivery-manifest.json'
delivery=json.loads(delivery_path.read_text()) if delivery_path.exists() else {}
audio_rejected=delivery.get('status')=='audio_rejected_by_user' or delivery.get('quality')=='audio_rejected'
time_state='当前配音版时间点，待重排' if audio_rejected else '与当前视频对应的时间点'
time_prefix='当前配音版时长（待重排） ' if audio_rejected else '实际制作时长 '
M={
'c1-s01':['R00','R00A','R00B'],
'c1-s02':['R01','R02','R03'],
'c1-s03':['R04','R04','R05','R05','R05'],
'c1-s04':['R06','R06','R06','R05'],
'c2-s01':['V01','V01A','V02','V03'],
'c2-s02':['V03B','V04','V04A'],
'c2-s03':['V04B','V04B','V05','V05'],
'c2-s04':['V05A','V05A','V05A'],
'c2-s05':['V06','V07','V07','V08']}
HUMAN={
'c1-s01-a':'使用自己的账户打开产品入口，完成登录；按实际界面进入连接GitHub。',
'c1-s01-b':'核对发布者、个人或组织身份，选择目标仓库，并完成必要授权或管理员申请。',
'c1-s01-c':'完成用户授权与回跳；确认返回的是原账户与工作区。',
'c1-s02-a':'打开代码评审设置，确认账户，选择自己的仓库。',
'c1-s02-b':'只在本人会话需要时完成开关确认或授权；先听Agent说明当前策略。',
'c1-s04-a':'打开分析入口，确认自己的账户和日期范围。',
'c2-s01-a':'在实际MAP页面下载ZIP，再拖入当前项目Codex对话。',
'c2-s01-b':'从CDS“接入Agent”进入上手助手，在技能库选择“视觉验收归档”。',
'c2-s01-c':'把CDS生成的启动提示词复制给当前项目Agent。',
'c2-s02-a':'遇到本人登录、SSO或授权步骤时接手；不提供密码或Token。',
'c2-s02-c':'说明读者平时到哪里看报告，并确认自己能打开。',
'c2-s05-a':'打开Agent返回的本轮真实报告链接，确认目的地正确。'}
AGENT={
'c1-s01-a':'检查项目已有连接与所需权限；返回下一步实际入口。',
'c1-s01-b':'说明安装范围、组织批准状态；不能把申请提交当成授权生效。',
'c1-s02-a':'检查目标仓库和实际入口；找不到时回查连接、仓库勾选及组织批准。',
'c1-s03-a2':'用历史发现解释：页面能打开，仍需验证后续请求、鉴权与结果返回。历史案例不能当本轮已修复证明。',
'c1-s04-b':'对照历史PR1281的8轮记录解释趋势：中间P1为零，后轮仍可能再发现P1；评论数量不等于开放缺陷数。',
'c1-s04-c':'把每轮发现评论、去重有效问题、当前开放问题分别记录，关联被审版本和处理证据。',
'c2-s01-a':'检查包的真实来源与内容，安装并读回实际技能；不要求人解压或执行命令。',
'c2-s01-b':'核对当前CDS权威技能分发。海鲜市场只列清单，手动安装包也不是视觉验收包。',
'c2-s03-b':'检查PR、定时或发布前事件是否真正接线；未配置只能说明约定，不能声称自动触发已生效。',
'c2-s03-b2':'把待验证动作拆成输入、操作、预期反馈及报告证据，再按项目真实条件执行。',
'c2-s05-c':'打开证据对应的动作、预期与实际，核对失败项、复测记录、未执行项和剩余缺口。'}
def fmt(n):
 if n is None:return '待生成'
 n=max(0,int(float(n)));return f'{n//60:02}:{n%60:02}'
def copybox(text,label='复制内容'):
 return '<div class="copybox"><textarea readonly aria-label="'+esc(label)+'">'+esc(text)+'</textarea><button type="button" class="copy">'+esc(label)+'</button><span class="copy-feedback" role="status"></span></div>'
def state(scene):
 return {'authenticated_ui_pending':'操作路径示意 · 登录实录待补','live_run_pending':'现场运行实录待补','local_component_demo':'本机组件 · 教学数据','historical_verified':'历史记录 · 非本轮结论','explanatory':'讲解示意','pause_card':'无声暂停卡'}.get(scene.get('evidence_state'),'按画面标注区分 · 不等于线上验收')
url_set={}
lessons=[];toc=[];data=[]
for seg in story['segments']:
 timing_file=ROOT/'projects'/seg['id']/'timing.json'
 timing=json.loads(timing_file.read_text()) if timing_file.exists() else {}
 tscenes={x['id']:x for x in timing.get('scenes',[])}
 assert len(M[seg['id']])==len(seg['scenes']),seg['id']
 toc.append('<li><a href="#'+seg['id']+'"><strong>'+seg['id']+' · '+esc(seg['title'])+'</strong><span>'+fmt(timing.get('duration_seconds'))+'</span></a><ul>')
 articles=[]
 for i,(scene,cid) in enumerate(zip(seg['scenes'],M[seg['id']])):
  card=cards[cid];t=tscenes.get(scene['id'],{});start=t.get('start')
  seek=min(math.ceil((float(start)+0.65)*30)/30,float(start)+float(t.get('duration',1))-1/30) if start is not None else None
  label=fmt(seek)
  pause=not bool(scene.get('voice'))
  human=HUMAN.get(scene['id'],'说明本轮业务目标，确认Agent理解与结果；遇到本人登录或授权再接手。')
  agent=AGENT.get(scene['id'],card['action'])
  action='；'.join(scene.get('bullets',[]))+'。'
  expected=card['expected'];recovery=card['recovery']
  if pause:
   human='暂停视频，选自己的PR或功能，按本章顺序复述一次；只向Agent说明目标并审阅结果。'
   agent='按本章流程协助完成练习，返回实际证据、未完成项与下一步；不替人提前宣布理解或通过。'
   action='对照本幕检查点，换成自己的项目完成一轮。'
   expected='能指出从哪里开始、交给Agent什么、到哪里看结果，以及缺什么证据。'
   recovery='说不清某一步就回到对应小节；前提或证据缺失时保留未完成，不跳过。'
  for u in [scene.get('display_url')]+[x for x in scene.get('sources',[])+card.get('sources',[]) if x.startswith('https://')]:
   if u:url_set.setdefault(u,[]).append(scene['id'])
  url_html=''
  if scene.get('display_url'):
   url=scene['display_url'];v=verified.get(url,{})
   url_html='<h4>本幕关键地址</h4>'+copybox(url,'复制地址')+'<p class="verification">'+esc(v.get('result','尚无本轮访问核验记录，目标页待核验'))+'<br>核验记录时间：'+esc(v.get('checked_at','未记录'))+'；登录后目标页：'+('已核验' if v.get('authenticated_target_verified') else '待核验')+'</p>'
  prompt=card.get('command','') if card.get('command_kind')=='prompt' else ''
  prompt_html='<h4>交给Agent</h4>'+copybox(prompt,'复制提示词') if prompt else ''
  src='<details class="sources"><summary>来源与本幕证据状态</summary><p>'+esc(scene.get('source_note',''))+'</p><p>对应操作卡：'+esc(cid)+'；教材与视频源：segments.json / course.json / guide.platform.testing.script.md。</p><ul>'+''.join('<li>'+esc(x)+'</li>'for x in dict.fromkeys(scene.get('sources',[])+card.get('sources',[])))+'</ul></details>'
  image='../evidence/textbook/'+scene['id']+'.jpg'
  frame_record=ROOT/'evidence/textbook'/(scene['id']+'.json')
  frame_time=json.loads(frame_record.read_text()).get('time_seconds') if frame_record.exists() else None
  video='../review/index.html?segment='+seg['id']+('&amp;t='+str(round(seek,6)) if seek is not None else '')+'#'+seg['id']
  art='<article class="scene" id="'+scene['id']+'"><div class="scene-meta">'+seg['id']+' · 本段 '+label+('（待重排）' if audio_rejected else '')+' · '+esc(cid)+'</div><h3>'+esc(scene['headline'])+'</h3><p class="badge">'+esc(state(scene))+'</p><figure><img src="'+image+'" alt="视频同帧：'+esc(scene['headline'])+'" loading="lazy"><div class="frame-missing">视频同帧图待提取<br>'+esc(scene['id'])+'</div><figcaption>本幕定位 '+label+'；同帧图取自 '+fmt(frame_time)+'；<a href="'+video+'" target="_blank">打开对应视频位置</a></figcaption></figure><p class="action"><strong>这一幕做什么：</strong>'+esc(action)+'</p><dl><dt>你做什么</dt><dd>'+esc(human)+'</dd><dt>Agent做什么</dt><dd>'+esc(agent)+'</dd><dt>看到什么才算到位</dt><dd>'+esc(expected)+'</dd><dt>出错怎么办</dt><dd>'+esc(recovery)+'</dd></dl>'+url_html+prompt_html+'<details class="voice"><summary>展开视频旁白</summary><p>'+esc(scene.get('voice')or'本幕为无声暂停卡，留出阅读和练习时间。')+'</p></details>'+src+'</article>'
  articles.append(art)
  toc.append('<li><a href="#'+scene['id']+'">'+esc(scene['headline'])+' <span>'+label+'</span></a></li>')
  data.append({'scene_id':scene['id'],'segment_id':seg['id'],'course_card_id':cid,'video_start_seconds':start,'video_seek_seconds':seek,'frame':image})
 toc.append('</ul></li>')
 lessons.append('<section class="segment" id="'+seg['id']+'"><header class="segment-header"><div>第'+str(seg['chapter'])+'章 · '+seg['id']+' · '+time_prefix+fmt(timing.get('duration_seconds'))+'</div><h2>'+esc(seg['title'])+'</h2><p>'+esc(' '.join(seg.get('evidence_gaps',[])))+'</p></header>'+''.join(articles)+'</section>')
url_rows=[]
for url,refs in url_set.items():
 v=verified.get(url,{})
 result=v.get('result','来源文件已引用；本教材未取得该链接的本轮独立访问核验记录。')
 checked=v.get('checked_at','未记录；不声称已验证可打开')
 url_rows.append('<article class="url-row"><h3>'+('课程操作入口' if url in verified else '参考来源')+'</h3>'+copybox(url,'复制地址')+'<p>'+esc(result)+'</p><p class="small">记录时间：'+esc(checked)+'<br>使用小节：'+esc('、'.join(dict.fromkeys(refs)))+'</p></article>')
html='''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>前两章配套教材 · 用Codex做好测试交付</title><style>
:root{--paper:#f6f1e7;--ink:#243a38;--green:#21745b;--line:#c7cebf;--muted:#59685f}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.75 "Microsoft YaHei","PingFang SC",sans-serif}a{color:var(--green);text-decoration-thickness:1px;text-underline-offset:3px}button,textarea{font:inherit}button{padding:7px 13px;border:1px solid var(--green);border-radius:5px;color:var(--green);background:transparent;cursor:pointer}button:hover{background:#e7ede2}.cover{padding:38px 5vw 27px;border-bottom:2px solid var(--ink);max-width:1400px;margin:auto}.eyebrow{font-size:14px;letter-spacing:.08em;color:var(--green)}h1{font-size:36px;line-height:1.4;margin:9px 0 15px}h2{font-size:29px;line-height:1.5;margin:7px 0}h3{font-size:23px;line-height:1.5;margin:7px 0 10px}h4{font-size:17px;margin:18px 0 6px}p{margin:10px 0}.cover .links{display:flex;flex-wrap:wrap;gap:12px 22px;margin:15px 0}.layout{display:grid;grid-template-columns:300px minmax(0,1fr);gap:35px;max-width:1400px;margin:auto;padding:28px 5vw}.toc{font-size:14px;align-self:start;position:sticky;top:15px;max-height:calc(100vh - 30px);overflow:auto;padding-right:12px}.toc ul{list-style:none;padding-left:14px}.toc>ul{padding:0}.toc li{margin:8px 0}.toc a{display:flex;justify-content:space-between;gap:7px;text-decoration:none}.toc strong{font-weight:600}.toc span{white-space:nowrap;font:12px/1.9 monospace;color:var(--muted)}.toc-title{font-size:18px;border-bottom:1px solid var(--line);padding-bottom:10px}.toc>ul>li{margin:0 0 20px}.content{min-width:0}.segment-header{border:1px solid var(--green);border-left:5px solid var(--green);padding:18px 22px;margin:0 0 24px;border-radius:3px}.segment-header>div,.segment-header>p{font-size:14px;color:var(--muted)}.scene{scroll-margin-top:15px;border-bottom:2px solid var(--line);padding-bottom:32px;margin:0 0 35px}.scene-meta{font:13px/1.5 monospace;color:var(--green)}.badge{font-size:13px;border:1px solid #b7a77d;color:#805400;display:inline-block;padding:2px 8px;border-radius:3px;margin:0 0 10px}figure{margin:8px 0 20px;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:#edf0e5}figure img{display:block;width:100%;height:auto;aspect-ratio:16/9;object-fit:contain}figcaption{font-size:13px;color:var(--muted);padding:7px 12px;border-top:1px solid var(--line)}.frame-missing{display:none;min-height:180px;align-items:center;justify-content:center;text-align:center;padding:25px;color:var(--muted);background:repeating-linear-gradient(-8deg,#edf0e5,#edf0e5 18px,#e8ede2 18px,#e8ede2 19px)}figure.missing img{display:none}figure.missing .frame-missing{display:flex;flex-direction:column}.action{font-size:18px}dl{display:grid;grid-template-columns:145px minmax(0,1fr);margin:14px 0;gap:0}dt,dd{border-top:1px solid var(--line);padding:11px 8px;margin:0}dt{font-weight:600;color:var(--green)}.copybox{display:flex;flex-wrap:wrap;gap:7px;align-items:center}.copybox textarea{width:100%;min-height:95px;padding:11px 13px;background:#fffdf8;color:var(--ink);border:1px solid var(--line);border-radius:4px;line-height:1.7;resize:vertical;overflow-wrap:anywhere}.copy-feedback,.small,.verification{font-size:13px;color:var(--muted)}details{border-top:1px dashed var(--line);padding:12px 0;font-size:14px;margin-top:12px}summary{cursor:pointer;color:var(--green)}details p{white-space:pre-wrap}.sources li{overflow-wrap:anywhere}.url-list{border-top:3px solid var(--green);padding-top:20px;scroll-margin-top:15px}.url-row{padding:18px 0;border-bottom:1px solid var(--line)}.url-row h3{font-size:16px}.url-row textarea{min-height:70px}.principle{border-left:3px solid var(--green);padding-left:15px;font-size:15px}.print-note{font-size:13px;color:var(--muted)}footer{padding:20px 5vw;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}@media(max-width:950px){.layout{grid-template-columns:1fr;padding:22px}.toc{position:static;max-height:none;border-bottom:2px solid var(--line);padding-bottom:15px}.toc>ul{display:grid;grid-template-columns:1fr 1fr;gap:18px}.cover{padding:25px 22px}h1{font-size:29px}h2{font-size:25px}}@media(max-width:550px){body{font-size:16px}.toc>ul{display:block}.toc>ul>li{margin-bottom:15px}dl{grid-template-columns:1fr}dt{padding-bottom:0}dd{border-top:0;padding-top:4px}.scene h3{font-size:21px}.segment-header{padding:15px}h1{font-size:26px}.layout{padding:20px 16px}.copybox button{width:100%}}@media print{@page{size:A4;margin:15mm 14mm}html{scroll-behavior:auto}body{background:white;color:#172b29;font-size:10pt;line-height:1.6}.cover{padding:0 0 10mm;border-bottom:1pt solid #243a38}.cover h1{font-size:25pt}.layout{display:block;padding:8mm 0}.toc{position:static;max-height:none;overflow:visible;padding:0;break-after:page}.toc{font-size:8.5pt;line-height:1.35}.toc-title{font-size:12pt;padding-bottom:2mm}.toc>ul{columns:2;column-gap:9mm}.toc>ul>li{break-inside:avoid;margin:0 0 3mm}.toc li{margin:1mm 0}.toc span{font-size:7.5pt;line-height:1.4}.toc ul{padding-left:3mm}.cover .links,button,.copy-feedback,.print-note{display:none!important}.segment-header{break-before:auto;break-after:avoid;padding:5mm;margin-top:6mm}.segment-header h2{font-size:18pt}.scene{padding-bottom:5mm;margin-bottom:7mm}.scene h3{font-size:15pt;break-after:avoid}.scene-meta{font-size:8pt;break-after:avoid}.badge{font-size:8pt}figure{break-inside:avoid;max-width:155mm;margin:3mm auto 5mm}figure img{max-height:70mm}figure.missing .frame-missing{min-height:35mm}figcaption{font-size:8pt}.action{font-size:11pt}dl{grid-template-columns:33mm minmax(0,1fr)}dt,dd{padding:2mm;break-inside:avoid}.copybox textarea{display:none}.print-copy{display:block!important;border:1pt solid #c7cebf;padding:3mm;white-space:pre-wrap;overflow-wrap:anywhere;font-size:9pt}.voice,.sources{display:none}.verification,.small{font-size:8pt}.url-list{break-before:page;columns:2;column-gap:8mm}.url-list>h2,.url-list>p{column-span:all}.url-list>h2{font-size:16pt}.url-list>p{font-size:9pt;margin:2mm 0}.url-row{break-inside:avoid;padding:2mm 0;font-size:8.5pt;line-height:1.35}.url-row h3{font-size:9pt;margin:1mm 0}.url-row p{margin:1.5mm 0}.url-row .print-copy{font-size:8pt;line-height:1.35;padding:2mm}.url-row .small{font-size:7.5pt}footer{padding:3mm 0}.url-row textarea{display:none}a{color:inherit;text-decoration:none}}
.print-copy{display:none}
</style></head><body><header class="cover"><div class="eyebrow">视频配套教材 · 第一、第二章</div><h1>用Codex做好一次测试交付</h1><p>面向会使用Codex、测试经验少的项目使用者。按视频的9个片段、33个场景逐步跟做。</p><p class="principle">__AUDIO_NOTICE__</p><p class="principle">你负责说明目标、必要登录授权和审阅结果；代码、命令、环境、测试与归档由Agent处理。每个“通过”都要有实际证据。</p><div class="links"><a href="../review/index.html">返回视频分段审阅</a><a href="#addresses">课程关键地址与核验清单</a><button onclick="window.print()">打印 / 保存PDF</button></div><p class="print-note">__TIME_NOTICE__</p></header><div class="layout"><nav class="toc" aria-label="教材目录"><div class="toc-title">按视频顺序查找</div><ul>__TOC__</ul><a href="#addresses">全部关键地址与来源</a></nav><main class="content">__LESSONS__<section class="url-list" id="addresses"><h2>关键地址与来源复制清单</h2><p>先核对链接实际到达哪里。登录页、首页或HTTP成功，都不能代替目标功能页已核验。</p><p class="principle">MAP、CDS及报告地址因项目而异：让Agent从当前权威配置和CDS实际分支取得可打开入口，核验页面、身份与时间后返回。没有取得实际地址时，保留待核验，不让学员猜域名。</p>__URLS__</section></main></div><footer>按视频顺序跟做，遇到不清楚的步骤可回到对应小节。待补实录和证据缺口仍需完成，不能提前视作系统验收通过。</footer><script>
for(const img of document.querySelectorAll('figure img')){const missing=()=>img.parentElement.classList.add('missing');img.addEventListener('error',missing);img.addEventListener('load',()=>img.parentElement.classList.remove('missing'));if(img.complete&&!img.naturalWidth)missing();}
for(const box of document.querySelectorAll('.copybox')){const area=box.querySelector('textarea'),feedback=box.querySelector('.copy-feedback');const print=document.createElement('div');print.className='print-copy';print.textContent=area.value;box.append(print);box.querySelector('button').addEventListener('click',async()=>{try{if(!navigator.clipboard?.writeText)throw new Error('fallback');await navigator.clipboard.writeText(area.value);feedback.textContent='已复制，可粘贴给Agent或打开地址。';}catch{area.focus();area.select();let ok=false;try{ok=document.execCommand('copy');}catch{}feedback.textContent=ok?'已复制。':'文字已选中，请使用浏览器复制。';}});area.style.height='auto';area.style.height=Math.max(area.scrollHeight+2,70)+'px';}
</script></body></html>'''
html=html.replace('__AUDIO_NOTICE__',('画面 / 教材审阅版；旧配音已停用。以下时间点仅供定位当前画面，待官方配音后重排。' if audio_rejected else '按对应视频逐步跟做，遇到待补实录时保留未完成状态。')).replace('__TIME_NOTICE__',('画面与教材先行审阅。旧配音已停用，时间点待官方配音重排；现有图片和文案继续用于讲解与审阅。' if audio_rejected else '每节附对应视频时间点，图片直接取自成片，待补实录明确标注。你可以按目录回到相同步骤，对照视频跟做。')).replace('__TOC__',''.join(toc)).replace('__LESSONS__',''.join(lessons)).replace('__URLS__',''.join(url_rows))
out=ROOT/'textbook';out.mkdir(exist_ok=True)
(out/'index.html').write_text(html)
(ROOT/'textbook-scene-map.json').write_text(json.dumps({'schema':1,'kind':'generated scene-to-course-card index; normative rules remain in course.json','timing_state':time_state,'sources':{'storyboard':{'path':'segments.json','sha256':hashlib.sha256((ROOT/'segments.json').read_bytes()).hexdigest()},'course_cards':{'path':'scripts/testing-tutorial/course.json','schema':course.get('schema'),'revision':course.get('revision'),'sha256':hashlib.sha256(course_path.read_bytes()).hexdigest()},'guide':'doc/guide.platform.testing.script.md','links':'evidence/review-link-check.json'},'scenes':data,'urls':list(url_set)},ensure_ascii=False,indent=2))
print(json.dumps({'file':str(out/'index.html'),'scenes':len(data),'segments':len(story['segments']),'key_urls':len(url_set),'timing_available':sum(x['video_start_seconds']is not None for x in data)},ensure_ascii=False))
