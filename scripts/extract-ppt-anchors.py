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

# (锚定名, 源目录名)。zhangzara 系列自带导航运行时；hermes/graphify 是纯 CSS
# is-active 静态 deck（无 script），提取时由 NAV_RUNTIME 补一段通用键盘导航。
ANCHORS = [
    ('cobalt-grid', 'html-ppt-zhangzara-cobalt-grid'),
    ('retro-zine', 'html-ppt-zhangzara-retro-zine'),
    ('coral', 'html-ppt-zhangzara-coral'),
    ('monochrome', 'html-ppt-zhangzara-monochrome'),
    ('grove', 'html-ppt-zhangzara-grove'),
    ('bold-poster', 'html-ppt-zhangzara-bold-poster'),
    ('soft-editorial', 'html-ppt-zhangzara-soft-editorial'),
    ('vellum', 'html-ppt-zhangzara-vellum'),
    ('cyber-terminal', 'html-ppt-hermes-cyber-terminal'),
    ('dark-graph', 'html-ppt-graphify-dark-graph'),
]

MODIFIERS = {'slide', 'active', 'is-active', 'hairlines', 'dark', 'light', 'on'}

# 给无运行时模板补的通用导航（toggling is-active；兼容装配端给首块加的 active）
NAV_RUNTIME = """
<script>
(function () {
  var slides = [].slice.call(document.querySelectorAll('.slide'));
  if (!slides.length) return;
  var i = slides.findIndex(function (s) { return s.classList.contains('is-active'); });
  if (i < 0) {
    i = Math.max(0, slides.findIndex(function (s) { return s.classList.contains('active'); }));
    slides[i].classList.add('is-active');
  }
  function go(n) {
    if (n < 0 || n >= slides.length || n === i) return;
    slides[i].classList.remove('is-active');
    i = n;
    slides[i].classList.add('is-active');
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); go(i + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(i - 1); }
    else if (e.key === 'Home') { go(0); }
    else if (e.key === 'End') { go(slides.length - 1); }
  });
})();
</script>
"""
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


COMMENT_RE = re.compile(r'<!--\s*\d+\.\s*([A-Za-z][^>]*?)\s*-->')


def layout_name(cls: str, idx: int, preceding: str = '') -> str:
    for token in cls.split():
        if token not in MODIFIERS:
            return token
    # 类名只有 slide 的模板（hermes/graphify）：从紧邻的编号注释取版式名
    # （<!-- 6. STATS --> -> stats）
    comments = COMMENT_RE.findall(preceding)
    if comments:
        name = re.sub(r'[^a-z0-9]+', '-', comments[-1].lower()).strip('-')
        if name:
            return name
    return f'layout-{idx + 1:02d}'


def text_summary(block: str, limit: int = 90) -> str:
    t = re.sub(r'<style[\s\S]*?</style>', ' ', block)
    t = re.sub(r'<[^>]+>', ' ', t)
    t = re.sub(r'\s+', ' ', t).strip()
    return t[:limit]


def clean_class_attr(cls: str) -> str:
    return ' '.join(t for t in cls.split() if t not in ('active', 'is-active'))


def extract_anchor(name: str, src_name: str) -> None:
    src_dir = SRC / 'design-templates' / src_name
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
    # 无导航运行时的静态 deck：补通用键盘导航（插在 </body> 前，无则追加）
    if '<script' not in html.lower():
        if '</body>' in suffix:
            suffix = suffix.replace('</body>', NAV_RUNTIME + '\n</body>', 1)
        else:
            suffix = suffix + NAV_RUNTIME
    (out / 'prefix.html').write_text(prefix, encoding='utf-8')
    (out / 'suffix.html').write_text(suffix, encoding='utf-8')

    layouts = []
    # 首块的编号注释在 prefix 尾部，回看 300 字符以便命名 cover
    prev_end = max(0, blocks[0][0] - 300)
    for i, (s, e, cls) in enumerate(blocks):
        block = (html[s:e]
                 .replace(' is-active"', '"').replace('"slide is-active ', '"slide ')
                 .replace(' active"', '"').replace('"slide active ', '"slide '))
        lname = layout_name(cls, i, preceding=html[prev_end:s])
        prev_end = e
        fname = f'{i + 1:02d}-{lname}.html'
        (out / 'slides' / fname).write_text(block, encoding='utf-8')
        layouts.append({'file': fname, 'layout': lname, 'classAttr': clean_class_attr(cls),
                        'chars': len(block), 'summary': text_summary(block)})

    license_src = src_dir / 'LICENSE'
    if not license_src.exists():
        license_src = SRC / 'LICENSE'
    shutil.copyfile(license_src, out / 'LICENSE')
    (out / 'meta.json').write_text(
        json.dumps({'name': name, 'upstream': f'nexu-io/open-design ({src_name})',
                    'license': 'MIT', 'slideCount': len(blocks), 'layouts': layouts},
                   ensure_ascii=False, indent=2),
        encoding='utf-8')
    print(f'{name}: {len(blocks)} slides ->', [x['layout'] for x in layouts])


def main() -> None:
    DST.mkdir(parents=True, exist_ok=True)
    for name, src_name in ANCHORS:
        extract_anchor(name, src_name)


if __name__ == '__main__':
    main()
