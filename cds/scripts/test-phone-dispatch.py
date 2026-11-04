import importlib.util
import json
from pathlib import Path
import unittest


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

m = load('phone-dispatch'); relay = load('independent-alarm-relay'); monitor = load('independent-monitor')

class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.state = {}; self.calls = []; self.snapshots = []
        self.channel = {'id': 'phone', 'enabled': True, 'bark': {'key': 'test-only'}}
        self.guard = m.PhoneDispatch(self.state, lambda: self.snapshots.append(json.loads(json.dumps(self.state))), lambda c, msg: self.calls.append(msg) or True)
    def submit(self, identifier, now=0, level='active'):
        return self.guard.submit(self.channel, {'title': identifier, 'body': 'test', 'level': level, 'url': 'https://status.example/#feed=public'}, identifier, now)
    def test_hundred_distinct_incidents_one_summary_all_receipts(self):
        for i in range(100): self.submit(str(i))
        self.guard.flush(29); self.assertEqual(self.calls, [])
        self.guard.flush(30); self.assertEqual(len(self.calls), 1)
        self.assertIn('100', self.calls[0]['title'])
        self.assertEqual(len(next(iter(self.state['destinations'].values()))['receipts']), 100)
        self.assertTrue(self.submit('99', 40))
    def test_new_faults_same_source_preserved_and_bounded(self):
        self.submit('first'); self.guard.flush(30)
        self.submit('second', 31); self.guard.flush(90)
        self.assertEqual(len(self.calls), 2)
        for i in range(100): self.submit('new-' + str(i), 91)
        self.guard.flush(329); self.assertEqual(len(self.calls), 2)
        self.guard.flush(330); self.assertEqual(len(self.calls), 3)
        self.assertIn('100', self.calls[-1]['title'])
        self.assertIn('new-0', self.calls[-1]['body'])
    def test_restart_after_send_intent_and_unknown_result_no_replay(self):
        self.submit('first'); self.guard.flush(30)
        reserved = next(s for s in self.snapshots if next(iter(s['destinations'].values()))['receipts'])
        guard = m.PhoneDispatch(reserved, lambda: None, lambda c, msg: self.fail('replayed'))
        self.assertFalse(guard.submit(self.channel, {}, 'first', 40))
        guard.flush(400)
    def test_duplicate_channel_same_phone_does_not_get_extra_budget(self):
        for i in range(100):
            channel = {**self.channel, 'id': str(i)}
            self.guard.submit(channel, {'title': str(i)}, str(i), 0)
        self.guard.flush(30)
        self.assertEqual(len(self.calls), 1)
    def test_platform_and_relay_share_budget_without_suppressing_independent_fault(self):
        items = {}
        for i in range(100):
            items[str(i)] = {'id': str(i), 'channelId': 'phone', 'receivedAt': 0,
                'message': {'title': '故障 ' + str(i), 'body': 'test'},
                'event': {'targetId': str(i), 'correlationKey': 'shared' if i < 99 else 'independent', 'kind': 'business-down', 'projectId': 'business'}}
        state = {'channels': [self.channel], 'inbox': items}
        relay.process(state, 31, lambda: None, dispatcher=self.guard)
        self.assertEqual(len(next(iter(self.state['destinations'].values()))['pending']), 2)
        self.submit('platform-outage', 31)
        self.guard.flush(61)
        relay.process(state, 62, lambda: None, dispatcher=self.guard)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(state['receipts']), 100)
        self.assertIn('故障 99', self.calls[0]['body'])
        self.assertIn('platform-outage', self.calls[0]['body'])
    def test_queued_platform_is_not_reported_accepted_and_persisted_before_send(self):
        state = {'incident': {'id': 'incident', 'reason': 'unreachable'}}
        config = {'bark': self.channel['bark'], 'publicUrl': 'https://status.example/'}
        self.assertEqual(monitor.notify(config, state, 'down', 0, self.guard), 'queued')
        self.assertNotIn('deliveries', state)
        self.guard.flush(30)
        self.assertTrue(monitor.notify(config, state, 'down', 40, self.guard))
        self.assertTrue(state['deliveries'][0]['accepted'])
    def test_real_http_transport_receives_one_request_for_hundred_incidents(self):
        from http.server import BaseHTTPRequestHandler, HTTPServer
        from threading import Thread
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.send_response(200); self.end_headers(); self.wfile.write(b'{"code":200}')
            def log_message(self, *args): pass
        server = HTTPServer(('127.0.0.1', 0), Handler)
        worker = Thread(target=server.serve_forever, daemon=True); worker.start()
        try:
            guard = m.PhoneDispatch({}, lambda: None, relay.send)
            channel = {'bark': {'key': 'test-sink', 'serverUrl': 'http://127.0.0.1:' + str(server.server_port)}}
            for i in range(100): guard.submit(channel, {'title': '独立故障 ' + str(i), 'body': 'test'}, str(i), 0)
            guard.flush(30)
            self.assertEqual(len(requests), 1)
            self.assertEqual(requests[0]['title'], '有 100 项监控变化，请查看')
        finally:
            server.shutdown(); server.server_close(); worker.join()

    def test_drills_share_normal_budget(self):
        for i in range(100): self.submit('drill-' + str(i))
        self.guard.flush(30); self.assertEqual(len(self.calls), 1)

