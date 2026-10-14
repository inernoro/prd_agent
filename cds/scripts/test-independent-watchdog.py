import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('watchdog', Path(__file__).with_name('independent-watchdog.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
CONFIG = {'bark': {'key': 'private-fixture'}, 'publicUrl': 'https://status.example/#feed=https%3A%2F%2Fdata.example%2Fheartbeat',
    'watchdogPublicUrl': 'https://data.example/watchdog', 'iconUrl': 'https://status.example/avatar.png'}
BAD = {'healthy': False, 'reason': 'stale'}
GOOD = {'healthy': True, 'reason': 'fresh'}


class WatchdogTest(unittest.TestCase):
    def setUp(self):
        self.state = {'version': 1}; self.disk = {}; self.sent = []
    def save(self, state):
        self.disk = copy.deepcopy(state)
    def sender(self, config, body):
        self.sent.append(body); return 'accepted'
    def tick(self, observation, now):
        return m.tick(CONFIG, self.state, observation, now, self.save, self.sender)
    def test_outage_repeated_checks_and_restart_send_once(self):
        self.tick(BAD, 1000)
        for now in [1300, 1600, 1900]:
            self.state = copy.deepcopy(self.disk)
            self.tick(BAD, now)
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(len(self.state['receipts']), 1)
    def test_recovery_once_after_three_fresh_checks_and_ten_minutes(self):
        self.tick(BAD, 1000)
        for now in [1300, 1600]:
            self.tick(GOOD, now); self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.tick(GOOD, 1900), 'recovered')
        self.state = copy.deepcopy(self.disk); self.tick(GOOD, 2200)
        self.assertEqual(len(self.sent), 2)
        self.assertIn('心跳已恢复', self.sent[1]['title'])
    def test_new_independent_outage_is_not_suppressed(self):
        self.tick(BAD, 1000)
        for now in [1300, 1600, 1900]: self.tick(GOOD, now)
        self.tick(BAD, 2200)
        self.assertEqual(len(self.sent), 3)
        self.assertNotEqual(self.state['incident']['id'], self.state['history'][0]['id'])
    def test_scheduler_gap_and_flapping_do_not_count_as_stable_recovery(self):
        self.tick(BAD, 1000); self.tick(GOOD, 1300); self.tick(GOOD, 2500)
        self.assertEqual(len(self.sent), 1)
        self.tick(BAD, 2800); self.tick(GOOD, 3100); self.tick(GOOD, 3400)
        self.assertEqual(len(self.sent), 1)
    def test_primary_down_does_not_create_dead_monitor_alert(self):
        snapshot = {'updatedAt': m.iso(1000), 'reachable': False, 'dataOk': False,
            'incident': {'reason': 'unreachable'}, 'metrics': [{'state': 'down'}]}
        self.tick(m.assess(snapshot, 1100), 1100)
        self.assertFalse(self.sent)
    def test_read_failures_need_two_rounds_and_do_not_assert_business_down(self):
        unreadable = {'healthy': False, 'reason': 'unreadable'}
        self.tick(unreadable, 1000); self.assertFalse(self.sent)
        self.tick(unreadable, 1300); self.assertEqual(len(self.sent), 1)
        self.assertIn('可能是网络', self.sent[0]['body'])
        self.tick(BAD, 1600); self.assertEqual(len(self.sent), 1)
    def test_missing_invalid_future_and_naive_time_are_not_healthy(self):
        for snapshot in [{}, {'updatedAt': 'bad'}, {'updatedAt': m.iso(2000)}, {'updatedAt': '2026-10-14T12:00:00'}]:
            self.assertFalse(m.assess(snapshot, 1000)['healthy'])
        self.assertFalse(m.assess({'updatedAt': m.iso(819)}, 1000)['healthy'])
        self.assertTrue(m.assess({'updatedAt': m.iso(820)}, 1000)['healthy'])
    def test_save_failure_prevents_send(self):
        with self.assertRaises(OSError):
            m.tick(CONFIG, self.state, BAD, 1000, lambda _: (_ for _ in ()).throw(OSError()), self.sender)
        self.assertFalse(self.sent)
    def test_crash_after_send_intent_never_repeats_uncertain_send(self):
        def crash(*args): raise RuntimeError('process interrupted')
        with self.assertRaises(RuntimeError): m.tick(CONFIG, self.state, BAD, 1000, self.save, crash)
        self.state = copy.deepcopy(self.disk); self.tick(BAD, 1300)
        self.assertFalse(self.sent)
        self.assertEqual(next(iter(self.state['receipts'].values()))['status'], 'unconfirmed')
    def test_crash_before_send_intent_is_resumed(self):
        m.advance(self.state, BAD, 1000); self.save(self.state)
        self.state = copy.deepcopy(self.disk); self.tick(BAD, 1300)
        self.assertEqual(len(self.sent), 1)
    def test_unconfirmed_fault_does_not_emit_recovery(self):
        m.tick(CONFIG, self.state, BAD, 1000, self.save, lambda *args: 'unconfirmed')
        for now in [1300, 1600, 1900]: self.tick(GOOD, now)
        self.assertFalse(self.sent)
    def test_private_credentials_not_in_link_or_ledger(self):
        self.tick(BAD, 1000)
        self.assertNotIn('private-fixture', json.dumps(self.disk))
        body = self.sent[0]
        self.assertNotIn('private-fixture', body['url']); self.assertIn('watchdog=', body['url'])
        self.assertEqual(body['icon'], CONFIG['iconUrl'])
        self.assertIn('心跳中断', body['title']); self.assertNotIn('CDS A', body['title'])
    def test_http_timeout_is_15_seconds_and_cache_busted(self):
        with patch.object(m.urllib.request, 'urlopen', side_effect=TimeoutError()) as request:
            self.assertFalse(m.observe({'heartbeatUrl': 'https://data.example/heartbeat'}, 1000)['healthy'])
            self.assertEqual(request.call_args.kwargs['timeout'], 15)
            self.assertIn('_watchdog=1000', request.call_args.args[0].full_url)
    def test_drill_is_one_clear_notice_even_after_restart(self):
        for _ in range(2): m.tick(CONFIG, self.state, BAD, 1000, self.save, self.sender, drill=True)
        self.assertEqual(len(self.sent), 1); self.assertTrue(self.sent[0]['title'].startswith('演练｜'))
        self.assertIn('实际监控未暂停', self.sent[0]['body'])


if __name__ == '__main__': unittest.main()
