"""Protocol tests use a local deterministic fake, never a model or production data."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('collect', ROOT / 'collect.py')
collect = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collect)


def event(seq, type, **payload):
    return {'seq': seq, 'type': type, 'payload': payload}


def search(seq, ids, latency=13, mode='semantic', tool_id='s'):
    return event(seq, 'tool_finished', tool='kb_search', toolUseId=tool_id, ok=True,
                 retrievalEvidence={'mode': mode, 'retrievedEntryIds': ids, 'contextEntryIds': ids,
                                    'retrievalLatencyMs': latency})


def result(events, message=None):
    return collect.observation_from_events('KB-001', events,
           message or {'status': 'completed', 'content': '结论[原文](/document-store?store=st&entry=a)'},
           'https://preview.example', 50)


class ObservationTests(unittest.TestCase):
    def test_multiline_sse_comments_and_crlf(self):
        data = b': heartbeat\r\nid: 4\r\nevent: done\r\ndata: {\r\ndata: "text": "ok"}\r\n\r\n'
        self.assertEqual(list(collect.sse_events(io.BytesIO(data))), [event(4, 'done', text='ok')])

    def test_incomplete_last_frame_not_dispatched(self):
        self.assertEqual(list(collect.sse_events(io.BytesIO(b'id: 1\nevent: done\ndata: {}'))), [])

    def test_bad_json_is_blocked(self):
        with self.assertRaises(collect.CollectionError):
            list(collect.sse_events(io.BytesIO(b'id: 1\ndata: not-json\n\n')))

    def test_first_semantic_order_and_latency_not_merged_or_summed(self):
        row = result([search(1, ['literal'], 90, mode='literal'), search(2, ['b', 'a', 'b'], 14),
                      search(3, ['c'], 70, tool_id='s2')])
        self.assertEqual(row['retrievedEntryIds'], ['b', 'a', 'b'])
        self.assertEqual(row['latencyMs'], 14)
        self.assertEqual(len(row['searchCalls']), 3)
        self.assertEqual(row['contextEntryIds'], ['literal', 'b', 'a', 'c'])

    def test_read_context_is_merged_without_affecting_retrieval_order(self):
        row = result([search(1, ['a']), event(2, 'tool_finished', tool='kb_read', toolUseId='r', ok=True,
                      retrievalEvidence={'mode': 'read', 'retrievedEntryIds': [], 'contextEntryIds': ['b'], 'retrievalLatencyMs': None})])
        self.assertEqual(row['retrievedEntryIds'], ['a'])
        self.assertEqual(row['contextEntryIds'], ['a', 'b'])

    def test_literal_only_does_not_fill_semantic_metrics(self):
        row = result([search(1, ['a'], mode='literal')])
        self.assertIsNone(row['retrievedEntryIds'])
        self.assertIsNone(row['latencyMs'])
        self.assertEqual(row['collectionStatus'], 'blocked')

    def test_missing_read_evidence_blocks_context(self):
        row = result([search(1, ['a']), event(2, 'tool_finished', tool='kb_read', ok=True)])
        self.assertIsNone(row['contextEntryIds'])
        self.assertEqual(row['contextEntryIdsObserved'], ['a'])

    def test_failed_semantic_search_is_not_valid_empty_retrieval(self):
        row = result([event(1, 'tool_finished', tool='kb_search', ok=False, message='NO_EMBEDDING_MODEL')])
        self.assertIsNone(row['retrievedEntryIds'])
        self.assertIsNone(row['latencyMs'])

    def test_real_empty_semantic_result_is_valid(self):
        row = result([search(1, [])])
        self.assertEqual(row['retrievedEntryIds'], [])
        self.assertEqual(row['contextEntryIds'], [])

    def test_unknown_read_tool_name_uses_started_correlation(self):
        row = result([search(1, ['a']), event(2, 'tool_started', tool='kb_read', toolUseId='r'),
                      event(3, 'tool_finished', toolUseId='r', ok=True,
                      retrievalEvidence={'mode': 'read', 'contextEntryIds': ['b']})])
        self.assertEqual(row['contextEntryIds'], ['a', 'b'])

    def test_no_keyword_support_or_refusal_inference(self):
        row = result([search(1, ['a'])], {'status': 'completed', 'content': '未找到答案 [原文](/document-store?store=st&entry=a)'})
        self.assertEqual(row['answerStatus'], 'pending_review')
        self.assertIsNone(row['answerSupported'])
        self.assertIsNone(row['citations'][0]['quote'])
        self.assertIsNone(row['citations'][0]['opens'])
        self.assertIsNone(row['citations'][0]['supports'])

    def test_final_failed_message_blocks_even_with_search_evidence(self):
        self.assertEqual(result([search(1, ['a'])], {'status': 'failed', 'content': 'partial'})['collectionStatus'], 'blocked')

    def test_review_cannot_rewrite_observed_citation(self):
        row = result([search(1, ['a'])])
        review = collect.review_template([row])
        item = review['questions'][0]
        item.update(answerStatus='answered', answerSupported=True, answerEvidence='review/a.json')
        item['citations'][0]['url'] = '/document-store?store=st&entry=b'
        with self.assertRaises(collect.CollectionError):
            collect.apply_review([row], review)

    def test_pending_review_preserves_blocked_fields(self):
        row = result([search(1, ['a'])])
        self.assertEqual(collect.apply_review([row], collect.review_template([row]))[0]['answerStatus'], 'pending_review')

    def test_external_markdown_link_is_retained_as_unverified_candidate(self):
        citations = collect.citations_from_markdown('[source](https://other.example/not-an-original)', 'https://preview.example')
        self.assertFalse(citations[0]['sameOrigin'])
        self.assertFalse(citations[0]['isKnowledgeSource'])
        self.assertIsNone(citations[0]['entryId'])

    def test_mapping_preserves_restricted_store_and_identities(self):
        corpus = json.loads((ROOT / 'corpus.json').read_text())
        questions = json.loads((ROOT / 'questions.json').read_text())
        mapping = {'temporaryFixturesConfirmed': True, 'users': {'evaluation-user': 'u', 'other-user': 'other'},
                   'entries': {doc['entryId']: {'entryId': 'real-' + doc['entryId'], 'storeId': 'real-' + doc['storeId']} for doc in corpus['documents']}}
        mapped_corpus, mapped_questions = collect.remap_inputs(corpus, questions, mapping)
        self.assertEqual(mapped_questions['questions'][0]['userId'], 'u')
        self.assertEqual(mapped_corpus['documents'][-1]['ownerId'], 'other')
        mapping['entries']['private-payroll']['storeId'] = 'real-evaluation-store'
        mapping['entries']['private-acquisition']['storeId'] = 'real-evaluation-store'
        with self.assertRaises(collect.CollectionError):
            collect.remap_inputs(corpus, questions, mapping)


class FakeServerTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.stream_count = 0
        self.reject_message = False
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def request(self):
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
                owner.requests.append((self.command, self.path, dict(self.headers), body))
                if self.path == '/api/v1/auth/login':
                    value = {'accessToken': 'normal-login-token'}
                elif self.path == '/api/authz/me':
                    value = {'userId': 'u'}
                elif self.path == '/api/chat-agent/sessions':
                    value = {'item': {'id': 'session'}}
                elif self.path == '/api/chat-agent/sessions/session/messages' and self.command == 'POST':
                    if owner.reject_message:
                        self.send_error(503)
                        return
                    value = {'turnId': 'turn', 'assistantMessageId': 'assistant', 'seq': 1}
                elif self.path.startswith('/api/chat-agent/sessions/session/messages?'):
                    value = {'items': [{'id': 'assistant', 'turnId': 'turn', 'status': 'completed', 'content': '住宿六百元[原文](/document-store?store=st&entry=a)'}]}
                elif self.path.startswith('/api/chat-agent/sessions/session/stream?'):
                    owner.stream_count += 1
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
                    self.end_headers()
                    if owner.stream_count == 1:
                        events = [event(1, 'turn_started', turnId='turn'), search(2, ['a'])]
                    else:
                        # Duplicate event on reconnection must not double-count the call.
                        events = [search(2, ['a']), event(3, 'tool_finished', tool='kb_read', toolUseId='r', ok=True,
                                  retrievalEvidence={'mode': 'read', 'contextEntryIds': ['b']}), event(4, 'done', text='finished')]
                    for item in events:
                        frame = f"id: {item['seq']}\nevent: {item['type']}\ndata: {json.dumps(item['payload'])}\n\n"
                        self.wfile.write(frame.encode())
                    return
                else:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'success': True, 'data': value}).encode())

            do_GET = request
            do_POST = request

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_normal_session_post_sse_resume_final_readback(self):
        client = collect.Client(f'http://127.0.0.1:{self.server.server_port}', 'test-access-token')
        self.assertEqual(client.authenticate(), 'u')
        journal = []
        row, events = collect.collect_question(client, {'queryId': 'KB-001', 'query': '住宿多少钱？'}, 'st', journal=lambda state: journal.append(copy.deepcopy(state)))
        self.assertEqual(row['collectionStatus'], 'collected')
        self.assertEqual(row['retrievedEntryIds'], ['a'])
        self.assertEqual(row['contextEntryIds'], ['a', 'b'])
        self.assertEqual(len(row['searchCalls']), 1)
        self.assertEqual(row['latencyMs'], 13)
        self.assertEqual(len(events), 4)
        self.assertEqual(journal[0]['phase'], 'message_acceptance_unknown')
        self.assertEqual(journal[0]['sessionId'], 'session')
        self.assertTrue(any('afterSeq=2' in request[1] for request in self.requests))
        self.assertEqual(sum(method == 'POST' and path.endswith('/messages') for method, path, _, _ in self.requests), 1)
        for _, path, headers, body in self.requests:
            self.assertEqual(headers.get('Authorization'), 'Bearer test-access-token')
            self.assertFalse(any('permit' in key.lower() or 'impersonate' in key.lower() for key in headers))
            self.assertNotIn('/gw/', path)
            self.assertNotIn('taskPermitId', body)

    def test_normal_login_instead_of_impersonation(self):
        client = collect.Client(f'http://127.0.0.1:{self.server.server_port}')
        with patch.dict(collect.os.environ, {'KB_EVAL_USERNAME': 'evaluation-login', 'KB_EVAL_PASSWORD': 'dummy-password'}):
            self.assertEqual(client.authenticate(), 'u')
        self.assertEqual(self.requests[0][1], '/api/v1/auth/login')
        self.assertEqual(self.requests[0][3]['clientType'], 'admin')
        self.assertNotIn('Authorization', self.requests[0][2])
        self.assertEqual(self.requests[1][2]['Authorization'], 'Bearer normal-login-token')

    def test_unknown_message_acceptance_retains_session_and_does_not_retry(self):
        self.reject_message = True
        client = collect.Client(f'http://127.0.0.1:{self.server.server_port}', 'test-access-token')
        journal = []
        with self.assertRaises(collect.CollectionError):
            collect.collect_question(client, {'queryId': 'KB-001', 'query': '住宿多少钱？'}, 'st', journal=lambda state: journal.append(copy.deepcopy(state)))
        self.assertEqual(journal[-1]['sessionId'], 'session')
        self.assertEqual(journal[-1]['phase'], 'message_acceptance_unknown')
        self.assertEqual(sum(method == 'POST' and path.endswith('/messages') for method, path, _, _ in self.requests), 1)

    def test_redirect_and_credential_origins_are_rejected(self):
        with self.assertRaises(collect.CollectionError):
            collect.Client('https://token@example.test')
        with self.assertRaises(collect.CollectionError):
            collect.Client('http://production.example')


if __name__ == '__main__':
    unittest.main()
