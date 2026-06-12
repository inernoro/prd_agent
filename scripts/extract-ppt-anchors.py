#!/usr/bin/env python3
"""
从 open-design（MIT）提取 MD->PPT 锚定 deck 模板资产（v2：平衡扫描，保留各模板自带运行时）。

每套 zhangzara 模板是自包含成品 deck（自己的导航 JS/舞台/设计系统）。提取为三段：
- prefix.html   第一个 slide 块之前的全部（head + 设计系统 CSS + 容器开头）
- slides/NN-<layout>.html  每个 slide 块原文（子智能体照抄换内容的范本）
- suffix.html   最后一个 slide 块之后的全部（导航运行时，按 OD 规则原样保留）
- meta.json     版式清单（名字 + 文本摘要，供逐页选版式）
- LICENSE       MIT 随附（再分发义务）

装配 = prefix + 生成的 slide 块们（首块加 active）+ suffix。

用法：python3 scripts/extract-ppt-anchors.py [open-design 路径]
"""
import json
import re
import shutil
import sys
from pathlib import Path

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/open-design')
DST = Path(__file__).resolve().parent.parent / 'prd-api/src/PrdAgent.Api/Resources/mdppt'

ANCHORS = [
    'cobalt-grid', 'retro-zine', 'coral', 'monochrome',
    'grove', 'bold-poster', 'soft-editorial', 'vellum',
]

MODIFIERS = {'slide', 'active', 'hairlines', 'dark', 'light', 'on'}
TAG_RE = re.compile(r'<(/?)(div|section|article)\b[^>]*?(/?)>', re.I)
OPEN_RE = re.compile(r'<(div|section|article)\b[^>]*class="([^"]*)"[^>]*>', re.I)


def is_slide_class(cls: str) -> bool:
    return 'slide' in cls.split()


def find_slide_blocks(html: str):
    """平衡扫描提取顶层 slide 块：[(start, end, class_attr)]。"""
    blocks = []
    pos = 0
    while True:
        m = OPEN_RE.search(html, pos)
        if not m:
            break
        if not is_slide_class(m.group(2)):
            pos = m.end()
            continue
        tag = m.group(1).lower()
        depth = 1
        scan = m.end()
        while depth > 0:
            t = TAG_RE.search(html, scan)
            if not t:
                raise RuntimeError(f'unbalanced {tag} at {m.start()}')
            if t.group(2).lower() == tag and not t.group(3):
                depth += -1 if t.group(1) else 1
            scan = t.end()
        blocks.append((m.start(), scan, m.group(2)))
        pos = scan
    return blocks


def layout_name(cls: str, idx: int) -> str:
    for token in cls.split():
        if token not in MODIFIERS:
            return token
    return f'layout-{idx + 1:02d}'


def text_summary(block: str, limit: int = 90) -> str:
    t = re.sub(r'<style[\s\S]*?</style>', ' ', block)
    t = re.sub(r'<[^>]+>', ' ', t)
    t = re.sub(r'\s+', ' ', t).strip()
    return t[:limit]


def extract_anchor(name: str) -> None:
    src_dir = SRC / 'design-templates' / f'html-ppt-zhangzara-{name}'
    html = (src_dir / 'example.html').read_text(encoding='utf-8')
    out = DST / 'anchors' / name
    if out.exists():
        shutil.rmtree(out)
    (out / 'slides').mkdir(parents=True)

    blocks = find_slide_blocks(html)
    if not blocks:
        raise RuntimeError(f'{name}: no slide blocks found')

    prefix = html[:blocks[0][0]]
    suffix = html[blocks[-1][1]:]
    (out / 'prefix.html').write_text(prefix, encoding='utf-8')
    (out / 'suffix.html').write_text(suffix, encoding='utf-8')

    layouts = []
    for i, (s, e, cls) in enumerate(blocks):
        block = html[s:e].replace(' active"', '"').replace('"slide active ', '"slide ')
        lname = layout_name(cls, i)
        fname = f'{i + 1:02d}-{lname}.html'
        (out / 'slides' / fname).write_text(block, encoding='utf-8')
        layouts.append({'file': fname, 'layout': lname, 'classAttr': cls.replace('active', '').strip(),
                        'chars': len(block), 'summary': text_summary(block)})

    shutil.copyfile(src_dir / 'LICENSE', out / 'LICENSE')
    (out / 'meta.json').write_text(
        json.dumps({'name': name, 'upstream': f'zarazhangrui/beautiful-html-templates ({name})',
                    'license': 'MIT', 'slideCount': len(blocks), 'layouts': layouts},
                   ensure_ascii=False, indent=2),
        encoding='utf-8')
    print(f'{name}: {len(blocks)} slides ->', [x['layout'] for x in layouts])


def main() -> None:
    DST.mkdir(parents=True, exist_ok=True)
    for name in ANCHORS:
        extract_anchor(name)


if __name__ == '__main__':
    main()
