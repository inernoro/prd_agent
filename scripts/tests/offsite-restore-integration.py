#!/usr/bin/env python3
"""Real local Mongo restore: late archive metadata closes cross-database pointers."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest


class ArchiveDirectoryRestoreTests(unittest.TestCase):
    def test_late_directory_is_restored_and_missing_directory_is_rejected(self):
        for binary in ('mongod', 'mongosh', 'mongodump', 'mongorestore'):
            self.assertIsNotNone(shutil.which(binary), 'Actual Mongo tools are required')
        root = Path(tempfile.mkdtemp(prefix='map-offsite-restore-test-'))
        data = root / 'fixture-data'
        data.mkdir()
        sock = socket.socket()
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
        sock.close()
        log = (root / 'fixture.log').open('wb')
        fixture = subprocess.Popen(['mongod', '--dbpath', str(data), '--bind_ip', '127.0.0.1',
            '--port', str(port), '--nounixsocket', '--wiredTigerCacheSizeGB', '0.5',
            '--setParameter', 'ttlMonitorEnabled=false'], stdout=log, stderr=log)

        def query(js):
            return subprocess.check_output(['mongosh', '--quiet', '--host', '127.0.0.1', '--port', str(port),
                                            '--eval', js], text=True).strip()

        def sha(path):
            with path.open('rb') as stream:
                return hashlib.file_digest(stream, 'sha256').hexdigest()

        backup = root / 'backup'
        backup.mkdir()
        try:
            for _ in range(200):
                if fixture.poll() is not None:
                    self.fail('Fixture Mongo failed')
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=.1):
                        break
                except OSError:
                    time.sleep(.1)
            key = b'fictional-restoration-test-key-0'
            self.assertEqual(len(key), 32)
            query('db.getSiblingDB("prdagent").createCollection("log_archive_batches");'
                  'db.getSiblingDB("prdagent").apirequestlogs.insertOne({_id:"cold-log",ColdArchiveId:"late-batch",StartedAt:new Date(0)});'
                  'db.getSiblingDB("llm_gateway").fixture.insertOne({_id:"gateway"});'
                  'db.getSiblingDB("admin").fixture.insertOne({_id:"admin"});')
            manifest = {'status': 'completed', 'scope': ['prdagent', 'llm_gateway', 'admin'],
                        'exclusions': [], 'archives': []}
            for database in manifest['scope']:
                name = database + '.archive.gz'
                with (backup / (database + '.dump.log')).open('wb') as output:
                    subprocess.run(['mongodump', '--host', '127.0.0.1', '--port', str(port), '--db', database,
                                    '--archive=' + str(backup / name), '--gzip'], stdout=output, stderr=output, check=True)
                manifest['archives'].append({'database': database, 'file': name, 'sha256': sha(backup / name)})
            # This directory entry is intentionally newer than the primary prdagent dump.
            query('db.getSiblingDB("prdagent").log_archive_batches.insertOne({_id:"late-batch",Source:"api",'
                  'StorageKey:"fictional/cold.bin",PlainSha256:"fictional-plain",CipherSha256:"fictional-cipher",KeyId:'
                  + json.dumps(hashlib.sha256(key).hexdigest()[:16]) + '});')
            name = 'log-archive-index.archive.gz'
            with (backup / 'log-archive-index.dump.log').open('wb') as output:
                subprocess.run(['mongodump', '--host', '127.0.0.1', '--port', str(port), '--db', 'prdagent',
                    '--collection', 'log_archive_batches', '--archive=' + str(backup / name), '--gzip'],
                    stdout=output, stderr=output, check=True)
            manifest['archiveMetadataSupplement'] = {'database': 'prdagent', 'collection': 'log_archive_batches',
                                                      'file': name, 'sha256': sha(backup / name)}
            indexes = query('const out={};for(const name of ["prdagent","llm_gateway","admin"]){'
                'const d=db.getSiblingDB(name);out[name]=d.getCollectionInfos({type:"collection"}).map(c=>'
                '({name:c.name,indexes:d.getCollection(c.name).getIndexes()}));}print(EJSON.stringify(out));')
            (backup / 'indexes.json').write_text(indexes)
            manifest['indexSnapshotSha256'] = sha(backup / 'indexes.json')
            (backup / 'api-environment.snapshot.json').write_text(json.dumps([
                'LogArchive__EncryptionKey=' + base64.b64encode(key).decode()]))
            manifest_path = backup / 'manifest.json'
            manifest_path.write_text(json.dumps(manifest))
            script = Path(__file__).resolve().parents[1] / 'prd-agent-isolated-restore.py'
            with (root / 'success.log').open('wb') as output:
                subprocess.run([os.sys.executable, str(script), '--backup', str(backup), '--work', str(root / 'complete')],
                               stdout=output, stderr=output, check=True)
            result = json.loads((root / 'complete/result.json').read_text())
            self.assertEqual(result['coldArchiveReferences']['missing'], 0)
            self.assertTrue(result['coldArchiveReferences']['offsiteDecryptionKeyAvailable'])
            self.assertEqual(result['coldArchiveReferences']['sources'][0]['pointers'], 1)
            self.assertTrue(result['isolatedProcessStopped'])
            del manifest['archiveMetadataSupplement']
            manifest_path.write_text(json.dumps(manifest))
            with (root / 'failure.log').open('wb') as output:
                rejected = subprocess.run([os.sys.executable, str(script), '--backup', str(backup), '--work', str(root / 'incomplete')],
                                          stdout=output, stderr=output)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn('no complete archive directory entry', (root / 'failure.log').read_text())
            self.assertTrue(json.loads((root / 'incomplete/result.json').read_text())['isolatedProcessStopped'])
        finally:
            fixture.terminate()
            fixture.wait(timeout=30)
            log.close()
            shutil.rmtree(root)


if __name__ == '__main__':
    unittest.main()
