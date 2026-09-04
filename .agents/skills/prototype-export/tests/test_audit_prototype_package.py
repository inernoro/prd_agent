from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "audit_prototype_package.py"
SPEC = importlib.util.spec_from_file_location("prototype_audit", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def make_zip(path: Path, entries: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries.items():
            archive.writestr(name, content)


class AuditPrototypePackageTests(unittest.TestCase):
    def test_clean_static_package_is_strict_ready(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "clean.zip"
            make_zip(source, {
                "index.html": b'<link rel="stylesheet" href="src/app.css"><script src="src/app.js"></script>',
                "src/app.css": b"body{color:#111}",
                "src/app.js": b"document.body.dataset.ready='1'",
            })

            report = MODULE.audit_zip(source)

            self.assertTrue(report["strictReady"])
            self.assertEqual("index.html", report["preferredEntry"])
            self.assertEqual(2, report["localReferenceCount"])
            self.assertEqual([], report["missingLocalReferences"])

    def test_first_html_fallback_matches_hosting_entry_contract(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "slides.zip"
            make_zip(source, {
                "slides.html": b"<main>slides</main>",
            })

            report = MODULE.audit_zip(source)

            self.assertTrue(report["strictReady"])
            self.assertEqual("slides.html", report["preferredEntry"])

    def test_node_modules_and_external_cdn_trigger_optimization(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.zip"
            make_zip(source, {
                "prototype/": b"",
                "prototype/index.html": b'<script src="https://cdn.example/vue.js"></script><script src="src/app.js"></script><img src="/assets/logo.png">',
                "prototype/src/app.js": b"new Vue({el:'#app'})",
                "prototype/assets/logo.png": b"image",
                "prototype/node_modules/vue/package.json": b"{}",
                "prototype/package-lock.json": b"{}",
            })

            report = MODULE.audit_zip(source)

            self.assertFalse(report["strictReady"])
            self.assertTrue(report["optimizationRecommended"])
            self.assertEqual(1, report["nodeModulesEntries"])
            self.assertEqual(1, report["externalReferenceCount"])
            self.assertEqual(2, report["localReferenceCount"])
            self.assertEqual([], report["missingLocalReferences"])
            self.assertEqual("prototype/", report["rootPrefix"])

    def test_unsafe_paths_duplicates_and_missing_refs_are_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "unsafe.zip"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("index.html", b'<script src="missing.js"></script>')
                archive.writestr("../outside.txt", b"blocked")
                archive.writestr("Asset.js", b"one")
                archive.writestr("asset.js", b"two")
                archive.writestr("same.txt", b"first")
                archive.writestr("same.txt", b"second")

            report = MODULE.audit_zip(source)

            self.assertFalse(report["strictReady"])
            self.assertIn("../outside.txt", report["unsafePaths"])
            self.assertIn("same.txt", report["duplicatePaths"])
            self.assertIn("asset.js", report["caseCollisions"])
            self.assertEqual(["missing.js"], report["missingLocalReferences"])

    def test_nested_css_and_javascript_references_are_checked(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "nested.zip"
            make_zip(source, {
                "index.html": b'<link rel="stylesheet" href="assets/app.css"><script src="assets/app.js"></script>',
                "assets/app.css": b'body{background:url("missing-background.png")}',
                "assets/app.js": b'import "./nested.js";',
                "assets/nested.js": b'import "./missing-module.js";',
            })

            report = MODULE.audit_zip(source)

            self.assertFalse(report["strictReady"])
            self.assertEqual(
                ["assets/missing-background.png", "assets/missing-module.js"],
                report["missingLocalReferences"],
            )

    def test_html_style_attribute_references_are_checked(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "inline-style.zip"
            make_zip(source, {
                "index.html": b'<div style="background:url(./missing.png)"></div>',
            })

            report = MODULE.audit_zip(source)

            self.assertFalse(report["strictReady"])
            self.assertEqual(["missing.png"], report["missingLocalReferences"])

    def test_excessive_compression_ratio_is_blocked_in_strict_mode(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "compression-bomb.zip"
            make_zip(source, {
                "index.html": b"<main>prototype</main>",
                "payload.bin": b"x" * (2 * 1024 * 1024),
            })

            report = MODULE.audit_zip(source)

            self.assertFalse(report["strictReady"])
            self.assertEqual(["payload.bin"], report["suspiciousCompressionPaths"])
            self.assertIn("包含异常压缩比文件", report["blockers"])

    def test_oversized_runtime_text_is_not_silently_certified(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "oversized-runtime.zip"
            make_zip(source, {
                "index.html": b'<script src="missing.js"></script>' + b" " * (2 * 1024 * 1024),
            })

            report = MODULE.audit_zip(source)

            self.assertFalse(report["strictReady"])
            self.assertEqual(["index.html"], report["unscannedRuntimePaths"])
            self.assertIn("运行文本超过安全扫描上限", report["blockers"])

    def test_cli_strict_returns_two_for_source_package(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.zip"
            make_zip(source, {
                "index.html": b"<main>prototype</main>",
                "node_modules/pkg/index.js": b"module.exports = {}",
            })

            result = subprocess.run(
                [sys.executable, str(SCRIPT), str(source), "--strict", "--json"],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(2, result.returncode)
            self.assertFalse(__import__("json").loads(result.stdout)["strictReady"])

    def test_development_artifacts_are_not_strict_ready(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "development.zip"
            make_zip(source, {
                "index.html": b"<main>prototype</main>",
                "package-lock.json": b"{}",
                "app.js.map": b"{}",
            })

            report = MODULE.audit_zip(source)

            self.assertFalse(report["strictReady"])
            self.assertTrue(report["optimizationRecommended"])
            self.assertEqual(1, report["developmentEntries"])
            self.assertEqual(1, report["sourceMapEntries"])

    def test_runtime_loader_references_are_included_in_strict_audit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "runtime-loaders.zip"
            make_zip(source, {
                "index.html": b'<script src="app.js"></script>',
                "app.js": (
                    b"fetch ('./missing.json');"
                    b"new Worker ('./missing-worker.js');"
                    b"navigator.serviceWorker.register ('./missing-service-worker.js');"
                    b"importScripts ('./missing-import.js');"
                ),
            })

            report = MODULE.audit_zip(source)

            self.assertFalse(report["strictReady"])
            self.assertEqual([
                "missing-import.js",
                "missing-service-worker.js",
                "missing-worker.js",
                "missing.json",
            ], report["missingLocalReferences"])

    def test_dynamic_runtime_loader_is_reported_as_unscanned(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "dynamic-loader.zip"
            make_zip(source, {
                "index.html": b"<script>const path = './data.json'; fetch(path)</script>",
                "data.json": b"{}",
            })

            report = MODULE.audit_zip(source)

            self.assertFalse(report["strictReady"])
            self.assertEqual(["index.html"], report["unscannedRuntimePaths"])

    def test_html_base_href_resolves_runtime_references(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "base-href.zip"
            make_zip(source, {
                "prototype/index.html": b'<base href="/assets/"><script src="app.js"></script>',
                "prototype/assets/app.js": b"document.body.dataset.ready = '1'",
            })

            report = MODULE.audit_zip(source)

            self.assertTrue(report["strictReady"])
            self.assertEqual([], report["missingLocalReferences"])
            self.assertEqual(1, report["localReferenceCount"])

    def test_binary_runtime_asset_is_not_decoded_as_text(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "binary-asset.zip"
            make_zip(source, {
                "index.html": b'<img src="logo.png">',
                "logo.png": b"\x89PNG\r\n\x1a\n\xff\xfe",
            })

            report = MODULE.audit_zip(source)

            self.assertTrue(report["strictReady"])
            self.assertEqual([], report["unscannedRuntimePaths"])
            self.assertEqual([], report["missingLocalReferences"])

    def test_valueless_base_href_is_treated_as_absent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "valueless-base.zip"
            make_zip(source, {
                "index.html": b'<base href><script src="app.js"></script>',
                "app.js": b"document.body.dataset.ready = '1'",
            })

            report = MODULE.audit_zip(source)

            self.assertTrue(report["strictReady"])
            self.assertEqual([], report["missingLocalReferences"])


if __name__ == "__main__":
    unittest.main()
