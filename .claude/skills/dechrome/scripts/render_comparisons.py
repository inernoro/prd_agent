#!/usr/bin/env python3
"""Compose evidence pairs without hiding either side or changing source PNG bytes."""
import base64
import hashlib
import html
import struct
from pathlib import Path

STYLE = r'''
:root{--paper:#f7f1e8;--paper-2:#fffdf8;--ink:#211d18;--ink-2:rgba(33,29,24,.74);--line:rgba(33,29,24,.14);--accent:#0f766e;--serif:"Source Serif 4","Songti SC","Noto Serif SC",serif;--sans:"PingFang SC","Noto Sans CJK SC",system-ui,sans-serif;--mono:"SF Mono",Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.65 var(--sans);overflow-wrap:anywhere}main{max-width:1120px;margin:auto;padding:24px 28px 48px}h1,h2,h3,p{margin:0}h1{font:600 32px/1.25 var(--serif);letter-spacing:.02em}h2{font:600 24px/1.35 var(--serif);margin:28px 0 12px}h3{font-size:18px}p{max-width:76ch;margin:10px 0 16px}a{color:var(--accent);text-underline-offset:3px;overflow-wrap:anywhere}small,code{font-size:13px}.masthead{position:relative;display:flex;align-items:center;gap:14px;border-bottom:3px solid var(--ink);padding:0 0 12px}.masthead>*:not(.emblem){position:relative;z-index:1}.stamp{display:grid;place-items:center;flex:none;width:44px;height:44px;color:var(--paper-2);background:var(--accent);font:700 15px var(--mono);box-shadow:3px 3px 0 var(--ink)}.publication{color:var(--accent);font:11px/1.4 var(--mono);letter-spacing:.14em;margin-top:3px}.emblem{position:absolute;right:-6px;top:-12px;width:86px;height:86px;color:var(--accent);opacity:.13;pointer-events:none;z-index:0}.dateline{display:flex;gap:8px 18px;flex-wrap:wrap;padding:10px 0;color:var(--ink-2);font:12px/1.5 var(--mono);border-bottom:1px solid var(--line)}.verdict{color:#b42318;font-family:var(--sans);font-weight:600}.report-lede{font-size:14px;margin:10px 0 0;color:var(--ink-2)}
.comparison{padding:24px 0 28px;border-bottom:1px solid var(--line)}.comparison-title{display:flex;align-items:baseline;gap:12px}.case-no{color:var(--accent);font:13px var(--mono);flex:none}.comparison h2{margin:0;font-size:23px}.comparison-summary{margin:8px 0 12px;max-width:76ch;color:var(--ink-2);font-size:15px}.comparison-shots{display:grid;grid-template-columns:minmax(0,1fr);gap:20px}.comparison-shots.portrait{grid-template-columns:repeat(2,minmax(0,1fr));max-width:804px;margin:auto;gap:24px}figure{min-width:0;margin:0}.shot-caption{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 7px;font-size:14px}.phase{font-weight:650}.phase-after{color:var(--accent)}.shot-size{color:var(--ink-2);font:12px var(--mono)}.evidence-open{display:block;width:100%;padding:0;border:1px solid var(--line);border-radius:0;background:var(--paper-2);cursor:zoom-in;text-align:inherit}.evidence-open img{display:block;width:100%;height:auto}.image-help{font:12px/1.5 var(--sans);color:var(--ink-2);margin:8px 0 0}.comparison-details{margin-top:10px;font-size:14px}.comparison-details p{margin:8px 0 12px}.comparison-details summary{color:var(--ink-2)}summary{cursor:pointer;min-height:44px;padding:10px 0;font-size:14px}details:not([open])>:not(summary){display:none}button:focus-visible,summary:focus-visible,a:focus-visible,[tabindex]:focus-visible{outline:3px solid var(--accent);outline-offset:4px}.table-scroll{max-width:100%;overflow:auto;width:100%}table{width:100%;min-width:620px;border-collapse:collapse}th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:14px;color:var(--ink-2);background:var(--paper-2)}pre{font:13px/1.6 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}.colophon{border-top:2px solid var(--ink);margin-top:28px;padding-top:12px;color:var(--ink-2);font:12px/1.7 var(--mono)}
.zoom-dialog{margin:auto;width:calc(100vw - 24px);max-width:none;height:calc(100dvh - 24px);max-height:none;padding:0;border:1px solid var(--line);background:var(--paper-2);color:var(--ink)}.zoom-dialog[open]{display:flex;flex-direction:column}.zoom-dialog::backdrop{background:rgba(33,29,24,.55)}.zoom-heading{display:flex;align-items:center;gap:16px;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--line)}.zoom-heading h2{margin:0;font:600 16px/1.4 var(--sans)}.zoom-close{min-height:44px;padding:8px 14px;border:1px solid var(--line);background:var(--paper-2);color:var(--ink);font:14px var(--sans);cursor:pointer}.zoom-canvas{min-height:0;flex:1;overflow:auto;overscroll-behavior:contain}.zoom-canvas img{display:block;max-width:none;width:auto;height:auto}.zoom-note{font-size:12px;color:var(--ink-2)}
@media(max-width:760px){.comparison-shots.portrait{grid-template-columns:minmax(0,1fr);max-width:440px}.comparison-shots{gap:16px}}
@media(max-width:640px){main{padding:16px 16px 32px}h1{font-size:27px}.masthead{gap:12px}.emblem{width:60px;height:60px;top:-8px;right:-2px}.dateline{font-size:11px;gap:6px 12px}.comparison{padding:20px 0 24px}.comparison h2{font-size:22px}.comparison-summary{font-size:15px}.case-no{font-size:12px}.zoom-heading{align-items:flex-start;gap:8px}.zoom-heading h2{font-size:14px}.zoom-note{display:block;font-size:11px}}
'''

