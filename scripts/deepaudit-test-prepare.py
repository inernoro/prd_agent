#!/usr/bin/env python3
"""Exercise installation against a local, pinned upstream checkout without network."""
import argparse
import importlib.util
import json
import pathlib
import subprocess
import tempfile
import unittest

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--source-checkout", required=True, type=pathlib.Path)
args, unittest_args = parser.parse_known_args()
spec = importlib.util.spec_from_file_location("prepare", pathlib.Path(__file__).with_name("deepaudit-prepare.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class OverlayInstallation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.checkout = pathlib.Path(self.temp.name) / "fork"
        subprocess.run(["git", "clone", "--shared", str(args.source_checkout), str(self.checkout)],
                       check=True, capture_output=True)
        manifest = json.loads((pathlib.Path(__file__).resolve().parents[1] /
                               "deploy/deepaudit/upstream.json").read_text())
        subprocess.run(["git", "-C", str(self.checkout), "checkout", "--detach", manifest["commit"]],
                       check=True, capture_output=True)
        subprocess.run(["git", "-C", str(self.checkout), "remote", "set-url", "origin",
                        "https://github.com/inernoro/DeepAudit.git"], check=True)

    def tearDown(self):
        self.temp.cleanup()

    def test_install_is_repeatable_and_checks_release_contract(self):
        first = module.prepare(self.checkout)
        self.assertEqual(first, module.prepare(self.checkout))
        self.assertIn("backend/app/cds_runtime.py", first)
        subprocess.run(["sh", str(self.checkout / "cds-release.sh"), "check"], check=True,
                       capture_output=True)

    def test_refuses_overwriting_existing_work(self):
        target = self.checkout / "backend/app/cds_runtime.py"
        target.write_text("operator work\n")
        with self.assertRaisesRegex(ValueError, "overwrite"):
            module.prepare(self.checkout)
        self.assertEqual(target.read_text(), "operator work\n")

    def test_refuses_symlink_escape(self):
        target = self.checkout / "backend/app/cds_runtime.py"
        outside = pathlib.Path(self.temp.name) / "outside.py"
        outside.write_text("outside\n")
        target.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "leaves checkout"):
            module.prepare(self.checkout)
        self.assertEqual(outside.read_text(), "outside\n")

    def test_refuses_wrong_repository(self):
        subprocess.run(["git", "-C", str(self.checkout), "remote", "set-url", "origin",
                        "https://github.com/other/project.git"], check=True)
        with self.assertRaisesRegex(ValueError, "origin"):
            module.prepare(self.checkout)


unittest.main(argv=[__file__, *unittest_args])
