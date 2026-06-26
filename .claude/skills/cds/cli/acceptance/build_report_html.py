#!/usr/bin/env python3
"""把验收 HTML 片段 + 截图(manifest) 组装为自包含 HTML（截图 base64 内嵌），写到 stdout 或 --out。
之后用 `cdscli report create --html-file <out> [--project --folder]` 入库。

body 片段里用 {{IMG:name}} 占位，name 对应 manifest（create-visual-test-to-kb harness writeManifest
产出的 shots 数组：[{name, caption, path, ...}]）。

用法:
  build_report_html.py --title "CDS · X · 验收报告" --verdict pass \
      --body-file body.html --manifest /tmp/acc_shots/x/manifest.json --out /tmp/report.html
"""
import argparse, base64, json, re, sys

VC = {'pass': ('通过', '#1a7f37'), 'conditional': ('有条件通过', '#9a6700'), 'fail': ('不通过', '#b42318')}


def img(shot):
    try:
        with open(shot['path'], 'rb') as f:
            b64 = base64.b64encode(f.read()).decode()
    except Exception as e:
        return f'<div style="color:#b42318">[截图缺失 {shot.get("name")}: {e}]</div>'
    cap = shot.get('caption', '')
    return (f'<figure style="margin:14px 0"><img src="data:image/png;base64,{b64}" '
            f'style="max-width:100%;border:1px solid #d0d7de;border-radius:8px;display:block"/>'
            f'<figcaption style="font-size:13px;color:#57606a;margin-top:6px">{cap}</figcaption></figure>')


def build(title, verdict, body, manifest):
    shots = {s['name']: s for s in manifest}
    body = re.sub(r'\{\{IMG:([^}]+)\}\}',
                  lambda m: img(shots[m.group(1).strip()]) if m.group(1).strip() in shots
                  else f'<div style="color:#b42318">[未找到截图 {m.group(1)}]</div>', body)
    vcn, vc = VC.get(verdict, ('', '#57606a'))
    return f'''<!doctype html><html lang="zh"><head><meta charset="utf-8"/><style>
 body{{font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1f2328;background:#fff;margin:0;padding:28px 32px;max-width:1000px}}
 h1{{font-size:23px;margin:0 0 10px}} h2{{font-size:17px;margin:24px 0 8px;border-bottom:1px solid #eaeef2;padding-bottom:5px}}
 table{{border-collapse:collapse;width:100%;margin:10px 0;font-size:14px}} th,td{{border:1px solid #d0d7de;padding:7px 10px;text-align:left;vertical-align:top}} th{{background:#f6f8fa}}
 .v{{display:inline-block;padding:4px 14px;border-radius:999px;color:#fff;font-weight:700;background:{vc}}}
 blockquote{{margin:10px 0;padding:8px 14px;background:#f6f8fa;border-left:3px solid #d0d7de;color:#444}}
 .lead{{color:#444;margin:8px 0 14px}}</style></head><body>
<h1>{title}</h1><p><span class="v">{vcn}</span></p>{body}</body></html>'''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--title', required=True)
    ap.add_argument('--verdict', default='pass', choices=list(VC))
    ap.add_argument('--body-file', required=True)
    ap.add_argument('--manifest', required=True)
    ap.add_argument('--out', help='输出 HTML 文件路径(默认 stdout)')
    a = ap.parse_args()
    body = open(a.body_file, encoding='utf-8').read()
    manifest = json.load(open(a.manifest, encoding='utf-8'))
    html = build(a.title, a.verdict, body, manifest)
    size = len(html.encode('utf-8'))
    if size > 10 * 1024 * 1024:
        print(f'ERROR: {size/1048576:.1f}MB 超 10MB 上限，请压图(jpeg/缩放)后重试', file=sys.stderr); sys.exit(1)
    if a.out:
        open(a.out, 'w', encoding='utf-8').write(html)
        print(f'[OK] {a.out} ({size//1024}KB) — 接着: cdscli report create --title "{a.title}" --html-file {a.out} [--project --folder]', file=sys.stderr)
    else:
        sys.stdout.write(html)


if __name__ == '__main__':
    main()