SCRIPT = r'''
const zoom=document.querySelector('.zoom-dialog');
if(zoom&&typeof zoom.showModal==='function'){
 const image=zoom.querySelector('img'),heading=zoom.querySelector('h2'),canvas=zoom.querySelector('.zoom-canvas');let opener;
 for(const button of document.querySelectorAll('.evidence-open')){
  button.disabled=false;
  button.addEventListener('click',()=>{
   opener=button;const source=button.querySelector('img');image.src=source.src;image.alt=source.alt;
   heading.textContent=source.alt+' · '+source.naturalWidth+'×'+source.naturalHeight;
   zoom.showModal();canvas.scrollTo(0,0);zoom.querySelector('.zoom-close').focus();
  });
 }
 zoom.querySelector('.zoom-close').addEventListener('click',()=>zoom.close());
 zoom.addEventListener('keydown',e=>{
  if(e.key!=='Tab')return;
  const items=[...zoom.querySelectorAll('button:not([disabled]),[tabindex="0"]')];
  const first=items[0],last=items.at(-1),active=zoom.ownerDocument.activeElement;
  if(e.shiftKey&&active===first){e.preventDefault();last.focus()}
  else if(!e.shiftKey&&active===last){e.preventDefault();first.focus()}
 });
 zoom.addEventListener('close',()=>{opener?.focus({preventScroll:true});image.removeAttribute('src')});
 zoom.addEventListener('click',e=>{if(e.target===zoom)zoom.close()});
}
'''


def render_comparisons(comparisons):
    """Return HTML and byte identities. Both originals stay visible without JS."""
    esc = lambda value: html.escape(str(value), quote=True)
    sections, manifest = [], []
    for index, case in enumerate(comparisons):
        pair = []
        for side in ("before", "after"):
            file = Path(case[side])
            if case.get("provenance") != "deterministic-fixture":
                raise ValueError("Public report images must be explicitly synthetic")
            raw = file.read_bytes()
            if raw[:8] != b"\x89PNG\r\n\x1a\n":
                raise ValueError("Expected original PNG evidence")
            width, height = struct.unpack(">II", raw[16:24])
            pair.append({"side": side, "file": str(file), "sha256": hashlib.sha256(raw).hexdigest(),
                         "width": width, "height": height, "data": base64.b64encode(raw).decode()})
        if (pair[0]["width"], pair[0]["height"]) != (pair[1]["width"], pair[1]["height"]):
            raise ValueError("Comparison viewports must match")
        if pair[0]["sha256"] == pair[1]["sha256"]:
            raise ValueError("Identical images do not prove the declared visible change")
        portrait = pair[0]["width"] < pair[0]["height"]
        sections.append(f'<section class="comparison" data-pair="{index}" aria-labelledby="comparison-{index}">'
                        f'<header class="comparison-title"><span class="case-no">{index + 1:02d}</span>'
                        f'<h2 id="comparison-{index}">{esc(case.get("display_title",case["title"]))}</h2></header>'
                        f'<p class="comparison-summary">{esc(case["summary"] if "summary" in case else case["change"])}</p>'
                        f'<div class="comparison-shots{" portrait" if portrait else ""}">')
        for item, label in zip(pair, ("修改前", "修改后")):
            title = esc(case["title"] + " · " + label)
            sections.append(f'<figure data-phase="{item["side"]}"><figcaption class="shot-caption">'
                            f'<span class="phase phase-{item["side"]}">{label}</span>'
                            f'<span class="shot-size">{item["width"]} × {item["height"]}</span></figcaption>'
                            f'<button class="evidence-open" type="button" disabled aria-label="查看原图：{title}">'
                            f'<img loading="lazy" width="{item["width"]}" height="{item["height"]}" '
                            f'src="data:image/png;base64,{item["data"]}" alt="{title}"></button></figure>')
        sections.append('</div><p class="image-help">前后图均已展开。点击任一图片直接查看 100% 原图。</p>'
                        '<details class="comparison-details"><summary>测量口径、保持项与证据边界</summary>')
        for label, key in (("变化", "change"), ("保持不变", "unchanged"), ("证据范围", "scope"), ("版本/产物", "versions")):
            sections.append(f'<p><strong>{label}</strong> {esc(case[key])}</p>')
        sections.append('</details></section>')
        manifest.append({"title": case["title"], "images": [{key: value for key, value in item.items() if key != "data"} for item in pair]})
    sections.append('<dialog class="zoom-dialog" aria-labelledby="zoom-title"><header class="zoom-heading">'
                    '<div><h2 id="zoom-title">原图</h2><span class="zoom-note">100% 原始像素，可滚动查看；Esc 关闭</span></div>'
                    '<button class="zoom-close" type="button" aria-label="关闭原图">关闭</button></header>'
                    '<div class="zoom-canvas" tabindex="0" role="region" aria-label="原图滚动区域"><img alt=""></div></dialog>')
    return "".join(sections), manifest
