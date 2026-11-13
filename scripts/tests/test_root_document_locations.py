#!/usr/bin/env python3
"""Exercise document placement through the root guard with isolated directories."""

from __future__ import annotations

import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "root_layout_guard", Path(__file__).with_name("test_root_layout_contract.py")
)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class DocumentLocationTests(unittest.TestCase):
    def run_guard(self, files: list[str]) -> tuple[int, str]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in files:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("# Test document\n", encoding="utf-8")
            output = io.StringIO()
            with patch.object(guard, "REPO", root), patch.object(
                guard, "is_git_ignored", return_value=False
            ), contextlib.redirect_stdout(output):
                result = guard.main()
            return result, output.getvalue()

    def test_principle_guides_are_rejected_in_root(self):
        for kind in ("adr", "pdr", "spec", "design", "plan", "rule", "guide", "report", "debt"):
            with self.subTest(kind=kind):
                name = f"pri.{kind}.md"
                result, output = self.run_guard(["README.md", name])
                self.assertEqual(result, 1)
                self.assertIn(f"unapproved root file '{name}'", output)

    def test_root_markdown_is_not_approved_by_its_document_type(self):
        result, output = self.run_guard(["guide.doc.pri.adr.md"])
        self.assertEqual(result, 1)
        self.assertIn("unapproved root file", output)

    def test_existing_entrypoints_and_guides_under_doc_are_allowed(self):
        result, output = self.run_guard([
            "README.md", "AGENTS.md", "doc/guide.doc.pri.adr.md", "doc/guide.doc.pri.pdr.md",
        ])
        self.assertEqual(result, 0, output)


if __name__ == "__main__":
    unittest.main()
