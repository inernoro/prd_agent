import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('kb_evaluate', ROOT / 'evaluate.py')
evaluator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluator)


class EvaluationTests(unittest.TestCase):
    def setUp(self):
        self.corpus = {'documents': [
            {'entryId': 'a', 'storeId': 's', 'ownerId': 'u', 'isPublic': False, 'content': '住宿上限六百元'},
            {'entryId': 'b', 'storeId': 's', 'ownerId': 'u', 'isPublic': False, 'content': '财务周四付款'},
            {'entryId': 'secret', 'storeId': 'private', 'ownerId': 'other', 'isPublic': False, 'content': '秘密'}]}
        self.questions = {'questions': [{'queryId': 'q', 'category': 'cross_document', 'userId': 'u', 'relevantEntryIds': ['a', 'b'], 'forbiddenEntryIds': ['secret']}]}
        self.row = {'queryId': 'q', 'retrievedEntryIds': ['a', 'a', 'b'], 'contextEntryIds': ['a', 'b'], 'latencyMs': 20,
                    'answerStatus': 'answered', 'answerSupported': True, 'answerEvidence': 'review/answer-q.json',
                    'citations': [{'entryId': 'a', 'quote': '住宿上限六百元', 'url': '/document-store?store=s&entry=a',
                                   'opens': True, 'supports': True, 'openEvidence': 'screenshots/a.png', 'supportEvidence': 'review/a.json'}]}

    def run_eval(self, rows=None):
        return evaluator.evaluate(self.corpus, self.questions, [self.row] if rows is None else rows)

    def test_no_evidence_is_blocked_not_zero(self):
        report = self.run_eval([])
        self.assertEqual(report['verdict'], 'blocked')
        self.assertTrue(all(x['status'] == 'blocked' for x in report['metrics'].values()))
        self.assertEqual(report['permissionIsolation']['status'], 'blocked')

    def test_complete_run_scores_and_deduplicates_recall(self):
        report = self.run_eval()
        self.assertEqual(report['metrics']['recallAt5']['value'], 1)
        self.assertEqual(report['metrics']['citationCorrectness']['value'], 1)
        self.assertEqual(report['metrics']['unsupportedAnswerRate']['value'], 0)

    def test_cross_document_requires_all_relevant_documents(self):
        self.row['retrievedEntryIds'] = ['a']
        self.assertEqual(self.run_eval()['metrics']['recallAt5']['value'], .5)

    def test_five_means_five_results_not_five_unique(self):
        self.row['retrievedEntryIds'] = ['a', 'a', 'a', 'a', 'a', 'b']
        self.assertEqual(self.run_eval()['metrics']['recallAt5']['value'], .5)

    def test_permission_leak_in_context_fails_even_when_not_in_results(self):
        self.row['contextEntryIds'].append('secret')
        report = self.run_eval()
        self.assertEqual(report['verdict'], 'fail')
        self.assertEqual(report['permissionIsolation']['violations'][0]['entryIds'], ['secret'])

    def test_unknown_entry_also_fails_closed(self):
        self.row['retrievedEntryIds'].append('unknown')
        self.assertEqual(self.run_eval()['verdict'], 'fail')

    def test_kb_uri_does_not_count_as_openable_source(self):
        self.row['citations'][0]['url'] = 'kb://stores/s/entries/a'
        report = self.run_eval()
        self.assertEqual(report['metrics']['citationCorrectness']['value'], 0)
        self.assertEqual(report['metrics']['unsupportedAnswerRate']['value'], 1)

    def test_quote_must_exist_in_original(self):
        self.row['citations'][0]['quote'] = '住宿上限一千元'
        self.assertEqual(self.run_eval()['metrics']['citationCorrectness']['value'], 0)

    def test_openable_but_non_supporting_quote_fails(self):
        self.row['citations'][0]['supports'] = False
        self.assertEqual(self.run_eval()['metrics']['citationCorrectness']['value'], 0)

    def test_missing_adjudication_blocks_instead_of_assuming_correctness(self):
        del self.row['answerSupported']
        self.assertEqual(self.run_eval()['metrics']['unsupportedAnswerRate']['status'], 'blocked')

    def test_no_answer_question_answer_is_unsupported(self):
        self.questions['questions'][0]['relevantEntryIds'] = []
        self.assertEqual(self.run_eval()['metrics']['unsupportedAnswerRate']['value'], 1)

    def test_retrieval_only_baseline_does_not_claim_answer_metrics(self):
        self.row['answerStatus'] = 'not_run'
        self.row['citations'] = None
        report = self.run_eval()
        self.assertEqual(report['metrics']['recallAt5']['status'], 'measured')
        self.assertEqual(report['metrics']['citationCorrectness']['status'], 'blocked')
        self.assertEqual(report['metrics']['unsupportedAnswerRate']['status'], 'blocked')

    def test_missing_context_evidence_blocks_isolation(self):
        del self.row['contextEntryIds']
        self.assertEqual(self.run_eval()['permissionIsolation']['status'], 'blocked')

    def test_negative_latency_is_not_valid_evidence(self):
        self.row['latencyMs'] = -1
        self.assertEqual(self.run_eval()['metrics']['retrievalLatencyMs']['status'], 'blocked')

    def test_duplicate_query_observation_is_rejected(self):
        with self.assertRaises(ValueError):
            self.run_eval([self.row, self.row])

    def test_unknown_query_is_rejected(self):
        self.row['queryId'] = 'invented'
        with self.assertRaises(ValueError):
            self.run_eval()

    def test_fixed_set_covers_required_categories(self):
        questions = evaluator.load_json(ROOT / 'questions.json')['questions']
        self.assertGreaterEqual(len(questions), 30)
        self.assertTrue({'synonym', 'cross_document', 'no_answer', 'no_permission'} <= {q['category'] for q in questions})
        self.assertEqual(len(questions), len({q['queryId'] for q in questions}))
        documents = evaluator.load_json(ROOT / 'corpus.json')['documents']
        ids = {doc['entryId'] for doc in documents}
        self.assertTrue(all(set(q['relevantEntryIds'] + q['forbiddenEntryIds']) <= ids for q in questions))


if __name__ == '__main__':
    unittest.main()
