from __future__ import annotations

import copy
import dataclasses
import hashlib
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import publisher


class MemoryGateway:
    def __init__(self, fail_after: int | None = None, fail_graph_publish: bool = False):
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
        self.fail_graph_publish = fail_graph_publish
        self.lose_graph_publish_response = False
        self.lose_put_response_for: set[str] = set()
        self.fail_primary_before_commit = False
        self.lose_primary_response_after_commit = False
        self.link_graph: dict = {"exists": False, "draft": None, "published": None, "history": []}

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
            self.fail_after = None
            raise publisher.TutorialError("注入的中途失败")
        existing = self.nodes.get(source_id)
        if existing is not None and existing["updatedAt"] != body.get("expectedUpdatedAt"):
            raise publisher.ApiConflict("expectedUpdatedAt 不匹配")
        parent_id = self.nodes[body["parentSourceId"]]["id"] if body.get("parentSourceId") else None
        if (
            existing is not None
            and existing["contentSha256"] == body["sourceSha256"]
            and existing["parentId"] == parent_id
        ):
            existing["metadata"]["lastAppliedRunId"] = body["runId"]
            return {"action": "noop", "nodeId": existing["id"], "updatedAt": existing["updatedAt"]}
        action = "created" if existing is None else "updated"
        created_by = body["runId"] if existing is None else existing["metadata"]["createdByRunId"]
        self.store_updated_at += 1
        metadata = {
            "publisher": body["publisher"],
            "sourceId": source_id,
            "sourcePath": body["sourcePath"],
            "sourceSha256": body["sourceSha256"],
            "manifestSha256": body["manifestSha256"],
            "sourceRevision": body["sourceRevision"],
            "kind": body["kind"],
            "lastAppliedSha256": body["sourceSha256"],
            "createdByRunId": created_by,
            "lastAppliedRunId": body["runId"],
        }
        if body.get("replaceCustomMetadata"):
            metadata.update(body.get("metadata") or {})
        else:
            metadata.update(existing.get("metadata", {}) if existing else {})
            metadata.update(body.get("metadata") or {})
            metadata.update({
                "publisher": body["publisher"],
                "sourceId": source_id,
                "sourcePath": body["sourcePath"],
                "sourceSha256": body["sourceSha256"],
                "manifestSha256": body["manifestSha256"],
                "sourceRevision": body["sourceRevision"],
                "kind": body["kind"],
                "lastAppliedSha256": body["sourceSha256"],
                "createdByRunId": created_by,
                "lastAppliedRunId": body["runId"],
            })
        metadata_sha = publisher.sha256_text("\n".join(f"{key}:{metadata[key]}" for key in sorted(metadata)))
        self.nodes[source_id] = {
            "id": f"node-{source_id}",
            "parentId": parent_id,
            "isFolder": body["kind"] == "folder",
            "title": body["title"],
            "summary": body.get("summary"),
            "contentType": body.get("contentType"),
            "tags": body.get("tags") or [],
            "category": body.get("category"),
            "sortOrder": body.get("sortOrder"),
            "metadata": metadata,
            "metadataSha256": metadata_sha,
            "contentSha256": body["sourceSha256"],
            "content": body["content"],
            "managed": True,
            "sourceId": source_id,
            "updatedAt": self.store_updated_at,
        }
        if source_id in self.lose_put_response_for:
            self.lose_put_response_for.remove(source_id)
            raise publisher.TutorialError("注入的节点响应丢失")
        return {"action": action, "nodeId": f"node-{source_id}", "updatedAt": self.store_updated_at}

    def set_primary(self, store_id: str, body: dict) -> dict:
        if self.fail_primary_before_commit:
            self.fail_primary_before_commit = False
            raise publisher.ApiConflict("注入的主文档写入前失败")
        if self.store_updated_at != body["expectedStoreUpdatedAt"]:
            raise publisher.ApiConflict("store CAS 不匹配")
        self.primary_entry_id = self.nodes[body["sourceId"]]["id"]
        self.store_updated_at += 1
        if self.lose_primary_response_after_commit:
            self.lose_primary_response_after_commit = False
            raise publisher.TutorialError("注入的主文档响应丢失")
        return {"primaryEntryId": self.primary_entry_id, "updatedAt": self.store_updated_at}

    def delete_created_node(self, store_id: str, source_id: str, query: dict[str, str]) -> dict:
        node = self.nodes[source_id]
        if node["metadata"]["createdByRunId"] != query["runId"]:
            raise publisher.ApiConflict("不是本批次创建")
        if any(item.get("parentId") == node["id"] for item in self.nodes.values()):
            raise publisher.ApiConflict("节点仍有子项")
        del self.nodes[source_id]
        self.store_updated_at += 1
        return {"action": "deleted"}

    def get_link_graph(self, store_id: str, managed_publisher: str) -> dict:
        return copy.deepcopy(self.link_graph)

    def save_link_graph_draft(self, store_id: str, body: dict) -> dict:
        current_draft = self.link_graph.get("draft") or {}
        if current_draft.get("graphSha256") != body.get("expectedDraftSha256"):
            raise publisher.ApiConflict("草稿 SHA 不匹配")
        graph = copy.deepcopy(body["graph"])
        graph["graphSha256"] = hashlib.sha256(
            json.dumps(graph, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()
        self.link_graph.update({"exists": True, "draft": graph})
        return copy.deepcopy(self.link_graph)

    def publish_link_graph(self, store_id: str, body: dict) -> dict:
        if self.fail_graph_publish:
            self.fail_graph_publish = False
            raise publisher.TutorialError("注入的图谱发布失败")
        draft = self.link_graph.get("draft") or {}
        published = self.link_graph.get("published") or {}
        if draft.get("graphSha256") != body.get("expectedDraftSha256"):
            raise publisher.ApiConflict("草稿 SHA 不匹配")
        if published.get("graphSha256") != body.get("expectedPublishedSha256"):
            raise publisher.ApiConflict("已发布 SHA 不匹配")
        self.link_graph["published"] = copy.deepcopy(draft)
        self.link_graph["history"].append({"graphSha256": draft["graphSha256"]})
        if self.lose_graph_publish_response:
            self.lose_graph_publish_response = False
            raise publisher.TutorialError("注入的图谱发布响应丢失")
        return copy.deepcopy(self.link_graph)


class TutorialPublisherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = publisher.load_and_validate(Path(__file__).with_name("manifest.json"))

    def test_manifest_has_exactly_thirty_three_continuous_chapters(self):
        chapter_ids = [node.source_id for node in self.source.nodes if node.source_id.startswith("chapter-")]
        self.assertEqual([f"chapter-{number:02d}" for number in range(33)], chapter_ids)

    def test_practical_tutorials_live_in_a_dedicated_folder(self):
        folder = next(node for node in self.source.nodes if node.source_id == "part-practical")
        self.assertEqual("folder", folder.kind)
        practical = [node for node in self.source.nodes if node.source_id.startswith("practical-image-")]
        self.assertEqual(4, len(practical))
        self.assertTrue(all(node.parent_source_id == folder.source_id for node in practical))
        self.assertEqual([400, 401, 402, 403], [node.sort_order for node in practical])

    def test_visual_density_has_no_zero_image_chapter(self):
        chapters = [node for node in self.source.nodes if node.source_id.startswith("chapter-")]
        counts = [len(publisher.MARKDOWN_IMAGE_RE.findall(node.content)) for node in chapters]
        urls = [url for node in chapters for url in publisher.MARKDOWN_IMAGE_RE.findall(node.content)]
        self.assertTrue(all(count >= publisher.MIN_IMAGES_PER_CHAPTER for count in counts))
        self.assertGreaterEqual(len(set(urls)), publisher.MIN_UNIQUE_IMAGES)
        self.assertGreaterEqual(len(urls), publisher.MIN_EVIDENCE_REFERENCES)

    def test_publisher_thresholds_come_from_evidence_ssot(self):
        evidence = json.loads(Path(__file__).with_name("evidence-map.json").read_text(encoding="utf-8"))

        self.assertEqual(evidence["minimumImagesPerChapter"], publisher.MIN_IMAGES_PER_CHAPTER)
        self.assertEqual(evidence["minimumUniqueImages"], publisher.MIN_UNIQUE_IMAGES)
        self.assertEqual(evidence["minimumEvidenceReferences"], publisher.MIN_EVIDENCE_REFERENCES)

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
        self.assertEqual("published", first["linkGraph"]["action"])

        node_times = {key: value["updatedAt"] for key, value in gateway.nodes.items()}
        store_time = gateway.store_updated_at
        second_plan = publisher.build_plan(self.source, gateway.snapshot("store-a", self.source.publisher))
        self.assertTrue(all(item.action == "verify-noop" for item in second_plan))
        second = publisher.apply_plan(gateway, "store-a", self.source, second_plan)
        self.assertEqual(len(self.source.nodes), second["counts"]["noop"])
        self.assertEqual(node_times, {key: value["updatedAt"] for key, value in gateway.nodes.items()})
        self.assertEqual(store_time, gateway.store_updated_at)
        self.assertEqual("noop", second["linkGraph"]["action"])
        self.assertEqual(1, len(gateway.link_graph["history"]))

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

    def test_manual_graph_draft_is_not_overwritten(self):
        gateway = MemoryGateway()
        plan = publisher.build_plan(self.source, gateway.snapshot("store-a", self.source.publisher))
        publisher.apply_plan(gateway, "store-a", self.source, plan)
        manual = copy.deepcopy(gateway.link_graph["published"])
        manual["surfaces"][0]["label"] = "人工草稿"
        manual["graphSha256"] = "f" * 64
        gateway.link_graph["draft"] = manual

        with self.assertRaisesRegex(publisher.ApiConflict, "人工图谱草稿"):
            publisher.stage_link_graph(gateway, "store-a", self.source, publisher._source_revision())
        self.assertEqual("人工草稿", gateway.link_graph["draft"]["surfaces"][0]["label"])

    def test_graph_publish_failure_restores_updated_content(self):
        gateway = MemoryGateway()
        first_plan = publisher.build_plan(self.source, gateway.snapshot("store-a", self.source.publisher))
        publisher.apply_plan(gateway, "store-a", self.source, first_plan)
        before = copy.deepcopy(gateway.nodes)

        changed_node = dataclasses.replace(
            self.source.nodes[0],
            content=self.source.nodes[0].content + "\n\n受控更新",
            source_sha256=publisher.sha256_text(self.source.nodes[0].content + "\n\n受控更新"),
        )
        changed_source = dataclasses.replace(
            self.source,
            manifest_sha256="e" * 64,
            nodes=[changed_node, *self.source.nodes[1:]],
        )
        plan = publisher.build_plan(changed_source, gateway.snapshot("store-a", changed_source.publisher))
        gateway.fail_graph_publish = True
        with self.assertRaisesRegex(publisher.TutorialError, "图谱发布失败"):
            publisher.apply_plan(gateway, "store-a", changed_source, plan)
        self.assertEqual(before[changed_node.source_id]["content"], gateway.nodes[changed_node.source_id]["content"])
        self.assertEqual(
            before[changed_node.source_id]["contentSha256"],
            gateway.nodes[changed_node.source_id]["contentSha256"],
        )

    def test_committed_graph_publish_is_reconciled_after_response_loss(self):
        gateway = MemoryGateway()
        gateway.lose_graph_publish_response = True
        plan = publisher.build_plan(self.source, gateway.snapshot("store-a", self.source.publisher))

        applied = publisher.apply_plan(gateway, "store-a", self.source, plan)

        self.assertTrue(applied["linkGraph"]["reconciled"])
        self.assertEqual(len(self.source.nodes), len(gateway.nodes))
        self.assertEqual(
            gateway.link_graph["draft"]["graphSha256"],
            gateway.link_graph["published"]["graphSha256"],
        )

    def test_committed_node_update_is_discovered_after_response_loss(self):
        gateway = MemoryGateway()
        publisher.apply_plan(
            gateway,
            "store-a",
            self.source,
            publisher.build_plan(self.source, gateway.snapshot("store-a", self.source.publisher)),
        )
        before = copy.deepcopy(gateway.nodes)
        changed_node = dataclasses.replace(
            self.source.nodes[0],
            content=self.source.nodes[0].content + "\n\n响应丢失更新",
            source_sha256=publisher.sha256_text(self.source.nodes[0].content + "\n\n响应丢失更新"),
        )
        changed_source = dataclasses.replace(
            self.source,
            manifest_sha256="d" * 64,
            nodes=[changed_node, *self.source.nodes[1:]],
        )
        gateway.lose_put_response_for.add(changed_node.source_id)

        with self.assertRaisesRegex(publisher.TutorialError, "节点响应丢失"):
            publisher.apply_plan(
                gateway,
                "store-a",
                changed_source,
                publisher.build_plan(changed_source, gateway.snapshot("store-a", changed_source.publisher)),
            )

        self.assertEqual(before[changed_node.source_id]["content"], gateway.nodes[changed_node.source_id]["content"])
        self.assertEqual(
            before[changed_node.source_id]["contentSha256"],
            gateway.nodes[changed_node.source_id]["contentSha256"],
        )

    def test_updated_children_are_restored_before_new_parent_is_deleted(self):
        gateway = MemoryGateway()
        publisher.apply_plan(
            gateway,
            "store-a",
            self.source,
            publisher.build_plan(self.source, gateway.snapshot("store-a", self.source.publisher)),
        )
        new_parent = dataclasses.replace(
            self.source.nodes[0],
            source_id="rollback-parent",
            kind="folder",
            title="回滚父目录",
            source_path="rollback-parent",
            content="",
            source_sha256=publisher.sha256_text(""),
            parent_source_id=None,
        )
        reparented = dataclasses.replace(self.source.nodes[0], parent_source_id=new_parent.source_id)
        changed_source = dataclasses.replace(
            self.source,
            manifest_sha256="c" * 64,
            nodes=[new_parent, reparented, *self.source.nodes[1:]],
        )
        gateway.fail_after = gateway.put_count + 2

        with self.assertRaisesRegex(publisher.TutorialError, "中途失败"):
            publisher.apply_plan(
                gateway,
                "store-a",
                changed_source,
                publisher.build_plan(changed_source, gateway.snapshot("store-a", changed_source.publisher)),
            )

        self.assertNotIn(new_parent.source_id, gateway.nodes)
        self.assertIsNone(gateway.nodes[reparented.source_id]["parentId"])

    def test_primary_write_is_reconciled_after_committed_response_loss(self):
        gateway = MemoryGateway()
        gateway.lose_primary_response_after_commit = True

        applied = publisher.apply_plan(
            gateway,
            "store-a",
            self.source,
            publisher.build_plan(self.source, gateway.snapshot("store-a", self.source.publisher)),
        )

        self.assertEqual("reconciled", applied["primary"]["action"])
        self.assertEqual(gateway.nodes[self.source.primary_source_id]["id"], gateway.primary_entry_id)

    def test_primary_write_retries_after_transient_precommit_failure(self):
        gateway = MemoryGateway()
        gateway.fail_primary_before_commit = True

        applied = publisher.apply_plan(
            gateway,
            "store-a",
            self.source,
            publisher.build_plan(self.source, gateway.snapshot("store-a", self.source.publisher)),
        )

        self.assertEqual("reconciled", applied["primary"]["action"])
        self.assertEqual(2, applied["primary"]["attempts"])
        self.assertEqual(gateway.nodes[self.source.primary_source_id]["id"], gateway.primary_entry_id)

    def test_graph_only_revision_comes_from_remote_content(self):
        gateway = MemoryGateway()
        plan = publisher.build_plan(self.source, gateway.snapshot("store-a", self.source.publisher))
        publisher.apply_plan(gateway, "store-a", self.source, plan)
        snapshot = gateway.snapshot("store-a", self.source.publisher)
        self.assertEqual(publisher._source_revision(), publisher._snapshot_source_revision(snapshot, self.source))

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

    def test_cross_chapter_references_are_clickable_and_protected_regions_are_unchanged(self):
        titles = {
            int(node.source_id.removeprefix("chapter-")): node.title
            for node in self.source.nodes
            if node.source_id.startswith("chapter-")
        }
        for number, node in titles.items():
            chapter = next(item for item in self.source.nodes if item.source_id == f"chapter-{number:02d}")
            self.assertEqual(
                chapter.content,
                publisher.link_chapter_references(chapter.content, number, titles),
                chapter.source_path,
            )

        sample = "第 20 章；`第 21 章`；[[第 22 章：看懂用量、预算和费用]]\n```text\n第 23 章\n```"
        linked = publisher.link_chapter_references(sample, 19, titles)
        self.assertIn("[[第 20 章：配置 PromptPolicy|第 20 章]]", linked)
        self.assertIn("`第 21 章`", linked)
        self.assertIn("[[第 22 章：看懂用量、预算和费用]]", linked)
        self.assertIn("```text\n第 23 章\n```", linked)


if __name__ == "__main__":
    unittest.main()
