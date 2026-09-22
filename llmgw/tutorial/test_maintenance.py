import copy
import datetime as dt
import unittest
from pathlib import Path

from llmgw.tutorial.maintenance import MaintenanceError, REPO_ROOT, analyze, load_json


class TutorialMaintenanceTests(unittest.TestCase):
    def setUp(self) -> None:
        root = Path(__file__).resolve().parent
        self.mapping = load_json(root / "maintenance-map.json")
        self.manifest = load_json(root / "manifest.json")
        self.evidence = load_json(root / "evidence-map.json")
        self.now = dt.datetime(2026, 7, 27, tzinfo=dt.timezone.utc)

    def run_scan(
        self,
        files: list[str],
        *,
        mapping: dict | None = None,
        evidence: dict | None = None,
        force_audit: bool = False,
        seed: str = "test-seed",
    ) -> dict:
        return analyze(
            REPO_ROOT,
            mapping or self.mapping,
            self.manifest,
            files,
            self.now,
            evidence or self.evidence,
            audit_seed=seed,
            sample_size=5,
            force_audit=force_audit,
        )

    def test_full_graph_and_random_audit_are_healthy(self) -> None:
        report = self.run_scan([], force_audit=True, seed="full-graph-20260727")

        self.assertEqual("skipped", report["status"])
        self.assertEqual([], report["findings"])
        self.assertEqual("passed", report["randomAudit"]["status"])
        self.assertEqual(5, report["randomAudit"]["sampleSize"])

    def test_no_relevant_change_skips_without_draft(self) -> None:
        report = self.run_scan(["prd-admin/src/pages/HomePage.tsx"])

        self.assertEqual("skipped", report["status"])
        self.assertEqual("no-relevant-changes", report["skipReason"])
        self.assertEqual([], report["updateDrafts"])
        self.assertEqual("skipped", report["randomAudit"]["status"])

    def test_theme_change_marks_every_surface_for_screenshot_review(self) -> None:
        report = self.run_scan(["llmgw/web/src/theme.css"])

        self.assertEqual("review_required", report["status"])
        self.assertEqual(len(self.mapping["surfaces"]), len(report["affectedTutorials"]))
        self.assertTrue(all("screenshot" in item["impacts"] for item in report["affectedTutorials"]))

    def test_exchange_backend_change_maps_to_exchange_tutorial(self) -> None:
        report = self.run_scan(["prd-api/src/PrdAgent.Api/Controllers/Api/ExchangeController.cs"])

        self.assertEqual("review_required", report["status"])
        self.assertEqual(["exchanges"], [item["surface"] for item in report["affectedTutorials"]])
        self.assertIn("chapter-19", report["affectedTutorials"][0]["tutorialSourceIds"])

    def test_changed_tutorial_reverse_links_to_surfaces(self) -> None:
        report = self.run_scan(["llmgw/tutorial/chapters/21-requests-and-sessions.md"])

        self.assertEqual("review_required", report["status"])
        self.assertEqual(
            {"log-detail", "log-entity-details", "logs"},
            {item["surface"] for item in report["affectedTutorials"]},
        )

    def test_missing_step_marker_is_p1(self) -> None:
        mapping = copy.deepcopy(self.mapping)
        logs = next(item for item in mapping["surfaces"] if item["id"] == "logs")
        logs["tutorialLinks"][0]["stepIds"] = ["missing-step-marker"]

        report = self.run_scan([], mapping=mapping, force_audit=True)

        self.assertEqual("drift", report["status"])
        self.assertTrue(any("步骤标记" in item["message"] for item in report["findings"]))

    def test_missing_evidence_is_p1(self) -> None:
        mapping = copy.deepcopy(self.mapping)
        logs = next(item for item in mapping["surfaces"] if item["id"] == "logs")
        logs["tutorialLinks"][0]["evidenceIds"] = ["999-not-registered"]

        report = self.run_scan([], mapping=mapping, force_audit=True)

        self.assertEqual("drift", report["status"])
        self.assertTrue(any("截图证据未注册" in item["message"] for item in report["findings"]))

    def test_evidence_from_another_chapter_is_p1(self) -> None:
        mapping = copy.deepcopy(self.mapping)
        logs = next(item for item in mapping["surfaces"] if item["id"] == "logs")
        logs["tutorialLinks"][0]["evidenceIds"] = [self.evidence["chapters"]["05"][0]]

        report = self.run_scan([], mapping=mapping, force_audit=True)

        self.assertEqual("drift", report["status"])
        self.assertTrue(any("对应教程" in item["message"] for item in report["findings"]))

    def test_empty_linked_chapter_evidence_is_p1(self) -> None:
        mapping = copy.deepcopy(self.mapping)
        logs = next(item for item in mapping["surfaces"] if item["id"] == "logs")
        logs["tutorialLinks"][0]["evidenceIds"] = []

        report = self.run_scan([], mapping=mapping, force_audit=True)

        self.assertEqual("drift", report["status"])
        self.assertTrue(any("没有章节证据" in item["message"] for item in report["findings"]))

    def test_graph_metadata_change_runs_audit(self) -> None:
        report = self.run_scan(["llmgw/tutorial/maintenance-map.json"])

        self.assertNotEqual("skipped", report["randomAudit"]["status"])
        self.assertNotEqual("no-relevant-changes", report.get("skipReason"))

    def test_reverse_link_gap_is_p1(self) -> None:
        mapping = copy.deepcopy(self.mapping)
        learning = next(item for item in mapping["surfaces"] if item["id"] == "learning-center")
        learning["tutorialSourceIds"].remove("chapter-01")

        report = self.run_scan([], mapping=mapping, force_audit=True)

        self.assertEqual("drift", report["status"])
        self.assertTrue(any(item["surface"] == "chapter-01" for item in report["findings"]))

    def test_unmapped_page_is_p1(self) -> None:
        """在册却没登记教程的页面必须报 P1。

        样本从虚构文件换成真实在册页面：判据现在要分辨「这个页面被删了」与
        「这个页面在册但漏登记」，而一个 git 里根本不存在的路径在这两种读法下
        长得一模一样——那样的样本测不准哪一种。
        """
        mapping = copy.deepcopy(self.mapping)
        mapping["surfaces"] = [s for s in mapping["surfaces"] if s["id"] != "home"]
        report = self.run_scan(["llmgw/web/src/pages/HomePage.tsx"], mapping=mapping)

        self.assertEqual("drift", report["status"])
        self.assertTrue(any(item["severity"] == "P1" for item in report["findings"]))
        self.assertTrue(any("没有对应教程" in item["message"] for item in report["findings"]))

    def test_duplicate_route_fails_graph_loading(self) -> None:
        mapping = copy.deepcopy(self.mapping)
        mapping["surfaces"][1]["routes"] = mapping["surfaces"][0]["routes"]

        with self.assertRaises(MaintenanceError):
            self.run_scan([], mapping=mapping)

    def test_random_audit_is_reproducible(self) -> None:
        first = self.run_scan([], force_audit=True, seed="stable-random-seed")
        second = self.run_scan([], force_audit=True, seed="stable-random-seed")
        other = self.run_scan([], force_audit=True, seed="other-random-seed")

        self.assertEqual(first["randomAudit"]["surfaceIds"], second["randomAudit"]["surfaceIds"])
        self.assertNotEqual(first["randomAudit"]["surfaceIds"], other["randomAudit"]["surfaceIds"])

    def test_home_and_governance_point_to_real_components(self) -> None:
        by_id = {item["id"]: item for item in self.mapping["surfaces"]}

        self.assertEqual("llmgw/web/src/pages/HomePage.tsx", by_id["home"]["pagePath"])
        self.assertEqual("llmgw/web/src/pages/OverviewPage.tsx", by_id["governance"]["pagePath"])
        self.assertEqual("llmgw/web/src/pages/ChangePasswordPage.tsx", by_id["change-password"]["pagePath"])

    def test_five_fault_injections_are_all_detected(self) -> None:
        mutations: list[tuple[str, dict]] = []

        missing_page = copy.deepcopy(self.mapping)
        missing_page["surfaces"][0]["pagePath"] = "llmgw/web/src/pages/AbsentPage.tsx"
        mutations.append(("missing-page", missing_page))

        bad_step = copy.deepcopy(self.mapping)
        next(item for item in bad_step["surfaces"] if item["id"] == "quickstart")["tutorialLinks"][0]["stepIds"] = ["absent-step"]
        mutations.append(("missing-step", bad_step))

        bad_evidence = copy.deepcopy(self.mapping)
        next(item for item in bad_evidence["surfaces"] if item["id"] == "organization")["tutorialLinks"][0]["evidenceIds"] = ["absent-evidence"]
        mutations.append(("missing-evidence", bad_evidence))

        bad_route = copy.deepcopy(self.mapping)
        next(item for item in bad_route["surfaces"] if item["id"] == "settings")["routes"] = ["settings"]
        mutations.append(("invalid-route", bad_route))

        no_reverse = copy.deepcopy(self.mapping)
        next(item for item in no_reverse["surfaces"] if item["id"] == "usage")["tutorialSourceIds"] = ["chapter-22", "chapter-23"]
        mutations.append(("orphan-tutorial", no_reverse))

        for name, mapping in mutations:
            with self.subTest(name=name):
                report = self.run_scan([], mapping=mapping, force_audit=True, seed=f"fault-{name}")
                self.assertEqual("drift", report["status"])
                self.assertTrue(report["findings"])

    def test_deleted_page_in_the_diff_is_not_asked_for_a_tutorial(self) -> None:
        """被这次改动删掉的页面不该再被要求有教程映射。

        本轮真踩过：模型池那一屏退场后，它的路径仍在 PR 的变更集里，判据照旧要求
        「给它登记教程」——而那是一个已经不存在的页面。放宽了什么？什么都没有：
        反向用例证明另外两道闸照旧红。
        """
        deleted = "llmgw/web/src/pages/ModelPoolsPage.tsx"
        self.assertFalse((REPO_ROOT / deleted).exists(), "这个页面又回来了，这条守卫在空跑")
        report = self.run_scan([deleted])
        self.assertEqual([], report["findings"])

        # 反向一：映射还指着已删页面 → P0 照旧
        stale = copy.deepcopy(self.mapping)
        next(s for s in stale["surfaces"] if s["id"] == "logical-models")["pagePath"] = deleted
        stale_report = self.run_scan([deleted], mapping=stale)
        self.assertEqual("drift", stale_report["status"])
        self.assertTrue(any(f["severity"] == "P0" for f in stale_report["findings"]))

        # 反向二在 test_unmapped_page_is_p1：在册却没登记的页面照旧报 P1。

    def test_embedded_surface_needs_no_route_of_its_own(self) -> None:
        """「上游」是一页两段：外壳占路由，两段各自是 pages 文件但不占路由。

        不认这种形状的话只有两条死路——给内嵌段硬编一个不存在的路由（判据立刻说
        「未在应用注册」），或者不登记它（判据立刻说「没有映射」）。这条钉住那个
        分支真的被走到了：内嵌段没有 routes，而整张图仍然干净。
        """
        embedded = [s for s in self.mapping["surfaces"] if s.get("embeddedIn")]
        self.assertTrue(embedded, "映射里已经没有内嵌面了，这条守卫在空跑")
        for surface in embedded:
            self.assertNotIn("routes", surface, f"{surface['id']} 是内嵌面，不该自己声明路由")
            host = next(x for x in self.mapping["surfaces"] if x["id"] == surface["embeddedIn"])
            self.assertTrue(host.get("routes"), f"外壳 {host['id']} 必须占着路由")

        report = self.run_scan([], force_audit=True, seed="embedded-clean")
        self.assertEqual("skipped", report["status"])
        self.assertEqual([], report["findings"])

    def test_embedded_surface_faults_are_all_detected(self) -> None:
        """内嵌这条分支自己的三种坏法，逐个必须报出来。"""
        host_missing = copy.deepcopy(self.mapping)
        next(s for s in host_missing["surfaces"] if s["id"] == "providers")["embeddedIn"] = "no-such-surface"

        host_is_embedded = copy.deepcopy(self.mapping)
        next(s for s in host_is_embedded["surfaces"] if s["id"] == "upstreams")["embeddedIn"] = "providers"

        embedded_claims_route = copy.deepcopy(self.mapping)
        next(s for s in embedded_claims_route["surfaces"] if s["id"] == "providers")["routes"] = ["/platforms"]

        for name, mapping in [
            ("host-missing", host_missing),
            ("host-is-embedded", host_is_embedded),
            ("embedded-claims-route", embedded_claims_route),
        ]:
            with self.subTest(name=name):
                with self.assertRaises(MaintenanceError):
                    self.run_scan([], mapping=mapping, force_audit=True, seed=f"embedded-{name}")


if __name__ == "__main__":
    unittest.main()
