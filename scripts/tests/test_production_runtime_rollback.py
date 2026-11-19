import json
import os
from pathlib import Path
import runpy
import subprocess
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
            "Cmd": ["serve", "running"],
            "Entrypoint": ["/app/start"],
        },
        "HostConfig": {"PortBindings": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "18080"}]}},
        "Mounts": [
            {"Type": "bind", "Source": "/old/bin/ffmpeg", "Destination": "/usr/local/bin/ffmpeg",
             "Propagation": "rprivate", "RW": False},
            {"Type": "volume", "Name": "map_storage", "Destination": "/data", "RW": True},
        ],
    }


class RuntimeRollbackTests(unittest.TestCase):
    def test_persist_release_image_pins_remains_private_with_umask_022(self):
        script = (Path(__file__).resolve().parents[2] / "exec_dep.sh").read_text()
        start = script.index("persist_release_image_pins() {")
        end = script.index("read_dotenv_value() {", start)
        command = script[start:end] + "umask 022\npersist_release_image_pins\n"
        with tempfile.TemporaryDirectory() as root:
            dotenv = Path(root) / ".env"
            dotenv.write_text("DESIGN_RUNTIME_API_KEY=fixture-only\n")
            dotenv.chmod(0o600)
            env = dict(os.environ, PRD_AGENT_DOTENV_FILE=str(dotenv))
            for component in ("API", "LLMGW", "LLMGW_SERVE", "LLMGW_WEB", "DESIGN_OPENDESIGN"):
                env[f"PRD_AGENT_{component}_IMAGE"] = "registry/fixture:new"
            result = subprocess.run(["sh", "-euc", command], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(dotenv.stat().st_mode & 0o777, 0o600)
            self.assertIn("DESIGN_RUNTIME_API_KEY=fixture-only", dotenv.read_text())
            self.assertIn("PRD_AGENT_API_IMAGE=registry/fixture:new", dotenv.read_text())
            self.assertNotIn("fixture-only", result.stdout + result.stderr)

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
                    name: {"image": "latest", "command": ["source-command"], "ports": [],
                           "volumes": [{"source": "/new/bin/ffmpeg"}], "depends_on": {"mongodb": {}}}
                    for name in before
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
                self.assertEqual(model["services"]["api"]["command"], ["serve", "running"])
                self.assertEqual(model["services"]["api"]["ports"][0]["published"], "18080")
                self.assertEqual(model["services"]["api"]["volumes"][1]["source"], "/old/bin/ffmpeg")
                self.assertEqual(model["volumes"]["map_storage"], {"external": True, "name": "map_storage"})
                self.assertEqual(model["services"]["api"]["labels"]["org.map.release.source-files"], "/old/compose.yml")
                self.assertNotIn("depends_on", model["services"]["api"])
                current["api"] = container("api", "sha256:new-api", "/new/compose.yml")
                current["gateway"] = container("gateway", "sha256:new-nginx", "/new/compose.yml")
                current["candidate-only"] = container("candidate-only", "sha256:new-worker", "/new/compose.yml")
                TOOLS["restore"]("map", "gateway", directory)
                self.assertEqual(current, before)
                self.assertEqual([args[-1] for args in calls if "up" in args], ["api", "gateway"])
                self.assertIn(("rm", "-f", "candidate-only-sha256:new-worker"), calls)

    def test_verifies_restored_mounts_even_when_image_matches(self):
        api = container("api", "sha256:old", "/old/compose.yml")
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            with patch.dict(TOOLS["capture"].__globals__, {
                "docker": lambda *args: '{"services":{"api":{}}}' if "config" in args else "",
                "inventory": lambda _name: {"api": api},
            }):
                TOOLS["capture"]("map", "gateway", directory)
                api["Mounts"][0]["Source"] = "/wrong/bin/ffmpeg"
                with self.assertRaisesRegex(RuntimeError, "配置与发布前不符：volumes"):
                    TOOLS["restore"]("map", "gateway", directory)


if __name__ == "__main__":
    unittest.main()
