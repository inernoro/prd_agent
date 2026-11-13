"""Offline evidence merge tests; no model, browser, HTTP or account access."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('kb_merge', ROOT / 'merge_observations.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MergeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.ids = [f'KB-{number:03}' for number in range(1, 41)]
        self.plan = {'expectedQueryIds': self.ids, 'baseUrl': 'https://preview.example',
                     'fixedInputSha256': {'corpus.json': 'frozen-corpus', 'questions.json': 'frozen-questions'},
                     'runtimeInputSha256': {}, 'serviceRevisionForCollection': 'c83b40b62fe94943cef458ae9aff1d424af0cbf0'}
        self.pilot, self.remaining = self.root / 'pilot', self.root / 'remaining'
        for directory in (self.pilot, self.remaining):
            directory.mkdir()
            (directory / 'runtime-corpus.json').write_text('{"documents":[]}\n')
            (directory / 'runtime-questions.json').write_text(json.dumps({'questions': [{'queryId': key} for key in self.ids]}))
        self.plan['runtimeInputSha256'] = {name: module.sha256(self.pilot / name)
                                           for name in ('runtime-corpus.json', 'runtime-questions.json')}
        self.write_run(self.pilot, self.ids[:1])
        self.write_run(self.remaining, self.ids[1:])
        self.plan_path = self.root / 'plan.json'
        self.plan_path.write_text(json.dumps(self.plan))
        self.output = self.root / 'merged'

    def tearDown(self):
        self.temp.cleanup()

    def write_run(self, directory, ids):
        rows = [{'queryId': key, 'collectionStatus': 'blocked' if key == 'KB-040' else 'collected',
                 'answerStatus': 'pending_review', 'finalAnswer': 'uncertain answer',
                 'citations': [{'entryId': 'unknown', 'url': 'https://wrong.example/bad', 'opens': False, 'supports': None}]}
                for key in ids]
        # Noncanonical spacing ensures the merge really preserves raw rows, not just parsed values.
        (directory / 'observations.jsonl').write_text(''.join(json.dumps(row, separators=(', ', ': ')) + '\n' for row in rows))
        manifest = {'baseUrl': self.plan['baseUrl'], 'fixedInputSha256': self.plan['fixedInputSha256'], 'questionCount': len(ids)}
        (directory / 'manifest.json').write_text(json.dumps(manifest))

    def merge(self):
        return module.merge(self.plan_path, [self.pilot, self.remaining], self.output)

    def test_merges_exactly_40_once_and_preserves_every_raw_byte_and_bad_citation(self):
        source = (self.pilot / 'observations.jsonl').read_bytes() + (self.remaining / 'observations.jsonl').read_bytes()
        report = self.merge()
        self.assertEqual((self.output / 'observations.jsonl').read_bytes(), source)
        rows = [json.loads(line) for line in source.splitlines()]
        self.assertEqual(rows[-1]['collectionStatus'], 'blocked')
        self.assertEqual(rows[0]['citations'][0]['url'], 'https://wrong.example/bad')
        self.assertEqual(report['questionCount'], 40)
        self.assertFalse(report['serviceRevisionVerifiedByMerge'])
        template = json.loads((self.output / 'review-template.json').read_text())
        self.assertEqual(len(template['questions']), 40)
        self.assertIsNone(template['questions'][0]['answerSupported'])
        self.assertFalse(template['questions'][0]['citations'][0]['opens'])
        self.assertEqual((self.output / 'observations.jsonl').stat().st_mode & 0o777, 0o600)

    def test_duplicate_kb001_full40_plus_pilot_is_rejected_without_output(self):
        self.write_run(self.remaining, self.ids)
        with self.assertRaises(module.CollectionError):
            self.merge()
        self.assertFalse(self.output.exists())

    def test_missing_question_is_not_reported_as_a_complete_merge(self):
        self.write_run(self.remaining, self.ids[1:-1])
        with self.assertRaises(module.CollectionError):
            self.merge()
        self.assertFalse(self.output.exists())

    def test_changed_runtime_corpus_or_question_hash_is_rejected(self):
        (self.remaining / 'runtime-corpus.json').write_text('{"documents":["changed"]}')
        with self.assertRaises(module.CollectionError):
            self.merge()
        self.assertFalse(self.output.exists())

    def test_changed_fixed_input_hash_or_origin_is_rejected(self):
        manifest = json.loads((self.remaining / 'manifest.json').read_text())
        manifest['baseUrl'] = 'https://different.example'
        (self.remaining / 'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaises(module.CollectionError):
            self.merge()
        self.assertFalse(self.output.exists())

    def test_existing_output_is_immutable(self):
        self.merge()
        original = (self.output / 'observations.jsonl').read_bytes()
        with self.assertRaises(module.CollectionError):
            self.merge()
        self.assertEqual((self.output / 'observations.jsonl').read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
