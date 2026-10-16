#!/usr/bin/env python3
"""验证 CI 预览运行镜像能启动并提供真实 HTML 与入口资源。"""
import io
import json
import re
import tarfile
import sys
import time
import urllib.request
from html.parser import HTMLParser


class EntryAssets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.assets = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == 'script' and values.get('type') == 'module' and values.get('src'):
            self.assets.append((values['src'], 'javascript'))
        if tag == 'link' and values.get('rel') == 'stylesheet' and values.get('href'):
            self.assets.append((values['href'], 'css'))


def main():
    base = sys.argv[1].rstrip('/')
    for attempt in range(60):
        try:
            with urllib.request.urlopen(base + '/api/instance-mode', timeout=2) as response:
                mode = json.load(response)
            break
        except (OSError, ValueError):
            if attempt == 59:
                raise
            time.sleep(1)
    assert mode.get('previewInstance') is True, '未激活隔离预览模式'
    with urllib.request.urlopen(base + '/project-list', timeout=5) as response:
        assert response.headers.get_content_type() == 'text/html'
        html = response.read().decode()
    assert 'window.__CDS_PREVIEW_INSTANCE__=true' in html
    parser = EntryAssets()
    parser.feed(html)
    assert any(kind == 'javascript' for _, kind in parser.assets), '缺少前端入口'
    for asset, kind in parser.assets:
        assert asset.startswith('/') and not asset.startswith('//'), '入口资源必须同源'
        with urllib.request.urlopen(base + asset, timeout=5) as response:
            assert kind in response.headers.get_content_type(), '入口资源 MIME 错误'
            assert len(response.read()) > 0, '入口资源为空'
    with urllib.request.urlopen(base + '/api/agent/setup.json?target=new', timeout=5) as response:
        setup = json.load(response)
    assert setup.get('version') == 'cds-agent-setup.v1', '缺少当前接入协议'
    with urllib.request.urlopen(base + '/api/skills/cds-pack/download', timeout=10) as response:
        bundle = response.read()
    with tarfile.open(fileobj=io.BytesIO(bundle), mode='r:gz') as archive:
        cli = archive.extractfile('skills/cds/cli/cdscli.py').read().decode()
    bundled_version = re.search(r'^VERSION\s*=\s*[\"\']([^\"\']+)', cli, re.MULTILINE)
    assert bundled_version and bundled_version.group(1) == setup.get('cliVersion'), '下载包与实例 CLI 版本不一致'
    assert 'def cmd_setup_check(' in cli, '下载包缺少接入自检'
    print(f'预览运行镜像通过：隔离模式、HTML、{len(parser.assets)} 个入口资源、匿名接入协议与当前技能包')


if __name__ == '__main__':
    main()
