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

    def test_reverse_link_gap_is_p1(self) -> None:
        mapping = copy.deepcopy(self.mapping)
        learning = next(item for item in mapping["surfaces"] if item["id"] == "learning-center")
        learning["tutorialSourceIds"].remove("chapter-01")

        report = self.run_scan([], mapping=mapping, force_audit=True)

        self.assertEqual("drift", report["status"])
        self.assertTrue(any(item["surface"] == "chapter-01" for item in report["findings"]))

    def test_unmapped_page_is_p1_even_when_file_is_new(self) -> None:
        report = self.run_scan(["llmgw/web/src/pages/NewSurfacePage.tsx"])

        self.assertEqual("drift", report["status"])
        self.assertTrue(any(item["severity"] == "P1" for item in report["findings"]))

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


if __name__ == "__main__":
    unittest.main()
