"""Deterministic normal-route fixture contracts; no HTTP, accounts or model calls."""
import copy
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('kb_fixture', ROOT / 'fixture.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
PASSWORD = 'fake-fixture-password-not-a-real-credential-123A!'
INITIAL = 'fake-initial-password-not-a-real-credential-123B!'


class FakePlatform:
    def __init__(self):
        self.users = {'primary': {'userId': 'primary', 'username': 'fake_admin', 'role': 'ADMIN', 'status': 'Active',
                                 'displayName': 'Fake Admin', 'effectivePermissions': module.PERMISSIONS + ['users.read', 'users.write', 'authz.manage']}}
        self.passwords = {}
        self.idempotency = {}
        self.stores, self.entries, self.contents, self.indexes, self.sessions = {}, {}, {}, {}, {}
        self.calls = []
        self.fail_once_after = None
        self.no_receipt_user = False
        self.counter = 0

    def factory(self, base_url, token=None):
        return FakeClient(self, token)

    def new_id(self, kind):
        self.counter += 1
        return kind + str(self.counter)

    def json(self, client, method, path, body=None, idempotency_key=None):
        self.calls.append((client.token or 'primary', method, path, copy.deepcopy(body), idempotency_key))
        response = self.route(client, method, path, body, idempotency_key)
        if self.fail_once_after == (method, urlsplit(path).path):
            self.fail_once_after = None
            raise module.CollectionError('mutation response interrupted')
        return copy.deepcopy(response)

    def route(self, client, method, path, body, idempotency_key):
        route, query = urlsplit(path).path, parse_qs(urlsplit(path).query)
        user_id = client.token if client.token in self.users else 'primary'
        if route == '/api/authz/me':
            return self.users[user_id]
        if route == '/api/v1/auth/login':
            user = next((user for user in self.users.values() if user['username'] == body['username']), None)
            if not user or self.passwords.get(user['userId']) != body['password'] or user['status'] != 'Active':
                raise module.CollectionError('POST request rejected: HTTP 401')
            return {'accessToken': user['userId'], 'mustResetPassword': user.get('mustResetPassword', False)}
        if route == '/api/v1/auth/reset-password':
            assert body['userId'] == user_id
            self.passwords[user_id] = body['newPassword']
            self.users[user_id]['mustResetPassword'] = False
            return {'userId': user_id}
        if route == '/api/users' and method == 'GET':
            regex = query.get('search', ['.*'])[0]
            items = [user for user in self.users.values() if re.search(regex, user['username'])]
            return {'items': items, 'total': len(items)}
        if route == '/api/users' and method == 'POST':
            assert user_id == 'primary'
            assert body['role'] == 'QA' and 'email' not in body and 'miduoSsoSubjectValue' not in body
            if idempotency_key in self.idempotency:
                return self.idempotency[idempotency_key]
            if self.no_receipt_user:
                raise module.CollectionError('unknown create response')
            new_id = self.new_id('user')
            user = {'userId': new_id, 'username': body['username'], 'role': 'QA', 'status': 'Active',
                    'displayName': body['displayName'], 'mustResetPassword': True, 'effectivePermissions': []}
            self.users[new_id] = user
            self.passwords[new_id] = body['password']
            self.idempotency[idempotency_key] = user
            return user
        if route.startswith('/api/authz/users/'):
            target = route.split('/')[4]
            if method == 'PUT':
                assert body == {'systemRoleKey': 'none', 'permAllow': module.PERMISSIONS, 'permDeny': []}
                self.users[target]['effectivePermissions'] = body['permAllow']
                self.users[target]['systemRoleKey'] = 'none'
            return {'userId': target, 'systemRoleKey': self.users[target].get('systemRoleKey'),
                    'effectiveSystemRoleKey': self.users[target].get('systemRoleKey') or 'none',
                    'permAllow': self.users[target]['effectivePermissions'], 'permDeny': []}
        if route.startswith('/api/users/'):
            target = route.split('/')[3]
            if route.endswith('/force-expire'):
                assert target != 'primary' and body == {'targets': ['admin', 'desktop']}
                return {'userId': target}
            if route.endswith('/status'):
                assert target != 'primary' and body == {'status': 'Disabled'}
                self.users[target]['status'] = body['status']
            return self.users[target]
        if route == '/api/document-store/stores':
            if method == 'GET':
                items = [store for store in self.stores.values() if store['ownerId'] == user_id]
                return {'items': items, 'total': len(items)}
            store_id = self.new_id('store')
            assert body.get('isPublic') is False and not body.get('sharedTeamIds') and not body.get('templateKey')
            self.stores[store_id] = {'id': store_id, 'ownerId': user_id, **body}
            return self.stores[store_id]
        if route.startswith('/api/document-store/stores/'):
            parts = route.split('/')
            store_id = parts[4]
            store = self.stores.get(store_id)
            if not store or store['ownerId'] != user_id:
                raise module.CollectionError('GET request rejected: HTTP 404')
            if len(parts) == 5:
                if method == 'DELETE':
                    assert not any(entry['storeId'] == store_id for entry in self.entries.values()), 'must delete entries before store cascade'
                    del self.stores[store_id]
                    return {'deletedEntries': 0}
                return store
            assert parts[5] == 'entries'
            if method == 'GET':
                items = [entry for entry in self.entries.values() if entry['storeId'] == store_id]
                return {'items': items, 'total': len(items)}
            entry_id = self.new_id('entry')
            self.entries[entry_id] = {'id': entry_id, 'storeId': store_id, **body}
            return self.entries[entry_id]
        if route.startswith('/api/document-store/entries/'):
            parts = route.split('/')
            entry_id = parts[4]
            entry = self.entries.get(entry_id)
            if not entry or self.stores[entry['storeId']]['ownerId'] != user_id:
                raise module.CollectionError('GET request rejected: HTTP 404')
            if len(parts) == 5:
                if method == 'DELETE':
                    del self.entries[entry_id]
                    self.contents.pop(entry_id, None)
                    return {'deleted': True}
                return entry
            if parts[5] == 'knowledge-index':
                status = self.indexes.get(entry_id, 'not_indexed')
                return {'status': status, 'pollingRecommended': status == 'pending'}
            assert parts[5] == 'content'
            if method == 'GET':
                return {'content': self.contents.get(entry_id)}
            assert self.indexes.get(entry_id, 'not_indexed') == 'not_indexed', 'prepare must not trigger refresh'
            self.contents[entry_id] = body['content']
            return {'updated': True, 'knowledgeIndex': None}
        if route.startswith('/api/chat-agent/sessions/'):
            session_id = route.split('/')[4]
            session = self.sessions.get(session_id)
            if not session or session['owner'] != user_id or session.get('deleted'):
                raise module.CollectionError('GET request rejected: HTTP 404')
            if method == 'DELETE':
                session['deleted'] = True
                return {'deleted': True}
            return {'item': session}
        raise AssertionError((method, path))


class FakeClient:
    def __init__(self, platform, token=None):
        self.platform, self.token = platform, token

    def authenticate(self):
        return self.token if self.token in self.platform.users else 'primary'

    def json(self, method, path, body=None, idempotency_key=None):
        return self.platform.json(self, method, path, body, idempotency_key)


class FixtureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'fixture-state.json'
        self.fixture = module.Fixture.plan(self.path, 'https://preview.example', '3544aedeb', run_id='fake_run_123')
        self.server = FakePlatform()
        self.fixture.client_factory = self.server.factory
        self.environment = patch.dict(module.os.environ, {'KB_FIXTURE_SECONDARY_PASSWORD': PASSWORD,
                                                          'KB_FIXTURE_SECONDARY_INITIAL_PASSWORD': INITIAL})
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.temp.cleanup()

    def resume(self):
        self.fixture = module.Fixture(self.path, self.server.factory)

    def prepare(self):
        self.fixture.prepare(create_secondary=True)

    def test_plan_is_local_and_ledger_has_no_credentials(self):
        self.assertEqual(self.server.calls, [])
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(PASSWORD, self.path.read_text())
        self.assertNotIn(INITIAL, self.path.read_text())

    def test_prepare_creates_only_two_owned_private_stores_and_twelve_fixed_entries(self):
        self.prepare()
        self.assertEqual(len(self.server.stores), 2)
        self.assertEqual(len(self.server.entries), 12)
        self.assertEqual(len({store['ownerId'] for store in self.server.stores.values()}), 2)
        self.assertEqual(self.fixture.state['status'], 'prepared_not_indexed')
        self.assertFalse(any('/gw/' in path or '/api/chat-agent' in path for _, _, path, _, _ in self.server.calls))
        self.assertEqual(len(json.loads((self.path.parent / 'mapping.json').read_text())['entries']), 12)
        self.assertFalse(json.loads((self.path.parent / 'index-prompts.json').read_text())['executed'])
        for path in self.path.parent.iterdir():
            self.assertNotIn(PASSWORD, path.read_text())
            self.assertNotIn(INITIAL, path.read_text())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_normal_admin_route_profile_requires_only_access_and_three_business_permissions(self):
        self.assertEqual(set(module.PERMISSIONS), {'access', 'chat-agent.use', 'document-store.read', 'document-store.write'})
        self.prepare()
        grant = next(body for _, method, path, body, _ in self.server.calls if method == 'PUT' and path.startswith('/api/authz/users/'))
        self.assertEqual(grant['systemRoleKey'], 'none')
        self.assertEqual(grant['permDeny'], [])
        self.assertEqual(set(grant['permAllow']), {'access', 'chat-agent.use', 'document-store.read', 'document-store.write'})
        self.assertFalse(any(permission.startswith(('users.', 'authz.', 'llm-gateway.')) for permission in grant['permAllow']))

    def test_resuming_completed_fixture_does_not_rewrite_or_recreate(self):
        self.prepare()
        before = sum(method in ('POST', 'PUT') for _, method, _, _, _ in self.server.calls)
        self.resume()
        self.prepare()
        after = sum(method in ('POST', 'PUT') and '/api/v1/auth/login' not in path for _, method, path, _, _ in self.server.calls)
        self.assertEqual(after, before - 1)  # One normal secondary login happened in the initial run.
        self.assertEqual(len(self.server.entries), 12)

    def test_unknown_account_receipt_reconciles_exact_username_and_idempotency(self):
        self.server.fail_once_after = ('POST', '/api/users')
        with self.assertRaises(module.CollectionError):
            self.prepare()
        self.assertEqual(len(self.server.users), 2)
        self.resume()
        self.prepare()
        self.assertEqual(len(self.server.users), 2)
        create_calls = [call for call in self.server.calls if call[1:3] == ('POST', '/api/users')]
        self.assertEqual(len(create_calls), 2)
        self.assertEqual(create_calls[0][4], create_calls[1][4])
        self.assertTrue(any('search=%5Ekb_eval_fake_run_123%24' in call[2] for call in self.server.calls))

    def test_unknown_account_without_read_confirmation_is_not_created_in_a_loop(self):
        self.server.no_receipt_user = True
        with self.assertRaises(module.CollectionError):
            self.prepare()
        self.resume()
        with self.assertRaises(module.CollectionError):
            self.prepare()
        self.assertEqual(sum(call[1:3] == ('POST', '/api/users') for call in self.server.calls), 1)

    def test_unknown_grant_receipt_uses_real_snapshot_fields_without_repeating_put(self):
        self.server.fail_once_after = ('PUT', '/api/authz/users/user1/authz')
        with self.assertRaises(module.CollectionError):
            self.prepare()
        self.resume()
        self.prepare()
        grants = [call for call in self.server.calls if call[1] == 'PUT' and call[2].startswith('/api/authz/users/')]
        self.assertEqual(len(grants), 1)
        self.assertTrue(any(call[1:3] == ('GET', '/api/authz/users/user1/authz') for call in self.server.calls))
        self.assertEqual(self.fixture.state['operations']['grant-secondary']['status'], 'completed')

    def test_unknown_store_create_recovered_without_duplicate(self):
        self.server.fail_once_after = ('POST', '/api/document-store/stores')
        with self.assertRaises(module.CollectionError):
            self.prepare()
        self.resume()
        self.prepare()
        self.assertEqual(len(self.server.stores), 2)
        self.assertEqual(sum(call[1:3] == ('POST', '/api/document-store/stores') for call in self.server.calls), 2)

    def test_unknown_content_save_readback_avoids_duplicate_write(self):
        # Entry numbering is deterministic: user1, store2, store3, entry4.
        self.server.fail_once_after = ('PUT', '/api/document-store/entries/entry4/content')
        with self.assertRaises(module.CollectionError):
            self.prepare()
        self.resume()
        self.prepare()
        self.assertEqual(sum(method == 'PUT' and path.endswith('/content') for _, method, path, _, _ in self.server.calls), 12)

    def test_unknown_entry_create_readback_avoids_duplicate(self):
        self.server.fail_once_after = ('POST', '/api/document-store/stores/store2/entries')
        with self.assertRaises(module.CollectionError):
            self.prepare()
        self.resume()
        self.prepare()
        self.assertEqual(len(self.server.entries), 12)
        self.assertEqual(sum(method == 'POST' and path.endswith('/entries') for _, method, path, _, _ in self.server.calls), 12)

    def test_modified_body_blocks_cleanup_before_deletion(self):
        self.prepare()
        self.server.contents[next(iter(self.server.entries))] = 'later user edit'
        with self.assertRaises(module.CollectionError):
            self.fixture.cleanup(True)
        self.assertFalse(any(method == 'DELETE' for _, method, _, _, _ in self.server.calls))

    def test_running_recorded_chat_blocks_cleanup_before_deletion(self):
        self.prepare()
        self.server.sessions['inflight'] = {'id': 'inflight', 'owner': 'primary', 'running': True}
        self.fixture.add_session('primary', 'inflight')
        with self.assertRaises(module.CollectionError):
            self.fixture.cleanup(True)
        self.assertFalse(any(method == 'DELETE' for _, method, _, _, _ in self.server.calls))

    def test_modified_nonempty_fixture_is_never_silently_repaired(self):
        self.prepare()
        entry_id = next(iter(self.server.entries))
        self.server.contents[entry_id] = 'not the fixed synthetic body'
        before = sum(method == 'PUT' for _, method, _, _, _ in self.server.calls)
        self.resume()
        with self.assertRaises(module.CollectionError):
            self.prepare()
        self.assertEqual(sum(method == 'PUT' for _, method, _, _, _ in self.server.calls), before)

    def test_pending_refresh_blocks_cleanup_before_any_delete(self):
        self.prepare()
        # Make the second owner's entry pending to ensure the first owner's data also remains.
        entry_id = list(self.server.entries)[-1]
        self.server.indexes[entry_id] = 'pending'
        with self.assertRaises(module.CollectionError):
            self.fixture.cleanup(True)
        self.assertFalse(any(method == 'DELETE' for _, method, _, _, _ in self.server.calls))
        self.assertEqual(len(self.server.entries), 12)

    def test_untracked_entry_blocks_all_cleanup(self):
        self.prepare()
        store_id = next(iter(self.server.stores))
        self.server.entries['untracked'] = {'id': 'untracked', 'storeId': store_id}
        with self.assertRaises(module.CollectionError):
            self.fixture.cleanup(True)
        self.assertFalse(any(method == 'DELETE' for _, method, _, _, _ in self.server.calls))

    def test_cleanup_deletes_entries_before_empty_store_then_soft_deletes_and_disables_exact_account(self):
        self.prepare()
        self.server.sessions['recorded'] = {'id': 'recorded', 'owner': 'primary', 'running': False}
        self.fixture.add_session('primary', 'recorded')
        self.fixture.cleanup(True)
        self.assertEqual(self.server.stores, {})
        self.assertEqual(self.server.entries, {})
        self.assertTrue(self.server.sessions['recorded']['deleted'])
        self.assertEqual(self.server.users['primary']['status'], 'Active')
        secondary_id = self.fixture.state['secondary']['userId']
        self.assertEqual(self.server.users[secondary_id]['status'], 'Disabled')
        self.assertIn('no normal physical-cleanup endpoint', self.fixture.state['retainedRecords']['document_embeddings'])
        self.assertIn('soft only', self.fixture.state['retainedRecords']['chat_agent_messages_and_events'])
        self.assertFalse(any(path.endswith('bulk-delete') or path.endswith('force-expire-all') for _, _, path, _, _ in self.server.calls))
        self.resume()
        self.fixture.cleanup(True)  # No secondary login after it has been disabled.

    def test_same_owner_login_cannot_fake_a_second_identity(self):
        self.fixture.state['secondary'].update(mode='existing', username='fake_admin')
        self.fixture.save()
        self.server.passwords['primary'] = PASSWORD
        with patch.dict(module.os.environ, {'KB_FIXTURE_SECONDARY_USERNAME': 'fake_admin'}):
            with self.assertRaises(module.CollectionError):
                self.fixture.prepare()
        self.assertFalse(self.server.stores)

    def test_existing_secondary_account_permissions_are_never_changed_or_disabled(self):
        self.server.users['existing'] = {'userId': 'existing', 'username': 'existing_test', 'role': 'QA', 'status': 'Active',
                                         'displayName': 'Existing Test', 'effectivePermissions': module.PERMISSIONS}
        self.server.passwords['existing'] = PASSWORD
        self.fixture.state['secondary'].update(mode='existing', username=None)
        self.fixture.save()
        with patch.dict(module.os.environ, {'KB_FIXTURE_SECONDARY_USERNAME': 'existing_test'}):
            self.fixture.prepare()
            self.fixture.cleanup(True)
        self.assertEqual(self.server.users['existing']['status'], 'Active')
        self.assertFalse(any(path.startswith('/api/authz/users/') or path.startswith('/api/users/') and method != 'GET'
                             for _, method, path, _, _ in self.server.calls))


if __name__ == '__main__':
    unittest.main()
