#!/usr/bin/env python3
"""Contract and actual-browser regressions for the skill's original press editions."""
import copy
from html.parser import HTMLParser
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/reporting'))
import edition_layout as layout
from evidence import analyze


def load_publish():
    path = ROOT / '.claude/skills/daily-report-summary/reference/publish.py'
    spec = importlib.util.spec_from_file_location('skill_publish_layout_test', path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def report(cadence='weekly'):
    ledger = {'schemaVersion': 1, 'historyComplete': False, 'workItems': [
        {'id': 'export', 'title': '批量导出', 'nextStep': {'action': '按当前版本复验', 'owner': '待指定'}}
    ], 'events': [
        {'id': 'code', 'workItemId': 'export', 'kind': 'code_complete', 'revision': 'a' * 40,
         'occurredAt': '2026-09-28T10:00:00+08:00', 'source': {'uri': 'https://example.test/commit/a', 'excerpt': '编码完成记录'}},
        {'id': 'ci-failed', 'workItemId': 'export', 'kind': 'validation_failed', 'scope': 'ci', 'revision': 'a' * 40,
         'occurredAt': '2026-09-29T10:00:00+08:00', 'source': {'uri': 'https://example.test/ci/1', 'excerpt': '构建测试失败'}}
    ]}
    return analyze(ledger, '2026-09-28', '2026-10-04', cadence)


class Links(HTMLParser):
    def __init__(self):
        super().__init__(); self.ids=[]; self.hrefs=[]; self.days=[]
    def handle_starttag(self, tag, attrs):
        attrs=dict(attrs)
        if 'id' in attrs:self.ids.append(attrs['id'])
        if tag=='a' and attrs.get('href','').startswith('#'):self.hrefs.append(attrs['href'][1:])


class EditionLayoutTests(unittest.TestCase):
    def test_original_template_is_actually_read_without_copying_old_claims(self):
        text=layout.TEMPLATES['weekly'].read_text()
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); p=root/'weekly.html'
            p.write_text(text.replace('</style>', ':root{--layout-contract-marker:1}</style>'))
            with patch.object(layout,'ROOT',root),patch.dict(layout.TEMPLATES,{'weekly':p}):out=layout.render_edition(report())
        self.assertIn('--layout-contract-marker:1',out['html'])
        self.assertIn('class="masthead"',out['html']);self.assertIn('class="stamp">MAP',out['html'])
        self.assertNotIn('90.9%',out['html']);self.assertNotIn('模型网关走完',out['html'])
        self.assertNotIn('周报智能体',out['html']);self.assertIn('项目报告技能',out['html'])
        self.assertEqual('weekly.html',out['templatePath'])

    def test_all_cadences_pass_existing_publisher_guard_and_have_correct_emblems(self):
        publish=load_publish()
        for cadence,emblem in [('daily','moon'),('weekly','earth'),('monthly','sun')]:
            with self.subTest(cadence=cadence):
                out=layout.render_edition(report(cadence))
                self.assertEqual([],publish.validate_html_report(out['html']))
                publish.assert_no_placeholder(out['html'])
                self.assertIn('data-emblem="'+emblem+'"',out['html'])
                self.assertNotIn('<script',out['html'].lower())
                self.assertIn('不自动代填或提交个人月报',out['html'])
                self.assertIn('本期新增成果数不可用',out['html'])

    def test_ci_failure_is_visible_but_does_not_become_feature_validation(self):
        out=layout.render_edition(report())
        self.assertIn('当前版本 CI 失败',out['markdown'])
        self.assertIn('功能验证：未证实 → **未证实**',out['markdown'])
        self.assertIn('正式上线：未证实 → **未证实**',out['markdown'])
        self.assertLess(out['html'].index('id="risk"'),out['html'].index('id="progress"'))
        links=Links();links.feed(out['html'])
        self.assertEqual(len(links.ids),len(set(links.ids)))
        self.assertTrue(set(links.hrefs)<=set(links.ids))
        self.assertIn('e-ci-failed',links.hrefs)

    def test_unassigned_failure_is_not_hidden_in_an_activity_counter(self):
        r=report();e={'id':'unassigned-ci','kind':'validation_failed','workItemId':None,'scope':'ci','revision':'b'*40,
            'occurredAt':'2026-09-30T10:00:00+08:00','source':{'uri':'https://example.test/ci/2','excerpt':'外部流水线失败'}}
        r['evidence'][e['id']]=e;r['unassignedRisks']=[e]
        out=layout.render_edition(r)
        self.assertIn('未关联事项的CI 检查失败',out['markdown'])
        self.assertIn('#e-unassigned-ci',out['html']);self.assertIn('尚不能判断影响哪个事项，不计成果',out['html'])
        self.assertEqual(1,out['html'].count('data-work-item-id='))

    def test_missing_sources_remain_unavailable_and_week_has_seven_trace_days(self):
        context={'dailyReports':{'available':True,'items':[{'date':'2026-09-29','title':'当日日报','shareUrl':'https://example.test/daily/29'}]},
                 'releases':{'available':False,'reason':'发布台账连接失败'}}
        out=layout.render_edition(report(),context)
        self.assertIn('不可用：发布台账连接失败',out['html'])
        self.assertNotIn('本周未发布',out['html'])
        self.assertIn('target="_blank" rel="noopener noreferrer">当日日报',out['html'])
        self.assertEqual(6,out['html'].count('未采到对应日报，不代表当天没有工作。'))
        self.assertIn('2026-10-04',out['html'])
        self.assertIn('不按提交量判断忙闲',out['html'])

    def test_source_appendix_keeps_records_without_promoting_pass_or_preview_to_delivery(self):
        context={'acceptance':{'available':True,'items':[{'title':'原始CI报告','deeplink':'https://example.test/report/ci','verdict':'pass','commitSha':'c'*40}]},'previewDeploys':{'available':True,'items':[{'title':'分支部署','sourceUrl':'https://example.test/preview','status':'success'}]}}
        out=layout.render_edition(report(),context)
        self.assertIn('原始CI报告',out['html']);self.assertIn('https://example.test/report/ci',out['html'])
        self.assertIn('分支预览部署（不是正式上线）原始记录',out['html'])
        self.assertIn('功能验证：未证实 → **未证实**',out['markdown'])
        self.assertIn('正式上线：未证实 → **未证实**',out['markdown'])
        self.assertEqual([],load_publish().validate_html_report(out['html']))

    def test_untrusted_source_text_is_escaped_and_unknown_url_is_not_a_link(self):
        r=report();r['items'][0]['title']='<script>alert(1)</script>'
        r['evidence']['code']['source']['excerpt']='<img src=x onerror=alert(1)>'
        r['evidence']['code']['source']['uri']='javascript:alert(1)'
        r['evidence']['code']['timeBasis']='observed'
        out=layout.render_edition(r)
        self.assertNotIn('<script>',out['html']);self.assertNotIn('<img src=x',out['html'])
        self.assertNotIn('href="javascript:',out['html'])
        self.assertIn('&lt;script&gt;',out['html'])
        self.assertIn('证据观测时间，不计完成发生时间',out['markdown'])
        self.assertEqual([],load_publish().validate_html_report(out['html']))

    def test_metrics_require_explicit_measurement_and_comparison_sources(self):
        r=report();r['metrics']['efficiency']={'available':True,'measurement':{'value':12,'unit':'分钟/次','method':'同类任务记录中位数','population':'同一任务集合','sources':[{'uri':'https://example.test/measure/current','excerpt':'本期测量'}]},'comparison':{'delta':-2,'previous':{'sources':[{'uri':'https://example.test/measure/previous','excerpt':'上期测量'}]}}}
        out=layout.render_edition(r)
        self.assertIn('相邻同口径周期差值：-2 分钟/次',out['html'])
        self.assertIn('https://example.test/measure/previous',out['html'])
        self.assertIn('不能仅据此归因于某项改动',out['html'])
        self.assertIn('工时：不可用',out['html'])

    def test_empty_report_does_not_invent_highlights_or_risk_free_status(self):
        r=analyze({'schemaVersion':1,'workItems':[],'events':[]},'2026-09-28','2026-10-04')
        out=layout.render_edition(r)
        self.assertIn('尚未取得可关联的工作事项',out['html'])
        self.assertNotIn('按计划推进',out['html']);self.assertNotIn('无明显阻塞',out['html'])
        self.assertNotIn('data-work-item-id=',out['html'])


