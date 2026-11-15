#!/usr/bin/env python3
"""Build a self-contained review table from a real acceptance manifest (stdlib only)."""
import argparse
import base64
import hashlib
import html
import json
import mimetypes
from pathlib import Path
from urllib.parse import urlsplit


def esc(value):
    return html.escape(str(value), quote=True)


def image_block(value, label, root):
    if not value:
        return f'<div class="missing">{esc(label)}：尚未提供截图</div>'
    path = (root / value).resolve()
    mime = mimetypes.guess_type(path.name)[0]
    if mime not in {'image/png', 'image/jpeg', 'image/webp', 'image/gif'}:
        raise ValueError(f'Unsupported image format: {path}')
    encoded = base64.b64encode(path.read_bytes()).decode('ascii')
    return f'<figure><figcaption>{esc(label)}</figcaption><div class="original"><img loading="eager" alt="{esc(label)}" src="data:{mime};base64,{encoded}"></div></figure>'


def evidence_link(entry, root):
    label, value = entry['label'], entry['path']
    parsed = urlsplit(value)
    if parsed.scheme in {'http', 'https'} and parsed.netloc:
        return f'<a target="_blank" rel="noopener noreferrer" href="{esc(value)}">{esc(label)}</a>'
    if parsed.scheme or parsed.netloc:
        raise ValueError(f'Unsupported evidence URL: {value}')
    path = (root / value).resolve()
    mime = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
    encoded = base64.b64encode(path.read_bytes()).decode('ascii')
    return f'<a download="{esc(path.name)}" href="data:{mime};base64,{encoded}">{esc(label)}（下载）</a>'


