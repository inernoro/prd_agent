import datetime as dt
import unittest
from pathlib import Path

from llmgw.tutorial.maintenance import REPO_ROOT, analyze, load_json


class TutorialMaintenanceTests(unittest.TestCase):
    def setUp(self) -> None:
        root = Path(__file__).resolve().parent
        self.mapping = load_json(root / "maintenance-map.json")
        self.manifest = load_json(root / "manifest.json")
        self.now = dt.datetime(2026, 7, 18, tzinfo=dt.timezone.utc)

    def test_exchange_change_maps_to_chapters_without_drift(self) -> None:
        report = analyze(
            REPO_ROOT,
            self.mapping,
            self.manifest,
            [
                "llmgw/web/src/pages/ExchangesPage.tsx",
                "llmgw/tutorial/chapters/19-exchange.md",
            ],
            self.now,
        )

        self.assertEqual("healthy", report["status"])
        self.assertEqual(["chapter-19", "chapter-30"], report["affectedTutorials"][0]["tutorialSourceIds"])
        self.assertTrue(report["affectedTutorials"][0]["tutorialChanged"])
        self.assertEqual("exchanges-update-2026w29", report["updateDrafts"][0]["sourceId"])

    def test_unmapped_page_is_p1(self) -> None:
        report = analyze(
            REPO_ROOT,
            self.mapping,
            self.manifest,
            ["llmgw/web/src/pages/NewSurfacePage.tsx"],
            self.now,
        )

        self.assertEqual("drift", report["status"])
        self.assertEqual("P1", report["findings"][0]["severity"])


if __name__ == "__main__":
    unittest.main()
