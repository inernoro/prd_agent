#!/usr/bin/env python3
"""Behavior checks for retained release bundles; never contacts GitHub or Pages."""
import hashlib
import http.client
from datetime import datetime
from email.message import Message
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import unittest
from unittest import mock
import urllib.error
import zipfile


SCRIPT = Path(__file__).resolve().parents[1] / "lib" / "release-artifacts.py"
SPEC = importlib.util.spec_from_file_location("release_artifacts", SCRIPT)
artifacts = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(artifacts)
REPO = "example/map"
COMMIT_A = "a" * 40
COMMIT_B = "b" * 40
REF_A = "sha-" + COMMIT_A
REF_B = "sha-" + COMMIT_B
REAL_RUN = subprocess.run
ROOT = SCRIPT.parents[2]


class PublicHttpResponse(io.BytesIO):
    """A real-shaped urllib response: status and case-insensitive safe headers."""
    def __init__(self, body, status=200, headers=None):
        super().__init__(body)
        self.status = status
        self.headers = Message()
        for key, value in (headers or {}).items():
            self.headers[key] = value

    def getcode(self):
        return self.status

# Frozen from f29d1c0da65acafdd3e150fdcb14d4c086296ab4:exec_dep.sh,
# lines 1079-1107 and the original DIST_SHA256 expression. This deliberately
# executes the historical consumer, rather than calling today's fetch twice.
LEGACY_CONSUMER = r'''
    if [ -n "${DIST_URL:-}" ]; then
      asset_url="$DIST_URL"
      sha_url="${DIST_SHA256_URL:-}"
    else
      pages_base="${PAGES_BASE_URL:-https://get.miduo.org/https://${OWNER}.github.io/${REPO_NAME}}"
      asset_url="${pages_base%/}/prd-admin-dist-${TAG}.zip"
      sha_url="${pages_base%/}/prd-admin-dist-${TAG}.zip.sha256"
      manifest_url="${pages_base%/}/release-manifest-${TAG}.json"
    fi

    if [ -z "$asset_url" ]; then
      echo "ERROR: 未能确定静态站压缩包下载地址。" >&2
      echo "  - 默认从 GitHub Pages 下载 prd-admin-dist-${TAG}.zip（可用 PAGES_BASE_URL 覆盖）" >&2
      echo "  - 或直接设置 DIST_URL=... 指定 zip 地址" >&2
      exit 1
    fi

    if [ -n "$manifest_url" ]; then
      manifest_path="$tmp_dir/release-manifest.json"
      if curl -fL "$manifest_url" -o "$manifest_path" 2>/dev/null; then
        echo "Release manifest: $manifest_url"
        grep -E '"commit"|"ref"|"apiImage"|"llmgwImage"|"llmgwServeImage"|"llmgwWebImage"|"webDist"|"webSha256"' "$manifest_path" || true
      fi
    fi

    zip_path="$tmp_dir/prd-admin-dist.zip"
    release_failure_stage="static-download"
    echo "Downloading: $asset_url"
    curl -fL "$asset_url" -o "$zip_path"
    expected="$(printf '%s' "${DIST_SHA256:-}" | tr 'A-F' 'a-f' | xargs || true)"
'''


class ReleaseArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.audit_path = self.root / "public-download-diagnostics.jsonl"
        # A forgotten mock must fail instead of using a developer's credentials.
        self.network = mock.patch.object(artifacts.urllib.request, "urlopen", side_effect=AssertionError("Unexpected network"))
        self.process = mock.patch.object(artifacts.subprocess, "run", side_effect=AssertionError("Unexpected process"))
        self.network.start()
        self.process.start()
        self.addCleanup(self.network.stop)
        self.addCleanup(self.process.stop)
        configuration = mock.patch.dict(os.environ, {"PRD_AGENT_RELEASE_DOWNLOAD_PREFIX": "",
            "PRD_AGENT_RELEASE_DOWNLOAD_TRANSPORT": "browser",
            "PRD_AGENT_ARTIFACT_DIAGNOSTICS": str(self.audit_path),
            "PRD_AGENT_ARTIFACT_AUDIT_PATH": str(self.audit_path)})
        configuration.start()
        self.addCleanup(configuration.stop)
        sleeping = mock.patch.object(artifacts.time, "sleep")
        self.sleeping = sleeping.start()
        self.addCleanup(sleeping.stop)
        diagnostics_output = mock.patch.object(artifacts.sys, "stderr", io.StringIO())
        self.diagnostics_output = diagnostics_output.start()
        self.addCleanup(diagnostics_output.stop)

    def make_bundle(self, label="original", commit=COMMIT_A, ref=None, payload=b"original application"):
        ref = ref or "sha-" + commit
        dist = self.root / (label + "-dist")
        output = self.root / label
        (dist / "assets").mkdir(parents=True)
        (dist / "index.html").write_text(
            f'<script type="module" src="/assets/index-{commit}.js"></script>'
            f'<link href="/assets/index-{commit}.css" rel="stylesheet">', encoding="utf-8")
        (dist / "assets" / f"index-{commit}.js").write_bytes(payload)
        (dist / "assets" / f"index-{commit}.css").write_text("body { color: black; }")
        artifacts.bundle(dist, output, REPO, commit, ref)
        return output

    def audit_records(self, event=None, phase=None):
        records = [json.loads(line) for line in self.audit_path.read_text().splitlines()]
        return [record for record in records if (event is None or record.get("event") == event)
                and (phase is None or record.get("phase") == phase)]

    def assert_attempt_audit(self, record, status, received=True):
        self.assertEqual(record["schemaVersion"], 1)
        self.assertEqual(record["event"], "public_artifact_get")
        self.assertEqual(record["phase"], "finish")
        self.assertTrue(record["traceId"])
        self.assertTrue(record["callId"])
        self.assertIsInstance(record["attempt"], int)
        self.assertEqual(record["request"]["method"], "GET")
        self.assertTrue(record["request"]["endpoint"].startswith("https://"))
        self.assertEqual(record["response"]["received"], received)
        self.assertEqual(record["response"]["httpStatus"], status)
        self.assertTrue(record["response"]["bodyOmitted"])
        self.assertTrue(record["response"]["omissionReason"])
        if record["response"]["truncated"] is None:
            self.assertEqual(record["response"]["truncationReason"], "bounded_error_prefix_at_limit_total_size_unknown")
            self.assertIsNone(record["response"]["declaredBodyBytes"])
            self.assertIs(record["response"]["bodyReadComplete"], False)
            self.assertEqual(record["response"]["bodyObservedBytes"], 4096)
            self.assertEqual(record["configuration"]["snapshotLimit"], 4096)
        else:
            self.assertIsInstance(record["response"]["truncated"], bool)
        started = datetime.fromisoformat(record["timing"]["startedAt"].replace("Z", "+00:00"))
        finished = datetime.fromisoformat(record["timing"]["finishedAt"].replace("Z", "+00:00"))
        self.assertIsNotNone(started.tzinfo)
        self.assertIsNotNone(finished.tzinfo)
        self.assertLessEqual(started, finished)
        self.assertGreaterEqual(record["timing"]["durationMs"], 0)
        self.assertTrue(record["configuration"]["timeoutSeconds"] > 0)
        self.assertTrue(record["configuration"]["byteLimit"] > 0)
        self.assertTrue(record["configuration"]["snapshotLimit"] > 0)

    def manifest(self, directory, ref=REF_A):
        return directory / artifacts.names(ref)[2]

    def update_manifest(self, directory, bundle_ref=REF_A, **updates):
        path = self.manifest(directory, bundle_ref)
        data = json.loads(path.read_text())
        data.update(updates)
        path.write_text(json.dumps(data))

    def resign_zip(self, directory, ref=REF_A):
        archive, checksum, _ = [directory / name for name in artifacts.names(ref)]
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        checksum.write_text(f"{digest}  {archive.name}\n")
        self.update_manifest(directory, ref, webSha256=digest)

    def rewrite_zip(self, directory, transform):
        path = directory / artifacts.names(REF_A)[0]
        with zipfile.ZipFile(path) as archive:
            members = {name: archive.read(name) for name in archive.namelist()}
        transform(members)
        with zipfile.ZipFile(path, "w") as archive:
            for name, content in members.items():
                archive.writestr(name, content)
        self.resign_zip(directory)

    def published(self, ref=REF_A, draft=False, asset_names=None):
        return {"id": 701, "tag_name": "web-" + ref, "target_commitish": ref[4:] if ref.startswith("sha-") else COMMIT_A,
                "draft": draft, "assets": [{"id": 800 + index, "name": name, "state": "uploaded"} for index, name in enumerate(
                    artifacts.names(ref) if asset_names is None else asset_names)]}

    def public_reader(self, bundles):
        payloads = {url: (directory / name).read_bytes()
                    for ref, directory in bundles.items()
                    for name, url in zip(artifacts.names(ref), artifacts.urls(REPO, ref))}

        def read(url):
            self.assertIn(url, payloads, "Fetch must use the fixed release address, never Pages/latest")
            return payloads[url]
        return read

    def test_bundle_is_real_deterministic_zip_with_commit_bound_entry_and_hashes(self):
        first = self.make_bundle()
        second = self.make_bundle("repeat")
        result = artifacts.validate(first, REF_A, COMMIT_A)
        self.assertEqual(result["commit"], COMMIT_A)
        self.assertEqual(result["zipSha256"], hashlib.sha256((first / artifacts.names(REF_A)[0]).read_bytes()).hexdigest())
        self.assertEqual(result["files"], artifacts.validate(second, REF_A)["files"])
        with zipfile.ZipFile(first / artifacts.names(REF_A)[0]) as archive:
            self.assertEqual(archive.read(f"assets/index-{COMMIT_A}.js"), b"original application")
        manifest = json.loads(self.manifest(first).read_text())
        self.assertEqual(manifest["apiImage"], f"ghcr.io/{REPO}/prdagent-server:{REF_A}")

    def test_bundle_refuses_symlink_input(self):
        directory = self.make_bundle()
        dist = self.root / "original-dist"
        (dist / "outside.js").symlink_to(directory / artifacts.names(REF_A)[0])
        with self.assertRaises(artifacts.ArtifactError):
            artifacts.bundle(dist, self.root / "unsafe", REPO, COMMIT_A, REF_A)

    def test_validate_rejects_missing_or_empty_member_of_trio(self):
        for index in range(3):
            for empty in (False, True):
                with self.subTest(index=index, empty=empty):
                    directory = self.make_bundle(f"missing-{index}-{empty}")
                    path = directory / artifacts.names(REF_A)[index]
                    path.write_bytes(b"") if empty else path.unlink()
                    with self.assertRaises(artifacts.ArtifactError):
                        artifacts.validate(directory, REF_A)

    def test_validate_rejects_wrong_manifest_commit_ref_and_filename(self):
        for field, wrong in (("commit", COMMIT_B), ("ref", REF_B), ("webDist", "other.zip")):
            with self.subTest(field=field):
                directory = self.make_bundle(field)
                self.update_manifest(directory, **{field: wrong})
                with self.assertRaises(artifacts.ArtifactError):
                    artifacts.validate(directory, REF_A)
        with self.assertRaises(artifacts.ArtifactError):
            artifacts.validate(self.make_bundle("expected-commit"), REF_A, COMMIT_B)

    def test_validate_rejects_malformed_manifest_and_non_object_json(self):
        for index, value in enumerate(("{", "[]", "null", '"manifest"')):
            with self.subTest(value=value):
                directory = self.make_bundle(f"invalid-json-{index}")
                self.manifest(directory).write_text(value)
                with self.assertRaises(artifacts.ArtifactError):
                    artifacts.validate(directory, REF_A)

    def test_validate_detects_each_hash_disagreement(self):
        for changed in ("zip", "checksum", "manifest"):
            with self.subTest(changed=changed):
                directory = self.make_bundle(changed)
                archive, checksum, _ = [directory / name for name in artifacts.names(REF_A)]
                if changed == "zip":
                    with archive.open("ab") as output:
                        output.write(b"tampered")
                elif changed == "checksum":
                    checksum.write_text("0" * 64 + "  " + archive.name)
                else:
                    self.update_manifest(directory, webSha256="0" * 64)
                with self.assertRaises(artifacts.ArtifactError):
                    artifacts.validate(directory, REF_A)

    def test_validate_rejects_bad_zip_even_with_matching_hashes(self):
        directory = self.make_bundle()
        (directory / artifacts.names(REF_A)[0]).write_bytes(b"not a ZIP")
        self.resign_zip(directory)
        with self.assertRaises(artifacts.ArtifactError):
            artifacts.validate(directory, REF_A)

    def test_validate_rejects_unbound_missing_or_empty_entry_resources(self):
        cases = {
            "different-build": lambda files: files.update({"index.html": f'<script src="/assets/index-{COMMIT_B}.js"></script>'.encode(), f"assets/index-{COMMIT_B}.js": b"other"}),
            "missing-script": lambda files: files.pop(f"assets/index-{COMMIT_A}.js"),
            "empty-script": lambda files: files.update({f"assets/index-{COMMIT_A}.js": b""}),
            "mixed-css": lambda files: files.update({"index.html": (f'<script src="/assets/index-{COMMIT_A}.js"></script><link href="/assets/index-{COMMIT_B}.css">').encode(), f"assets/index-{COMMIT_B}.css": b"other"}),
        }
        for label, transform in cases.items():
            with self.subTest(case=label):
                directory = self.make_bundle(label)
                self.rewrite_zip(directory, transform)
                with self.assertRaises(artifacts.ArtifactError):
                    artifacts.validate(directory, REF_A)

    def test_validate_rejects_absolute_and_parent_traversal_members(self):
        for index, name in enumerate(("../escaped.txt", "/absolute.txt", "assets/../../escaped.txt")):
            with self.subTest(member=name):
                directory = self.make_bundle(f"unsafe-{index}")
                self.rewrite_zip(directory, lambda files: files.update({name: b"unsafe"}))
                with self.assertRaises(artifacts.ArtifactError):
                    artifacts.validate(directory, REF_A)
                self.assertFalse((self.root / "escaped.txt").exists())

    def test_fixed_urls_keep_a_fetchable_after_b_and_restore_uses_same_bytes(self):
        a = self.make_bundle()
        b = self.make_bundle("new-release", COMMIT_B)
        self.assertTrue(set(artifacts.urls(REPO, REF_A)).isdisjoint(artifacts.urls(REPO, REF_B)))
        with mock.patch.object(artifacts, "read_url", side_effect=self.public_reader({REF_A: a, REF_B: b})) as reader:
            artifacts.fetch(REPO, REF_B, self.root / "fetch-b", commit=COMMIT_B)
            with mock.patch.object(artifacts, "release", return_value=self.published()):
                result = artifacts.restore(REPO, REF_A, self.root / "rollback", COMMIT_A)
        self.assertTrue(result["exists"])
        self.assertEqual(result["zipSha256"], artifacts.validate(a, REF_A)["zipSha256"])
        self.assertEqual(reader.call_count, 6)
        for name in artifacts.names(REF_A):
            self.assertEqual((a / name).read_bytes(), (self.root / "rollback" / name).read_bytes())

    def test_failed_fetch_preserves_existing_valid_local_bundle(self):
        original = self.make_bundle()
        before = {name: (original / name).read_bytes() for name in artifacts.names(REF_A)}
        for failure in ("missing", "wrong-hash", "wrong-commit"):
            with self.subTest(failure=failure):
                remote = self.make_bundle("remote-" + failure, payload=b"different build")
                if failure == "wrong-hash":
                    self.update_manifest(remote, webSha256="0" * 64)
                elif failure == "wrong-commit":
                    self.update_manifest(remote, commit=COMMIT_B)
                read = self.public_reader({REF_A: remote})

                def download(url):
                    if failure == "missing" and url.endswith(".json"):
                        raise artifacts.ArtifactError("Manifest unavailable")
                    return read(url)
                with mock.patch.object(artifacts, "read_url", side_effect=download):
                    with self.assertRaises(artifacts.ArtifactError):
                        artifacts.fetch(REPO, REF_A, original, commit=COMMIT_A)
                self.assertEqual(before, {name: (original / name).read_bytes() for name in artifacts.names(REF_A)})

    def test_restore_absent_returns_without_network(self):
        with mock.patch.object(artifacts, "release", return_value=None), mock.patch.object(artifacts, "read_url") as read:
            self.assertEqual(artifacts.restore(REPO, REF_A, self.root / "absent"), {"exists": False})
        read.assert_not_called()

    def test_restore_rejects_draft_or_incomplete_release_before_fetch(self):
        for record in (self.published(draft=True, asset_names=[]), self.published(draft=True), self.published(asset_names=artifacts.names(REF_A)[:2])):
            with self.subTest(record=record), mock.patch.object(artifacts, "release", return_value=record), mock.patch.object(artifacts, "read_url") as read:
                with self.assertRaises(artifacts.ArtifactError):
                    artifacts.restore(REPO, REF_A, self.root / "restore")
                read.assert_not_called()

    def test_publish_reuses_canonical_same_sha_even_when_rebuild_differs(self):
        original = self.make_bundle()
        rebuilt = self.make_bundle("rebuilt", payload=b"same source rebuilt with different bytes")
        original_hash = artifacts.validate(original, REF_A)["zipSha256"]
        self.assertNotEqual(original_hash, artifacts.validate(rebuilt, REF_A)["zipSha256"])
        with mock.patch.object(artifacts, "release", return_value=self.published()), mock.patch.object(artifacts, "gh") as gh, mock.patch.object(artifacts, "read_url", side_effect=self.public_reader({REF_A: original})):
            result = artifacts.publish(REPO, REF_A, rebuilt)
        self.assertTrue(result["reused"])
        self.assertEqual(result["zipSha256"], original_hash)
        gh.assert_not_called()

    def test_publish_rejects_existing_draft_without_upload_or_edit(self):
        directory = self.make_bundle()
        for asset_names in ([], artifacts.names(REF_A)[:1], artifacts.names(REF_A)):
            with self.subTest(asset_names=asset_names), mock.patch.object(artifacts, "release", return_value=self.published(draft=True, asset_names=asset_names)), mock.patch.object(artifacts, "gh") as gh:
                with self.assertRaises(artifacts.ArtifactError):
                    artifacts.publish(REPO, REF_A, directory)
                gh.assert_not_called()

    def test_publish_create_race_reuses_complete_winner_without_upload(self):
        original = self.make_bundle()
        rebuilt = self.make_bundle("loser", payload=b"loser's different rebuilt bytes")
        with mock.patch.object(artifacts, "release", side_effect=[None, self.published(), self.published()]), mock.patch.object(artifacts, "gh", side_effect=artifacts.ArtifactError("Create race")) as gh, mock.patch.object(artifacts, "read_url", side_effect=self.public_reader({REF_A: original})):
            result = artifacts.publish(REPO, REF_A, rebuilt)
        self.assertTrue(result["reused"])
        self.assertEqual(result["zipSha256"], artifacts.validate(original, REF_A)["zipSha256"])
        self.assertEqual(gh.call_count, 1)
        self.assertEqual(gh.call_args.args[:2], ("api", f"repos/{REPO}/releases"))

    def test_publish_create_race_rejects_draft_or_incomplete_winner(self):
        directory = self.make_bundle()
        for winner in (None, self.published(draft=True), self.published(asset_names=[])):
            with self.subTest(winner=winner), mock.patch.object(artifacts, "release", side_effect=[None, winner, winner]), mock.patch.object(artifacts, "gh", side_effect=artifacts.ArtifactError("Create race")) as gh:
                with self.assertRaises(artifacts.ArtifactError):
                    artifacts.publish(REPO, REF_A, directory)
                self.assertEqual(gh.call_count, 1)

    def publishing_gh(self, remote, calls, existing=None):
        assets = {asset["id"]: asset["name"] for asset in (existing or {}).get("assets", [])}

        def run(*args, **kwargs):
            calls.append(args)
            self.assertEqual(args[0], "api", "Draft operations must use IDs, not tag-based gh release commands")
            endpoint = args[1]
            if endpoint == f"repos/{REPO}/releases":
                return json.dumps(self.published(draft=True, asset_names=[])).encode()
            upload_prefix = f"https://uploads.github.com/repos/{REPO}/releases/701/assets?name="
            if endpoint.startswith(upload_prefix):
                name = endpoint.removeprefix(upload_prefix)
                self.assertIn(name, artifacts.names(REF_A))
                self.assertEqual(args[args.index("--method") + 1], "POST")
                self.assertIn("Content-Type: application/octet-stream", args)
                self.assertEqual(Path(args[args.index("--input") + 1]).name, name)
                asset_id = 900 + len(assets)
                assets[asset_id] = name
                return json.dumps({"id": asset_id, "name": name}).encode()
            read_prefix = f"repos/{REPO}/releases/assets/"
            if endpoint.startswith(read_prefix):
                self.assertIn("Accept: application/octet-stream", args)
                name = assets[int(endpoint.removeprefix(read_prefix))]
                path = remote / name
                return path.read_bytes() if path.exists() else b""
            self.assertEqual(endpoint, f"repos/{REPO}/releases/701")
            self.assertEqual(args[args.index("--method") + 1], "PATCH")
            self.assertIn("draft=false", args)
            self.assertIn("make_latest=false", args)
            return b"{}"
        return run

    def test_publish_stages_complete_bundle_verifies_remote_and_never_changes_latest(self):
        directory = self.make_bundle()
        calls = []
        with mock.patch.object(artifacts, "release", return_value=None), mock.patch.object(artifacts, "gh", side_effect=self.publishing_gh(directory, calls)), mock.patch.object(artifacts, "read_url", side_effect=self.public_reader({REF_A: directory})):
            result = artifacts.publish(REPO, REF_A, directory)
        self.assertFalse(result["reused"])
        self.assertEqual(calls[0][:2], ("api", f"repos/{REPO}/releases"))
        self.assertIn("make_latest=false", calls[0])
        self.assertIn("draft=true", calls[0])
        self.assertEqual(len(calls), 8)  # create, three upload/read pairs, publish
        self.assertEqual([call[1].rsplit("?name=", 1)[-1] for call in calls[1:-1:2]], artifacts.names(REF_A))
        self.assertIn("make_latest=false", calls[-1])
        self.assertIn("draft=false", calls[-1])
        self.assertEqual(calls[-1][:4], ("api", f"repos/{REPO}/releases/701", "--method", "PATCH"))
        self.assertFalse(any("--clobber" in call for call in calls))
        self.assertFalse(any("/releases/tags/" in call[1] for call in calls))

    def test_publish_validates_every_local_file_before_any_github_operation(self):
        for label in ("missing-manifest", "bad-hash", "bad-entry"):
            with self.subTest(case=label):
                directory = self.make_bundle(label)
                if label == "missing-manifest":
                    self.manifest(directory).unlink()
                elif label == "bad-hash":
                    self.update_manifest(directory, webSha256="0" * 64)
                else:
                    self.rewrite_zip(directory, lambda files: files.update({"index.html": b"invalid entry"}))
                with mock.patch.object(artifacts, "gh") as gh, mock.patch.object(artifacts, "release") as release:
                    with self.assertRaises(artifacts.ArtifactError):
                        artifacts.publish(REPO, REF_A, directory)
                    gh.assert_not_called()
                    release.assert_not_called()

    def test_publish_never_publishes_remote_draft_with_missing_or_different_bytes(self):
        local = self.make_bundle()
        different = self.make_bundle("different-draft", payload=b"other bundle")
        incomplete = self.make_bundle("incomplete-draft")
        self.manifest(incomplete).unlink()
        for remote in (different, incomplete):
            with self.subTest(remote=remote.name):
                calls = []
                with mock.patch.object(artifacts, "release", return_value=None), mock.patch.object(artifacts, "gh", side_effect=self.publishing_gh(remote, calls)), mock.patch.object(artifacts, "read_url") as read:
                    with self.assertRaises(artifacts.ArtifactError):
                        artifacts.publish(REPO, REF_A, local)
                self.assertFalse(any("PATCH" in call for call in calls))
                read.assert_not_called()

    def test_release_finds_tagless_draft_on_later_paginated_page(self):
        draft = self.published(draft=True, asset_names=[])
        other = self.published(REF_B, draft=True)
        with mock.patch.object(artifacts, "gh", side_effect=[None, json.dumps([other] * 100).encode(), json.dumps([draft]).encode()]) as gh:
            self.assertEqual(artifacts.release(REPO, REF_A), draft)
        self.assertEqual(gh.call_args_list, [
            mock.call("api", f"repos/{REPO}/releases/tags/web-{REF_A}", missing_ok=True),
            mock.call("api", f"repos/{REPO}/releases?per_page=100&page=1"),
            mock.call("api", f"repos/{REPO}/releases?per_page=100&page=2")])

    def test_release_does_not_list_when_tag_endpoint_finds_published_release(self):
        existing = self.published()
        with mock.patch.object(artifacts, "gh", return_value=json.dumps(existing).encode()) as gh:
            self.assertEqual(artifacts.release(REPO, REF_A), existing)
        self.assertEqual(gh.call_count, 1)

    def test_release_pagination_absence_and_duplicate_ref_fail_closed(self):
        for records, duplicate in (([[self.published(REF_B)]], False),
                                   ([[self.published(draft=True)] + [self.published(REF_B)] * 99, [self.published(draft=True)]], True)):
            with self.subTest(duplicate=duplicate), mock.patch.object(artifacts, "gh", side_effect=[None, *[json.dumps(page).encode() for page in records]]) as gh:
                if duplicate:
                    with self.assertRaises(artifacts.ArtifactError):
                        artifacts.release(REPO, REF_A)
                else:
                    self.assertIsNone(artifacts.release(REPO, REF_A))
                self.assertEqual(gh.call_count, 1 + len(records))

    def test_explicit_resume_verifies_all_original_assets_before_uploading_only_missing(self):
        directory = self.make_bundle()
        digest = artifacts.validate(directory, REF_A)["zipSha256"]
        for count in (0, 1, 3):
            with self.subTest(existing_assets=count):
                existing = self.published(draft=True, asset_names=artifacts.names(REF_A)[:count])
                calls = []
                with mock.patch.object(artifacts, "release", return_value=existing), mock.patch.object(artifacts, "gh", side_effect=self.publishing_gh(directory, calls, existing)), mock.patch.object(artifacts, "read_url", side_effect=self.public_reader({REF_A: directory})):
                    result = artifacts.publish(REPO, REF_A, directory, resume_id=701, original_sha256=digest)
                self.assertFalse(result["reused"])
                self.assertEqual(result["zipSha256"], digest)
                self.assertEqual([call[1] for call in calls[:count]], [f"repos/{REPO}/releases/assets/{800 + index}" for index in range(count)])
                uploads = [call[1].rsplit("?name=", 1)[1] for call in calls if call[1].startswith("https://uploads.github.com/")]
                self.assertEqual(uploads, artifacts.names(REF_A)[count:])
                self.assertEqual(calls[-1][:4], ("api", f"repos/{REPO}/releases/701", "--method", "PATCH"))
                self.assertFalse(any(call[1] == f"repos/{REPO}/releases" for call in calls))
                self.assertFalse(any("--clobber" in call for call in calls))

    def test_resume_requires_matching_id_original_hash_and_target_before_remote_mutation(self):
        directory = self.make_bundle()
        digest = artifacts.validate(directory, REF_A)["zipSha256"]
        wrong_target = self.published(draft=True, asset_names=[])
        wrong_target["target_commitish"] = COMMIT_B
        cases = ((self.published(draft=True, asset_names=[]), 702, digest),
                 (self.published(draft=True, asset_names=[]), 701, None),
                 (self.published(draft=True, asset_names=[]), None, digest),
                 (self.published(draft=True, asset_names=[]), 701, "0" * 64),
                 (wrong_target, 701, digest), (None, 701, digest),
                 (None, 701, None), (None, None, digest))
        for existing, resume_id, original_hash in cases:
            with self.subTest(existing=existing, resume_id=resume_id, original_hash=original_hash), mock.patch.object(artifacts, "release", return_value=existing), mock.patch.object(artifacts, "gh") as gh, mock.patch.object(artifacts, "read_url") as read:
                with self.assertRaises(artifacts.ArtifactError):
                    artifacts.publish(REPO, REF_A, directory, resume_id=resume_id, original_sha256=original_hash)
                gh.assert_not_called()
                read.assert_not_called()

    def test_resume_rejects_conflicting_or_unrelated_existing_assets_before_any_upload(self):
        original = self.make_bundle()
        changed = self.make_bundle("conflicting-remote", payload=b"different bytes must never overwrite original")
        digest = artifacts.validate(original, REF_A)["zipSha256"]
        for unrelated in (False, True):
            with self.subTest(unrelated=unrelated):
                existing = self.published(draft=True, asset_names=["unrelated.zip"] if unrelated else artifacts.names(REF_A)[:1])
                calls = []
                with mock.patch.object(artifacts, "release", return_value=existing), mock.patch.object(artifacts, "gh", side_effect=self.publishing_gh(changed, calls, existing)), mock.patch.object(artifacts, "read_url") as read:
                    with self.assertRaises(artifacts.ArtifactError):
                        artifacts.publish(REPO, REF_A, original, resume_id=701, original_sha256=digest)
                self.assertTrue(all("/releases/assets/" in call[1] for call in calls))
                read.assert_not_called()

    def test_cli_recovery_arguments_are_publish_only(self):
        for command in ("fetch", "bundle", "restore", "pages", "alias", "validate"):
            with self.subTest(command=command), mock.patch.object(artifacts, command) as operation:
                status, _, _ = self.cli(command, "--ref", REF_A, "--directory", str(self.root),
                    "--resume-draft-id", "701", "--original-sha256", "0" * 64)
                self.assertEqual(status, 1)
                operation.assert_not_called()

    def pages_tar(self, directory, label="original-pages", omit=None, duplicate=None):
        path = self.root / (label + ".tar")
        with tarfile.open(path, "w") as archive:
            for name in artifacts.names(REF_A):
                if name == omit:
                    continue
                content = (directory / name).read_bytes()
                info = tarfile.TarInfo("./" + name)
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
                if name == duplicate:
                    # Both accepted spellings must count as a duplicate.
                    info = tarfile.TarInfo(name)
                    info.size = len(content)
                    archive.addfile(info, io.BytesIO(content))
            for name in ("index.html", "admin/index.html", "../unwanted.txt"):
                content = b"not one of the retained original three files"
                info = tarfile.TarInfo(name)
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
        return path

    def test_import_pages_retains_only_original_three_files_byte_for_byte(self):
        directory = self.make_bundle()
        original = {name: (directory / name).read_bytes() for name in artifacts.names(REF_A)}
        path = self.pages_tar(directory)
        output = self.root / "imported"
        digest = artifacts.validate(directory, REF_A)["zipSha256"]
        result = artifacts.import_pages(path, output, REF_A, COMMIT_A, digest)
        self.assertEqual(result["zipSha256"], digest)
        self.assertEqual({item.name: item.read_bytes() for item in output.iterdir()}, original)
        self.assertFalse((self.root / "unwanted.txt").exists())

    def test_import_pages_missing_duplicate_wrong_commit_or_audited_hash_leaves_no_partial(self):
        directory = self.make_bundle()
        digest = artifacts.validate(directory, REF_A)["zipSha256"]
        cases = [("missing-" + str(index), name, None, COMMIT_A, digest)
                 for index, name in enumerate(artifacts.names(REF_A))]
        cases += [("duplicate-" + str(index), None, name, COMMIT_A, digest)
                  for index, name in enumerate(artifacts.names(REF_A))]
        cases += [("wrong-commit", None, None, COMMIT_B, digest),
                  ("wrong-original-hash", None, None, COMMIT_A, "0" * 64),
                  ("missing-original-hash", None, None, COMMIT_A, None)]
        for label, omitted, duplicate, commit, original_hash in cases:
            with self.subTest(case=label):
                path = self.pages_tar(directory, label, omitted, duplicate)
                output = self.root / (label + "-output")
                with self.assertRaises(artifacts.ArtifactError):
                    artifacts.import_pages(path, output, REF_A, commit, original_hash)
                self.assertEqual(list(output.iterdir()) if output.exists() else [], [])

    def test_import_pages_failure_preserves_existing_output(self):
        directory = self.make_bundle()
        path = self.pages_tar(directory)
        output = self.root / "existing-import"
        output.mkdir()
        old = {name: ("previous " + name).encode() for name in artifacts.names(REF_A)}
        for name, content in old.items():
            (output / name).write_bytes(content)
        with self.assertRaises(artifacts.ArtifactError):
            artifacts.import_pages(path, output, REF_A, COMMIT_A, "0" * 64)
        self.assertEqual({item.name: item.read_bytes() for item in output.iterdir()}, old)

    def test_release_tag_alias_preserves_original_zip_and_requires_expected_commit(self):
        directory = self.make_bundle()
        original = artifacts.validate(directory, REF_A)
        tag = "release-20261108"
        aliased = artifacts.alias(directory, REF_A, tag)
        self.assertEqual(aliased["zipSha256"], original["zipSha256"])
        self.assertEqual(artifacts.validate(directory, tag, COMMIT_A)["commit"], COMMIT_A)
        with self.assertRaises(artifacts.ArtifactError):
            artifacts.validate(directory, tag, COMMIT_B)
        self.assertIn(f"/releases/download/web-{tag}/", artifacts.urls(REPO, tag)[0])
        for invalid in ("latest", "../bad", "sha-short", "sha-" + "A" * 40):
            with self.subTest(ref=invalid), self.assertRaises(artifacts.ArtifactError):
                artifacts.urls(REPO, invalid)

    def test_public_download_never_attaches_authorization_and_bounds_size(self):
        with mock.patch.object(artifacts.urllib.request, "urlopen", return_value=io.BytesIO(b"abc")) as opening:
            self.assertEqual(artifacts.read_url("https://github.com/example/map/asset", limit=3), b"abc")
        request = opening.call_args.args[0]
        self.assertNotIn("authorization", {key.lower() for key in request.headers})
        with mock.patch.object(artifacts.urllib.request, "urlopen", return_value=io.BytesIO(b"abcd")):
            with self.assertRaises(artifacts.ArtifactError):
                artifacts.read_url("https://github.com/example/map/asset", limit=3)
        with self.assertRaises(artifacts.ArtifactError):
            artifacts.read_url("http://github.com/example/map/asset")

    def test_configured_public_prefix_fetches_verified_bundle_without_tokens_and_explicit_base_wins(self):
        directory = self.make_bundle()
        canonical = artifacts.urls(REPO, REF_A)
        prefix = "https://get.miduo.org/"
        expected = [prefix + url for url in canonical]
        requests = []

        def download(request, **kwargs):
            requests.append(request)
            self.assertIn(request.full_url, expected)
            return io.BytesIO((directory / request.full_url.rsplit("/", 1)[1]).read_bytes())
        with mock.patch.dict(os.environ, {"PRD_AGENT_RELEASE_DOWNLOAD_PREFIX": prefix,
                "GH_TOKEN": "test-credential-must-never-be-forwarded", "GITHUB_TOKEN": "another-test-credential"}), mock.patch.object(artifacts.urllib.request, "urlopen", side_effect=download):
            self.assertEqual(artifacts.urls(REPO, REF_A), expected)
            explicit = "https://audited.invalid/fixed-bundle"
            self.assertEqual(artifacts.urls(REPO, REF_A, explicit), [explicit + "/" + name for name in artifacts.names(REF_A)])
            result = artifacts.fetch(REPO, REF_A, self.root / "prefixed-fetch", commit=COMMIT_A)
        self.assertEqual(result["urls"], expected)
        self.assertEqual(result["zipSha256"], artifacts.validate(directory, REF_A)["zipSha256"])
        self.assertEqual([request.full_url for request in requests], expected)
        for request in requests:
            self.assertNotIn("authorization", {name.lower() for name in request.headers})
            self.assertNotIn("credential", json.dumps(request.headers))

    def test_public_source_failure_records_safe_diagnostics_without_fallback_and_404_latest_stays_absent(self):
        directory = self.make_bundle()
        prefix = "https://get.miduo.org/"
        diagnostic = Path(os.environ["PRD_AGENT_ARTIFACT_DIAGNOSTICS"])
        secret_reason = "https://signed.invalid/file?token=must-not-appear"
        with mock.patch.dict(os.environ, {"PRD_AGENT_RELEASE_DOWNLOAD_PREFIX": prefix}), mock.patch.object(artifacts.urllib.request, "urlopen", side_effect=urllib.error.HTTPError("https://public.invalid", 503, secret_reason, {}, None)) as opening:
            with self.assertRaises(artifacts.ArtifactError) as caught:
                artifacts.fetch(REPO, REF_A, self.root / "unavailable-fetch")
        self.assertEqual(opening.call_count, 3)
        self.assertEqual([call.args[0].full_url for call in opening.call_args_list], [opening.call_args.args[0].full_url] * 3)
        self.assertEqual(self.sleeping.call_args_list, [mock.call(1), mock.call(2)])
        self.assertTrue(opening.call_args.args[0].full_url.startswith(prefix))
        self.assertNotIn(secret_reason, str(caught.exception))
        records = self.audit_records("public_artifact_get", "finish")
        self.assertEqual(len(records), 3)
        for record in records:
            self.assert_attempt_audit(record, 503)
        self.assertEqual([record["attempt"] for record in records], [1, 2, 3])
        self.assertEqual([record["decision"]["willRetrySameUrl"] for record in records], [True, True, False])
        self.assertEqual(records[0]["decision"]["errorType"], "HTTPError")
        self.assertNotIn("token=", diagnostic.read_text())
        self.assertEqual(list((self.root / "unavailable-fetch").iterdir()), [])
        with mock.patch.dict(os.environ, {"PUBLISH_LATEST": "false"}), mock.patch.object(artifacts.urllib.request, "urlopen", side_effect=urllib.error.HTTPError("https://pages.invalid/latest", 404, secret_reason, {}, None)) as opening:
            artifacts.pages(directory, REF_A, self.root / "empty-old-pages", REPO)
        self.assertEqual(opening.call_count, 3)
        self.assertFalse((self.root / "empty-old-pages/prd-admin-dist-latest.zip").exists())

    def test_public_github_api_maps_named_asset_ids_to_original_bytes_without_auth_or_browser_fallback(self):
        directory = self.make_bundle()
        metadata_url = f"https://api.github.com/repos/{REPO}/releases/tags/web-{REF_A}"
        asset_urls = [f"https://api.github.com/repos/{REPO}/releases/assets/{800 + index}" for index in range(3)]
        metadata = self.published()
        metadata["assets"].reverse()  # Name, rather than API list position, binds each file.
        payloads = {metadata_url: json.dumps(metadata).encode()}
        payloads.update({url: (directory / name).read_bytes() for url, name in zip(asset_urls, artifacts.names(REF_A))})
        requests = []

        def download(request, **kwargs):
            requests.append(request)
            return io.BytesIO(payloads[request.full_url])
        source = (ROOT / ".github/workflows/web-latest-pages.yml").read_text()
        workflow_env = source.split("\nenv:\n", 1)[1].split("\njobs:\n", 1)[0]
        self.assertRegex(workflow_env, r"(?m)^  PRD_AGENT_RELEASE_DOWNLOAD_TRANSPORT: github-api$")
        with mock.patch.dict(os.environ, {"PRD_AGENT_RELEASE_DOWNLOAD_TRANSPORT": "github-api",
                "GH_TOKEN": "test-token-never-forward", "GITHUB_TOKEN": "another-test-token"}), mock.patch.object(artifacts.urllib.request, "urlopen", side_effect=download):
            result = artifacts.fetch(REPO, REF_A, self.root / "api-fetched", commit=COMMIT_A)
        self.assertEqual([request.full_url for request in requests], [metadata_url, *asset_urls])
        self.assertEqual(requests[0].get_header("Accept"), "application/vnd.github+json")
        for request in requests:
            self.assertNotIn("authorization", {name.lower() for name in request.headers})
            self.assertNotIn("test-token", json.dumps(request.headers))
        self.assertTrue(all(request.get_header("Accept") == "application/octet-stream" for request in requests[1:]))
        self.assertEqual(result["transport"], "github-api")
        self.assertEqual(result["urls"], asset_urls)
        self.assertEqual(result["sourceIdentity"], {"metadataUrl": metadata_url, "releaseId": 701,
                         "assetIds": [800, 801, 802], "commit": COMMIT_A})
        for name in artifacts.names(REF_A):
            self.assertEqual((self.root / "api-fetched" / name).read_bytes(), (directory / name).read_bytes())
        # Explicitly audited URLs remain an intentional browser transport even
        # when the default job transport is the public asset-ID API.
        base = "https://audited.invalid/fixed"
        with mock.patch.dict(os.environ, {"PRD_AGENT_RELEASE_DOWNLOAD_TRANSPORT": "github-api"}), mock.patch.object(artifacts.urllib.request, "urlopen", side_effect=lambda request, **kwargs: io.BytesIO((directory / request.full_url.rsplit("/", 1)[1]).read_bytes())) as opening:
            result = artifacts.fetch(REPO, REF_A, self.root / "explicit-fetched", base=base, commit=COMMIT_A)
        self.assertEqual(result["transport"], "browser")
        self.assertEqual([call.args[0].full_url for call in opening.call_args_list], artifacts.urls(REPO, REF_A, base))

    def test_public_api_rejects_draft_incomplete_wrong_identity_and_invalid_ids_before_asset_reads(self):
        cases = {
            "draft": lambda value: value.update(draft=True),
            "wrong-ref": lambda value: value.update(tag_name="web-" + REF_B),
            "wrong-commit": lambda value: value.update(target_commitish=COMMIT_B),
            "mutable-commit": lambda value: value.update(target_commitish="main"),
            "invalid-release-id": lambda value: value.update(id=0),
            "boolean-release-id": lambda value: value.update(id=True),
            "missing-asset": lambda value: value["assets"].pop(),
            "duplicate-name": lambda value: value["assets"].append(dict(value["assets"][0])),
            "duplicate-id": lambda value: value["assets"][1].update(id=800),
            "string-id": lambda value: value["assets"][0].update(id="800"),
            "boolean-id": lambda value: value["assets"][0].update(id=True),
            "zero-id": lambda value: value["assets"][0].update(id=0),
            "unfinished-upload": lambda value: value["assets"][0].update(state="starter"),
        }
        for label, mutate in cases.items():
            with self.subTest(case=label):
                metadata = self.published()
                mutate(metadata)
                output = self.root / ("rejected-api-" + label)
                with mock.patch.dict(os.environ, {"PRD_AGENT_RELEASE_DOWNLOAD_TRANSPORT": "github-api"}), mock.patch.object(artifacts.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(metadata).encode())) as opening:
                    with self.assertRaises(artifacts.ArtifactError):
                        artifacts.fetch(REPO, REF_A, output, commit=COMMIT_A)
                self.assertEqual(opening.call_count, 1)
                self.assertIn("api.github.com/", opening.call_args.args[0].full_url)
                self.assertEqual(list(output.iterdir()), [])
        with mock.patch.dict(os.environ, {"PRD_AGENT_RELEASE_DOWNLOAD_TRANSPORT": "github-api"}), mock.patch.object(artifacts.urllib.request, "urlopen", side_effect=urllib.error.URLError("metadata unavailable")) as opening:
            with self.assertRaises(artifacts.ArtifactError):
                artifacts.fetch(REPO, REF_A, self.root / "api-unavailable")
        self.assertEqual(opening.call_count, 1, "API failure must not automatically switch to browser or proxy")

    def test_cli_local_staging_inputs_require_fetch_and_env_file_before_any_operation(self):
        for command, extra in (("fetch", []), ("validate", ["--env-file", str(self.root / "inputs.env")]),
                               ("publish", ["--env-file", str(self.root / "inputs.env")])):
            with self.subTest(command=command), mock.patch.object(artifacts, command) as operation:
                status, _, _ = self.cli(command, "--ref", REF_A, "--directory", str(self.root), "--local-inputs", *extra)
                self.assertEqual(status, 1)
                operation.assert_not_called()
                self.assertFalse((self.root / "inputs.env").exists())

    def test_audit_write_failure_is_visible_and_never_returns_success_or_retries_get(self):
        url = "https://api.github.com/repos/example/map/releases/assets/800"
        for phase in ("before-request", "after-response"):
            for failed_http in (False, True):
                with self.subTest(phase=phase, failed_http=failed_http):
                    self.sleeping.reset_mock()
                    self.diagnostics_output.seek(0)
                    self.diagnostics_output.truncate()
                    blocked = self.root / f"audit-failure-{phase}-{failed_http}"
                    if phase == "before-request":
                        blocked.mkdir()

                    def upstream(*args, **kwargs):
                        # The start record was durable. Lose the destination
                        # before finishing so this failure cannot be classified
                        # as a transient upstream 503 and cause another GET.
                        blocked.unlink()
                        blocked.mkdir()
                        if failed_http:
                            raise urllib.error.HTTPError(url, 503, "upstream failure", {}, io.BytesIO(b"must not be logged"))
                        return PublicHttpResponse(b"original bytes", headers={"Content-Type": "application/zip"})
                    with mock.patch.dict(os.environ, {"PRD_AGENT_ARTIFACT_AUDIT_PATH": str(blocked)}), mock.patch.object(artifacts.urllib.request, "urlopen", side_effect=upstream) as opening:
                        with self.assertRaisesRegex(artifacts.ArtifactError, "Audit persistence failed"):
                            artifacts.read_url(url)
                    self.assertEqual(opening.call_count, 0 if phase == "before-request" else 1)
                    self.sleeping.assert_not_called()
                    self.assertIn("audit", self.diagnostics_output.getvalue().lower())
                    self.assertNotIn("must not be logged", self.diagnostics_output.getvalue())
                    self.assertFalse(self.audit_path.exists(), "Audit failure must not silently switch to the legacy path")

    def test_successful_public_response_is_persisted_with_safe_headers_timing_and_body_omission(self):
        body = b"\x00original retained media bytes\xff" * 200
        response = PublicHttpResponse(body, headers={"Content-Type": "application/zip",
            "Content-Length": str(len(body)), "X-GitHub-Request-Id": "AB12:CD34:EF56:7890:ABCD:1234",
            "X-MS-Request-Id": "12345678-1234-4234-8234-123456789abc",
            "Location": "https://blob.invalid/download?signature=never-save-location",
            "Set-Cookie": "session=must-not-be-persisted", "Authorization": "Bearer never-save-this"})
        url = "https://username:private-password@api.github.com/repos/example/map/releases/assets/800?signature=never-save-query"
        def opening(*args, **kwargs):
            self.assertEqual(len(self.audit_records("public_artifact_get", "start")), 1)
            self.assertEqual(self.audit_records("public_artifact_get", "finish"), [])
            return response
        with mock.patch.dict(os.environ, {"PRD_AGENT_ARTIFACT_AUDIT_REQUEST_ID": "release-audit-test",
                "GITHUB_REPOSITORY": REPO}), mock.patch.object(artifacts.urllib.request, "urlopen", side_effect=opening):
            self.assertEqual(artifacts.read_url(url), body)
        records = self.audit_records("public_artifact_get", "finish")
        self.assertEqual(len(records), 1)
        record = records[0]
        self.assert_attempt_audit(record, 200)
        self.assertEqual(record["attempt"], 1)
        self.assertEqual(record["traceId"], "release-audit-test")
        self.assertEqual(record["request"]["endpoint"], "https://api.github.com/repos/example/map/releases/assets/800")
        self.assertEqual(record["response"]["contentType"], "application/zip")
        self.assertEqual(record["response"]["responseState"], "received")
        self.assertEqual(record["response"]["contentTypeState"], "valid")
        self.assertIn("AB12:CD34:EF56:7890:ABCD:1234", json.dumps(record["response"]["upstreamRequestId"]))
        self.assertEqual(record["response"]["upstreamRequestId"]["X-MS-Request-Id"],
                         {"state": "valid", "value": "12345678-1234-4234-8234-123456789abc"})
        self.assertEqual(record["response"]["bodyObservedBytes"], len(body))
        snapshot_limit = record["configuration"]["snapshotLimit"]
        self.assertEqual(record["response"]["prefixSha256"], hashlib.sha256(body[:snapshot_limit]).hexdigest())
        self.assertEqual(record["response"]["truncated"], len(body) > snapshot_limit)
        self.assertEqual(record["decision"]["outcome"], "success")
        self.assertTrue(record["configuration"]["buildFingerprint"])
        self.assertTrue(record["configuration"]["instance"])
        persisted = self.audit_path.read_text()
        for secret in ("private-password", "never-save-query", "never-save-location", "must-not-be-persisted", "never-save-this", "original retained media bytes"):
            self.assertNotIn(secret, persisted)
        # CDS may expose only a truncated stderr tail. The full record must be
        # independently retrievable from the audit file after the call returns.
        self.diagnostics_output.seek(0)
        self.diagnostics_output.truncate()
        self.assertEqual(self.audit_records("public_artifact_get", "finish"), records)

    def test_retry_success_and_no_response_have_distinct_persistent_attempts_and_safe_request_id_state(self):
        url = "https://api.github.com/repos/example/map/releases/assets/800"
        private_body = b'<html>password=private-response-value; https://signed.invalid/?signature=do-not-save</html>'
        invalid_request_id = "user@example.invalid?access_token=never-persist-header"
        failure = urllib.error.HTTPError(url, 502, "not safe to echo", {"Content-Type": "text/html",
            "X-GitHub-Request-Id": "BEEF:0123:4567:89AB:CDEF:0000"}, io.BytesIO(private_body))
        success = PublicHttpResponse(b"published bytes", headers={"Content-Type": "application/octet-stream",
            "X-Request-Id": invalid_request_id})
        with mock.patch.dict(os.environ, {"PRD_AGENT_ARTIFACT_AUDIT_REQUEST_ID": "one-release-request"}), mock.patch.object(artifacts.urllib.request, "urlopen", side_effect=[failure, success]):
            self.assertEqual(artifacts.read_url(url), b"published bytes")
        with mock.patch.dict(os.environ, {"PRD_AGENT_ARTIFACT_AUDIT_REQUEST_ID": "one-release-request"}), mock.patch.object(artifacts.urllib.request, "urlopen", side_effect=TimeoutError("network stage never returned headers")):
            with self.assertRaises(artifacts.ArtifactError):
                artifacts.read_url(url)
        records = self.audit_records("public_artifact_get", "finish")
        self.assertEqual(len(records), 3)
        for record, status, received in zip(records, (502, 200, None), (True, True, False)):
            self.assert_attempt_audit(record, status, received)
        self.assertEqual([record["attempt"] for record in records], [1, 2, 1])
        self.assertEqual(len({record["traceId"] for record in records}), 1)
        self.assertEqual(records[0]["callId"], records[1]["callId"])
        self.assertNotEqual(records[1]["callId"], records[2]["callId"])
        self.assertEqual(records[1]["decision"]["outcome"], "success")
        self.assertNotEqual(records[0]["decision"]["outcome"], "success")
        self.assertNotEqual(records[2]["decision"]["outcome"], "success")
        self.assertTrue(records[2]["decision"]["errorType"])
        self.assertEqual(records[0]["response"]["contentType"], "text/html")
        self.assertIn("BEEF:0123:4567:89AB:CDEF:0000", json.dumps(records[0]["response"]["upstreamRequestId"]))
        self.assertIn(hashlib.sha256(invalid_request_id.encode()).hexdigest(), json.dumps(records[1]["response"]))
        self.assertEqual(records[2]["response"]["bodyObservedBytes"], 0)
        self.assertEqual(records[2]["response"]["responseState"], "not_received")
        persisted = self.audit_path.read_text()
        for sensitive in (invalid_request_id, "private-response-value", "do-not-save", "not safe to echo", "network stage never returned headers"):
            self.assertNotIn(sensitive, persisted)
        partial = b"partial-private-media-must-not-be-logged" * 200
        errors = (TimeoutError("body-timeout-user-document-must-not-appear"),
                  http.client.IncompleteRead(partial, len(partial) + 100))
        for error in errors:
            with self.subTest(response_body_error=type(error).__name__):
                self.sleeping.reset_mock()
                response = PublicHttpResponse(b"", headers={"Content-Type": "application/octet-stream",
                    "Content-Length": str(len(partial) + 100), "X-GitHub-Request-Id": "FACE:0123:4567:89AB:CDEF:0000"})
                with mock.patch.object(response, "read", side_effect=error), mock.patch.object(artifacts.urllib.request, "urlopen", return_value=response) as opening:
                    with self.assertRaises(artifacts.ArtifactError):
                        artifacts.read_url(url)
                self.assertEqual(opening.call_count, 1)
                self.sleeping.assert_not_called()
                record = self.audit_records("public_artifact_get", "finish")[-1]
                self.assert_attempt_audit(record, 200, received=True)
                self.assertEqual(record["attempt"], 1)
                self.assertEqual(record["decision"]["outcome"], "error")
                self.assertEqual(record["decision"]["failureStage"], "response_body")
                self.assertEqual(record["decision"]["errorType"], type(error).__name__)
                self.assertFalse(record["decision"]["willRetrySameUrl"])
                self.assertEqual(record["response"]["contentType"], "application/octet-stream")
                self.assertEqual(record["response"]["upstreamRequestId"]["X-GitHub-Request-Id"],
                                 {"state": "valid", "value": "FACE:0123:4567:89AB:CDEF:0000"})
                captured = partial if isinstance(error, http.client.IncompleteRead) else None
                self.assertEqual(record["response"]["bodyObservedBytes"], len(captured) if captured is not None else 0)
                self.assertEqual(record["response"]["prefixSha256"], hashlib.sha256(captured[:4096]).hexdigest() if captured is not None else None)
                self.assertIsNone(record["response"]["fullBodySha256"])
                self.assertLessEqual(record["response"]["digestInputBytes"], 4096)
                persisted = self.audit_path.read_text()
                self.assertNotIn("partial-private-media-must-not-be-logged", persisted)
                self.assertNotIn("body-timeout-user-document-must-not-appear", persisted)

    def test_http_200_metadata_field_rejections_and_bundle_hash_rejection_are_persisted(self):
        cases = (("missing", None), ("null", None), ("empty", ""), ("whitespace", "  "),
                 ("type_error", ["not-a-commit"]), ("format_error", "bad-commit-private-value"), ("valid", COMMIT_A))
        for expected_state, value in cases:
            with self.subTest(field_state=expected_state):
                if self.audit_path.exists():
                    self.audit_path.unlink()
                metadata = self.published()
                if expected_state == "missing":
                    del metadata["target_commitish"]
                else:
                    metadata["target_commitish"] = value
                body = json.dumps(metadata).encode()
                with mock.patch.dict(os.environ, {"PRD_AGENT_ARTIFACT_AUDIT_REQUEST_ID": "metadata-predicate-test"}), mock.patch.object(artifacts.urllib.request, "urlopen",
                        return_value=PublicHttpResponse(body, headers={"Content-Type": "application/json"})):
                    if expected_state == "valid":
                        sources, _ = artifacts.api_sources(REPO, REF_A)
                        self.assertEqual(len(sources), 3)
                    else:
                        with self.assertRaises(artifacts.ArtifactError):
                            artifacts.api_sources(REPO, REF_A)
                records = self.audit_records()
                completed = [record for record in records if record.get("event") == "public_artifact_get" and record.get("phase") == "finish"]
                self.assertEqual(len(completed), 1)
                self.assert_attempt_audit(completed[0], 200)
                decisions = [record for record in records if record.get("event") == "artifact_validation"
                             and record.get("decision", {}).get("stage") == "release_metadata"]
                self.assertEqual(len(decisions), 1)
                decision = decisions[0]
                self.assertLess(records.index(completed[0]), records.index(decision), "Upstream response must be durable before local conversion")
                self.assertEqual(decision["traceId"], completed[0]["traceId"])
                field_records = [record for record in records if record.get("event") == "artifact_validation"
                                 and record.get("decision", {}).get("stage") == "release_metadata_fields"]
                self.assertEqual(len(field_records), 1)
                self.assertEqual(field_records[0]["states"]["parseStatus"], "valid_json")
                self.assertLess(records.index(completed[0]), records.index(field_records[0]))
                self.assertLess(records.index(field_records[0]), records.index(decision))
                field = field_records[0]["states"]["fieldStates"]["target_commitish"]
                self.assertEqual(field["state"], expected_state)
                if expected_state != "missing":
                    self.assertEqual(field["type"], type(value).__name__)
                self.assertEqual(decision["decision"]["outcome"] == "rejected", expected_state != "valid")
                self.assertNotIn("bad-commit-private-value", self.audit_path.read_text())
        self.audit_path.unlink()
        invalid_body = b'{"message": "sensitive-invalid-json-value",'
        with mock.patch.object(artifacts.urllib.request, "urlopen", return_value=PublicHttpResponse(
                invalid_body, headers={"Content-Type": "application/json"})):
            with self.assertRaises(artifacts.ArtifactError):
                artifacts.api_sources(REPO, REF_A)
        parsing = [record for record in self.audit_records("artifact_validation")
                   if record["decision"].get("stage") == "release_metadata_fields"]
        self.assertEqual(len(parsing), 1)
        self.assertEqual(parsing[0]["states"]["parseStatus"], "invalid_json")
        self.assertEqual(parsing[0]["decision"]["outcome"], "rejected")
        self.assertEqual(parsing[0]["states"]["fieldStates"], {})
        self.assertNotIn("sensitive-invalid-json-value", self.audit_path.read_text())
        if self.audit_path.exists():
            self.audit_path.unlink()
        directory = self.make_bundle("audited-hash-reject")
        self.update_manifest(directory, webSha256="0" * 64)
        # Discard fixture creation audit; this assertion concerns the actual
        # successful GETs followed by this invocation's failed local predicate.
        self.audit_path.unlink(missing_ok=True)
        with mock.patch.object(artifacts.urllib.request, "urlopen", side_effect=lambda request, **kwargs: PublicHttpResponse(
                (directory / request.full_url.rsplit("/", 1)[1]).read_bytes(), headers={"Content-Type": "application/octet-stream"})):
            with self.assertRaises(artifacts.ArtifactError):
                artifacts.fetch(REPO, REF_A, self.root / "audited-hash-rejected-output")
        completed = self.audit_records("public_artifact_get", "finish")
        self.assertEqual(len(completed), 3)
        self.assertTrue(all(record["decision"]["outcome"] == "success" for record in completed))
        rejected = [record for record in self.audit_records("artifact_validation")
                    if record["decision"].get("stage") == "bundle_validation" and record["decision"]["outcome"] == "rejected"]
        self.assertEqual(len(rejected), 1, "HTTP success must not replace a failed hash-validation decision")
        self.assertEqual(rejected[0]["states"]["reasonCode"], "digest_mismatch")
        self.assertEqual(list((self.root / "audited-hash-rejected-output").iterdir()), [])

    def test_github_cli_header_audit_preserves_binary_expected_404_and_unexposed_status(self):
        body = b"PK\x00\xfforiginal ZIP bytes\r\nHTTP/1.1 is part of the artifact\x00"
        redirect = b"HTTP/2.0 302 Found\r\nLocation: https://signed.invalid/?access_token=never-log-redirect\r\n\r\n"
        headers = b"HTTP/2.0 200 OK\r\nContent-Type: application/octet-stream\r\nX-GitHub-Request-Id: BEEF:0123:4567:89AB:CDEF:0000\r\nSet-Cookie: session=never-log-cookie\r\n\r\n"
        result = mock.Mock(returncode=0, stdout=redirect + headers + body, stderr=b"")
        with mock.patch.object(artifacts.subprocess, "run", return_value=result) as process:
            returned = artifacts.gh("api", f"repos/{REPO}/releases/assets/800", "-H", "Accept: application/octet-stream")
        self.assertEqual(returned, body)
        self.assertIn("--include", process.call_args.args[0])
        records = self.audit_records("github_cli", "finish")
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["response"]["httpStatus"], 200)
        self.assertEqual(records[0]["response"]["contentType"], "application/octet-stream")
        self.assertEqual(records[0]["response"]["fullBodySha256"], hashlib.sha256(body).hexdigest())
        self.assertEqual(records[0]["decision"]["parseStatus"], "not_applicable_binary")
        self.assertTrue(records[0]["response"]["bodyOmitted"])
        self.assertNotIn("never-log-redirect", self.audit_path.read_text())
        self.assertNotIn("never-log-cookie", self.audit_path.read_text())
        self.audit_path.unlink()
        not_found = b'{"message":"Not Found","access_token":"never-log-json-token"}'
        result = mock.Mock(returncode=1, stdout=b"HTTP/2.0 404 Not Found\r\nContent-Type: application/json\r\n\r\n" + not_found,
                           stderr=b"gh: Not Found (HTTP 404)")
        with mock.patch.object(artifacts.subprocess, "run", return_value=result):
            self.assertIsNone(artifacts.gh("api", f"repos/{REPO}/releases/tags/web-{REF_A}", missing_ok=True))
        records = self.audit_records("github_cli", "finish")
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["response"]["httpStatus"], 404)
        self.assertEqual(records[0]["decision"]["outcome"], "not_found_expected")
        self.assertEqual(records[0]["decision"]["remoteMessage"], "Not Found")
        self.assertNotIn("never-log-json-token", self.audit_path.read_text())
        self.audit_path.unlink()
        for nested in ({"access_token": "never-log-nested-credential"}, [{"password": "never-log-nested-credential"}]):
            with self.subTest(nested_message_type=type(nested).__name__):
                nested_body = json.dumps({"message": nested, "status": 401}).encode()
                response = b"HTTP/2.0 401 Unauthorized\r\nContent-Type: application/json\r\nLocation: https://signed.invalid/?sig=never-log-nested-location\r\n\r\n" + nested_body
                with mock.patch.object(artifacts.subprocess, "run", return_value=mock.Mock(returncode=1, stdout=response, stderr=b"gh: HTTP 401")):
                    with self.assertRaises(artifacts.ArtifactError):
                        artifacts.gh("api", f"repos/{REPO}/releases/701")
                record = self.audit_records("github_cli", "finish")[0]
                self.assertEqual(record["response"]["httpStatus"], 401)
                self.assertIsNone(record["decision"]["remoteMessage"])
                self.assertIsNone(record["response"]["upstreamReason"])
                self.assertTrue(record["response"]["upstreamReasonOmissionReason"])
                self.assertEqual(record["response"]["upstreamBusinessCode"], 401)
                self.assertNotIn("never-log-nested-credential", self.audit_path.read_text())
                self.assertNotIn("never-log-nested-location", self.audit_path.read_text())
                self.audit_path.unlink()
                error = urllib.error.HTTPError("https://api.github.com/test", 401, "no raw reason",
                    {"Content-Type": "application/json", "Location": "https://signed.invalid/?sig=never-log-nested-location"}, io.BytesIO(nested_body))
                with mock.patch.object(artifacts.urllib.request, "urlopen", side_effect=error):
                    with self.assertRaises(artifacts.ArtifactError):
                        artifacts.read_url("https://api.github.com/test")
                record = self.audit_records("public_artifact_get", "finish")[0]
                self.assertIsNone(record["response"]["upstreamReason"])
                self.assertEqual(record["response"]["upstreamBusinessCode"], 401)
                self.assertNotIn("never-log-nested-credential", self.audit_path.read_text())
                self.assertNotIn("never-log-nested-location", self.audit_path.read_text())
                self.audit_path.unlink()
        plain = b'{"id":701}'
        with mock.patch.object(artifacts.subprocess, "run", return_value=mock.Mock(returncode=0, stdout=plain, stderr=b"")):
            self.assertEqual(artifacts.gh("api", f"repos/{REPO}/releases/701"), plain)
        record = self.audit_records("github_cli", "finish")[0]
        self.assertIsNone(record["response"]["httpStatus"])
        self.assertIsNone(record["response"]["contentType"])
        self.assertEqual(record["response"]["headerOmissionReason"], "not_exposed_by_cli")
        self.assertEqual(record["response"]["responseState"], "not_exposed_by_cli")

    def test_transient_502_and_504_retry_exact_same_public_request_then_return_original_bytes(self):
        url = f"https://api.github.com/repos/{REPO}/releases/assets/800"
        diagnostic = Path(os.environ["PRD_AGENT_ARTIFACT_DIAGNOSTICS"])
        response_body = b"private response body must not be logged\n" * 200
        for retry_after in (None, "4"):
            with self.subTest(retry_after=retry_after):
                if diagnostic.exists():
                    diagnostic.unlink()
                self.sleeping.reset_mock()
                self.diagnostics_output.seek(0)
                self.diagnostics_output.truncate()
                responses = [urllib.error.HTTPError(url, status, "https://signed.invalid/?token=not-for-log",
                    {} if retry_after is None else {"Retry-After": retry_after}, io.BytesIO(response_body))
                    for status in (502, 504)] + [PublicHttpResponse(b"original published bytes")]
                with mock.patch.dict(os.environ, {"GH_TOKEN": "credential-never-forward"}), mock.patch.object(artifacts.urllib.request, "urlopen", side_effect=responses) as opening:
                    result = artifacts.read_url(url)
                self.assertEqual(result, b"original published bytes")
                calls = opening.call_args_list
                self.assertEqual(len(calls), 3)
                self.assertTrue(all(call.args[0] is calls[0].args[0] for call in calls))
                self.assertTrue(all(call.kwargs == {"timeout": 90} for call in calls))
                self.assertEqual(calls[0].args[0].full_url, url)
                self.assertEqual(calls[0].args[0].get_header("Accept"), "application/octet-stream")
                self.assertNotIn("authorization", {name.lower() for name in calls[0].args[0].headers})
                self.assertEqual(self.sleeping.call_args_list,
                    [mock.call(1), mock.call(2)] if retry_after is None else [mock.call(4), mock.call(4)])
                records = self.audit_records("public_artifact_get", "finish")
                self.assertEqual([record["response"]["httpStatus"] for record in records], [502, 504, 200])
                failures = [record for record in records if record["decision"]["outcome"] != "success"]
                self.assertEqual(len(failures), 2)
                self.assertEqual([record["attempt"] for record in failures], [1, 2])
                self.assertTrue(all(record["decision"]["willRetrySameUrl"] for record in failures))
                self.assertTrue(all(record["response"]["bodyObservedBytes"] == 4096 for record in failures))
                self.assertTrue(all(record["response"]["prefixSha256"] == hashlib.sha256(response_body[:4096]).hexdigest() for record in failures))
                for record in failures:
                    self.assert_attempt_audit(record, record["response"]["httpStatus"])
                    self.assertIsNone(record["response"]["truncated"])
                    self.assertEqual(record["response"]["truncationReason"], "bounded_error_prefix_at_limit_total_size_unknown")
                    self.assertIsNone(record["response"]["declaredBodyBytes"])
                    self.assertIs(record["response"]["bodyReadComplete"], False)
                self.assertNotIn("private response", diagnostic.read_text() + self.diagnostics_output.getvalue())
                self.assertNotIn("token=", diagnostic.read_text() + self.diagnostics_output.getvalue())

    def test_get_retry_bound_retry_after_and_integrity_errors_never_reread_or_fallback(self):
        url = "https://api.github.com/repos/example/map/releases/assets/800"
        cases = [(503, None, 3, [1, 2]), (504, "10", 3, [10, 10]),
                 (503, "11", 1, []), (502, "Fri, 08 Nov 2030 00:00:00 GMT", 1, []),
                 (504, "invalid", 1, []), (503, "", 1, []),
                 (404, None, 1, []), (401, None, 1, []), (403, None, 1, [])]
        for status, retry_after, expected_calls, delays in cases:
            with self.subTest(status=status, retry_after=retry_after):
                self.sleeping.reset_mock()

                def unavailable(*args, **kwargs):
                    raise urllib.error.HTTPError(url, status, "test source failure",
                        {} if retry_after is None else {"Retry-After": retry_after}, io.BytesIO(b"unavailable"))
                with mock.patch.object(artifacts.urllib.request, "urlopen", side_effect=unavailable) as opening:
                    with self.assertRaises(artifacts.ArtifactError):
                        artifacts.read_url(url)
                self.assertEqual(opening.call_count, expected_calls)
                self.assertEqual({call.args[0].full_url for call in opening.call_args_list}, {url})
                self.assertEqual(self.sleeping.call_args_list, [mock.call(delay) for delay in delays])
        for error in (TimeoutError("bounded timeout"), urllib.error.URLError("unavailable transport")):
            with self.subTest(error=type(error).__name__):
                self.sleeping.reset_mock()
                with mock.patch.object(artifacts.urllib.request, "urlopen", side_effect=error) as opening:
                    with self.assertRaises(artifacts.ArtifactError):
                        artifacts.read_url(url)
                self.assertEqual(opening.call_count, 1)
                self.sleeping.assert_not_called()
        self.sleeping.reset_mock()
        with mock.patch.object(artifacts.urllib.request, "urlopen", return_value=io.BytesIO(b"oversized")) as opening:
            with self.assertRaises(artifacts.ArtifactError):
                artifacts.read_url(url, limit=2)
        self.assertEqual(opening.call_count, 1)
        self.sleeping.assert_not_called()
        for label in ("hash-mismatch", "malformed-manifest", "bad-zip"):
            with self.subTest(integrity_error=label):
                directory = self.make_bundle(label)
                if label == "hash-mismatch":
                    self.update_manifest(directory, webSha256="0" * 64)
                elif label == "malformed-manifest":
                    self.manifest(directory).write_text("invalid-json")
                else:
                    (directory / artifacts.names(REF_A)[0]).write_bytes(b"not a ZIP")
                    self.resign_zip(directory)
                with mock.patch.object(artifacts.urllib.request, "urlopen", side_effect=lambda request, **kwargs: io.BytesIO((directory / request.full_url.rsplit("/", 1)[1]).read_bytes())) as opening:
                    with self.assertRaises(artifacts.ArtifactError):
                        artifacts.fetch(REPO, REF_A, self.root / (label + "-result"))
                self.assertEqual([call.args[0].full_url for call in opening.call_args_list], artifacts.urls(REPO, REF_A))
                self.sleeping.assert_not_called()

    def test_network_and_gh_errors_do_not_leak_signed_urls(self):
        signed = "https://private.invalid/asset?secret=must-not-appear"
        error = urllib.error.URLError(signed)
        with mock.patch.object(artifacts.urllib.request, "urlopen", side_effect=error):
            with self.assertRaises(artifacts.ArtifactError) as caught:
                artifacts.read_url("https://github.com/example/map/asset")
        self.assertNotIn(signed, str(caught.exception))
        result = mock.Mock(returncode=1, stderr=signed.encode(), stdout=b"")
        with mock.patch.object(artifacts.subprocess, "run", return_value=result):
            with self.assertRaises(artifacts.ArtifactError) as caught:
                artifacts.gh("release", "download", "web-test")
        self.assertNotIn(signed, str(caught.exception))

    def cli(self, *args):
        output, errors = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, "argv", [str(SCRIPT), *args]), mock.patch.object(sys, "stdout", output), mock.patch.object(sys, "stderr", errors):
            status = artifacts.main()
        return status, output.getvalue(), errors.getvalue()

    def test_cli_fetch_exports_only_verified_shell_safe_inputs(self):
        directory = self.make_bundle()
        env_file = self.root / "inputs.env"
        # An apostrophe is legal in a URL, but must not become shell syntax.
        base = "https://mirror.invalid/quoted'path/web-" + REF_A
        payloads = {url: (directory / name).read_bytes() for name, url in zip(artifacts.names(REF_A), artifacts.urls(REPO, REF_A, base))}
        with mock.patch.object(artifacts, "read_url", side_effect=payloads.__getitem__):
            status, output, errors = self.cli("fetch", "--repo", REPO, "--ref", REF_A, "--commit", COMMIT_A,
                "--base-url", base, "--directory", str(self.root / "fetched"), "--env-file", str(env_file))
        self.assertEqual(status, 0)
        self.assertTrue(all(line.startswith("Artifact audit:") for line in errors.splitlines()), errors)
        self.assertEqual(json.loads(output)["commit"], COMMIT_A)
        child = REAL_RUN(["sh", "-c", '. "$1"; sh -c \'printf "%s\\n" "$DIST_URL" "$DIST_SHA256_URL" "$DIST_MANIFEST_URL" "$DIST_SHA256"\'', "bridge", str(env_file)], capture_output=True, text=True)
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertEqual(child.stdout.splitlines(), [*artifacts.urls(REPO, REF_A, base), artifacts.validate(directory, REF_A)["zipSha256"]])

    def test_cli_failed_fetch_never_creates_or_partially_replaces_env_file(self):
        for index, failure in enumerate(("missing", "hash", "commit")):
            for preexisting in (False, True):
                with self.subTest(failure=failure, preexisting=preexisting):
                    directory = self.make_bundle(f"env-fail-{index}-{preexisting}")
                    if failure == "hash":
                        self.update_manifest(directory, webSha256="0" * 64)
                    elif failure == "commit":
                        self.update_manifest(directory, commit=COMMIT_B)
                    read = self.public_reader({REF_A: directory})

                    def download(url):
                        if failure == "missing" and url.endswith(".json"):
                            raise artifacts.ArtifactError("Manifest missing")
                        return read(url)
                    env_file = self.root / f"env-{index}-{preexisting}"
                    if preexisting:
                        env_file.write_text("previous complete export\n")
                    with mock.patch.object(artifacts, "read_url", side_effect=download):
                        status, _, _ = self.cli("fetch", "--repo", REPO, "--ref", REF_A, "--commit", COMMIT_A,
                            "--directory", str(self.root / f"failed-{index}-{preexisting}"), "--env-file", str(env_file))
                    self.assertEqual(status, 1)
                    self.assertEqual(env_file.read_text() if env_file.exists() else None,
                                     "previous complete export\n" if preexisting else None)

    def test_cli_forbids_env_export_before_any_nonfetch_side_effect(self):
        for command in ("publish", "bundle", "restore", "pages", "alias", "validate"):
            with self.subTest(command=command), mock.patch.object(artifacts, command) as operation:
                status, _, _ = self.cli(command, "--ref", REF_A, "--directory", str(self.root),
                    "--env-file", str(self.root / "not-created.env"))
                self.assertEqual(status, 1)
                operation.assert_not_called()
                self.assertFalse((self.root / "not-created.env").exists())

    def latest_payloads(self, directory):
        archive = (directory / artifacts.names(REF_A)[0]).read_bytes()
        digest = hashlib.sha256(archive).hexdigest()
        return {"prd-admin-dist-latest.zip": archive,
                "prd-admin-dist-latest.zip.sha256": f"{digest}  prd-admin-dist-latest.zip\n".encode(),
                "release-manifest-latest.json": json.dumps({"commit": COMMIT_A, "ref": "latest", "webDist": "prd-admin-dist-latest.zip", "webSha256": digest}).encode()}

    def test_pages_latest_true_publishes_complete_current_trio_without_remote_read(self):
        directory = self.make_bundle()
        output = self.root / "site"
        with mock.patch.dict(os.environ, {"PUBLISH_LATEST": "true"}), mock.patch.object(artifacts, "read_url") as read:
            artifacts.pages(directory, REF_A, output, REPO)
        read.assert_not_called()
        for name in artifacts.names(REF_A):
            self.assertEqual((output / name).read_bytes(), (directory / name).read_bytes())
        self.assertEqual((output / "prd-admin-dist-latest.zip").read_bytes(), (directory / artifacts.names(REF_A)[0]).read_bytes())
        latest = json.loads((output / "release-manifest-latest.json").read_text())
        self.assertEqual((latest["ref"], latest["commit"], latest["webDist"]), ("latest", COMMIT_A, "prd-admin-dist-latest.zip"))
        self.assertTrue(latest["apiImage"].endswith(":latest"))
        for path in (output, output / "admin"):
            self.assertEqual((path / "commit.txt").read_text(), COMMIT_A + "\n")
            self.assertEqual((path / "assets" / f"index-{COMMIT_A}.js").read_bytes(), b"original application")

    def test_pages_b_preserves_latest_a_but_a_rollback_uses_retained_release(self):
        a = self.make_bundle()
        b = self.make_bundle("pages-b", COMMIT_B)
        old_latest = self.latest_payloads(a)
        base = "https://pages.invalid/map"

        def read_latest(url):
            self.assertTrue(url.startswith(base + "/"))
            return old_latest[url.rsplit("/", 1)[1]]
        output = self.root / "site-b"
        with mock.patch.dict(os.environ, {"PUBLISH_LATEST": "false", "PAGES_PRESERVE_BASE_URL": base}), mock.patch.object(artifacts, "read_url", side_effect=read_latest):
            artifacts.pages(b, REF_B, output, REPO)
        self.assertEqual((output / "commit.txt").read_text(), COMMIT_B + "\n")
        for name, content in old_latest.items():
            self.assertEqual((output / name).read_bytes(), content)
        self.assertTrue(all(not (output / name).exists() for name in artifacts.names(REF_A)))
        # Pages B contains no fixed A files; disaster recovery still has A.
        with mock.patch.object(artifacts, "read_url", side_effect=self.public_reader({REF_A: a})):
            artifacts.fetch(REPO, REF_A, self.root / "restored-a", commit=COMMIT_A)
        for name in artifacts.names(REF_A):
            self.assertEqual((a / name).read_bytes(), (self.root / "restored-a" / name).read_bytes())

    def test_pages_preserve_latest_absent_is_allowed_but_partial_corrupt_or_unavailable_fails(self):
        directory = self.make_bundle()
        old = self.latest_payloads(directory)
        for case in ("absent", "partial", "corrupt", "unavailable"):
            with self.subTest(case=case):
                def download(url):
                    name = url.rsplit("/", 1)[1]
                    if case == "unavailable":
                        raise artifacts.ArtifactError("Artifact source unavailable (503)")
                    if case == "absent" or (case == "partial" and name.endswith(".json")):
                        raise artifacts.ArtifactError("Artifact source unavailable (404)")
                    return b"corrupt" if case == "corrupt" and name.endswith(".zip") else old[name]
                output = self.root / ("preserve-" + case)
                with mock.patch.dict(os.environ, {"PUBLISH_LATEST": "false"}), mock.patch.object(artifacts, "read_url", side_effect=download):
                    if case == "absent":
                        artifacts.pages(directory, REF_A, output, REPO)
                        self.assertFalse((output / "prd-admin-dist-latest.zip").exists())
                    else:
                        with self.assertRaises(artifacts.ArtifactError):
                            artifacts.pages(directory, REF_A, output, REPO)

    def subprocess_network_fixture(self, directory):
        shim = self.root / "offline-python"
        shim.mkdir(exist_ok=True)
        (shim / "sitecustomize.py").write_text(textwrap.dedent('''
            import io, json, os, pathlib, time, urllib.error, urllib.request
            time.sleep = lambda seconds: None
            assets = {}
            def offline(request, **kwargs):
                url = request.full_url
                with open(os.environ["TEST_NETWORK_LOG"], "a") as log:
                    log.write(url + "\\n")
                path = pathlib.Path(os.environ["TEST_ARTIFACT_FIXTURE"]) / url.rsplit("/", 1)[1]
                if os.environ.get("TEST_SOURCE_UNAVAILABLE") == "1":
                    raise urllib.error.HTTPError(url, 503, "offline test", {}, None)
                root = pathlib.Path(os.environ["TEST_ARTIFACT_FIXTURE"])
                if "/releases/tags/web-" in url:
                    ref = url.split("/releases/tags/web-", 1)[1]
                    names = [f"prd-admin-dist-{ref}.zip", f"prd-admin-dist-{ref}.zip.sha256", f"release-manifest-{ref}.json"]
                    manifest = root / names[2]
                    commit = json.loads(manifest.read_text())["commit"] if manifest.exists() else ref[4:]
                    assets.update({800 + index: root / name for index, name in enumerate(names)})
                    return io.BytesIO(json.dumps({"id": 701, "draft": False, "tag_name": "web-" + ref,
                        "target_commitish": commit, "assets": [{"id": 800 + index, "state": "uploaded", "name": name}
                            for index, name in enumerate(names)]}).encode())
                if "/releases/assets/" in url:
                    path = assets[int(url.rsplit("/", 1)[1])]
                if not path.is_file():
                    raise urllib.error.HTTPError(url, 404, "offline test", {}, None)
                return io.BytesIO(path.read_bytes())
            urllib.request.urlopen = offline
        '''))
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith(("GH_", "GITHUB_", "DIST_", "CDS_", "PYTHON", "TEST_"))}
        environment.update(PYTHONPATH=str(shim), TEST_ARTIFACT_FIXTURE=str(directory),
                           TEST_NETWORK_LOG=str(self.root / "network.log"), CDS_COMMIT_SHA=COMMIT_A)
        return environment

    def bridge_repository(self):
        repository = self.root / "bridge-repo"
        (repository / "scripts" / "lib").mkdir(parents=True)
        body = SCRIPT.read_bytes()
        (repository / "scripts" / "lib" / SCRIPT.name).write_bytes(body)
        for command in (["git", "init", "-q"], ["git", "add", "scripts/lib/release-artifacts.py"],
                        ["git", "-c", "user.name=Retention test", "-c", "user.email=retention@example.invalid", "commit", "-qm", "test bridge contract"]):
            result = REAL_RUN(command, cwd=repository, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        commit = REAL_RUN(["git", "rev-parse", "HEAD"], cwd=repository, capture_output=True, text=True, check=True).stdout.strip()
        return repository, commit, hashlib.sha256(body).hexdigest()

    def bridge_script(self, commit, digest):
        prefix = artifacts.legacy_bridge_prefix(commit, digest, REPO)
        # Everything after the prefix models the unmodified old rollback body.
        # Only the historical download/verification phase is executed; actual
        # fast/exec deployment actions are explicit harmless sentinels.
        return prefix + r'''
printf 'old-body-entered\n' >> "$TEST_ACTION_LOG"
sh -c 'printf "%s\n" "$DIST_URL" "$DIST_SHA256_URL" "$DIST_MANIFEST_URL" "$DIST_SHA256"' > "$TEST_EXPORTED_INPUTS"
TAG="sha-$CDS_COMMIT_SHA" OWNER=example REPO_NAME=map manifest_url=""
tmp_dir="$TEST_OLD_WORKDIR"
curl() { python3 "$TEST_CURL_SHIM" "$@"; }
''' + LEGACY_CONSUMER + r'''
actual="$(sha256sum "$zip_path" | awk '{print $1}')"
[ "$actual" = "$expected" ]
printf 'fast-sentinel\nexec-sentinel\n' >> "$TEST_ACTION_LOG"
'''

    def run_bridge(self, directory, failure=None):
        repository, commit, digest = self.bridge_repository()
        environment = self.subprocess_network_fixture(directory)
        action_log = self.root / "actions.log"
        exports = self.root / "exported-inputs"
        work = self.root / "old-exec-work"
        work.mkdir()
        curl_shim = self.root / "mock-curl.py"
        curl_shim.write_text(textwrap.dedent('''
            import os, pathlib, shutil, sys, urllib.parse
            args = sys.argv[1:]
            url = next(arg for arg in args if arg.startswith(("https://", "file://")))
            with open(os.environ["TEST_CURL_LOG"], "a") as log:
                log.write(url + "\\n")
            if not url.startswith("file://"):
                raise SystemExit("Historical consumer must use this invocation's verified staging files")
            source = pathlib.Path(urllib.parse.unquote(urllib.parse.urlsplit(url).path))
            if not source.is_file() or source.parent.name != "bundle":
                raise SystemExit("Missing local staging file")
            shutil.copyfile(source, args[args.index("-o") + 1])
        '''))
        environment.update(TEST_ACTION_LOG=str(action_log), TEST_EXPORTED_INPUTS=str(exports),
            TEST_OLD_WORKDIR=str(work), TEST_CURL_SHIM=str(curl_shim), TEST_CURL_LOG=str(self.root / "curl.log"))
        if failure == "source":
            environment["TEST_SOURCE_UNAVAILABLE"] = "1"
        if failure == "body-hash":
            digest = "0" * 64
        script = self.root / "rollback.sh"
        script.write_text(self.bridge_script(commit, digest))
        # A dirty working tree helper must never replace the pinned Git blob.
        (repository / "scripts" / "lib" / SCRIPT.name).write_text("raise SystemExit('wrong working tree helper')\n")
        result = REAL_RUN(["sh", str(script)], cwd=repository, env=environment, capture_output=True, text=True)
        return result, action_log, exports, work

    def test_legacy_bridge_uses_pinned_git_body_and_old_consumer_really_reads_exports(self):
        directory = self.make_bundle()
        result, actions, exports, work = self.run_bridge(directory)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(actions.read_text().splitlines(), ["old-body-entered", "fast-sentinel", "exec-sentinel"])
        urls = exports.read_text().splitlines()
        for url, name in zip(urls[:3], artifacts.names(REF_A)):
            self.assertTrue(url.startswith("file://"))
            self.assertTrue(url.endswith("/bundle/" + name))
        self.assertEqual(urls[3], artifacts.validate(directory, REF_A)["zipSha256"])
        self.assertEqual((work / "prd-admin-dist.zip").read_bytes(), (directory / artifacts.names(REF_A)[0]).read_bytes())
        self.assertEqual((self.root / "curl.log").read_text().splitlines(), urls[:1])
        api_urls = [f"https://api.github.com/repos/{REPO}/releases/assets/{800 + index}" for index in range(3)]
        self.assertEqual((self.root / "network.log").read_text().splitlines(),
            [f"https://api.github.com/repos/{REPO}/releases/tags/web-{REF_A}", *api_urls])
        receipt = next(json.loads(line) for line in result.stdout.splitlines() if line.startswith("{"))
        self.assertEqual(receipt["urls"], api_urls)
        self.assertEqual(receipt["sourceIdentity"]["assetIds"], [800, 801, 802])
        self.assertEqual(receipt["transport"], "github-api")

    def test_legacy_bridge_failures_stop_before_historical_body_fast_or_exec(self):
        # Each subcase needs an isolated root so logs cannot inherit a previous run.
        for failure in ("source", "manifest", "commit", "hash", "body-hash"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(dir=self.root) as temporary:
                original_root = self.root
                self.root = Path(temporary)
                try:
                    directory = self.make_bundle()
                    if failure == "manifest":
                        self.manifest(directory).unlink()
                    elif failure == "commit":
                        self.update_manifest(directory, commit=COMMIT_B)
                    elif failure == "hash":
                        self.update_manifest(directory, webSha256="0" * 64)
                    result, actions, exports, work = self.run_bridge(directory, failure)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(actions.exists())
                    self.assertFalse(exports.exists())
                    self.assertFalse((self.root / "curl.log").exists())
                    self.assertEqual(list(work.iterdir()), [])
                    if failure == "body-hash":
                        self.assertFalse((self.root / "network.log").exists())
                finally:
                    self.root = original_root

    def test_bridge_rejects_unpinned_or_shell_injected_contract(self):
        for commit, digest, repository in (("main", "0" * 64, REPO), (COMMIT_A, "wrong", REPO),
                                           (COMMIT_A, "0" * 64, "owner/repo;touch bad")):
            with self.subTest(commit=commit, repo=repository), self.assertRaises(artifacts.ArtifactError):
                artifacts.legacy_bridge_prefix(commit, digest, repository)

    def workflow_job(self, name):
        source = (ROOT / ".github/workflows/web-latest-pages.yml").read_text()
        match = re.search(r"^  " + re.escape(name) + r":\n(.*?)(?=^  [A-Za-z][\w-]*:\n|\Z)", source, re.M | re.S)
        self.assertIsNotNone(match, name)
        return match.group(1)

    def workflow_run(self, job, name):
        match = re.search(r"^      - name: " + re.escape(name) + r"\n(.*?)(?=^      - |\Z)", self.workflow_job(job), re.M | re.S)
        self.assertIsNotNone(match, name)
        run = re.search(r"^        run: \|\n((?:          .*\n|\n)+)", match.group(1), re.M)
        self.assertIsNotNone(run, "Expected a shell block in " + name)
        return textwrap.dedent(run.group(1))

    def test_pages_main_head_check_runs_real_script_and_skips_superseded_or_invalid_candidates(self):
        run = self.workflow_run("pages", "Check current main before Pages writes")
        current = {"ref": "refs/heads/main", "object": {"type": "commit", "sha": COMMIT_A},
                   "unrelated_metadata": "private-head-metadata-must-not-be-persisted"}
        stale = {**current, "object": {"type": "commit", "sha": COMMIT_B}}
        cases = [("current-push", current, 200, "push", "true", "valid"),
                 ("current-manual", current, 200, "workflow_dispatch", "true", "valid"),
                 ("stale", stale, 200, "push", "false", "superseded"),
                 ("wrong-ref", {**current, "ref": "refs/heads/other"}, 200, "push", None, "rejected"),
                 ("wrong-type", {**current, "object": {"type": "tag", "sha": COMMIT_A}}, 200, "push", None, "rejected"),
                 ("bad-sha", {**current, "object": {"type": "commit", "sha": "private-head-metadata-must-not-be-persisted"}}, 200, "push", None, "rejected"),
                 ("missing-sha", {**current, "object": {"type": "commit"}}, 200, "push", None, "rejected"),
                 ("null-sha", {**current, "object": {"type": "commit", "sha": None}}, 200, "push", None, "rejected"),
                 ("empty-sha", {**current, "object": {"type": "commit", "sha": ""}}, 200, "push", None, "rejected"),
                 ("whitespace-sha", {**current, "object": {"type": "commit", "sha": "  "}}, 200, "push", None, "rejected"),
                 ("wrong-sha-type", {**current, "object": {"type": "commit", "sha": 123}}, 200, "push", None, "rejected"),
                 ("missing-object", {"ref": "refs/heads/main"}, 200, "push", None, "rejected"),
                 ("wrong-shape", [], 200, "push", None, "rejected"),
                 ("invalid-json", "not-json-private-head-metadata-must-not-be-persisted", 200, "push", None, "rejected"),
                 ("lookup-failed", {"message": "Not Found"}, 404, "push", None, "rejected")]
        for label, payload, status, event, publish, outcome in cases:
            with self.subTest(case=label):
                working = self.root / ("main-head-" + label)
                (working / "scripts/lib").mkdir(parents=True)
                (working / "bin").mkdir()
                shutil.copyfile(SCRIPT, working / "scripts/lib" / SCRIPT.name)
                fixture = working / "head-response"
                fixture.write_text(payload if isinstance(payload, str) else json.dumps(payload))
                log = working / "gh-calls.jsonl"
                gh = working / "bin/gh"
                gh.write_text("#!" + sys.executable + "\nimport json, os, pathlib, sys\nwith open(os.environ['TEST_GH_LOG'], 'a') as log:\n log.write(json.dumps(sys.argv[1:]) + '\\n')\nstatus = int(os.environ['TEST_HEAD_STATUS'])\nsys.stdout.write(f'HTTP/2.0 {status} Test\\r\\nContent-Type: application/json\\r\\nX-GitHub-Request-Id: AB12:CD34:EF56:7890:ABCD:1234\\r\\n\\r\\n')\nsys.stdout.write(pathlib.Path(os.environ['TEST_HEAD_SOURCE']).read_text())\nif status >= 400:\n sys.stderr.write(f'gh: HTTP {status}\\n')\n raise SystemExit(1)\n")
                gh.chmod(0o755)
                output = working / "step-output"
                audit = working / "main-head-audit.jsonl"
                environment = self.subprocess_network_fixture(working)
                environment.update(PATH=str(working / "bin") + os.pathsep + os.environ["PATH"],
                    GITHUB_REPOSITORY=REPO, GITHUB_SHA=COMMIT_A, GITHUB_EVENT_NAME=event,
                    GITHUB_OUTPUT=str(output), GH_TOKEN="test-workflow-token-never-forwarded",
                    PRD_AGENT_ARTIFACT_AUDIT_PATH=str(audit), PRD_AGENT_ARTIFACT_AUDIT_REQUEST_ID="main-head-" + label,
                    TEST_GH_LOG=str(log), TEST_HEAD_SOURCE=str(fixture), TEST_HEAD_STATUS=str(status))
                result = REAL_RUN(["sh", "-eu", "-c", run], cwd=working, env=environment, capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, publish is not None, result.stderr)
                self.assertEqual(output.read_text() if output.exists() else None,
                                 "publish=" + publish + "\n" if publish is not None else None)
                calls = [json.loads(line) for line in log.read_text().splitlines()]
                self.assertEqual(len(calls), 1)
                self.assertEqual(calls[0][0:2], ["api", f"repos/{REPO}/git/ref/heads/main"])
                self.assertIn("--include", calls[0])
                records = [json.loads(line) for line in audit.read_text().splitlines()]
                cli = [record for record in records if record.get("event") == "github_cli" and record.get("phase") == "finish"]
                self.assertEqual(len(cli), 1)
                self.assertEqual(cli[0]["response"]["httpStatus"], status)
                self.assertEqual(cli[0]["response"]["contentType"], "application/json")
                self.assertEqual(cli[0]["response"]["upstreamRequestId"]["X-GitHub-Request-Id"]["value"], "AB12:CD34:EF56:7890:ABCD:1234")
                decision = [record for record in records if record.get("event") == "artifact_validation"
                            and record.get("decision", {}).get("stage") == "pages_main_head"]
                self.assertEqual(len(decision), 1)
                self.assertEqual(decision[0]["decision"]["outcome"], outcome)
                self.assertLess(records.index(cli[0]), records.index(decision[0]))
                states = decision[0]["states"]
                expected_fields = {
                    "wrong-ref": ("ref", "format_error"), "wrong-type": ("object.type", "format_error"),
                    "bad-sha": ("object.sha", "format_error"), "missing-sha": ("object.sha", "missing"),
                    "null-sha": ("object.sha", "null"), "empty-sha": ("object.sha", "empty"),
                    "whitespace-sha": ("object.sha", "whitespace"), "wrong-sha-type": ("object.sha", "type_error"),
                    "missing-object": ("object", "missing"), "wrong-shape": ("ref", "container_type_error")}
                if label in expected_fields:
                    field, state = expected_fields[label]
                    self.assertEqual(states["fieldStates"][field]["state"], state)
                if label in ("invalid-json", "lookup-failed"):
                    self.assertFalse(states["responseParsed"])
                    self.assertEqual(states["fieldStates"], {})
                if publish is not None:
                    self.assertEqual(states["candidateCommit"], COMMIT_A)
                    self.assertEqual(states["mainCommit"], COMMIT_A if publish == "true" else COMMIT_B)
                    self.assertEqual(states["candidateIsCurrent"], publish == "true")
                    self.assertEqual(set(states["fieldStates"]), {"ref", "object", "object.type", "object.sha"})
                    self.assertTrue(all(field["state"] == "valid" for field in states["fieldStates"].values()))
                self.assertNotIn("private-head-metadata-must-not-be-persisted", audit.read_text())
                self.assertNotIn("test-workflow-token-never-forwarded", audit.read_text())
                self.assertFalse((self.root / "network.log").exists(), "The head check must not fetch or prepare Pages")

    def test_all_pages_writes_require_current_main_output_and_audit_upload_remains_unconditional(self):
        pages = self.workflow_job("pages")
        steps = re.split(r"^      - ", pages.split("    steps:\n", 1)[1], flags=re.M)[1:]
        writing = [step for step in steps if any(target in step for target in (
            "name: Prepare Pages from the retained bundle", "uses: actions/configure-pages@v5",
            "uses: actions/upload-pages-artifact@v3", "uses: actions/deploy-pages@v4"))]
        self.assertEqual(len(writing), 4)
        for step in writing:
            self.assertRegex(step, r"(?m)^        if: steps\.main-head\.outputs\.publish == 'true'$")
        self.assertLess(pages.index("Check current main before Pages writes"), pages.index("Prepare Pages from the retained bundle"))
        audit = next(step for step in steps if "name: Preserve safe third-party response audit" in step)
        self.assertRegex(audit, r"(?m)^        if: always\(\)$")
        self.assertIn("uses: actions/upload-artifact@v4", audit)
        self.assertNotIn("main-head.outputs.publish", audit)
        permission = re.search(r"^    permissions:\n(.*?)(?=^    [a-z-]+:)", pages, re.M | re.S).group(1)
        self.assertEqual(textwrap.dedent(permission).strip(), "contents: read\npages: write\nid-token: write")
        retain = self.workflow_job("retain")
        self.assertIn("group: web-bundle-${{ github.sha }}", retain)
        self.assertIn("cancel-in-progress: false", retain)
        self.assertNotIn("main-head", retain)

    def test_workflow_push_and_manual_paths_fetch_retained_canonical_pages_bundle(self):
        run = self.workflow_run("pages", "Prepare Pages from the retained bundle")
        cases = (("push", False, "", True), ("workflow_dispatch", False, "release-qa", False),
                 ("workflow_dispatch", True, "", True))
        for event, requested_latest, tag, expected_latest in cases:
            with self.subTest(event=event, requested_latest=requested_latest, tag=tag), tempfile.TemporaryDirectory(dir=self.root) as temporary:
                original_root = self.root
                self.root = Path(temporary)
                try:
                    directory = self.make_bundle()
                    for name, payload in self.latest_payloads(directory).items():
                        (directory / name).write_bytes(payload)
                    if tag:
                        artifacts.alias(directory, REF_A, tag)
                    working = self.root / "workflow"
                    (working / "scripts/lib").mkdir(parents=True)
                    shutil.copyfile(SCRIPT, working / "scripts/lib" / SCRIPT.name)
                    environment = self.subprocess_network_fixture(directory)
                    environment.update(GITHUB_REPOSITORY=REPO, GITHUB_SHA=COMMIT_A, RELEASE_TAG=tag,
                        PUBLISH_LATEST=str(event == "push" or requested_latest).lower(),
                        PRD_AGENT_RELEASE_DOWNLOAD_TRANSPORT="github-api",
                        PAGES_PRESERVE_BASE_URL="https://pages.invalid/map")
                    result = REAL_RUN(["sh", "-eu", "-c", run], cwd=working, env=environment, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    site = working / "site"
                    self.assertEqual(artifacts.validate(site, REF_A, COMMIT_A)["zipSha256"], artifacts.validate(directory, REF_A)["zipSha256"])
                    latest = json.loads((site / "release-manifest-latest.json").read_text())
                    self.assertEqual(latest["commit"], COMMIT_A)
                    urls = (self.root / "network.log").read_text().splitlines()
                    api_urls = [f"https://api.github.com/repos/{REPO}/releases/assets/{800 + index}" for index in range(3)]
                    self.assertEqual(urls[:4], [f"https://api.github.com/repos/{REPO}/releases/tags/web-{REF_A}", *api_urls])
                    if tag:
                        self.assertEqual(artifacts.validate(site, tag, COMMIT_A)["zipSha256"], artifacts.validate(directory, REF_A)["zipSha256"])
                        self.assertEqual(urls[-4:], [f"https://api.github.com/repos/{REPO}/releases/tags/web-{tag}", *api_urls])
                    self.assertEqual(any(url.startswith("https://pages.invalid/") for url in urls), not expected_latest)
                finally:
                    self.root = original_root

    def test_workflow_retain_optional_tag_aliases_only_the_published_canonical_bundle(self):
        run = self.workflow_run("retain", "Publish once; validate and reuse on retry")
        for tag in ("", "release-qa"):
            with self.subTest(tag=tag):
                working = self.root / ("retain-" + (tag or "no-tag"))
                working.mkdir()
                bin_dir = working / "bin"
                bin_dir.mkdir()
                log = working / "commands.jsonl"
                # This shell mock records argv as JSON, without running gh or
                # Python's artifact CLI. The artifact API itself is tested above.
                wrapper = bin_dir / "python3"
                wrapper.write_text("#!" + sys.executable + "\nimport json, os, sys\nwith open(os.environ['TEST_COMMAND_LOG'], 'a') as log:\n log.write(json.dumps(sys.argv[1:]) + '\\n')\n")
                wrapper.chmod(0o755)
                environment = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ["PATH"],
                    GITHUB_REPOSITORY=REPO, GITHUB_SHA=COMMIT_A, RELEASE_TAG=tag, TEST_COMMAND_LOG=str(log))
                result = REAL_RUN(["sh", "-eu", "-c", run], cwd=working, env=environment, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                commands = [json.loads(line) for line in log.read_text().splitlines()]
                self.assertEqual([args[1] for args in commands], ["publish", "fetch", "alias", "publish"] if tag else ["publish"])
                self.assertEqual(commands[0], ["scripts/lib/release-artifacts.py", "publish", "--repo", REPO, "--ref", REF_A, "--directory", "bundle"])
                if tag:
                    self.assertEqual(commands[1], ["scripts/lib/release-artifacts.py", "fetch", "--repo", REPO, "--ref", REF_A, "--directory", "canonical"])
                    self.assertIn("canonical", commands[2])
                    self.assertEqual(commands[-1], ["scripts/lib/release-artifacts.py", "publish", "--repo", REPO, "--ref", tag, "--directory", "canonical"])

    def test_migration_identity_step_rejects_wrong_source_run_before_artifact_download(self):
        run = self.workflow_run("retain-existing", "Verify the original successful workflow identity")
        valid = {"head_sha": COMMIT_A, "status": "completed", "conclusion": "success",
                 "repository": {"full_name": REPO}, "path": ".github/workflows/web-latest-pages.yml"}
        cases = [("valid", valid, "123", COMMIT_A, "0" * 64)]
        for field, value in (("head_sha", COMMIT_B), ("status", "in_progress"), ("conclusion", "failure"),
                             ("repository", {"full_name": "other/repository"}), ("path", ".github/workflows/ci.yml")):
            cases.append(("wrong-" + field, dict(valid, **{field: value}), "123", COMMIT_A, "0" * 64))
        cases += [("bad-run", valid, "123;false", COMMIT_A, "0" * 64),
                  ("missing-commit", valid, "123", "", "0" * 64),
                  ("bad-hash", valid, "123", COMMIT_A, "bad")]
        for label, record, run_id, commit, digest in cases:
            with self.subTest(case=label):
                working = self.root / label
                (working / "bin").mkdir(parents=True)
                (working / "scripts/lib").mkdir(parents=True)
                shutil.copyfile(SCRIPT, working / "scripts/lib" / SCRIPT.name)
                source = working / "source-run.json"
                source.write_text(json.dumps(record))
                log = working / "gh-calls.jsonl"
                gh = working / "bin/gh"
                gh.write_text("#!" + sys.executable + "\nimport json, os, pathlib, sys\nwith open(os.environ['TEST_GH_LOG'], 'a') as log:\n log.write(json.dumps(sys.argv[1:]) + '\\n')\nif '--include' in sys.argv:\n sys.stdout.write('HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\nX-GitHub-Request-Id: TEST-IDENTITY-001\\r\\n\\r\\n')\nsys.stdout.write(pathlib.Path(os.environ['TEST_RUN_SOURCE']).read_text())\n")
                gh.chmod(0o755)
                environment = dict(os.environ, PATH=str(working / "bin") + os.pathsep + os.environ["PATH"],
                    GITHUB_REPOSITORY=REPO, ORIGINAL_RUN=run_id, ORIGINAL_COMMIT=commit, ORIGINAL_SHA256=digest,
                    TEST_GH_LOG=str(log), TEST_RUN_SOURCE=str(source),
                    PRD_AGENT_ARTIFACT_AUDIT_PATH=str(working / "identity-audit.jsonl"),
                    PRD_AGENT_ARTIFACT_AUDIT_REQUEST_ID="migration-identity-test")
                result = REAL_RUN(["sh", "-eu", "-c", run], cwd=working, env=environment, capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, label == "valid")
                if label in ("bad-run", "missing-commit", "bad-hash"):
                    self.assertFalse(log.exists(), "Malformed input must fail before even reading the source run")
                else:
                    calls = [json.loads(line) for line in log.read_text().splitlines()]
                    self.assertEqual(len(calls), 1)
                    self.assertEqual(calls[0][0], "api")
                    self.assertIn(f"repos/{REPO}/actions/runs/{run_id}", calls[0])
                    self.assertIn("--include", calls[0])
                    audits = [json.loads(line) for line in (working / "identity-audit.jsonl").read_text().splitlines()]
                    cli = [record for record in audits if record.get("event") == "github_cli" and record.get("phase") == "finish"]
                    self.assertEqual(len(cli), 1)
                    self.assertEqual(cli[0]["traceId"], "migration-identity-test")
                    self.assertEqual(cli[0]["response"]["httpStatus"], 200)
                    self.assertEqual(cli[0]["response"]["contentType"], "application/json")
                    self.assertTrue(cli[0]["response"]["bodyOmitted"])
                    identity = [record for record in audits if record.get("event") == "artifact_validation"
                                and record.get("decision", {}).get("stage") == "original_workflow_identity"]
                    self.assertEqual(len(identity), 1)
                    self.assertLess(audits.index(cli[0]), audits.index(identity[0]))
                    self.assertEqual(identity[0]["decision"]["outcome"], "valid" if label == "valid" else "rejected")

    def test_migration_step_imports_original_bytes_before_mocked_publish_and_stops_on_failure(self):
        run = self.workflow_run("retain-existing", "Retain the original bytes without rebuilding")
        directory = self.make_bundle()
        digest = artifacts.validate(directory, REF_A)["zipSha256"]
        for label, draft, missing, expected_hash in (("new", "", False, digest), ("resume", "701", False, digest),
                                                    ("missing", "701", True, digest), ("bad-hash", "701", False, "0" * 64)):
            with self.subTest(case=label):
                working = self.root / ("migration-" + label)
                (working / "scripts/lib").mkdir(parents=True)
                (working / "original").mkdir()
                (working / "bin").mkdir()
                shutil.copyfile(SCRIPT, working / "scripts/lib" / SCRIPT.name)
                archive = self.pages_tar(directory, "migration-input-" + label,
                                         omit=artifacts.names(REF_A)[2] if missing else None)
                shutil.copyfile(archive, working / "original/artifact.tar")
                log = working / "publish.jsonl"
                wrapper = working / "bin/python3"
                # Execute the real import CLI. Only publish is intercepted.
                wrapper.write_text("#!" + sys.executable + "\nimport json, os, sys\nif sys.argv[2] == 'publish':\n with open(os.environ['TEST_PUBLISH_LOG'], 'a') as log:\n  log.write(json.dumps(sys.argv[1:]) + '\\n')\nelse:\n os.execv(sys.executable, [sys.executable, *sys.argv[1:]])\n")
                wrapper.chmod(0o755)
                environment = self.subprocess_network_fixture(directory)
                environment.update(PATH=str(working / "bin") + os.pathsep + os.environ["PATH"], GITHUB_REPOSITORY=REPO,
                    ORIGINAL_COMMIT=COMMIT_A, ORIGINAL_SHA256=expected_hash, DRAFT_ID=draft, TEST_PUBLISH_LOG=str(log))
                result = REAL_RUN(["sh", "-eu", "-c", run], cwd=working, env=environment, capture_output=True, text=True)
                success = label in ("new", "resume")
                self.assertEqual(result.returncode == 0, success, result.stderr)
                if success:
                    for name in artifacts.names(REF_A):
                        self.assertEqual((working / "inherited" / name).read_bytes(), (directory / name).read_bytes())
                    command = ["scripts/lib/release-artifacts.py", "publish", "--repo", REPO, "--ref", REF_A, "--directory", "inherited"]
                    if draft:
                        command += ["--resume-draft-id", draft, "--original-sha256", digest]
                    self.assertEqual([json.loads(line) for line in log.read_text().splitlines()], [command])
                else:
                    self.assertFalse(log.exists(), "Bad original source must not reach publish")
                    self.assertEqual(list((working / "inherited").iterdir()), [])
                self.assertFalse((self.root / "network.log").exists())

    def test_optional_migration_permissions_identity_order_and_default_build_skip_inheritance(self):
        migration = self.workflow_job("retain-existing")
        build = self.workflow_job("build")
        self.assertRegex(migration, r"permissions:\n      contents: write\n      actions: read")
        self.assertNotIn("pages: write", migration)
        self.assertNotIn("secrets.", migration)
        self.assertIn("GH_TOKEN: ${{ github.token }}", migration)
        self.assertIn("group: web-bundle-${{ inputs.retain_commit }}", migration)
        self.assertIn("cancel-in-progress: false", migration)
        self.assertLess(migration.index("Verify the original successful workflow identity"), migration.index("actions/download-artifact@v4"))
        self.assertLess(migration.index("actions/download-artifact@v4"), migration.index("Retain the original bytes without rebuilding"))
        self.assertIn("name: github-pages", migration)
        self.assertIn("run-id: ${{ inputs.retain_from_run }}", migration)
        self.assertIn("github-token: ${{ github.token }}", migration)
        condition = re.search(r"^    if: (.+)$", migration, re.M).group(1)
        fields = ("retain_from_run", "retain_commit", "retain_original_sha256", "retain_draft_id")
        # Evaluate the actual simple workflow predicates with controlled values.
        for supplied in (None, *fields):
            inputs = {field: "provided" if field == supplied else "" for field in fields}
            expression = re.sub(r"inputs\.([a-z_0-9]+)", lambda item: repr(inputs[item.group(1)]), condition)
            expression = expression.replace("||", " or ")
            self.assertEqual(eval(expression, {"__builtins__": {}}, {}), supplied is not None)
        self.assertIn("needs: retain-existing", build)

    def test_complete_workflow_dag_overrides_ancestor_skip_but_blocks_failure_and_cancellation(self):
        chain = (("build", "retain-existing"), ("retain", "build"), ("pages", "retain"))
        conditions = {}
        for job, parent in chain:
            block = self.workflow_job(job)
            self.assertRegex(block, r"(?m)^    needs: " + re.escape(parent) + r"$")
            condition = re.search(r"^    if: (.+)$", block, re.M).group(1)
            # Without an explicit status function GitHub implicitly adds
            # success(), propagating the skipped migration even across a
            # successful build. Every downstream job needs this override.
            self.assertIn("always()", condition, job)
            self.assertIn("!cancelled()", condition, job)
            conditions[job] = condition

        def allowed(job, results, cancelled=False, ref="refs/heads/main"):
            expression = re.sub(r"needs\.([\w-]+)\.result", lambda item: repr(results[item.group(1)]), conditions[job])
            expression = expression.replace("always()", "True").replace("!cancelled()", str(not cancelled))
            expression = expression.replace("github.ref", repr(ref))
            expression = expression.replace("&&", " and ").replace("||", " or ")
            return eval(expression, {"__builtins__": {}}, {})

        for job, parent in chain:
            for result in ("success", "skipped", "failure", "cancelled"):
                for cancelled in (False, True):
                    for ref in ("refs/heads/main", "refs/heads/codex/retention-candidate"):
                        with self.subTest(job=job, parent_result=result, workflow_cancelled=cancelled, ref=ref):
                            acceptable = result in (("success", "skipped") if job == "build" else ("success",))
                            publishable_ref = job != "pages" or ref == "refs/heads/main"
                            self.assertEqual(allowed(job, {parent: result}, cancelled, ref), acceptable and not cancelled and publishable_ref)

        # Walk the actual dependency chain, including how a blocked job turns
        # into skipped for its successor, rather than checking build alone.
        for migration in ("skipped", "success", "failure", "cancelled"):
            for ref in ("refs/heads/main", "refs/heads/codex/retention-candidate"):
                results = {"retain-existing": migration}
                decisions = []
                for job, _ in chain:
                    decision = allowed(job, results, ref=ref)
                    decisions.append(decision)
                    results[job] = "success" if decision else "skipped"
                expected = [migration in ("skipped", "success")] * 3
                if ref != "refs/heads/main":
                    expected[-1] = False
                self.assertEqual(decisions, expected)
        for stopped_job in ("build", "retain"):
            for stopped_result in ("failure", "cancelled", "skipped"):
                results = {"retain-existing": "skipped"}
                passed_stop = False
                for job, _ in chain:
                    decision = allowed(job, results)
                    self.assertEqual(decision, not passed_stop)
                    results[job] = stopped_result if job == stopped_job else ("success" if decision else "skipped")
                    passed_stop = passed_stop or job == stopped_job

    def test_workflow_permissions_serialization_and_ci_wiring_preserve_other_releases(self):
        source = (ROOT / ".github/workflows/web-latest-pages.yml").read_text()
        self.assertRegex(source, r"(?m)^  push:\n    branches: \[main\]")
        self.assertRegex(source, r"(?m)^  workflow_dispatch:")
        self.assertRegex(source, r"(?m)^permissions:\n  contents: read\n")
        self.assertNotRegex(source, r"(?m)^concurrency:")
        build, retain, pages = [self.workflow_job(job) for job in ("build", "retain", "pages")]
        self.assertNotIn("contents: write", build)
        self.assertIn("restore --repo", build)
        self.assertIn('if: steps.restore.outputs.exists != \'true\'', build)
        self.assertIn("needs: build", retain)
        self.assertRegex(retain, r"permissions:\n      contents: write")
        self.assertIn("group: web-bundle-${{ github.sha }}", retain)
        self.assertIn("cancel-in-progress: false", retain)
        self.assertNotIn("pages: write", retain)
        self.assertIn("needs: retain", pages)
        self.assertIn("contents: read", pages)
        self.assertIn("pages: write", pages)
        self.assertIn("id-token: write", pages)
        self.assertRegex(pages, r"environment:\n      name: github-pages\n")
        self.assertIn("uses: actions/deploy-pages@v4", pages)
        self.assertIn("group: pages", pages)
        self.assertIn("cancel-in-progress: false", pages)
        self.assertIn("PUBLISH_LATEST: ${{ github.event_name == 'push' || inputs.publish_latest == true }}", pages)
        # Durable publishing must not move the unrelated desktop updater's
        # /releases/latest channel; the publish API behavior is checked above.
        self.assertNotIn("--clobber", source)
        self.assertNotRegex(source, r"gh release (?:create|edit|delete)")
        ci = (ROOT / ".github/workflows/ci.yml").read_text()
        filters = re.search(r"release_scripts:\n(.*?)(?=^            [A-Za-z_]+:|^  [A-Za-z_]+:)", ci, re.M | re.S)
        self.assertIsNotNone(filters)
        for path in (".github/workflows/web-latest-pages.yml", "scripts/lib/release-artifacts.py", "scripts/tests/test_*.py"):
            self.assertIn("- '" + path + "'", filters.group(1))
        job = re.search(r"^  release-script-test:\n(.*?)(?=^  [\w-]+:\n|\Z)", ci, re.M | re.S)
        self.assertIsNotNone(job)
        self.assertIn("needs.changes.outputs.release_scripts == 'true'", job.group(1))
        self.assertIn("for t in scripts/tests/test_*.py", job.group(1))
        self.assertIn('python3 "$t"', job.group(1))


if __name__ == "__main__":
    unittest.main(verbosity=2)