def build(manifest, destination):
    raw = manifest.read_bytes()
    data = json.loads(raw)
    cases, root = data['cases'], manifest.parent
    if not isinstance(cases, list) or not cases:
        raise ValueError('cases must be a nonempty list')
    rows, details, ids = [], [], set()
    for index, case in enumerate(cases, 1):
        for field in ('id', 'title', 'module', 'report', 'fidelity', 'status'):
            if not isinstance(case.get(field), str) or not case[field].strip():
                raise ValueError(f'Case {index}: missing nonempty {field}')
        if case['id'] in ids:
            raise ValueError(f'Duplicate case id: {case["id"]}')
        ids.add(case['id'])
        if case['status'] not in {'通过', '需调整', '阻塞', '未执行'}:
            raise ValueError(f'Case {index}: invalid execution status')
        left, right = case.get('reference_image'), case.get('actual_image')
        if left and right and (root / left).resolve() == (root / right).resolve():
            raise ValueError(f'Case {index}: design and system must not use the same source file')
        if case['status'] == '通过' and (not left or not right or case['fidelity'] == '待评'):
            raise ValueError(f'Case {index}: passing comparison requires both images and a fidelity assessment')
        target = f'case-{index}'
        rows.append(f'<tr><td>{esc(case["title"])}<small>{esc(case["id"])}</small></td><td>{esc(case["module"])}</td><td class="text">{esc(case["report"])}</td><td class="text">{esc(case["fidelity"])}</td><td>{esc(case["status"])}</td><td><a href="#{target}" onclick="document.getElementById(\'{target}\').open=true">左右对照与意见</a></td></tr>')
        images = image_block(left, '左：设计基准', root) + image_block(right, '右：真实系统', root)
        links = ' · '.join(evidence_link(e, root) for e in case.get('evidence', []))
        details.append(f'<details id="{target}" data-case-id="{esc(case["id"])}"><summary>{esc(case["id"])} · {esc(case["title"])}</summary><p class="text">审查者：{esc(case.get("reviewer", "未记录"))}\n设计来源：{esc(case.get("reference_source", "未记录"))}\n系统来源：{esc(case.get("actual_source", "未记录"))}\n差异与评价依据：{esc(case.get("differences", "未记录"))}</p><div class="compare">{images}</div><p>{links}</p><label>用户判定 <select><option>待审</option><option>通过</option><option>需调整</option></select></label><label>用户意见<textarea rows="3" placeholder="填写审阅意见"></textarea></label></details>')
    key = hashlib.sha256(raw).hexdigest()[:20]
    metadata = '\n'.join(f'{label}：{data.get(field, "未记录")}' for label, field in [('设计版本', 'design_version'), ('实现版本', 'implementation_version'), ('执行环境', 'environment')])
    css = '''body{font:15px/1.6 system-ui,sans-serif;margin:24px;color:#17202b;background:#f5f6f8}h1{font-size:26px}a{color:#175cd3}table{border-collapse:collapse;width:100%;background:white}th,td{padding:12px;border:1px solid #d6dbe3;text-align:left;vertical-align:top}th{background:#e8ecf2}small{display:block;color:#596579}.text{white-space:pre-wrap;overflow-wrap:anywhere}.table-scroll{overflow:auto}details{margin:18px 0;padding:16px;background:white;border:1px solid #d6dbe3}summary{cursor:pointer;font-weight:bold}.compare{display:grid;grid-template-columns:1fr 1fr;gap:16px}figure{margin:0;min-width:0}figcaption{font-weight:bold;margin-bottom:8px}.original{overflow:auto;max-height:70vh;background:#eee}.original img{display:block;width:auto;max-width:none}label{display:block;margin-top:12px}textarea{display:block;width:100%;box-sizing:border-box}button,select,textarea{font:inherit;padding:8px}button{cursor:pointer}.missing{padding:30px;background:#fff4d6}#save-message{color:#596579}@media(max-width:800px){body{margin:12px}.compare{grid-template-columns:1fr}}'''
    js = '''const storageKey='design-review-__KEY__';
const panels=[...document.querySelectorAll('details')];
let saved={};try{saved=JSON.parse(localStorage.getItem(storageKey)||'{}')}catch(e){}
for(const p of panels){const s=p.querySelector('select'),t=p.querySelector('textarea');const v=saved[p.dataset.caseId];if(v){s.value=['待审','通过','需调整'].includes(v.decision)?v.decision:'待审';t.value=v.comment||''}p.addEventListener('input',()=>{saved[p.dataset.caseId]={decision:s.value,comment:t.value};try{localStorage.setItem(storageKey,JSON.stringify(saved));document.getElementById('save-message').textContent='意见已保存到本浏览器；请导出以便交回。'}catch(e){document.getElementById('save-message').textContent='本浏览器无法保存；请立即导出意见。'}})}
document.getElementById('export').onclick=()=>{const result={title:document.title,exported_at:new Date().toISOString(),review_version:storageKey,cases:panels.map(p=>({id:p.dataset.caseId,user_decision:p.querySelector('select').value,user_comment:p.querySelector('textarea').value}))};const u=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download='design-review-decisions.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)};'''.replace('__KEY__', key)
    title = esc(data.get('title', '设计对照验收表'))
    page = f'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title><style>{css}</style><h1>{title}</h1><p class="text">{esc(metadata)}</p><p>共 {len(cases)} 项。执行结论与用户判定分别记录。左右图以原尺寸展示，可在图内滚动查看；缺图项明确标出。</p><button id="export">导出用户审核意见</button><p id="save-message">用户判定默认待审。意见存储于本浏览器，请导出后交回。</p><div class="table-scroll"><table><thead><tr><th>标题</th><th>模块</th><th>验收报告</th><th>拟真度</th><th>执行状态</th><th>证据 / 用户审阅</th></tr></thead><tbody>{"".join(rows)}</tbody></table></div>{"".join(details)}<script>{js}</script></html>'
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(page, encoding='utf-8')
    print(f'Created {destination} ({len(cases)} cases, {destination.stat().st_size} bytes)')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    build(args.manifest.resolve(), args.output.resolve())
