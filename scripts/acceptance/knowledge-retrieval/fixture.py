#!/usr/bin/env python3
"""Recoverable, explicitly executed two-owner fixtures for the fixed KB evaluation.

No gateway, task permit, model configuration, implicit indexing, invitation or mail API.
Plan, prompts and session tracking are local only. Never run prepare/cleanup as a probe.
"""
import argparse
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import quote
import uuid

from collect import Client, CollectionError

ROOT = Path(__file__).resolve().parent
PERMISSIONS = ['document-store.read', 'document-store.write', 'chat-agent.use']


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(value, output, ensure_ascii=False, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load(path):
    return json.loads(path.read_text())


def optional_get(client, path):
    try:
        return client.json('GET', path)
    except CollectionError as error:
        if str(error).endswith('HTTP 404'):
            return None
        raise


def ident(value):
    return quote(value, safe='')


class Fixture:
    def __init__(self, state_path, client_factory=Client):
        self.path = state_path
        self.state = load(state_path)
        self.client_factory = client_factory
        self.corpus = load(ROOT / 'corpus.json')['documents']
        if self.state['corpusSha256'] != digest((ROOT / 'corpus.json').read_text()):
            raise CollectionError('fixed corpus changed; do not resume against a different fixture')

    @classmethod
    def plan(cls, output, base_url, target_revision, secondary_mode='create', run_id=None):
        Client(base_url)  # Validate the origin without making a request.
        if not re.fullmatch(r'[0-9a-fA-F]{7,40}', target_revision):
            raise CollectionError('record the verified target revision before planning fixtures')
        run_id = run_id or uuid.uuid4().hex[:12]
        if not re.fullmatch(r'[a-zA-Z0-9_]{6,16}', run_id):
            raise CollectionError('run ID must contain 6-16 letters, digits or underscores')
        if output.exists():
            raise CollectionError('fixture plan already exists; resume its ledger instead of overwriting')
        state = {'schemaVersion': 1, 'runId': run_id, 'baseUrl': base_url.rstrip('/'),
                 'targetRevision': target_revision, 'createdAt': now(),
                 'corpusSha256': digest((ROOT / 'corpus.json').read_text()),
                 'primary': {'userId': None},
                 'secondary': {'mode': secondary_mode, 'username': 'kb_eval_' + run_id if secondary_mode == 'create' else None,
                               'userId': None, 'createdByRun': False},
                 'stores': {}, 'entries': {}, 'sessions': [], 'operations': {}, 'status': 'planned'}
        atomic_json(output, state)
        return cls(output)

    def save(self):
        self.state['updatedAt'] = now()
        atomic_json(self.path, self.state)

    def step(self, key, method, path, action, reconcile=None, replay_safe=False):
        """Durable intent before a mutation; uncertain receipts never become blind new creates."""
        operation = self.state['operations'].get(key)
        if operation and operation['status'] == 'completed':
            return operation.get('result')
        if operation:
            if operation['method'] != method or operation['path'] != path:
                raise CollectionError('operation target changed since its durable intent')
            found = reconcile() if reconcile else None
            if found is not None:
                operation.update(status='completed', result=found, reconciledAt=now())
                self.save()
                return found
            if not replay_safe:
                raise CollectionError('unknown mutation receipt retained; reconcile this exact operation before continuing')
        else:
            self.state['operations'][key] = operation = {'status': 'pending', 'method': method, 'path': path, 'startedAt': now()}
            self.save()
        result = action()
        operation.update(status='completed', result=result, completedAt=now())
        self.save()
        return result

    def primary_client(self):
        client = self.client_factory(self.state['baseUrl'], os.environ.get('KB_EVAL_TOKEN'))
        user_id = client.authenticate()
        known = self.state['primary']['userId']
        if known is not None and user_id != known:
            raise CollectionError('primary identity changed; the ledger cannot move to another user')
        self.state['primary']['userId'] = user_id
        self.save()
        return client

    def verify_created_user(self, primary):
        secondary = self.state['secondary']
        if not secondary['createdByRun'] or not secondary['userId'] or secondary['userId'] == self.state['primary']['userId']:
            raise CollectionError('account mutation requires the exact secondary account created by this run')
        detail = primary.json('GET', '/api/users/' + ident(secondary['userId']))
        if detail.get('username') != secondary['username'] or detail.get('role') != 'QA' or detail.get('displayName') != '知识检索临时评测 ' + self.state['runId']:
            raise CollectionError('temporary account identity or role changed; account mutation refused')

    def ensure_secondary(self, primary, create_secondary):
        secondary = self.state['secondary']
        if secondary['mode'] == 'create':
            if not create_secondary:
                raise CollectionError('creating a secondary QA account requires explicit --create-secondary')
            password = os.environ.get('KB_FIXTURE_SECONDARY_INITIAL_PASSWORD') or os.environ.get('KB_FIXTURE_SECONDARY_PASSWORD')
            final_password = os.environ.get('KB_FIXTURE_SECONDARY_PASSWORD')
            if not password or not final_password:
                raise CollectionError('provide temporary account passwords through environment variables, never arguments or the ledger')
            principal = primary.json('GET', '/api/authz/me')
            if not {'users.read', 'users.write', 'authz.manage'} <= set(principal.get('effectivePermissions', [])):
                raise CollectionError('normal administrator user-management permissions are required')
            body = {'username': secondary['username'], 'password': password, 'role': 'QA',
                    'displayName': '知识检索临时评测 ' + self.state['runId']}
            def find_created():
                page = primary.json('GET', '/api/users?search=' + ident('^' + secondary['username'] + '$') + '&pageSize=2')
                matches = [item for item in page['items'] if item.get('username') == secondary['username']]
                if len(matches) != 1:
                    return None
                candidate = matches[0]
                operation = self.state['operations']['create-secondary']
                operation['candidateUserId'] = candidate.get('userId')
                self.save()
                if candidate.get('role') != 'QA' or candidate.get('displayName') != body['displayName']:
                    raise CollectionError('username exists but does not identify this temporary run')
                # Confirm the server-side idempotency receipt; an occupied username cannot create a duplicate.
                receipt = primary.json('POST', '/api/users', body, idempotency_key='kb-eval-user-' + self.state['runId'])
                if receipt.get('userId') != candidate.get('userId'):
                    raise CollectionError('account idempotency receipt does not match the exact observed username')
                return candidate['userId']
            def create():
                page = primary.json('GET', '/api/users?search=' + ident('^' + secondary['username'] + '$') + '&pageSize=2')
                if page['items']:
                    raise CollectionError('planned username already exists; do not mutate or adopt it')
                response = primary.json('POST', '/api/users', body,
                                        idempotency_key='kb-eval-user-' + self.state['runId'])
                if response.get('username') != secondary['username'] or response.get('role') != 'QA' or not response.get('userId'):
                    raise CollectionError('account creation did not confirm the requested QA identity')
                return response['userId']
            secondary['userId'] = self.step('create-secondary', 'POST', '/api/users', create, reconcile=find_created)
            secondary['createdByRun'] = True
            self.save()
            self.verify_created_user(primary)
            user_path = '/api/authz/users/' + ident(secondary['userId']) + '/authz'
            def matches_grant(snapshot):
                return (snapshot.get('userId') == secondary['userId'] and snapshot.get('systemRoleKey') == 'none'
                        and snapshot.get('effectiveSystemRoleKey') == 'none'
                        and set(snapshot.get('permAllow', [])) == set(PERMISSIONS) and not snapshot.get('permDeny'))
            def grant():
                response = primary.json('PUT', user_path, {'systemRoleKey': 'none', 'permAllow': PERMISSIONS, 'permDeny': []})
                if not matches_grant(response):
                    raise CollectionError('minimal permission snapshot was not confirmed')
                return True
            self.step('grant-secondary', 'PUT', user_path, grant,
                      reconcile=lambda: True if matches_grant(primary.json('GET', user_path)) else None)
        else:
            username = os.environ.get('KB_FIXTURE_SECONDARY_USERNAME')
            if not username:
                raise CollectionError('existing secondary identity requires its normal username environment variable')
            if secondary['username'] not in (None, username):
                raise CollectionError('existing secondary username changed')
            secondary['username'] = username
            self.save()
        return self.secondary_client()

    def secondary_client(self):
        secondary = self.state['secondary']
        final_password = os.environ.get('KB_FIXTURE_SECONDARY_PASSWORD')
        if not secondary.get('username') or not final_password:
            raise CollectionError('secondary normal-login credentials are missing')
        client = self.client_factory(self.state['baseUrl'])
        reset = self.state['operations'].get('reset-secondary-password')
        pending_reset = bool(reset and reset['status'] != 'completed')
        first_login = secondary['createdByRun'] and reset is None
        password = (os.environ.get('KB_FIXTURE_SECONDARY_INITIAL_PASSWORD') or final_password) if first_login else final_password
        login = client.json('POST', '/api/v1/auth/login', {'username': secondary['username'], 'password': password, 'clientType': 'admin'})
        if not login.get('accessToken'):
            raise CollectionError('secondary normal login did not return an access token')
        client.token = login['accessToken']
        user_id = client.authenticate()
        if user_id == self.state['primary']['userId'] or (secondary['userId'] and user_id != secondary['userId']):
            raise CollectionError('two distinct normal owner identities are required')
        secondary['userId'] = user_id
        self.save()
        if login.get('mustResetPassword'):
            if not secondary['createdByRun'] or pending_reset:
                raise CollectionError('password reset is unconfirmed; do not change an existing or uncertain account')
            body = {'userId': user_id, 'newPassword': final_password, 'confirmPassword': final_password}
            self.step('reset-secondary-password', 'POST', '/api/v1/auth/reset-password',
                      lambda: bool(client.json('POST', '/api/v1/auth/reset-password', body)))
        elif pending_reset:
            self.state['operations']['reset-secondary-password'].update(status='completed', result=True, reconciledAt=now())
            self.save()
        principal = client.json('GET', '/api/authz/me')
        if not set(PERMISSIONS) <= set(principal.get('effectivePermissions', [])):
            raise CollectionError('secondary account lacks the required normal document/chat permissions')
        return client

    def store_spec(self, key, owner):
        return {'owner': owner, 'name': 'kb_eval_' + self.state['runId'] + '_' + key,
                'description': 'Isolated fixed KB evaluation ' + self.state['runId'],
                'tags': ['kb-eval-' + self.state['runId']], 'isPublic': False}

    def validate_store(self, value, spec):
        user_id = self.state[spec['owner']]['userId']
        if not (value.get('ownerId') == user_id and value.get('name') == spec['name']
                and value.get('description') == spec['description'] and value.get('tags') == spec['tags']
                and value.get('isPublic') is False and not value.get('sharedTeamIds')
                and not value.get('templateKey') and not value.get('pmProjectId')
                and not value.get('productKnowledgeRef') and not value.get('shituCategoryRef')):
            raise CollectionError('store ownership, temporary marker or private scope changed')
        return value['id']

    def ensure_store(self, client, key, owner):
        spec = self.store_spec(key, owner)
        def create():
            return self.validate_store(client.json('POST', '/api/document-store/stores',
                {field: value for field, value in spec.items() if field != 'owner'}), spec)
        def reconcile():
            page = client.json('GET', '/api/document-store/stores?page=1&pageSize=100')
            candidates = [value for value in page['items'] if value.get('name') == spec['name']]
            if len(candidates) > 1:
                raise CollectionError('temporary store marker is not unique')
            return self.validate_store(candidates[0], spec) if candidates else None
        store_id = self.step('create-store:' + key, 'POST', '/api/document-store/stores', create, reconcile)
        self.state['stores'][key] = {**spec, 'id': store_id}
        self.save()
        self.validate_store(client.json('GET', '/api/document-store/stores/' + ident(store_id)), spec)
        return store_id

    def validate_entry(self, value, document, store_id):
        if (value.get('storeId') != store_id or value.get('title') != document['title'] or value.get('isFolder')
                or value.get('attachmentId') or value.get('sourceType') != 'upload'
                or value.get('metadata', {}).get('kbEvalRun') != self.state['runId']
                or value.get('metadata', {}).get('kbEvalKey') != document['entryId']):
            raise CollectionError('entry identity, fixture marker or safe content type changed')
        return value['id']

    def ensure_entry(self, client, document, store_id, owner):
        path = '/api/document-store/stores/' + ident(store_id) + '/entries'
        body = {'title': document['title'], 'sourceType': 'upload', 'contentType': 'markdown',
                'metadata': {'kbEvalRun': self.state['runId'], 'kbEvalKey': document['entryId']}}
        def reconcile():
            page = client.json('GET', path + '?all=true&pageSize=200')
            matches = [entry for entry in page['items'] if entry.get('metadata', {}).get('kbEvalRun') == self.state['runId']
                       and entry.get('metadata', {}).get('kbEvalKey') == document['entryId']]
            if len(matches) > 1:
                raise CollectionError('temporary entry marker is not unique')
            return self.validate_entry(matches[0], document, store_id) if matches else None
        entry_id = self.step('create-entry:' + document['entryId'], 'POST', path,
                             lambda: self.validate_entry(client.json('POST', path, body), document, store_id), reconcile)
        self.state['entries'][document['entryId']] = {'id': entry_id, 'storeId': store_id, 'owner': owner,
                                                   'contentSha256': digest(document['content'])}
        self.save()
        entry_path = '/api/document-store/entries/' + ident(entry_id)
        self.validate_entry(client.json('GET', entry_path), document, store_id)
        def content_matches():
            content = client.json('GET', entry_path + '/content').get('content')
            return True if content == document['content'] else None
        def write():
            current = client.json('GET', entry_path + '/content').get('content')
            if current == document['content']:
                return True
            if current:
                raise CollectionError('fixture body differs; never overwrite a non-empty document')
            index = client.json('GET', entry_path + '/knowledge-index')
            if index.get('status') != 'not_indexed':
                raise CollectionError('prepare will not write an indexed document or start refresh/model work')
            response = client.json('PUT', entry_path + '/content', {'content': document['content'], 'contentType': 'markdown'})
            if response.get('knowledgeIndex') is not None or response.get('updated') is not True:
                raise CollectionError('content save did not confirm a model-free initial write')
            if content_matches() is not True:
                raise CollectionError('saved content did not match fixed source')
            return True
        self.step('save-content:' + document['entryId'], 'PUT', entry_path + '/content', write, content_matches)
        if content_matches() is not True:
            raise CollectionError('completed fixture changed; do not silently repair it')

    def prepare(self, create_secondary=False):
        if self.state['status'].startswith('cleanup'):
            raise CollectionError('a cleanup ledger cannot be reused to recreate fixtures')
        primary = self.primary_client()
        secondary = self.ensure_secondary(primary, create_secondary)
        clients = {'primary': primary, 'secondary': secondary}
        owners = {'evaluation-store': 'primary', 'restricted-store': 'secondary'}
        for key, owner in owners.items():
            self.ensure_store(clients[owner], key, owner)
        for document in self.corpus:
            owner = owners[document['storeId']]
            self.ensure_entry(clients[owner], document, self.state['stores'][document['storeId']]['id'], owner)
        self.state['status'] = 'prepared_not_indexed'
        self.save()
        self.export()

    def export(self):
        if self.state['status'].startswith('cleanup'):
            raise CollectionError('do not export deleted fixture identities for another model run')
        if len(self.state['entries']) != len(self.corpus):
            raise CollectionError('prepare all fixed entries before exporting mappings or index prompts')
        mapping = {'temporaryFixturesConfirmed': True,
                   'users': {'evaluation-user': self.state['primary']['userId'], 'other-user': self.state['secondary']['userId']},
                   'entries': {key: {'entryId': value['id'], 'storeId': value['storeId']} for key, value in self.state['entries'].items()}}
        atomic_json(self.path.parent / 'mapping.json', mapping)
        prompts = [{'owner': value['owner'], 'userId': self.state[value['owner']]['userId'], 'entryId': value['id'],
                    'prompt': '请仅为我拥有的这篇指定文档建立语义检索索引：entryId=' + value['id'] + '。不要遍历或索引其他文档。'}
                   for value in self.state['entries'].values()]
        atomic_json(self.path.parent / 'index-prompts.json', {'executed': False, 'items': prompts})

    def add_session(self, owner, session_id):
        if owner not in ('primary', 'secondary') or not session_id:
            raise CollectionError('track only an explicitly known normal-owner session ID')
        item = {'owner': owner, 'id': session_id}
        if item not in self.state['sessions']:
            self.state['sessions'].append(item)
            self.save()

    def cleanup(self, tasks_terminal_confirmed):
        if not tasks_terminal_confirmed:
            raise CollectionError('confirm the recorded model/index tasks reached terminal receipts before cleanup')
        preparation_prefixes = ('create-', 'grant-', 'reset-', 'save-content:')
        if any(key.startswith(preparation_prefixes) and value['status'] != 'completed'
               for key, value in self.state['operations'].items()):
            raise CollectionError('unfinished preparation receipt retained; reconcile it before claiming cleanup')
        primary = self.primary_client()
        clients = {'primary': primary}
        secondary_needed = any(resource.get('owner') == 'secondary' and not resource.get('deleted')
                               for resource in list(self.state['stores'].values()) + self.state['sessions'])
        if secondary_needed:
            clients['secondary'] = self.secondary_client()
        # Check every recorded session before deleting any knowledge data.
        for session in self.state['sessions']:
            if session.get('deleted'):
                continue
            view = clients[session['owner']].json('GET', '/api/chat-agent/sessions/' + ident(session['id']))['item']
            if view.get('running'):
                raise CollectionError('a recorded conversation is still running; no cleanup started')
        documents = {document['entryId']: document for document in self.corpus}
        for key, store in self.state['stores'].items():
            if store.get('deleted'):
                continue
            client = clients[store['owner']]
            path = '/api/document-store/stores/' + ident(store['id'])
            current = optional_get(client, path)
            if current is None:
                if 'delete-store:' + key not in self.state['operations']:
                    raise CollectionError('store disappeared without a recorded cleanup intent')
                continue
            self.validate_store(current, store)
            page = client.json('GET', path + '/entries?all=true&pageSize=200')
            expected = {entry['id'] for entry in self.state['entries'].values() if entry['storeId'] == store['id']}
            if page.get('total', len(page['items'])) != len(page['items']) or any(entry['id'] not in expected for entry in page['items']):
                raise CollectionError('untracked entries exist; no cleanup started')
            for entry in page['items']:
                logical = next(logical for logical, value in self.state['entries'].items() if value['id'] == entry['id'])
                self.validate_entry(entry, documents[logical], store['id'])
                entry_path = '/api/document-store/entries/' + ident(entry['id'])
                index = client.json('GET', entry_path + '/knowledge-index')
                if index.get('status') == 'pending' or index.get('pollingRecommended'):
                    raise CollectionError('index refresh is pending; no cleanup started')
                content = client.json('GET', entry_path + '/content').get('content') or ''
                if digest(content) != self.state['entries'][logical]['contentSha256']:
                    raise CollectionError('fixture body changed; reconcile its exact expected hash before cleanup')
        self.state['status'] = 'cleanup_started'
        self.save()
        documents = {document['entryId']: document for document in self.corpus}
        for key, store in self.state['stores'].items():
            if store.get('deleted'):
                continue
            client = clients[store['owner']]
            store_path = '/api/document-store/stores/' + ident(store['id'])
            current = optional_get(client, store_path)
            pending_delete = self.state['operations'].get('delete-store:' + key)
            if current is None:
                if not pending_delete:
                    raise CollectionError('store disappeared without this run recording a deletion intent')
                self.step('delete-store:' + key, 'DELETE', store_path, lambda: True, reconcile=lambda: True)
                store['deleted'] = True
                self.save()
                continue
            self.validate_store(current, store)
            expected = {entry['id'] for entry in self.state['entries'].values() if entry['storeId'] == store['id']}
            page = client.json('GET', store_path + '/entries?all=true&pageSize=200')
            if page.get('total', len(page['items'])) != len(page['items']) or any(entry['id'] not in expected for entry in page['items']):
                raise CollectionError('store contains untracked entries; refuse cascading cleanup')
            for entry in page['items']:
                logical = next(logical for logical, resource in self.state['entries'].items() if resource['id'] == entry['id'])
                self.validate_entry(entry, documents[logical], store['id'])
                index = client.json('GET', '/api/document-store/entries/' + ident(entry['id']) + '/knowledge-index')
                if index.get('status') == 'pending' or index.get('pollingRecommended'):
                    raise CollectionError('index refresh is still pending; retain its source and task history')
            # DeleteEntry preserves shared content-addressed bodies still referenced elsewhere.
            for logical, resource in self.state['entries'].items():
                if resource['storeId'] != store['id']:
                    continue
                path = '/api/document-store/entries/' + ident(resource['id'])
                entry = optional_get(client, path)
                deletion = 'delete-entry:' + logical
                if entry is None and deletion not in self.state['operations']:
                    raise CollectionError('entry disappeared without a recorded deletion intent')
                if entry is not None:
                    self.validate_entry(entry, documents[logical], store['id'])
                self.step(deletion, 'DELETE', path, lambda path=path: bool(client.json('DELETE', path)),
                          reconcile=lambda path=path: True if optional_get(client, path) is None else None)
                if optional_get(client, path) is not None:
                    raise CollectionError('entry deletion has not converged')
                resource['deleted'] = True
                self.save()
            empty = client.json('GET', store_path + '/entries?all=true&pageSize=200')
            if empty['items'] or empty.get('total', 0):
                raise CollectionError('store is not empty; do not delete its shared bodies by store cascade')
            self.step('delete-store:' + key, 'DELETE', store_path, lambda: bool(client.json('DELETE', store_path)),
                      reconcile=lambda: True if optional_get(client, store_path) is None else None)
            if optional_get(client, store_path) is not None:
                raise CollectionError('store deletion has not converged')
            store['deleted'] = True
            self.save()
        for session in self.state['sessions']:
            if session.get('deleted'):
                continue
            path = '/api/chat-agent/sessions/' + ident(session['id'])
            client = clients[session['owner']]
            self.step('soft-delete-session:' + session['owner'] + ':' + session['id'], 'DELETE', path,
                      lambda path=path: bool(client.json('DELETE', path)),
                      reconcile=lambda path=path: True if optional_get(client, path) is None else None)
            session['deleted'] = True
            self.save()
        if self.state['secondary']['createdByRun']:
            self.verify_created_user(primary)
            user_path = '/api/users/' + ident(self.state['secondary']['userId'])
            self.step('expire-secondary', 'POST', user_path + '/force-expire',
                      lambda: bool(primary.json('POST', user_path + '/force-expire', {'targets': ['admin', 'desktop']})), replay_safe=True)
            self.step('disable-secondary', 'PUT', user_path + '/status',
                      lambda: bool(primary.json('PUT', user_path + '/status', {'status': 'Disabled'})), replay_safe=True)
            if primary.json('GET', user_path).get('status') != 'Disabled':
                raise CollectionError('temporary account disable was not confirmed')
        self.state['status'] = 'cleanup_logical_complete_with_retained_records'
        self.state['retainedRecords'] = {'document_embeddings': 'no normal physical-cleanup endpoint; do not claim purged',
                                         'chat_agent_messages_and_events': 'session deletion is soft only',
                                         'account': 'this-run QA account disabled and expired, retained for audit; existing identities untouched',
                                         'audit_and_billing': 'retained by normal service policy'}
        self.save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    plan = commands.add_parser('plan')
    plan.add_argument('--state', type=Path, required=True)
    plan.add_argument('--base-url', required=True)
    plan.add_argument('--target-revision', required=True)
    plan.add_argument('--secondary-mode', choices=['create', 'existing'], default='create')
    plan.add_argument('--run-id')
    for name in ('prepare', 'cleanup', 'prompts', 'track-session'):
        command = commands.add_parser(name)
        command.add_argument('--state', type=Path, required=True)
        if name in ('prepare', 'cleanup'):
            command.add_argument('--execute', action='store_true')
        if name == 'prepare':
            command.add_argument('--create-secondary', action='store_true')
        if name == 'cleanup':
            command.add_argument('--tasks-terminal-confirmed', action='store_true')
        if name == 'track-session':
            command.add_argument('--owner', choices=['primary', 'secondary'], required=True)
            command.add_argument('--session-id', required=True)
    args = parser.parse_args()
    if args.command == 'plan':
        fixture = Fixture.plan(args.state, args.base_url, args.target_revision, args.secondary_mode, args.run_id)
    else:
        fixture = Fixture(args.state)
        if args.command in ('prepare', 'cleanup') and not args.execute:
            raise CollectionError('no remote operation performed: pass --execute only for an authorized fixture run')
        if args.command == 'prepare':
            fixture.prepare(args.create_secondary)
        elif args.command == 'cleanup':
            fixture.cleanup(args.tasks_terminal_confirmed)
        elif args.command == 'prompts':
            fixture.export()
        else:
            fixture.add_session(args.owner, args.session_id)
    print(json.dumps({'runId': fixture.state['runId'], 'status': fixture.state['status'],
                      'storeCount': len(fixture.state['stores']), 'entryCount': len(fixture.state['entries'])}))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (CollectionError, KeyError, ValueError, OSError):
        print('Fixture blocked; retain the exact ledger and check normal identities/receipts. No credentials are printed.')
        raise SystemExit(2)
