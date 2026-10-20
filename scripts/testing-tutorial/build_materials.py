#!/usr/bin/env python3
"""Build an offline teaching walkthrough from the same operation cards used by preflight."""
import argparse
import hashlib
import html
import json
import re
import shutil
import subprocess
from pathlib import Path
from preflight import audit

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).parent

HTML = r'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>用 Codex 做好一次测试交付 · 可跟做讲解版</title>
<style>
:root{--paper:#f6f1e7;--ink:#243a38;--green:#21745b;--red:#b54239;--muted:#5e6662;--line:#d7d6c8;--soft:#e7ede2;--amber:#805400}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:20px/1.65 "Noto Sans CJK SC","Microsoft YaHei",sans-serif}button,a,input{font:inherit}button,a{touch-action:manipulation}button{cursor:pointer}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid var(--green);outline-offset:3px}button{background:transparent;color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:8px 16px}button:hover{background:var(--soft)}a{color:var(--green)}header{min-height:84px;padding:16px 32px;border-bottom:1px solid var(--line);display:flex;gap:24px;align-items:center;justify-content:space-between}header strong{font-weight:600;font-size:23px}header span{font-size:15px;color:var(--muted)}.tools{display:flex;gap:8px;align-items:center}.tools button{font-size:16px}.layout{display:grid;grid-template-columns:265px minmax(0,1fr);min-height:calc(100vh - 84px)}nav{border-right:1px solid var(--line);padding:24px 16px}nav button{display:block;border:0;border-radius:0;width:100%;text-align:left;font-size:17px;padding:12px 16px;margin-bottom:4px}nav button.active{background:var(--soft);border-left:3px solid var(--green);font-weight:600}nav .sub{font-size:14px;padding:12px 16px;color:var(--muted)}main{min-width:0;padding:28px 44px 20px;max-width:1540px;width:100%;margin:auto}.eyebrow{display:flex;justify-content:space-between;gap:15px;font-size:16px;color:var(--muted);margin-bottom:10px}.badge{padding:2px 10px;border:1px solid currentColor;border-radius:4px;color:var(--amber);font-size:14px}.badge.local{color:var(--green)}h1{font-size:clamp(28px,3vw,46px);line-height:1.3;font-weight:600;margin:10px 0 18px}h2{font-size:22px;margin:12px 0}p{margin:8px 0}.where{font-size:18px;border-bottom:1px solid var(--line);padding-bottom:16px;margin-bottom:20px}.where b{color:var(--green)}.bodygrid{display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,.88fr);gap:30px;align-items:start}.label{font-size:15px;letter-spacing:.04em;color:var(--green);margin-bottom:8px}.action{font-size:clamp(22px,1.7vw,29px);line-height:1.7;margin-bottom:20px}.expected{border-left:4px solid var(--green);padding:8px 20px;background:var(--soft);font-size:21px}.recovery{font-size:18px;color:var(--muted);padding:16px 0;border-bottom:1px solid var(--line)}.recovery b{color:var(--red)}pre{font:17px/1.7 "DejaVu Sans Mono",monospace;background:#eae8dd;white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;margin:16px 0 6px;border:1px solid var(--line)}.copy{font-size:15px;padding:4px 12px;float:right}.art{margin:0;padding-top:3px}.art img{display:block;max-width:100%;max-height:480px;object-fit:contain;border:1px solid var(--line);background:white;cursor:zoom-in}.art figcaption{font-size:15px;color:var(--muted);margin-top:8px}.diagram{width:100%;min-height:240px;display:flex;flex-direction:column;justify-content:center;gap:15px;padding:26px;border-top:2px solid var(--line);border-bottom:2px solid var(--line)}.diagram .node{padding:14px 20px;border:2px solid var(--ink);font-size:23px;border-radius:12px;max-width:95%}.diagram .node:nth-child(3){color:var(--green);border-color:var(--green)}.diagram .arrow{font-size:25px;line-height:24px;color:var(--green);padding-left:40px}.note{font-size:15px;color:var(--amber);padding:10px 0}.footer{margin-top:24px;padding-top:16px;border-top:1px solid var(--line);display:flex;gap:12px;align-items:center;justify-content:space-between}.footer button{font-size:18px}.progress{font-size:15px;color:var(--muted)}details{margin:20px 0 0;font-size:17px;border-top:1px solid var(--line);padding-top:12px}summary{cursor:pointer;color:var(--green)}.notes{font-size:16px;color:var(--muted);padding:10px 0}.quiz{margin-top:15px;padding:15px 20px;border:1px dashed var(--green)}.quiz strong{font-size:18px}.quiz p{font-size:18px}.quiz .answer{color:var(--green);font-size:17px}.trial{display:flex;gap:8px;flex-wrap:wrap}.trial button{font-size:15px}.trial button.selected{background:var(--green);color:white}.resources{font-size:16px;display:flex;gap:20px;flex-wrap:wrap;margin-top:16px}.overlay{position:fixed;inset:0;background:rgba(15,25,22,.88);z-index:100;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px;gap:20px}.overlay img{max-width:100%;max-height:85vh;object-fit:contain}.overlay button{background:var(--paper)}.hidden{display:none!important}.presenter nav,.presenter header .brand-note,.presenter details,.presenter .resources,.presenter .quiz{display:none}.presenter .layout{grid-template-columns:1fr}.presenter main{max-width:1800px}.presenter .action{font-size:30px}.presenter .expected{font-size:26px}.presenter .recovery{font-size:23px}.presenter h1{font-size:52px}.presenter .where{font-size:23px}.presenter .art img{max-height:560px}.presenter .eyebrow{font-size:21px}dialog{max-width:950px;width:90vw;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink);padding:28px}dialog::backdrop{background:rgba(20,35,30,.65)}.status-list{max-height:65vh;overflow:auto;font-size:17px}.status-list li{margin-bottom:10px}.field{margin:12px 0}.field label{display:block;font-size:16px}.field input{width:100%;padding:10px;background:white;border:1px solid var(--line);border-radius:4px;font-size:18px}.print-only{display:none}@media(max-width:1000px){header{padding:12px 18px;align-items:flex-start}header strong{font-size:18px}.layout{grid-template-columns:1fr}nav{display:flex;overflow:auto;gap:5px;padding:10px;border-right:0;border-bottom:1px solid var(--line)}nav button{white-space:nowrap;width:auto;font-size:14px;margin:0;padding:7px 10px}nav .sub{display:none}main{padding:20px}.bodygrid{grid-template-columns:1fr}.art{order:-1}.art img{max-height:300px;max-width:100%;margin:auto}.diagram{min-height:0;flex-direction:row;align-items:center;gap:10px;padding:16px}.diagram .node{font-size:16px;padding:10px}.diagram .arrow{transform:rotate(-90deg);padding:0}.tools{flex-wrap:wrap;justify-content:flex-end}.tools button{font-size:13px;padding:5px 8px}.eyebrow{flex-wrap:wrap}.presenter h1{font-size:34px}.presenter .action{font-size:23px}.presenter .expected{font-size:21px}.presenter .recovery{font-size:18px}.presenter .where{font-size:17px}}@media print{nav,header,.footer,details,.resources,.copy,.quiz{display:none!important}.layout,.bodygrid{display:block}main{padding:0;max-width:none}.print-only{display:block}body{font-size:12pt}.action,.expected{font-size:14pt}h1{font-size:24pt}.art img{max-height:250px}}
</style></head><body>
<header><div><strong>用 Codex 做好一次测试交付</strong><div class="brand-note"><span>人说目标，Agent操作代码与测试 · 保留原有内容，预算 __MINUTES__ 分钟</span></div></div><div class="tools"><button id="inputs">谁来操作</button><button id="status">检查状态</button><button id="quiz-open">暂停提问</button><button id="present">讲解模式</button><button id="export">导出试学记录</button></div></header>
<div class="layout"><nav id="chapters" aria-label="课程章节"></nav><main>
<div class="eyebrow"><span id="chapter"></span><span id="proof" class="badge"></span></div><h1 id="title"></h1><div class="where" id="where"></div>
<div class="bodygrid"><section><div class="label">现在做这一件事</div><p class="action" id="action"></p><div class="expected"><div class="label">看到什么才算做成</div><div id="expected"></div></div><div id="command-wrap"><pre id="command"></pre><button class="copy" id="copy">复制指令</button><a id="command-link" class="hidden" target="_blank" rel="noopener">打开页面</a><div style="clear:both"></div></div><p class="recovery"><b>没看到这个结果：</b><span id="recovery"></span></p></section><figure class="art" id="art"></figure></div>
<div class="quiz"><strong>先停一下，再继续</strong><p id="question"></p><button id="reveal">显示核对答案</button><p id="answer" class="answer hidden"></p></div>
<details id="teacher"><summary>讲师备注、来源与跟做记录</summary><div class="notes" id="notes"></div><div class="trial"><button data-trial="independent">独立完成</button><button data-trial="hinted">需要提示</button><button data-trial="blocked">卡住了</button></div><p class="note">按钮只记录本机试学情况，不会把课程标成正式验收通过。请按实际观察填写。</p></details>
<div class="footer"><button id="prev">上一步</button><span class="progress" id="progress"></span><button id="next">下一步</button></div>
<div class="resources"><a href="操作卡.html">完整操作卡</a><a href="preflight.json">渲染前检查结果</a><a href="create-visual-test-to-kb-repository-bundle.zip" download>仓库备用技能包</a><a href="doc/guide.platform.testing.script.md">原有完整口播稿</a></div>
</main></div>
<div id="zoom" class="overlay hidden"><img alt="放大的实际操作画面"><button id="closezoom">关闭画面</button></div>
<dialog id="quiz-dialog"><h2>先想清楚，再继续</h2><p id="quiz-question"></p><button id="quiz-answer-button">显示核对答案</button><p id="quiz-answer" class="hidden"></p><button data-close>继续操作</button></dialog>
<dialog id="status-dialog"><h2>渲染前检查状态</h2><div class="status-list" id="status-content"></div><button data-close>关闭</button></dialog>
<dialog id="inputs-dialog"><h2>谁来操作</h2><p>你：用一句话说明目标、登录并确认必要授权、打开实际页面检查结果。</p><p>Agent：整理测试记录，查询版本、入口与权限，操作代码，运行测试，修复并重新评审。</p><p>不要求你执行终端命令、编辑文件、填写版本号或复制密码。Agent 给出地址前，应先实际确认目标页面；缺登录或权限时说明下一步。</p><button data-close>关闭</button></dialog>
<script>
const COURSE=__COURSE__,LEDGER=__LEDGER__,PREFLIGHT=__PREFLIGHT__,ASSETS=__ASSETS__,SOURCE_REF=__SOURCE_REF__;
const STEPS=COURSE.chapters.flatMap(c=>c.steps.map(s=>({...s,chapter:c.title,chapterId:c.id,goal:c.goal})));
const $=id=>document.getElementById(id),escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let index=0, trial={};try{trial=JSON.parse(localStorage.getItem('testing-course-trial')||'{}')}catch{}
const quizzes={V01:['下载完成以后，哪件事还没有得到证明？','还没有证明工具识别了技能，也没有证明验收环境和CDS归档可用。'],V02:['SKILL.md应该在技能目录的哪一层？','应在create-visual-test-to-kb目录下直接可见；同时核对两项依赖。'],V03:['目录里存在文件，能否证明当前会话已识别技能？','不能。需要工具实际读取正文；必要时重新加载或新开会话。'],V04:['应用能登录，是否说明CDS报告一定能写入？','不能。应用登录和CDS项目归档是两套权限，要分别确认。'],V06:['生成了本机HTML，能否写“验收报告已交付”？','不能。必须正式归档到CDS并检查线上正文、证据和链接。'],V07:['报告找不到时，先查哪三项？','先查登录身份、项目范围和筛选条件，再核对归档结果。'],U03:['共享函数测试通过，能否排除另一个技能仍在自己计算？','不能。还要检查使用方，并证明旧出口重新出现时检查会失败。'],U04:['英文标题正确，是否足够证明中文标题跟着片长走？','不够。每个使用方都可能独立漂移，需分别检查。'],R03:['手动评审成功，能证明自动开关配置正确吗？','不能。自动评审要用符合所选触发策略的事件单独验证。']};
function sourceLink(s){return s.startsWith('https://')?s:'https://github.com/inernoro/prd_agent/blob/'+SOURCE_REF+'/'+s}
function render(){const s=STEPS[index],r=LEDGER.steps?.[s.id],asset=ASSETS[s.id];$('chapter').textContent=s.chapter;$('title').textContent=s.title;$('where').innerHTML='<b>从这里开始：</b>'+escape(s.where)+'<br><small>'+escape(s.operator==='human_browser'?'你完成登录、页面点击与授权确认':'发送任务给Agent，由Agent完成技术操作')+'</small>';$('action').textContent=s.action;$('expected').textContent=s.expected;$('recovery').textContent=s.recovery;$('command').textContent=s.command;$('command-wrap').classList.toggle('hidden',!s.command);$('copy').textContent=({prompt:'复制给Codex',shell:'复制命令',url:'复制链接',comment:'复制PR评论'})[s.command_kind]||'复制内容';$('command-link').classList.toggle('hidden',s.command_kind!=='url');if(s.command_kind==='url')$('command-link').href=s.command;let label=r?.state==='live'?'真实环境已核验':r?.state==='local'?(s.required_proof==='live'?'本机已演练 / 线上待核验':'本机演练已执行'):'待实际操作核验';if(s.required_proof==='content')label='讲解与练习说明';$('proof').textContent=label;$('proof').classList.toggle('local',r?.state==='local'||r?.state==='live');$('art').innerHTML=asset?'<img src="'+escape(asset.image)+'" alt="'+escape(asset.caption)+'"><figcaption>'+escape(asset.caption)+'</figcaption>':'<div class="diagram"><div class="node">找到操作位置</div><div class="arrow">↓</div><div class="node">执行并观察</div><div class="arrow">↓</div><div class="node">对照预期判断</div></div><figcaption>教学示意。真实界面尚未核验的步骤，保持待核验标记。</figcaption>';$('art').querySelector('img')?.addEventListener('click',()=>{$('zoom').querySelector('img').src=asset.image;$('zoom').classList.remove('hidden')});const quiz=quizzes[s.id]||['做完这一步，你要留下什么结果？',s.expected];$('question').textContent=quiz[0];$('answer').textContent=quiz[1];$('answer').classList.add('hidden');$('reveal').textContent='显示核对答案';$('notes').innerHTML='<p>本章目标：'+escape(s.goal)+'</p><p>证据范围：'+escape(r?.scope||'尚未取得对应实操证据；不宣称操作完成。')+'</p>'+(s.needs.length?'<p>Agent需要确认：'+s.needs.map(n=>escape(n)).join('；')+'</p>':'')+'<p>来源：'+s.sources.map(x=>'<a target="_blank" rel="noopener" href="'+escape(sourceLink(x))+'">'+escape(x)+'</a>').join(' / ')+'</p>';$('progress').textContent=s.id+' · '+(index+1)+' / '+STEPS.length+' · 方向键翻页 / F全屏 / P讲解模式';$('prev').disabled=index===0;$('next').disabled=index===STEPS.length-1;document.querySelectorAll('#chapters button').forEach(b=>b.classList.toggle('active',b.dataset.id===s.chapterId));document.querySelectorAll('[data-trial]').forEach(b=>b.classList.toggle('selected',trial[s.id]?.result===b.dataset.trial));history.replaceState(null,'','#'+s.id);window.scrollTo(0,0)}
COURSE.chapters.forEach(c=>{const b=document.createElement('button');b.textContent=c.title;b.dataset.id=c.id;b.addEventListener('click',()=>{index=STEPS.findIndex(s=>s.chapterId===c.id);render()});$('chapters').append(b)});const navNote=document.createElement('div');navNote.className='sub';navNote.textContent='先做、再判断。每步有预期和失败处理。原有详细口播在配套总稿，按需要暂停练习。';$('chapters').append(navNote);
function move(delta){index=Math.max(0,Math.min(STEPS.length-1,index+delta));render()}
$('prev').onclick=()=>move(-1);$('next').onclick=()=>move(1);$('present').onclick=()=>document.body.classList.toggle('presenter');$('reveal').onclick=()=>{$('answer').classList.toggle('hidden');$('reveal').textContent=$('answer').classList.contains('hidden')?'显示核对答案':'收起答案'};$('closezoom').onclick=()=>$('zoom').classList.add('hidden');
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText(STEPS[index].command);$('copy').textContent='已复制'}catch{const text=document.createElement('textarea');text.value=STEPS[index].command;document.body.append(text);text.select();const ok=document.execCommand('copy');text.remove();$('copy').textContent=ok?'已复制':'请手动选中文字复制'}};
$('quiz-open').onclick=()=>{$('quiz-question').textContent=$('question').textContent;$('quiz-answer').textContent=$('answer').textContent;$('quiz-answer').classList.add('hidden');$('quiz-dialog').showModal()};$('quiz-answer-button').onclick=()=>$('quiz-answer').classList.toggle('hidden');
$('status').onclick=()=>{$('status-content').innerHTML='<p>材料结构：'+(PREFLIGHT.draft_ready?'通过':'需要修正')+'；正式教程放行：'+(PREFLIGHT.release_ready?'通过':'尚未通过')+'</p><p>真人独立试学：'+(PREFLIGHT.learner_trial==='observed'?'有记录':'未验证')+'</p><p>下面的本机演练不代替线上操作；待核验项保持可见。</p><ul>'+PREFLIGHT.pending_steps.map(s=>'<li>'+escape(s.id+' '+s.title+'：'+s.reason)+'</li>').join('')+'</ul>';$('status-dialog').showModal()};
$('inputs').onclick=()=>$('inputs-dialog').showModal();document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
document.querySelectorAll('[data-trial]').forEach(b=>b.onclick=()=>{trial[STEPS[index].id]={result:b.dataset.trial,at:new Date().toISOString()};try{localStorage.setItem('testing-course-trial',JSON.stringify(trial))}catch{}render()});$('export').onclick=()=>{const data={course:COURSE.title,kind:'本机试学记录；需讲师核对实际观察；不自动证明学员学会',steps:trial};const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='试学记录.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)};
document.addEventListener('keydown',e=>{if(document.querySelector('dialog[open]')||['INPUT','TEXTAREA'].includes(document.activeElement.tagName))return;if(e.key==='ArrowRight'||e.key==='PageDown'){e.preventDefault();move(1)}if(e.key==='ArrowLeft'||e.key==='PageUp'){e.preventDefault();move(-1)}if(e.key.toLowerCase()==='p')document.body.classList.toggle('presenter');if(e.key.toLowerCase()==='f'){if(!document.fullscreenElement)document.documentElement.requestFullscreen?.();else document.exitFullscreen?.()}if(e.key==='Escape')$('zoom').classList.add('hidden')});
function fromHash(){const n=STEPS.findIndex(s=>s.id===location.hash.slice(1));if(n>=0)index=n;render()}window.addEventListener('hashchange',fromHash);window.__course={steps:STEPS,go(id){const n=STEPS.findIndex(s=>s.id===id);if(n>=0){index=n;render()}},get current(){return STEPS[index]}};fromHash();
</script></body></html>'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    out = args.out.resolve()
    if out.is_relative_to(ROOT):
        parser.error("讲解粗样和证据必须输出到仓库外")
    out.mkdir(parents=True, exist_ok=True)
    course = json.loads((HERE / "course.json").read_text())
    ledger = json.loads((out / "evidence/ledger.json").read_text()) if (out / "evidence/ledger.json").exists() else {}
    preflight = json.loads((out / "preflight.json").read_text())
    course_hash = hashlib.sha256((HERE / "course.json").read_bytes()).hexdigest()
    if preflight.get("course_sha256") != course_hash:
        parser.error("操作卡已变化，请重新运行渲染前检查；不能沿用旧绿灯")
    fresh = audit(course, ledger, out / "evidence")
    if not fresh["draft_ready"]:
        parser.error("材料结构未通过检查，停止制作粗样")
    preflight = {**fresh, "course_sha256": course_hash, "mode": "draft"}
    (out / "preflight.json").write_text(json.dumps(preflight, ensure_ascii=False, indent=2) + "\n")
    assets = json.loads((out / "evidence/teaching-assets.json").read_text()) if (out / "evidence/teaching-assets.json").exists() else {}
    for sid, asset in assets.items():
        path = (out / asset["image"]).resolve()
        if not path.is_relative_to(out) or not path.is_file() or not asset.get("caption"):
            parser.error("教学配图缺失或说明不完整：" + sid)
    text = HTML
    for key, value in {"COURSE": course, "LEDGER": ledger, "PREFLIGHT": preflight, "ASSETS": assets, "MINUTES": course["duration"] // 60, "SOURCE_REF": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()}.items():
        text = text.replace("__" + key + "__", json.dumps(value, ensure_ascii=False).replace("</", "<\\/"))
    if not (out / "create-visual-test-to-kb-repository-bundle.zip").is_file():
        text = text.replace('<a href="create-visual-test-to-kb-repository-bundle.zip" download>仓库备用技能包</a>',
                            '<span>备用包未生成，请从实际平台取得技能。</span>')
    optional = [("操作卡.pdf", "可打印操作卡"), ("评审数量案例.txt", "真实评审数量案例")]
    if (out / "视觉验收跟做粗样.mp4").is_file():
        optional.append(("视频观看.html", "4分钟视频样段"))
    for filename, label in optional:
        if (out / filename).is_file():
            text = text.replace('<div class="resources">',
                                '<div class="resources"><a href="' + filename + '">' + label + '</a>')
    (out / "index.html").write_text(text)
    cards = ['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>完整操作卡</title><style>body{max-width:1000px;margin:auto;padding:30px;background:#f6f1e7;color:#243a38;font:19px/1.8 sans-serif}section{border-top:1px solid #bbb;padding:20px 0;break-inside:avoid}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#e7ede2;padding:15px}h1{font-size:34px}h2{font-size:28px}h3{font-size:23px}a{color:#21745b}@media print{section{page-break-inside:avoid}}</style><h1>用Codex做好一次测试交付 · 完整操作卡</h1><p>保留原有课程内容；所有代码与命令由Agent操作。你说明目标、登录授权和确认结果。本册补充逐步操作、预期与失败处理。线上未核验及未试学范围见<a href="index.html">讲解版检查状态</a>。</p>']
    plain = []
    for chapter in course["chapters"]:
        cards.append('<h2>' + html.escape(chapter["title"]) + '</h2>')
        plain.append(chapter["title"])
        for s in chapter["steps"]:
            cards.append('<section id="' + s["id"] + '"><h3>' + html.escape(s["id"] + ' ' + s["title"]) + '</h3>')
            for label, key in [("从哪里开始", "where"), ("怎么做", "action"), ("看到什么算完成", "expected"), ("没看到怎么办", "recovery")]:
                cards.append('<p><strong>' + label + '：</strong>' + html.escape(s[key]) + '</p>')
                plain.append(label + '：' + s[key])
            if s["command"]:
                cards.append('<pre>' + html.escape(s["command"]) + '</pre>')
                plain.append(s["command"])
            cards.append('</section>')
            plain.append('')
    cards.append('</html>')
    (out / "操作卡.html").write_text(''.join(cards))
    (out / "操作卡.txt").write_text('\n'.join(plain) + '\n')
    (out / "doc").mkdir(exist_ok=True)
    for name in ["guide.platform.testing.script.md", "guide.platform.testing.methodology.md", "plan.platform.testing.tutorial.md"]:
        shutil.copy2(ROOT / "doc" / name, out / "doc" / name)
    narration = out / "narration"
    narration.mkdir(exist_ok=True)
    script = (ROOT / "doc/guide.platform.testing.script.md").read_text()
    prefixes = ["开场", "准备", "第一章", "第二章", "第三章", "第四章", "第五章", "独立练习"]
    for number, prefix in enumerate(prefixes, 1):
        section = re.search(rf"(?m)^## {prefix}[^\n]*\n.*?(?=^## |\Z)", script, re.S)
        if not section:
            parser.error("总稿章节已变化，请核对口播提取：" + prefix)
        lines, skip_prompt = [], False
        for line in section.group().splitlines():
            if line == "可复制的使用说明：":
                skip_prompt = True
            if line == "这段使用说明进入可复制讲义，不逐字配音。":
                skip_prompt = False
            if line.startswith(">") and not skip_prompt:
                lines.append(line[1:].lstrip())
        if not lines:
            parser.error(prefix + "没有固定口播，停止生成空稿")
        (narration / f"{number:02d}-{prefix}.txt").write_text("\n".join(lines).strip() + "\n")
    shutil.copy2(HERE / "course.json", out / "course.json")
    print(f"已生成离线讲解版、{sum(len(c['steps']) for c in course['chapters'])}张操作卡及完整原稿副本：{out}")


if __name__ == "__main__":
    main()