@unittest.skipUnless(os.environ.get('REPORT_LAYOUT_BROWSER_OUT'),'使用明确的仓库外截图目录启用浏览器回归')
class EditionBrowserTests(unittest.TestCase):
    def test_touch_viewport_source_links_and_actual_layout(self):
        from playwright.sync_api import sync_playwright
        from functools import partial
        from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
        from threading import Thread
        out=Path(os.environ['REPORT_LAYOUT_BROWSER_OUT']).resolve();out.mkdir(parents=True,exist_ok=True)
        class QuietHandler(SimpleHTTPRequestHandler):
            def log_message(self, *args):pass
        server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(out)))
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        Thread(target=server.serve_forever,daemon=True).start()
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM','/usr/bin/chromium'),headless=True)
            results=[]
            for cadence in ['daily','weekly','monthly']:
                artifact=out/(cadence+'.html');artifact.write_text(layout.render_edition(report(cadence))['html'])
                for mode in ['desktop','mobile']:
                    context=browser.new_context(viewport={'width':1440,'height':1000} if mode=='desktop' else {'width':390,'height':844},is_mobile=mode=='mobile',has_touch=mode=='mobile')
                    page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.goto(f'http://127.0.0.1:{server.server_port}/{cadence}.html')
                    width=page.evaluate('document.documentElement.scrollWidth');self.assertLessEqual(width,page.viewport_size['width'])
                    page.screenshot(path=str(out/f'{cadence}-{mode}-top.png'))
                    page.get_by_role('link',name='核查来源',exact=True).click();self.assertEqual('#sources',page.evaluate('location.hash'))
                    page.get_by_role('link',name='风险与阻塞',exact=True).click()
                    page.screenshot(path=str(out/f'{cadence}-{mode}.png'))
                    self.assertEqual([],errors);results.append({'cadence':cadence,'mode':mode,'width':width,'touchPoints':page.evaluate('navigator.maxTouchPoints'),'errors':errors});context.close()
            browser.close();(out/'browser-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))


if __name__=='__main__':unittest.main()
