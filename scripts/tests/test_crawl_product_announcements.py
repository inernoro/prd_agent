"""Behavior checks for the public announcement initialization tool (no network)."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import urllib.error

SPEC = importlib.util.spec_from_file_location(
    "crawl_product_announcements", Path(__file__).resolve().parents[1] / "crawl-product-announcements.py")
CRAWLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CRAWLER)


class AnnouncementSnapshotTests(unittest.TestCase):
    def test_list_keeps_titled_unique_same_origin_records_and_next_page(self):
        items, has_next, expected = CRAWLER.parse_list("""
            <a href='/945f/one'><img src='x'></a>
            <a href='/945f/one'><b>互动营销V3.33.1（方案）-上线公告</b></a>
            <a href='/945f/one'>重复链接</a>
            <a href='https://evil.example/945f/other'>不允许</a>
            <a href='/945f?page=2'>下一页</a><a href='/945f?page=65'>末页</a>
        """, 1)
        self.assertEqual(1, len(items))
        self.assertEqual("one", items[0]["id"])
        self.assertEqual("互动营销V3.33.1（方案）-上线公告", items[0]["title"])
        self.assertTrue(has_next)
        self.assertEqual(65, expected)

    def test_detail_separates_dateline_and_footer_and_ignores_business_dates(self):
        detail = CRAWLER.parse_detail("""
            <h1>应用V1.2.3-上线公告</h1>
            <div class='editor_js--paragraph'>示例订单为2026-01-01，不是发布时间</div>
            <div class='editor_js--paragraph editor_js--paragraph__align-right'>米多产品团队</div>
            <div class='editor_js--paragraph editor_js--paragraph__align-right'>2026年10月26日</div>
            <div class='flex items-center mt-10 text-xs text-gray-400'>
              <svg></svg><div class='ml-1'>2026-10-27 </div>
            </div>
            <div class='ml-1'>2099-12-31</div>
        """)
        self.assertEqual("2026年10月26日", detail["publishedAtRaw"])
        self.assertEqual("2026-10-27", detail["footerTimeRaw"])

    def test_missing_dates_stay_empty_and_error_page_does_not_count_as_detail(self):
        detail = CRAWLER.parse_detail("<h1>公告</h1><div class='editor_js--paragraph'>正文没有日期</div>")
        self.assertEqual("", detail["publishedAtRaw"])
        self.assertEqual("", detail["footerTimeRaw"])
        with self.assertRaises(ValueError):
            CRAWLER.parse_detail("<title>请求失败</title><p>请稍后重试</p>")

    def test_observed_date_without_day_suffix_preserves_original_text(self):
        detail = CRAWLER.parse_detail("<h1>智能营销V2.8.17</h1>"
                                      "<div class='editor_js--paragraph editor_js--paragraph__align-right'>2022年12月29</div>")
        self.assertEqual("2022年12月29", detail["publishedAtRaw"])

    def test_unaligned_dateline_is_only_taken_from_final_nonempty_paragraph(self):
        detail = CRAWLER.parse_detail("<h1>万能零售助手T3.7.5（新增AI小助手）-上线公告</h1>"
                                      "<div class='editor_js--paragraph'>米多平台运营团队</div>"
                                      "<div class='editor_js--paragraph'>2025年09月05日</div>")
        self.assertEqual("2025年09月05日", detail["publishedAtRaw"])
        business = CRAWLER.parse_detail("<h1>公告</h1><div class='editor_js--paragraph'>2025年09月05日</div>"
                                        "<div class='editor_js--paragraph'>上述为订单日期示例，正文没有发布日期</div>")
        self.assertEqual("", business["publishedAtRaw"])

    def test_application_and_version_require_one_complete_version(self):
        self.assertEqual(("互动营销", "V3.33.1"), CRAWLER.title_identity("互动营销 V3.33.1（新方案）"))
        self.assertEqual(("品牌商后台基础", "V4.25.0"), CRAWLER.title_identity("品牌后台基础V4.25.0（新增组织架构）-上线公告"))
        self.assertEqual(("", ""), CRAWLER.title_identity("应用V1.2与V2.0"))
        self.assertEqual(("", ""), CRAWLER.title_identity("应用V1.2.3与V2.0.0"))
        self.assertEqual(("", ""), CRAWLER.title_identity("2026.10.15功能优化小报"))

    def test_crawler_rejects_other_hosts_credentials_and_non_article_paths(self):
        for url in ("http://helper.weixin12315.com/945f", "https://evil.example/945f/x",
                    "https://token@helper.weixin12315.com/945f/x", "/admin", "/945f?token=secret"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                CRAWLER.approved_url(url)

    def test_complete_snapshot_cannot_hide_missing_pages_or_duplicate_records(self):
        state = {"schemaVersion": 1, "sourceUrl": CRAWLER.SOURCE, "scanCompleted": True,
                 "pagesScanned": 1, "expectedPages": 2, "records": []}
        with self.assertRaises(ValueError):
            CRAWLER.validate_snapshot(state)
        state["pagesScanned"] = 2
        row = {"id": "one", "url": CRAWLER.SOURCE + "/one", "title": "应用V1.0.0", "applicationName": "应用",
               "version": "V1.0.0", "publishedAtRaw": "", "footerTimeRaw": "", "detailStatus": "succeeded",
               "lastError": "", "fetchedAt": "2026-10-27T00:00:00Z"}
        state["records"] = [row, dict(row)]
        with self.assertRaises(ValueError):
            CRAWLER.validate_snapshot(state)

    def test_upstream_failure_retains_queryable_bounded_response_evidence(self):
        evidence_root = Path(__file__).resolve().parents[2] / ".agent-workspace/announcement-crawl-evidence/tests"
        evidence_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=evidence_root) as directory:
            audit_file = Path(directory) / "responses.jsonl"
            error = urllib.error.HTTPError(CRAWLER.SOURCE, 503, "Unavailable", {"Content-Type": "text/html"},
                                           io.BytesIO(b"<title>Temporary maintenance</title><p>Article body omitted</p>"))
            opener = Mock()
            opener.open.side_effect = error
            with patch.object(CRAWLER.urllib.request, "build_opener", return_value=opener):
                with self.assertRaises(RuntimeError):
                    CRAWLER.Fetcher(audit_file, "run-test", 0.1, 1).fetch(CRAWLER.SOURCE, "list", 1,
                                                                        lambda html: CRAWLER.parse_list(html, 1))
            audit = json.loads(audit_file.read_text(encoding="utf-8"))
            self.assertEqual("run-test", audit["runId"])
            self.assertEqual(503, audit["httpStatus"])
            self.assertTrue(audit["receivedResponse"])
            self.assertEqual("Temporary maintenance", audit["responseSnapshot"]["pageTitle"])
            self.assertEqual("failed", audit["outcome"])
            self.assertNotIn("Article body omitted</p>", audit_file.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
