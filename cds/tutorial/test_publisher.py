from __future__ import annotations

from pathlib import Path
import sys
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parent))
import publisher


class CdsTutorialPublisherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = publisher.load_and_validate(Path(__file__).with_name("manifest.json"))

    def test_book_has_twenty_five_continuous_chapters(self):
        chapters = [node for node in self.source.nodes if node.source_id.startswith("chapter-")]
        self.assertEqual([f"chapter-{number:02d}" for number in range(25)], [node.source_id for node in chapters])

    def test_book_is_detailed_and_has_no_published_emoji(self):
        documents = [node for node in self.source.nodes if node.kind == "document"]
        self.assertGreaterEqual(sum(len(node.content) for node in documents), publisher.MIN_BOOK_CHARACTERS)
        for node in documents:
            self.assertIsNone(publisher.core.EMOJI_RE.search(node.content), node.source_path)

    def test_manifest_sources_stay_inside_the_repository_allowlist(self):
        for node in self.source.nodes:
            self.assertTrue(node.source_path.startswith(publisher.ALLOWED_SOURCE_PREFIXES), node.source_path)
            if node.kind == "document":
                self.assertTrue(publisher._safe_repo_source(node.source_path).is_file())

    def test_empty_snapshot_creates_every_managed_node(self):
        plan = publisher.core.build_plan(self.source, {
            "applyAllowed": True,
            "conflicts": {},
            "nodes": [],
        })
        self.assertEqual(len(self.source.nodes), len(plan))
        self.assertTrue(all(item.action == "create" for item in plan))

    def test_request_body_uses_cds_category(self):
        node = next(node for node in self.source.nodes if node.source_id == "book-index")
        item = publisher.core.PlanItem(node, "create", None, None, "远端不存在")
        body = publisher.core._request_body(self.source, item, "run-test", "revision-test")
        self.assertEqual("CDS 权威教程", body["category"])
        self.assertEqual("cds-authoritative-tutorial", body["publisher"])

    def test_repository_links_are_rewritten_to_managed_chapter_wikilinks(self):
        chapter = next(node for node in self.source.nodes if node.source_id == "chapter-01")
        self.assertIn(
            "[[第 8 章：理解托管交付|自动交付与 Agent 接入]]",
            chapter.content,
        )
        self.assertIn(
            "[[第 9 章：选择三条部署路径|部署方式选择]]",
            chapter.content,
        )
        self.assertNotIn("](guide.cds.managed-delivery.md)", chapter.content)

    def test_unmanaged_repository_links_become_non_clickable_disclosures(self):
        rendered = publisher._rewrite_repository_markdown_links(
            "查看 [内部设计](design.private.md)，示例 ` [保留](sample.md) `。",
            "doc/guide.current.md",
            {"doc/guide.current.md": "当前章"},
        )
        self.assertIn("内部设计（本教程未收录）", rendered)
        self.assertNotIn("](design.private.md)", rendered)
        self.assertIn("` [保留](sample.md) `", rendered)

    def test_published_book_has_no_relative_markdown_document_links(self):
        leftovers: list[str] = []
        for node in self.source.nodes:
            if node.kind != "document":
                continue
            for match in publisher.MARKDOWN_LINK_RE.finditer(node.content):
                destination = match.group(2).strip().split(maxsplit=1)[0].strip("<>")
                if "://" not in destination and destination.split("#", 1)[0].lower().endswith(".md"):
                    leftovers.append(f"{node.source_path}: {match.group(0)}")
        self.assertEqual([], leftovers)


if __name__ == "__main__":
    unittest.main()
