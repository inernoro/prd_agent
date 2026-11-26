# 从 Lemo-Opuscar 风格库生成原型用的风格目录（只用于原型与演示数据，不进源码差异）。
#   python3 tools/import-opuscar.py <下载目录>
# 下载目录里有 slugs.txt、json/<slug>.json（styles/<slug>/style.json，MIT）和 posters/<slug>.webp
# （docs/readme/cards/<slug>-poster.webp，CC BY 4.0，署名 Lemo-Opuscar by Lemomo (LemoLab)）。
# 风格提示词 STYLE.md 是 CC BY-NC 4.0，这里不复制，只按 slug 引用；正式产品内置前须取得商用授权。
import json, os, sys
from PIL import Image

src = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(here, '..', 'src', 'opuscar')
os.makedirs(os.path.join(out, 'posters'), exist_ok=True)

slugs = [s.strip() for s in open(os.path.join(src, 'slugs.txt')) if s.strip()]
cats, styles = [], []
for slug in slugs:
    d = json.load(open(os.path.join(src, 'json', f'{slug}.json')))
    if d['category_cn'] not in [c['cn'] for c in cats]:
        cats.append({'id': f'{len(cats) + 1:02d}', 'cn': d['category_cn'], 'en': d['category_en']})
    cat = next(c for c in cats if c['cn'] == d['category_cn'])
    styles.append({
        'slug': slug, 'num': d['num'], 'cn': d['cn'], 'en': d['en'], 'category': cat['id'],
        'film': d.get('film_cn') or d['film'], 'line': d.get('line_cn') or d['line'],
        'dur': round(d.get('dur') or 0), **({'needsImageTool': True} if d.get('needs') else {}),
    })
    img = Image.open(os.path.join(src, 'posters', f'{slug}.webp')).convert('RGB')
    img.thumbnail((304, 304))
    img.save(os.path.join(out, 'posters', f'{slug}.webp'), 'WEBP', quality=58, method=6)

with open(os.path.join(out, 'catalog.json'), 'w') as f:
    json.dump({
        'source': {'name': 'Lemo-Opuscar by Lemomo (LemoLab)', 'url': 'https://github.com/lemomo-ai/lemo-opuscar',
                   'dataLicense': 'MIT（style.json）', 'posterLicense': 'CC BY 4.0（样片海报，已缩小）',
                   'promptLicense': 'CC BY-NC 4.0（STYLE.md，未复制）'},
        'categories': cats, 'styles': styles,
    }, f, ensure_ascii=False, indent=1)
print(len(cats), 'categories', len(styles), 'styles')