class PriorityTests(DispatchTests):
    def urgent(self, identifier, now, root=None):
        return self.guard.submit(self.channel, {'title': identifier, 'body': 'test'}, identifier, now, urgent_key=root or identifier)
    def test_urgent_after_normal_budget_immediate_then_bounded(self):
        self.submit('normal1'); self.guard.flush(30)
        self.submit('normal2', 31); self.guard.flush(90)
        self.urgent('urgent1', 91); self.guard.flush(91)
        self.assertEqual(len(self.calls), 3)
        self.urgent('urgent2', 92); self.guard.flush(92)
        self.assertEqual(len(self.calls), 3)
        self.guard.flush(151); self.assertEqual(self.calls[-1]['title'], 'urgent2')
    def test_urgent_storm_hundred_one_batch_no_random_identity_escape(self):
        for i in range(100): self.urgent(str(i), 0)
        self.guard.flush(0); self.assertEqual(len(self.calls), 1)
        self.urgent('random-new-id', 60, '0'); self.guard.flush(60)
        self.assertEqual(len(self.calls), 1)
        restarted = m.PhoneDispatch(json.loads(json.dumps(self.state)), lambda: None, lambda c, msg: self.calls.append(msg) or True)
        restarted.flush(60); self.assertEqual(len(self.calls), 1)
        restarted.flush(90); self.assertEqual(len(self.calls), 2)
    def test_relay_urgent_does_not_wait_thirty_seconds(self):
        state = {'channels': [self.channel], 'inbox': {'a': {'id': 'a', 'channelId': 'phone', 'receivedAt': 0,
            'message': {'title': '生产故障'}, 'event': {'urgency': 'urgent', 'kind': 'business-down', 'targetId': 'service', 'projectId': 'business'}}}}
        relay.process(state, 0, lambda: None, dispatcher=self.guard)
        self.guard.flush(0); self.assertEqual(len(self.calls), 1)
        relay.process(state, 1, lambda: None, dispatcher=self.guard)
        self.assertTrue(state['receipts']['a']['ok'])
    def test_severe_new_keys_have_five_per_rolling_window_limit(self):
        self.guard.persist = lambda: None
        for i in range(1200): self.submit('old-' + str(i))
        for t in range(0, 300, 5):
            self.urgent('new-' + str(t), t); self.guard.flush(t)
        self.assertEqual(len(self.calls), 5)
        self.assertIn('new-0', self.calls[0]['body'])

if __name__ == '__main__': unittest.main()
