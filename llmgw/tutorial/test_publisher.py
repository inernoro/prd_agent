from __future__ import annotations

import copy
import hashlib
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import publisher


class MemoryGateway:
    def __init__(self, fail_after: int | None = None):
        self.nodes: dict[str, dict] = {}
        self.foreign = {
            "id": "foreign-1",
            "parentId": None,
            "isFolder": False,
            "title": "人工保留内容",
            "metadata": {"owner": "human"},
            "metadataSha256": "foreign-metadata",
            "contentSha256": publisher.sha256_text("人工正文"),
            "content": None,
            "managed": False,
            "updatedAt": "2026-01-01T00:00:00Z",
        }
        self.primary_entry_id = None
        self.store_updated_at = 1
        self.put_count = 0
        self.fail_after = fail_after

    def snapshot(self, store_id: str, managed_publisher: str) -> dict:
        nodes = [copy.deepcopy(self.foreign)] + [copy.deepcopy(item) for item in self.nodes.values()]
        return {
            "store": {
                "id": store_id,
                "name": "隔离测试库",
                "primaryEntryId": self.primary_entry_id,
                "updatedAt": self.store_updated_at,
            },
            "publisher": managed_publisher,
            "snapshotSha256": hashlib.sha256(str(nodes).encode()).hexdigest(),
            "applyAllowed": True,
            "conflicts": {},
            "nodes": nodes,
        }

    def put_node(self, store_id: str, source_id: str, body: dict) -> dict:
        self.put_count += 1
        if self.fail_after is not None and self.put_count > self.fail_after:
            raise publisher.TutorialError("注入的中途失败")
        existing = self.nodes.get(source_id)
        if existing is not None and existing["updatedAt"] != body.get("expectedUpdatedAt"):
            raise publisher.ApiConflict("expectedUpdatedAt 不匹配")
        if existing is not None and existing["contentSha256"] == body["sourceSha256"]:
            existing["metadata"]["lastAppliedRunId"] = body["runId"]
            return {"action": "noop", "nodeId": existing["id"], "updatedAt": existing["updatedAt"]}
        action = "created" if existing is None else "updated"
        created_by = body["runId"] if existing is None else existing["metadata"]["createdByRunId"]
        self.store_updated_at += 1
        metadata = {
            "publisher": body["publisher"],
            "sourceId": source_id,
            "sourceSha256": body["sourceSha256"],
            "lastAppliedSha256": body["sourceSha256"],
            "createdByRunId": created_by,
            "lastAppliedRunId": body["runId"],
        }
        metadata_sha = publisher.sha256_text("\n".join(f"{key}:{metadata[key]}" for key in sorted(metadata)))
        self.nodes[source_id] = {
            "id": f"node-{source_id}",
            "parentId": None,
            "isFolder": body["kind"] == "folder",
            "title": body["title"],
            "metadata": metadata,
            "metadataSha256": metadata_sha,
            "contentSha256": body["sourceSha256"],
            "content": body["content"],
            "managed": True,
            "sourceId": source_id,
            "updatedAt": self.store_updated_at,
        }
        return {"action": action, "nodeId": f"node-{source_id}", "updatedAt": self.store_updated_at}

    def set_primary(self, store_id: str, body: dict) -> dict:
        if self.store_updated_at != body["expectedStoreUpdatedAt"]:
            raise publisher.ApiConflict("store CAS 不匹配")
        self.primary_entry_id = self.nodes[body["sourceId"]]["id"]
        self.store_updated_at += 1
        return {"primaryEntryId": self.primary_entry_id, "updatedAt": self.store_updated_at}

    def delete_created_node(self, store_id: str, source_id: str, query: dict[str, str]) -> dict:
        node = self.nodes[source_id]
        if node["metadata"]["createdByRunId"] != query["runId"]:
            raise publisher.ApiConflict("不是本批次创建")
        del self.nodes[source_id]
        self.store_updated_at += 1
        return {"action": "deleted"}


class TutorialPublisherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = publisher.load_and_validate(Path(__file__).with_name("manifest.json"))

    def test_manifest_has_exactly_thirty_three_continuous_chapters(self):
        chapter_ids = [node.source_id for node in self.source.nodes if node.source_id.startswith("chapter-")]
        self.assertEqual([f"chapter-{number:02d}" for number in range(33)], chapter_ids)

    def test_visual_density_has_no_zero_image_chapter(self):
        chapters = [node for node in self.source.nodes if node.source_id.startswith("chapter-")]
        counts = [len(publisher.MARKDOWN_IMAGE_RE.findall(node.content)) for node in chapters]
        urls = [url for node in chapters for url in publisher.MARKDOWN_IMAGE_RE.findall(node.content)]
        self.assertTrue(all(count >= publisher.MIN_IMAGES_PER_CHAPTER for count in counts))
        self.assertGreaterEqual(len(set(urls)), publisher.MIN_UNIQUE_IMAGES)
        self.assertGreaterEqual(len(urls), publisher.MIN_EVIDENCE_REFERENCES)

    def test_every_numbered_step_has_an_inline_image(self):
        chapters = [node for node in self.source.nodes if node.source_id.startswith("chapter-")]
        for chapter in chapters:
            doing = chapter.content.split("## 跟我做\n", 1)[1].split("## 看到什么算成功\n", 1)[0]
            steps = list(publisher.NUMBERED_STEP_RE.finditer(doing))
            self.assertTrue(steps, chapter.source_path)
            for index, step in enumerate(steps):
                end = steps[index + 1].start() if index + 1 < len(steps) else len(doing)
                self.assertIsNotNone(
                    publisher.MARKDOWN_IMAGE_RE.search(doing[step.end():end]),
                    f"{chapter.source_path}: {step.group(0)}",
                )

    def test_first_apply_second_apply_noop_and_manual_drift_conflict(self):
        gateway = MemoryGateway()
        foreign_before = copy.deepcopy(gateway.foreign)

        first_plan = publisher.build_plan(self.source, gateway.snapshot("store-a", self.source.publisher))
        self.assertTrue(all(item.action == "create" for item in first_plan))
        first = publisher.apply_plan(gateway, "store-a", self.source, first_plan)
        self.assertEqual(len(self.source.nodes), first["counts"]["created"])
        self.assertEqual(0, first["counts"]["noop"])

        node_times = {key: value["updatedAt"] for key, value in gateway.nodes.items()}
        store_time = gateway.store_updated_at
        second_plan = publisher.build_plan(self.source, gateway.snapshot("store-a", self.source.publisher))
        self.assertTrue(all(item.action == "verify-noop" for item in second_plan))
        second = publisher.apply_plan(gateway, "store-a", self.source, second_plan)
        self.assertEqual(len(self.source.nodes), second["counts"]["noop"])
        self.assertEqual(node_times, {key: value["updatedAt"] for key, value in gateway.nodes.items()})
        self.assertEqual(store_time, gateway.store_updated_at)

        drifted = gateway.nodes["chapter-11"]
        drifted["content"] += "\n人工修改"
        drifted["contentSha256"] = publisher.sha256_text(drifted["content"])
        drifted["updatedAt"] = gateway.store_updated_at + 1
        conflict_plan = publisher.build_plan(self.source, gateway.snapshot("store-a", self.source.publisher))
        conflict = next(item for item in conflict_plan if item.node.source_id == "chapter-11")
        self.assertEqual("conflict", conflict.action)
        before_apply = copy.deepcopy(gateway.nodes)
        with self.assertRaises(publisher.ApiConflict):
            publisher.apply_plan(gateway, "store-a", self.source, conflict_plan)
        self.assertEqual(before_apply, gateway.nodes)
        self.assertEqual(foreign_before, gateway.foreign)

    def test_mid_run_failure_rolls_back_only_current_run_creates(self):
        gateway = MemoryGateway(fail_after=5)
        plan = publisher.build_plan(self.source, gateway.snapshot("store-a", self.source.publisher))
        with self.assertRaises(publisher.TutorialError):
            publisher.apply_plan(gateway, "store-a", self.source, plan)
        self.assertEqual({}, gateway.nodes)
        self.assertEqual("人工保留内容", gateway.foreign["title"])

    def test_unexpected_managed_node_fails_closed(self):
        gateway = MemoryGateway()
        gateway.nodes["chapter-legacy"] = {
            "id": "legacy",
            "isFolder": False,
            "title": "旧章节",
            "metadata": {"lastAppliedSha256": publisher.sha256_text("旧")},
            "metadataSha256": "legacy",
            "contentSha256": publisher.sha256_text("旧"),
            "content": "旧",
            "managed": True,
            "sourceId": "chapter-legacy",
            "updatedAt": 1,
        }
        with self.assertRaises(publisher.ApiConflict):
            publisher.build_plan(self.source, gateway.snapshot("store-a", self.source.publisher))

    def test_placeholder_and_self_reported_tenant_are_rejected(self):
        chapter = next(node for node in self.source.nodes if node.source_id == "chapter-00")
        for bad in ("\n{{IMG:missing}}", '\n{"tenantId":"other"}'):
            changed = publisher.dataclasses.replace(chapter, content=chapter.content + bad)
            with self.assertRaises(publisher.TutorialError):
                publisher._validate_chapter(changed, 0, "什么是模型网关")


if __name__ == "__main__":
    unittest.main()
