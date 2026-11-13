#!/usr/bin/env python3
"""Generate real-history reports and verify their desktop/mobile presentation locally."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading

from evidence import analyze, write_reports


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, help='本地截图、JSON 及 HTML 目录；不上传')
    parser.add_argument('--chromium', default='/usr/bin/chromium')
    args = parser.parse_args()
    from playwright.sync_api import sync_playwright
    root = Path(__file__).resolve().parents[2]
    ledger = json.loads((root/'scripts/tests/fixtures/report_evidence/historical.json').read_text())
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    windows = [('daily','2026-10-04','2026-10-04'),
               ('weekly','2026-09-28','2026-10-04'),
               ('monthly','2026-10-01','2026-10-04')]
    for cadence, start, end in windows:
        write_reports(analyze(ledger,start,end,cadence), out/('real-'+cadence))

    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(out)))
    worker = threading.Thread(target=server.serve_forever,daemon=True)
    worker.start()
    checks = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=args.chromium, headless=True)
            try:
                for cadence, _, _ in windows:
                    page = browser.new_page(viewport={'width':1440,'height':1000})
                    errors = []
                    page.on('pageerror',lambda error:errors.append(str(error)))
                    response = page.goto(f'http://127.0.0.1:{server.server_port}/real-{cadence}.html',wait_until='networkidle')
                    assert response.status == 200
                    assert page.locator('h1').count() == 1
                    assert page.get_by_text('交付进展、风险与下一步',exact=True).is_visible()
                    text = page.inner_text('body')
                    assert '评价、认可和建议由员工本人表达' in text
                    assert '历史覆盖不完整' in text and '不可用' in text
                    assert not errors, errors
                    for link in page.locator('a[href^="#"]').all():
                        assert page.locator('[id="'+link.get_attribute('href')[1:]+'"]').count() == 1
                    first_link = page.locator('a[href^="#"]').first
                    first_link.click()
                    assert page.locator('details').evaluate('(e) => e.open'), '来源链接未展开核查区'
                    page.locator('details summary').click()
                    page.evaluate('window.scrollTo(0,0)')
                    page.screenshot(path=str(out/('real-'+cadence+'-desktop.png')))
                    page.set_viewport_size({'width':390,'height':844})
                    # Capture before asserting so future failures remain reviewable.
                    page.screenshot(path=str(out/('real-'+cadence+'-mobile.png')),full_page=True)
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), '手机横向溢出'
                    checks.append({'cadence':cadence,'http':response.status,'anchors':'all resolved',
                                   'mobileWidth':390,'horizontalOverflow':False,'pageErrors':errors})
                    page.close()
            finally:
                browser.close()
    except Exception as error:
        checks.append({'failure':str(error)})
        raise
    finally:
        (out/'browser-checks.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2)+'\n')
        server.shutdown()
        server.server_close()
        worker.join()
    print(json.dumps(checks,ensure_ascii=False))


if __name__=='__main__':
    main()
