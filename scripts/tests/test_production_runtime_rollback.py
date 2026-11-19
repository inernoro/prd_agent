import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parents[1]
DEPLOY = (SCRIPTS.parent / "exec_dep.sh").read_text()
TOOLS = runpy.run_path(str(SCRIPTS / "lib/production-runtime-rollback.py"))


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
    def test_only_confirmed_storage_failure_can_be_waived(self):
        start = DEPLOY.index("run_asset_storage_readiness() {")
        end = DEPLOY.index("reload_active_gateway() {", start)
        command = DEPLOY[start:end] + r'''
compose_run() { printf '%s' "$FIXTURE"; return 22; }
run_asset_storage_readiness
'''
        asset = {
            "errorCode": "ASSET_STORAGE_UNAVAILABLE",
            "components": [{"name": name, "ready": name != "asset-storage"}
                           for name in ("mongodb", "redis", "asset-storage")],
        }
        redis = {
            "errorCode": "REDIS_UNAVAILABLE",
            "components": [{"name": name, "ready": name == "mongodb"}
                           for name in ("mongodb", "redis", "asset-storage")],
        }
        with tempfile.TemporaryDirectory() as root:
            baseline = Path(root) / "old.json"
            for initial, latest, force, expected in (
                (asset, asset, "0", 0),
                ({}, asset, "0", 1),
                ({}, asset, "1", 0),
                (redis, redis, "1", 1),
                ({}, {"errorCode": "probe_request_failed"}, "1", 1),
            ):
                baseline.write_text(json.dumps(initial))
                env = dict(os.environ, tmp_dir=root, asset_readiness_baseline=str(baseline),
                           asset_storage_readiness_json=str(Path(root) / "post.json"),
                           api_service="api", force_external=force,
                           PRD_AGENT_ASSET_STORAGE_READINESS_ATTEMPTS="1", FIXTURE=json.dumps(latest))
                result = subprocess.run(["sh", "-euc", command], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)

    def test_design_warning_does_not_run_parent_exit_trap(self):
        start = DEPLOY.index("wait_for_design_runtime_readiness() {")
        end = DEPLOY.index("\ndesign_in_scope=1", start)
        command = DEPLOY[start:end] + r'''
compose_run() { case "$1" in config) echo design-opendesign ;; ps) echo fixture ;; esac; }
docker() { case "$3" in *"/"*) echo true/unhealthy ;; *".State.Running"*) echo true ;; *) echo unhealthy ;; esac; }
trap 'printf "outer-exit\n" >> "$TRAP_LOG"' EXIT
force_external=0 design_before_degraded=1 design_in_scope=0
check_design_runtime_after_deploy
test ! -e "$TRAP_LOG"
'''
        with tempfile.TemporaryDirectory() as root:
            log = Path(root) / "trap.log"
            result = subprocess.run(["sh", "-euc", command], env=dict(os.environ, TRAP_LOG=str(log)),
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(log.read_text().splitlines(), ["outer-exit"])

    def test_force_does_not_pass_a_new_design_engine_failure(self):
        start = DEPLOY.index("wait_for_design_runtime_readiness() {")
        end = DEPLOY.index("\ndesign_in_scope=1", start)
        command = DEPLOY[start:end] + r'''
wait_for_design_runtime_readiness() { return 1; }
design_runtime_degraded() { return 0; }
check_design_runtime_after_deploy
'''
        for baseline, affected, expected in (("0", "1", 1), ("1", "1", 1), ("1", "0", 0)):
            with self.subTest(baseline=baseline, affected=affected):
                result = subprocess.run(
                    ["sh", "-euc", command],
                    env=dict(os.environ, force_external="1", design_before_degraded=baseline, design_in_scope=affected),
                    capture_output=True, text=True,
                )
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)

    def test_failed_rollback_keeps_private_checkpoint(self):
        start = DEPLOY.index("release_exit() {")
        end = DEPLOY.index("\nreuse_static_dist=", start)
        command = DEPLOY[start:end] + r'''
restore_production_runtime() { return 1; }
write_release_evidence() { return 0; }
compose_started=1 release_completed=0 static_staging_dir=
release_failure_stage=compose-update release_rollback_result=not-needed
release_evidence_id=fixture
false
'''
        with tempfile.TemporaryDirectory() as root:
            temporary = Path(root) / "temporary"
            checkpoint = temporary / "rollback"
            checkpoint.mkdir(parents=True, mode=0o700)
            (checkpoint / "compose.json").write_text("fixture")
            env = dict(os.environ, HOME=root, tmp_dir=str(temporary), runtime_rollback_dir=str(checkpoint))
            result = subprocess.run(["sh", "-euc", command], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            retained = Path(root) / ".prd-agent-release-recovery" / "fixture"
            self.assertEqual((retained / "compose.json").read_text(), "fixture")
            self.assertEqual(retained.parent.stat().st_mode & 0o777, 0o700)
            self.assertFalse(temporary.exists())

    def test_receipt_errors_after_verified_release_warn_and_keep_success(self):
        command = DEPLOY[DEPLOY.index("release_completed=1\n\nwrite_deploy_receipt"): ]
        command = "write_release_evidence() { return 1; }\ncompose_started=1 TAG=sha-fixture\n" + command
        with tempfile.TemporaryDirectory() as root:
            parent = Path(root) / "not-a-directory"
            parent.touch()
            env = dict(os.environ, LLMGW_DEPLOY_RECEIPT_FILE=str(parent / "receipt.json"))
            result = subprocess.run(["sh", "-euc", command], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("Production release completed with public surface evidence:", result.stdout)
            self.assertIn("写入网关发布回执失败", result.stderr)

    def test_inventory_prefers_running_service_and_rejects_multiple_live_instances(self):
        running = container("api", "sha256:live", "/active/compose.yml")
        stopped = container("api", "sha256:stale", "/previous/compose.yml", running=False)
        with patch.dict(TOOLS["inventory"].__globals__, {
            "docker": lambda *args: "live stale" if args[0] == "ps" else json.dumps([running, stopped]),
        }):
            self.assertEqual(TOOLS["inventory"]("map"), {"api": running})
            stopped["State"]["Running"] = True
            with self.assertRaisesRegex(RuntimeError, "服务 api 有多个运行实例"):
                TOOLS["inventory"]("map")

    def test_capture_and_restore_use_standalone_and_custom_environment_file(self):
        before = container("api", "sha256:old", "/old/compose.yml")
        current = {"api": before}
        commands = []

        def run(executable, *args):
            commands.append((executable, *args))
            if "config" in args:
                return '{"services":{"api":{}}}'
            if "up" in args:
                current["api"] = before
            return ""

        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            environment = directory / "production.env"
            environment.touch()
            with patch.dict(TOOLS["capture"].__globals__, {"run_command": run, "inventory": lambda _name: current}):
                TOOLS["capture"]("map", "gateway", directory, "docker-compose", environment)
                current["api"] = container("api", "sha256:new", "/new/compose.yml")
                TOOLS["restore"]("map", "gateway", directory, "docker-compose")
        render = next(command for command in commands if "config" in command)
        self.assertEqual(render[0], "docker-compose")
        self.assertEqual(render[render.index("--env-file") + 1], str(environment.resolve()))
        self.assertEqual(next(command for command in commands if "up" in command)[0], "docker-compose")

    def test_persist_release_image_pins_remains_private_with_umask_022(self):
        start = DEPLOY.index("persist_release_image_pins() {")
        end = DEPLOY.index("read_dotenv_value() {", start)
        command = DEPLOY[start:end] + "umask 022\npersist_release_image_pins\n"
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

    def test_captures_and_restores_a_service_removed_from_the_candidate(self):
        retired = container("retired-worker", "sha256:old-worker", "/release/compose.yml")
        retired["Name"] = "/map-retired-worker"
        retired["NetworkSettings"] = {"Networks": {
            "previous-network": {"Aliases": ["worker"], "IPAMConfig": {"IPv4Address": "172.22.0.7"}},
        }}
        api = container("api", "sha256:old-api", "/release/compose.yml")
        current = {"api": api, "retired-worker": retired}

        def docker(*args):
            if "config" in args:
                return '{"services":{"api":{}}}'
            if "up" in args:
                self.assertEqual(args[-1], "retired-worker")
                current["retired-worker"] = retired
            return ""

        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            with patch.dict(TOOLS["capture"].__globals__, {"docker": docker, "inventory": lambda _name: dict(current)}):
                TOOLS["capture"]("map", "gateway", directory)
                model = json.loads((directory / "compose-0.json").read_text())
                service = model["services"]["retired-worker"]
                network, = service["networks"]
                self.assertEqual(service["container_name"], "map-retired-worker")
                self.assertEqual(service["image"], "sha256:old-worker")
                self.assertEqual(model["networks"][network], {"name": "previous-network", "external": True})
                self.assertEqual(service["networks"][network], {"aliases": ["worker"], "ipv4_address": "172.22.0.7"})
                del current["retired-worker"]
                TOOLS["restore"]("map", "gateway", directory)
                self.assertEqual(current, {"api": api, "retired-worker": retired})


if __name__ == "__main__":
    unittest.main()
