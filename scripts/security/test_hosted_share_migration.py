import importlib.util
import pathlib
import unittest
import uuid
from pymongo import MongoClient

spec = importlib.util.spec_from_file_location('migration', pathlib.Path(__file__).with_name('migrate-hosted-share-passwords.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class MigrationTests(unittest.TestCase):
    def test_migration_restart_restore_and_reset_conflict(self):
        client = MongoClient('mongodb://127.0.0.1:27083', serverSelectionTimeoutMS=5000)
        name = 'kd13_migration_' + uuid.uuid4().hex
        try:
            c = client[name].web_page_share_links
            original = {'_id': 'legacy', 'Password': 'synthetic-password', 'Token': 'stable-token', 'RecentAttempts': [1]}
            c.insert_one(original)
            self.assertEqual(1, m.migrate(c)['eligible'])
            self.assertIn('Password', c.find_one())
            self.assertEqual(1, m.migrate(c, True)['migrated'])
            migrated = c.find_one()
            self.assertNotIn('Password', migrated)
            self.assertEqual('stable-token', migrated['Token'])
            self.assertEqual([1], migrated['RecentAttempts'])
            self.assertEqual(0, m.migrate(c, True)['scanned'])
            # A restored legacy backup is isolated and migrated before becoming readable.
            c.replace_one({'_id': 'legacy'}, original)
            self.assertEqual(1, m.migrate(c, True)['migrated'])
            # A staged update cannot overwrite a reset that wins the race.
            stale = dict(original, _id='conflict')
            c.insert_one(stale)
            update = m.plan(stale)
            c.update_one({'_id': 'conflict'}, {'$set': {'Password': 'reset-password'}})
            self.assertEqual(0, c.update_one(*update).modified_count)
            bad = dict(migrated, _id='bad', Password='wrong-password')
            c.insert_one(bad)
            self.assertEqual(1, m.migrate(c, True)['invalid'])
            self.assertIn('Password', c.find_one({'_id': 'bad'}))
        finally:
            client.drop_database(name)
            client.close()

if __name__ == '__main__':
    unittest.main()
