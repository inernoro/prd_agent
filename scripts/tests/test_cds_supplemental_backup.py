"""Exercise the conditions that must prevent an incomplete backup from passing."""

import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "cds_supplemental_backup", Path(__file__).parents[1] / "cds-supplemental-backup.py"
)
BACKUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BACKUP)


class KafkaBackupTests(unittest.TestCase):
    def backup(self, end=0, group="", listed="one", config=""):
        def reply(_target, executable, *args):
            if executable == "kafka-topics.sh" and args == ("--list",):
                return listed + "\n"
            if executable == "kafka-topics.sh":
                return f"Topic: one\tTopicId: abc\tPartitionCount: 1\tReplicationFactor: 1\tConfigs: {config}"
            if executable == "kafka-consumer-groups.sh":
                return group
            return f"one:0:{end if args[-1] == 'latest' else 0}"

        with patch.object(BACKUP, "inspect", return_value={"Id": "same"}), patch.object(
            BACKUP, "kafka_cli", side_effect=reply
        ):
            return BACKUP.kafka_backup({})

    def test_empty_topics_can_be_recovered(self):
        self.assertEqual(
            self.backup()["topics"], [{"topic": "one", "partitions": 1, "replicationFactor": 1}]
        )

    def test_added_data_and_committed_groups_require_a_wider_method(self):
        for variant in ({"end": 5}, {"group": "live-group"}):
            with self.subTest(variant=variant), self.assertRaisesRegex(BACKUP.BackupError, "full data"):
                self.backup(**variant)

    def test_mismatched_inventory_and_custom_configuration_fail(self):
        with self.assertRaisesRegex(BACKUP.BackupError, "disagree"):
            self.backup(listed="one\ntwo")
        with self.assertRaisesRegex(BACKUP.BackupError, "custom topic configuration"):
            self.backup(config="cleanup.policy=compact")


class ObjectBackupTests(unittest.TestCase):
    def test_versioned_buckets_are_not_reported_as_covered(self):
        class Source:
            def request(self, _method, _path, operation, **_kwargs):
                if operation == "list-buckets":
                    return 200, {}, b"<Result><Buckets><Bucket><Name>data</Name></Bucket></Buckets></Result>"
                return 200, {}, b"<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>"

        with self.assertRaisesRegex(BACKUP.BackupError, "version history"):
            BACKUP.inventory(Source())


if __name__ == "__main__":
    unittest.main()
