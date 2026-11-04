import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'cli'))
import cdscli


class Response:
    headers = {}

    def __init__(self, lines):
        self.lines = lines

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def __iter__(self):
        return iter(self.lines)


class SelfActionCompletionTests(unittest.TestCase):
    def run_action(self, lines, status):
        with mock.patch.object(cdscli.urllib.request, 'urlopen', return_value=Response(lines)), \
             mock.patch.object(cdscli, '_request', return_value=(200, status, {})), \
             mock.patch.object(cdscli.time, 'sleep'), \
             mock.patch.object(cdscli, 'ok') as success, \
             mock.patch.object(cdscli, 'die', side_effect=SystemExit(3)) as failure:
            try:
                cdscli._run_self_action('/api/self-update', {}, no_wait=False, note='updated')
            except SystemExit:
                pass
        return success, failure

    def test_cut_off_build_stream_cannot_reuse_previous_not_required(self):
        success, failure = self.run_action(
            [b'event: web-build-tick\n', b'data: {"elapsed":18}\n'],
            {'restartStatus': 'not_required', 'bundleStale': True},
        )
        success.assert_not_called()
        self.assertEqual(failure.call_args.kwargs['extra']['restartStatus'], 'unconfirmed')
        self.assertEqual(failure.call_args.kwargs['code'], 3)

    def test_empty_stream_is_not_proof_even_if_old_bundle_is_current(self):
        success, failure = self.run_action([], {'restartStatus': 'not_required', 'bundleStale': False})
        success.assert_not_called()
        failure.assert_called_once()

    def test_current_web_only_done_is_success(self):
        success, failure = self.run_action(
            [b'event: done\n', b'data: {"mode":"web-only"}\n'],
            {'restartStatus': 'not_required'},
        )
        failure.assert_not_called()
        self.assertEqual(success.call_args.args[0]['updateMode'], 'web-only')

    def test_completed_restart_can_recover_after_stream_disconnect(self):
        success, failure = self.run_action([], {'restartStatus': 'completed'})
        failure.assert_not_called()
        self.assertTrue(success.call_args.args[0]['restarted'])


if __name__ == '__main__':
    unittest.main()
