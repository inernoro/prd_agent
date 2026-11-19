import json
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch


TOOLS = runpy.run_path(str(Path(__file__).resolve().parents[1] / "lib/production-runtime-rollback.py"))


def container(name, image, config_file, running=True):
    return {
        "Id": f"{name}-{image}",
        "Image": image,
        "State": {"Running": running},
        "Config": {
            "Labels": {
                "com.docker.compose.service": name,
                "com.docker.compose.project.working_dir": "/stable/map",
                "com.docker.compose.project.config_files": config_file,
            },
            "Env": ["PASSWORD=original$credential"],
        },
    }


class RuntimeRollbackTests(unittest.TestCase):
    def test_restores_changed_images_and_gateway_after_partial_update(self):
        api = container("api", "sha256:old-api", "/old/compose.yml")
        mongo = container("mongodb", "sha256:mongo", "/old/compose.yml")
        gateway = container("gateway", "sha256:old-nginx", "/stable/compose.yml")
        before = {"api": api, "mongodb": mongo, "gateway": gateway}
        current = dict(before)
        calls = []

        def docker(*args):
            calls.append(args)
            if "config" in args:
                return json.dumps({"services": {
                    name: {"image": "latest", "depends_on": {"mongodb": {}}} for name in before
                }})
            if args[:2] == ("rm", "-f"):
                current.pop("candidate-only")
            if "up" in args:
                for service in args[args.index("never") + 1:]:
                    current[service] = before[service]
            return ""

        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            with patch.dict(TOOLS["capture"].__globals__, {"docker": docker, "inventory": lambda _name: dict(current)}):
                TOOLS["capture"]("map", "gateway", directory)
                model = json.loads((directory / "compose-0.json").read_text())
                self.assertEqual(model["services"]["api"]["image"], "sha256:old-api")
                self.assertEqual(model["services"]["api"]["environment"]["PASSWORD"], "original$$credential")
                self.assertEqual(model["services"]["api"]["labels"]["org.map.release.source-files"], "/old/compose.yml")
                self.assertNotIn("depends_on", model["services"]["api"])
                current["api"] = container("api", "sha256:new-api", "/new/compose.yml")
                current["gateway"] = container("gateway", "sha256:new-nginx", "/new/compose.yml")
                current["candidate-only"] = container("candidate-only", "sha256:new-worker", "/new/compose.yml")
                TOOLS["restore"]("map", "gateway", directory)
                self.assertEqual(current, before)
                self.assertEqual([args[-1] for args in calls if "up" in args], ["api", "gateway"])
                self.assertIn(("rm", "-f", "candidate-only-sha256:new-worker"), calls)


if __name__ == "__main__":
    unittest.main()
