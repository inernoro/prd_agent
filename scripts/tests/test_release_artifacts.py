#!/usr/bin/env python3
"""Behavior checks for retained release bundles; never contacts GitHub or Pages."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
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
        # A forgotten mock must fail instead of using a developer's credentials.
        self.network = mock.patch.object(artifacts.urllib.request, "urlopen", side_effect=AssertionError("Unexpected network"))
        self.process = mock.patch.object(artifacts.subprocess, "run", side_effect=AssertionError("Unexpected process"))
        self.network.start()
        self.process.start()
        self.addCleanup(self.network.stop)
        self.addCleanup(self.process.stop)

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
                "draft": draft, "assets": [{"id": 800 + index, "name": name} for index, name in enumerate(
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
        self.assertEqual((status, errors), (0, ""))
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
            import io, os, pathlib, urllib.error, urllib.request
            def offline(request, **kwargs):
                url = request.full_url
                with open(os.environ["TEST_NETWORK_LOG"], "a") as log:
                    log.write(url + "\\n")
                path = pathlib.Path(os.environ["TEST_ARTIFACT_FIXTURE"]) / url.rsplit("/", 1)[1]
                if os.environ.get("TEST_SOURCE_UNAVAILABLE") == "1":
                    raise urllib.error.HTTPError(url, 503, "offline test", {}, None)
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
            import os, pathlib, shutil, sys
            args = sys.argv[1:]
            url = next(arg for arg in args if arg.startswith("https://"))
            with open(os.environ["TEST_CURL_LOG"], "a") as log:
                log.write(url + "\\n")
            shutil.copyfile(pathlib.Path(os.environ["TEST_ARTIFACT_FIXTURE"]) / url.rsplit("/", 1)[1], args[args.index("-o") + 1])
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
        self.assertEqual(urls[:3], artifacts.urls(REPO, REF_A, f"https://get.miduo.org/https://github.com/{REPO}/releases/download/web-{REF_A}"))
        self.assertEqual(urls[3], artifacts.validate(directory, REF_A)["zipSha256"])
        self.assertEqual((work / "prd-admin-dist.zip").read_bytes(), (directory / artifacts.names(REF_A)[0]).read_bytes())
        self.assertEqual((self.root / "curl.log").read_text().splitlines(), urls[:1])
        self.assertEqual((self.root / "network.log").read_text().splitlines(), urls[:3])

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
                        PAGES_PRESERVE_BASE_URL="https://pages.invalid/map")
                    result = REAL_RUN(["sh", "-eu", "-c", run], cwd=working, env=environment, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    site = working / "site"
                    self.assertEqual(artifacts.validate(site, REF_A, COMMIT_A)["zipSha256"], artifacts.validate(directory, REF_A)["zipSha256"])
                    latest = json.loads((site / "release-manifest-latest.json").read_text())
                    self.assertEqual(latest["commit"], COMMIT_A)
                    urls = (self.root / "network.log").read_text().splitlines()
                    self.assertEqual(urls[:3], artifacts.urls(REPO, REF_A))
                    if tag:
                        self.assertEqual(artifacts.validate(site, tag, COMMIT_A)["zipSha256"], artifacts.validate(directory, REF_A)["zipSha256"])
                        self.assertEqual(urls[-3:], artifacts.urls(REPO, tag))
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
