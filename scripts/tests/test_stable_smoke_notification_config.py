import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("config_repair", Path(__file__).parents[1] / "stable-smoke-notification-config.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ConfigRepairTests(unittest.TestCase):
    def fixture(self):
        return {"Name": "/prdagent-api", "Id": "1" * 64, "Image": "sha256:current-image", "State": {"Running": True}, "Config": {"Image": "moving-tag", "Env": ["PRIVATE_KEY=never-output", module.KEY + "=admin"], "Labels": {"org.opencontainers.image.revision": "a" * 40}, "Entrypoint": ["dotnet", "PrdAgent.Api.dll"]}, "HostConfig": {"Binds": ["existing-volume:/app/data"]}, "NetworkSettings": {"Networks": {"existing-network": {"Aliases": ["api", "prdagent-api", "1" * 64]}}}}

    def test_clone_preserves_running_image_all_other_env_volumes_and_command(self):
        old = self.fixture()
        saved = copy.deepcopy(old)
        new = module.clone_api_config(old, "a" * 40)
        self.assertEqual(new["Image"], old["Image"])
        self.assertEqual(new["Env"], ["PRIVATE_KEY=never-output", module.KEY + "=inernoro"])
        self.assertEqual(new["HostConfig"], old["HostConfig"])
        self.assertEqual(new["Entrypoint"], old["Config"]["Entrypoint"])
        self.assertEqual(old, saved)
        self.assertEqual(new["NetworkingConfig"]["EndpointsConfig"]["existing-network"]["Aliases"], ["api", "prdagent-api"])

    def test_wrong_revision_or_container_stops_before_mutation(self):
        for field, value in [("Name", "/another-app"), ("State", {"Running": False})]:
            old = self.fixture()
            old[field] = value
            with self.assertRaises(ValueError):
                module.clone_api_config(old, "a" * 40)
        with self.assertRaises(ValueError):
            module.clone_api_config(self.fixture(), "b" * 40)

    def test_duplicate_or_missing_target_fails_closed(self):
        for values in [[], [module.KEY + "=admin", module.KEY + "=inernoro"]]:
            old = self.fixture()
            old["Config"]["Env"] = values
            with self.assertRaises(ValueError):
                module.clone_api_config(old, "a" * 40)

    def test_dotenv_changes_only_fixed_key_and_is_idempotent(self):
        original = "PRIVATE_KEY=never-output\n" + module.DOTENV_KEY + "=admin\nOTHER=keep\n"
        expected = original.replace(module.DOTENV_KEY + "=admin", module.DOTENV_KEY + "=inernoro")
        self.assertEqual(module.patch_dotenv(original), expected)
        self.assertEqual(module.patch_dotenv(expected), expected)
        with self.assertRaises(ValueError):
            module.patch_dotenv(original + module.DOTENV_KEY + "=another\n")


if __name__ == "__main__":
    unittest.main()
