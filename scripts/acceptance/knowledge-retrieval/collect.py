#!/usr/bin/env python3
"""Collect observations through the normal ChatAgent session/worker/SSE path."""
import argparse
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parent
MAX_LINE = 1024 * 1024


class CollectionError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward bearer credentials to a redirect destination.


class Client:
    def __init__(self, base_url, token=None, timeout=30):
        parsed = urlsplit(base_url)
        if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
            raise CollectionError('base URL must be an HTTP(S) origin without credentials or query')
        if parsed.scheme != 'https' and parsed.hostname not in ('127.0.0.1', 'localhost', '::1'):
            raise CollectionError('non-loopback targets require HTTPS')
        self.base_url = base_url.rstrip('/')
        self.token = token
        self.timeout = timeout
        self.opener = build_opener(NoRedirect)

    def open(self, method, path, body=None, stream=False, idempotency_key=None):
        if not path.startswith('/') or path.startswith('//'):
            raise CollectionError('request path must be same-origin relative')
        headers = {'Accept': 'text/event-stream' if stream else 'application/json', 'X-Client': 'admin',
                   'User-Agent': 'curl/8.5.0'}
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        if idempotency_key:
            headers['Idempotency-Key'] = idempotency_key
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers['Content-Type'] = 'application/json'
        try:
            return self.opener.open(Request(self.base_url + path, data=data, headers=headers, method=method), timeout=self.timeout)
        except HTTPError as exc:
            exc.close()
            raise CollectionError(f'{method} {urlsplit(path).path} request rejected: HTTP {exc.code}') from None
        except (URLError, TimeoutError, OSError):
            raise CollectionError(f'{method} {urlsplit(path).path} request failed before a usable response') from None

    def json(self, method, path, body=None, idempotency_key=None):
        with self.open(method, path, body, idempotency_key=idempotency_key) as response:
            try:
                value = json.load(response)
            except (ValueError, UnicodeError):
                raise CollectionError('response is not valid JSON') from None
        if not isinstance(value, dict) or value.get('success') is not True or not isinstance(value.get('data'), dict):
            raise CollectionError('response did not confirm success with an object data payload')
        return value['data']

    def authenticate(self):
        if not self.token:
            username = os.environ.get('KB_EVAL_USERNAME') or os.environ.get('MAP_USERNAME')
            password = os.environ.get('KB_EVAL_PASSWORD') or os.environ.get('MAP_PASSWORD')
            if not username or not password:
                raise CollectionError('set KB_EVAL_TOKEN or normal login username/password environment variables')
            data = self.json('POST', '/api/v1/auth/login', {'username': username, 'password': password, 'clientType': 'admin'})
            self.token = data.get('accessToken')
            if not isinstance(self.token, str) or not self.token:
                raise CollectionError('normal login did not return an access token')
        identity = self.json('GET', '/api/authz/me')
        if not isinstance(identity.get('userId'), str):
            raise CollectionError('normal authorization endpoint did not confirm user identity')
        return identity['userId']


def sse_events(response):
    """Parse multiline SSE frames, ignoring comments; reject malformed evidence."""
    frame = {'data': []}
    while True:
        raw = response.readline(MAX_LINE + 1)
        if len(raw) > MAX_LINE:
            raise CollectionError('SSE line exceeded evidence limit')
        if not raw:
            # SSE dispatch requires a blank separator; an unfinished frame is not evidence.
            return
        try:
            line = raw.decode('utf-8').rstrip('\r\n')
        except UnicodeError:
            raise CollectionError('SSE frame is not UTF-8') from None
        if line == '':
            if frame['data']:
                try:
                    payload = json.loads('\n'.join(frame['data']))
                    seq = int(frame.get('id', ''))
                except (ValueError, TypeError):
                    raise CollectionError('SSE frame has invalid JSON or sequence') from None
                if not isinstance(payload, dict) or seq < 0:
                    raise CollectionError('SSE frame has invalid payload or sequence')
                yield {'seq': seq, 'type': frame.get('event', ''), 'payload': payload}
            frame = {'data': []}
        elif not line.startswith(':'):
            field, _, value = line.partition(':')
            if value.startswith(' '):
                value = value[1:]
            if field == 'data':
                frame['data'].append(value)
            elif field in ('id', 'event'):
                frame[field] = value


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as output:
        json.dump(value, output, ensure_ascii=False, indent=2)
        output.write('\n')


def remap_inputs(corpus, questions, mapping):
    """Use real IDs in both evaluator inputs and observations; never rewrite observed URLs."""
    if mapping.get('temporaryFixturesConfirmed') is not True:
        raise CollectionError('mapping must explicitly confirm isolated temporary fixtures')
    users, entries = mapping.get('users', {}), mapping.get('entries', {})
    corpus, questions = copy.deepcopy(corpus), copy.deepcopy(questions)
    expected = {doc['entryId'] for doc in corpus['documents']}
    if set(entries) != expected:
        raise CollectionError('mapping must contain every fixed document, including private fixtures, exactly once')
    ids = []
    stores = {}
    for doc in corpus['documents']:
        destination = entries[doc['entryId']]
        if not isinstance(destination, dict) or not all(isinstance(destination.get(k), str) and destination[k] for k in ('entryId', 'storeId')):
            raise CollectionError('entry mapping requires real entryId and storeId')
        if not isinstance(users.get(doc['ownerId']), str) or not users[doc['ownerId']]:
            raise CollectionError('mapping requires both fixture owner identities')
        prior = stores.setdefault(doc['storeId'], destination['storeId'])
        if prior != destination['storeId']:
            raise CollectionError('mapping must preserve each fixed knowledge store as one runtime store')
        ids.append(destination['entryId'])
        doc.update(entryId=destination['entryId'], storeId=destination['storeId'], ownerId=users[doc['ownerId']])
    if len(set(stores.values())) != len(stores):
        raise CollectionError('readable and restricted fixture stores must remain distinct')
    if len(ids) != len(set(ids)) or len(set(users.values())) != len(users):
        raise CollectionError('entry and user mapping must preserve distinct identities')
    for question in questions['questions']:
        if question['userId'] not in users:
            raise CollectionError('question principal is not mapped')
        question['userId'] = users[question['userId']]
        for key in ('relevantEntryIds', 'forbiddenEntryIds'):
            question[key] = [entries[item]['entryId'] for item in question[key]]
    return corpus, questions


def string_list(value):
    return isinstance(value, list) and all(isinstance(item, str) and item for item in value)


def citations_from_markdown(text, base_url):
    """Extract citation candidates, not verified sources or inferred quotations."""
    citations = []
    for match in re.finditer(r'\[([^\]\n]*)\]\(([^\s)]+)(?:\s+"[^"\n]*")?\)', text):
        label, url = match.groups()
        parsed = urlsplit(url)
        query = parse_qs(parsed.query)
        entry_ids = query.get('entry', [])
        store_ids = query.get('store', [])
        citations.append({'entryId': entry_ids[0] if len(entry_ids) == 1 else None,
                          'storeId': store_ids[0] if len(store_ids) == 1 else None,
                          'url': url, 'label': label, 'quote': None, 'isKnowledgeSource': parsed.path == '/document-store',
                          'opens': None, 'supports': None, 'openEvidence': None, 'supportEvidence': None,
                          'sameOrigin': not parsed.netloc or (parsed.scheme, parsed.netloc) == (urlsplit(base_url).scheme, urlsplit(base_url).netloc)})
    return citations


def observation_from_events(query_id, events, final_message, base_url, elapsed_ms):
    searches, contexts, issues = [], [], []
    started, finished = {}, set()
    terminal_errors = []
    for event in events:
        payload = event['payload']
        if event['type'] == 'error':
            terminal_errors.append({'seq': event['seq'], 'code': payload.get('code')})
        if event['type'] == 'tool_started':
            started[payload.get('toolUseId')] = payload.get('tool')
        if event['type'] != 'tool_finished':
            continue
        tool_id = payload.get('toolUseId')
        tool = payload.get('tool') or started.get(tool_id)
        finished.add(tool_id)
        if tool not in ('kb_search', 'kb_read'):
            if tool is None:
                issues.append({'seq': event['seq'], 'reason': 'tool result identity missing; context completeness unknown'})
            continue
        evidence = payload.get('retrievalEvidence')
        if payload.get('ok') is not True or not isinstance(evidence, dict) or not string_list(evidence.get('contextEntryIds')):
            issues.append({'seq': event['seq'], 'tool': tool, 'reason': 'failed or incomplete context evidence'})
            continue
        for entry in evidence['contextEntryIds']:
            if entry not in contexts:
                contexts.append(entry)
        if tool == 'kb_search':
            call = {'seq': event['seq'], 'toolUseId': tool_id, **copy.deepcopy(evidence)}
            searches.append(call)
            if not string_list(evidence.get('retrievedEntryIds')):
                issues.append({'seq': event['seq'], 'tool': tool, 'reason': 'missing retrieval order'})
    if any(tool in ('kb_search', 'kb_read') and tool_id not in finished for tool_id, tool in started.items()):
        issues.append({'reason': 'knowledge tool started without terminal result'})
    semantic = [call for call in searches if call.get('mode') == 'semantic']
    primary = semantic[0] if semantic else None
    elapsed = primary.get('retrievalLatencyMs') if primary else None
    if not isinstance(elapsed, (float, int)) or isinstance(elapsed, bool) or not math.isfinite(elapsed) or elapsed < 0:
        elapsed = None
    completed = final_message is not None and final_message.get('status') == 'completed' and not terminal_errors
    final_text = final_message.get('content', '') if final_message else ''
    if not isinstance(final_text, str):
        final_text = ''
        completed = False
    complete = completed and not issues and primary is not None
    return {'queryId': query_id, 'retrievedEntryIds': primary.get('retrievedEntryIds') if complete else None,
            'contextEntryIds': contexts if completed and not issues else None,
            'latencyMs': elapsed if complete else None, 'searchCalls': searches,
            'contextEntryIdsObserved': contexts, 'primarySemanticSeq': primary['seq'] if primary else None,
            'turnElapsedMs': elapsed_ms, 'finalAnswer': final_text,
            'answerStatus': 'pending_review' if completed else 'not_run', 'answerSupported': None, 'answerEvidence': None,
            'citations': citations_from_markdown(final_text, base_url),
            'collectionStatus': 'collected' if complete else 'blocked', 'collectionIssues': issues,
            'terminalErrors': terminal_errors, 'finalMessageStatus': final_message.get('status') if final_message else None}


def collect_question(client, question, store_id, timeout_seconds=300, reconnects=3, journal=lambda state: None):
    started_at = time.monotonic()
    session = client.json('POST', '/api/chat-agent/sessions', {'title': '知识检索评测 ' + question['queryId'], 'model': None})['item']
    session_id = session['id']
    path = '/api/chat-agent/sessions/' + quote(session_id, safe='')
    prompt = ('仅在指定的临时知识库内检索，不要建立索引、写入或修改文档。'
              f'请用 kb_search 的 semantic 模式、storeId={store_id}、limit=5 检索，'
              '再按需要用 kb_read 核查原文。仅根据有权限的原文回答，逐项附原句和 source.uri 链接；无依据则说明未找到。\n'
              '问题：' + question['query'])
    state = {'sessionId': session_id, 'phase': 'message_acceptance_unknown', 'events': []}
    journal(state)  # Retain the session even when the POST acceptance response is lost.
    accepted = client.json('POST', path + '/messages', {'content': prompt})
    state.update(phase='accepted', turnId=accepted['turnId'], assistantMessageId=accepted['assistantMessageId'])
    journal(state)
    cursor = accepted['seq'] - 1
    events = state['events']
    seen = set()
    last_failure = None
    for attempt in range(reconnects + 1):
        if time.monotonic() - started_at > timeout_seconds:
            last_failure = 'turn observation deadline reached; server task may still run'
            break
        try:
            with client.open('GET', path + '/stream?afterSeq=' + str(cursor), stream=True) as response:
                if 'text/event-stream' not in response.headers.get('Content-Type', ''):
                    raise CollectionError('stream did not return text/event-stream')
                for event in sse_events(response):
                    if event['type'] == 'idle':
                        break
                    if event['seq'] in seen:
                        continue
                    if event['seq'] != cursor + 1:
                        raise CollectionError('SSE event sequence is not contiguous')
                    seen.add(event['seq'])
                    cursor = event['seq']
                    events.append(event)
                    journal(state)
                    if event['type'] in ('done', 'error'):
                        break
                    if time.monotonic() - started_at > timeout_seconds:
                        raise CollectionError('turn observation deadline reached')
            if any(event['type'] in ('done', 'error') for event in events):
                break
        except (CollectionError, OSError, TimeoutError):
            last_failure = 'stream interrupted; resume requested using last event sequence'
    messages = client.json('GET', path + '/messages?limit=200')['items']
    message = next((item for item in messages if item.get('id') == accepted['assistantMessageId'] and item.get('turnId') == accepted['turnId']), None)
    row = observation_from_events(question['queryId'], events, message, client.base_url, (time.monotonic() - started_at) * 1000)
    # A completed REST message cannot replace a missing event tail: its tool context is unknown.
    if not any(event['type'] in ('done', 'error') for event in events):
        row.update(retrievedEntryIds=None, contextEntryIds=None, latencyMs=None, collectionStatus='blocked')
        row['collectionIssues'].append({'reason': last_failure or 'no terminal SSE event captured'})
    state['phase'] = 'observed'
    journal(state)
    row.update(sessionId=session_id, turnId=accepted['turnId'], assistantMessageId=accepted['assistantMessageId'])
    return row, events


def review_template(rows):
    return {'schemaVersion': 1, 'instructions': 'Review actual answers and click each source as the same normal user; null is unverified. Do not infer support/opening from keywords or HTTP status.',
            'questions': [{'queryId': row['queryId'], 'sessionId': row.get('sessionId'),
                           'answerStatus': None, 'answerSupported': None, 'answerEvidence': None,
                           'citations': copy.deepcopy(row['citations'])} for row in rows]}


def apply_review(rows, review):
    by_id = {}
    for item in review['questions']:
        if item['queryId'] in by_id:
            raise CollectionError('duplicate review query ID')
        by_id[item['queryId']] = item
    if set(by_id) != {row['queryId'] for row in rows}:
        raise CollectionError('review IDs must exactly match observations')
    result = copy.deepcopy(rows)
    for row in result:
        item = by_id[row['queryId']]
        if item.get('answerStatus') not in ('answered', 'abstained'):
            continue
        if row['collectionStatus'] != 'collected':
            raise CollectionError('cannot adjudicate incomplete collection as a completed observation')
        if item.get('answerStatus') == 'answered' and (type(item.get('answerSupported')) is not bool or not item.get('answerEvidence')):
            raise CollectionError('answered review requires explicit support judgment and evidence')
        candidates = row['citations']
        reviewed = item.get('citations')
        if not isinstance(reviewed, list) or len(reviewed) != len(candidates):
            raise CollectionError('review must preserve every extracted citation candidate')
        for before, after in zip(candidates, reviewed):
            if any(before.get(key) != after.get(key) for key in ('entryId', 'url', 'storeId')):
                raise CollectionError('review cannot rewrite observed citation identity or URL')
            if before.get('sameOrigin') is not True and after.get('opens') is True:
                raise CollectionError('cross-origin citation cannot be approved as the target original')
        row.update({key: copy.deepcopy(item.get(key)) for key in ('answerStatus', 'answerSupported', 'answerEvidence', 'citations')})
    return result


def read_rows(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def write_rows(path, rows):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as output:
        for row in rows:
            output.write(json.dumps(row, ensure_ascii=False) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    run = sub.add_parser('run')
    run.add_argument('--base-url', required=True)
    run.add_argument('--mapping', type=Path, required=True)
    run.add_argument('--output-dir', type=Path, required=True)
    run.add_argument('--question-id', action='append')
    run.add_argument('--timeout-seconds', type=int, default=300)
    apply = sub.add_parser('apply-review')
    apply.add_argument('--observations', type=Path, required=True)
    apply.add_argument('--review', type=Path, required=True)
    apply.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'apply-review':
        if args.output.exists() or args.output.resolve() == args.observations.resolve():
            raise CollectionError('review output must be a new file; original observations are immutable')
        write_rows(args.output, apply_review(read_rows(args.observations), json.loads(args.review.read_text())))
        return 0
    if not 1 <= args.timeout_seconds <= 1800:
        raise CollectionError('timeout must be between 1 and 1800 seconds')
    if args.output_dir.exists() and any(args.output_dir.iterdir()):
        raise CollectionError('use an empty output directory to preserve earlier evidence')
    corpus = json.loads((ROOT / 'corpus.json').read_text())
    questions = json.loads((ROOT / 'questions.json').read_text())
    mapping = json.loads(args.mapping.read_text())
    runtime_corpus, runtime_questions = remap_inputs(corpus, questions, mapping)
    selected = runtime_questions['questions']
    if args.question_id:
        if set(args.question_id) - {q['queryId'] for q in selected}:
            raise CollectionError('unknown fixed question ID')
        selected = [q for q in selected if q['queryId'] in args.question_id]
    client = Client(args.base_url, os.environ.get('KB_EVAL_TOKEN'))
    if any(q['userId'] != client.authenticate() for q in selected[:1]):
        raise CollectionError('authenticated user does not match the mapped evaluation principal')
    args.output_dir.mkdir(parents=True, exist_ok=True)
    write_json(args.output_dir / 'runtime-corpus.json', runtime_corpus)
    write_json(args.output_dir / 'runtime-questions.json', runtime_questions)
    rows = []
    for question in selected:
        # No entry enumeration, implicit indexing, model configuration or task-permit fabrication.
        fixed = next(q for q in questions['questions'] if q['queryId'] == question['queryId'])
        source_entry = (fixed['forbiddenEntryIds'] or fixed['relevantEntryIds'] or ['travel-policy'])[0]
        store_id = mapping['entries'][source_entry]['storeId']
        journal_state = {}
        def journal(state):
            journal_state.update(copy.deepcopy(state))
            write_json(args.output_dir / (question['queryId'] + '-state.json'), state)
        try:
            row, events = collect_question(client, question, store_id, args.timeout_seconds, journal=journal)
        except (CollectionError, KeyError, OSError, TimeoutError):
            # Never re-POST a message whose acceptance is unknown: it may already consume model calls.
            row, events = {'queryId': question['queryId'], 'retrievedEntryIds': None, 'contextEntryIds': None,
                           'latencyMs': None, 'answerStatus': 'not_run', 'citations': [], 'collectionStatus': 'blocked',
                           'collectionIssues': [{'reason': 'collection interrupted; do not resubmit without checking the server session'}],
                           **{key: journal_state[key] for key in ('sessionId', 'turnId', 'assistantMessageId') if key in journal_state}}, journal_state.get('events', [])
        rows.append(row)
        write_json(args.output_dir / (question['queryId'] + '-events.json'), events)
        write_rows(args.output_dir / 'observations.jsonl', rows)
        write_json(args.output_dir / 'review-template.json', review_template(rows))
        print(question['queryId'] + ': ' + row['collectionStatus'])
    write_json(args.output_dir / 'manifest.json', {'schemaVersion': 1, 'baseUrl': client.base_url,
               'scope': 'normal ChatAgent REST/SSE diagnostic collection; not browser user-path acceptance',
               'primaryRetrieval': 'first semantic search call in event order; original order and per-call latency only',
               'questionCount': len(selected), 'reviewsPending': True,
               'fixedInputSha256': {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in ('corpus.json', 'questions.json')},
               'cleanup': 'Sessions retained for evidence; no knowledge data created/modified/deleted by the runner.'})
    return 2  # Human/browser adjudication is deliberately pending.


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (CollectionError, ValueError, KeyError, OSError):
        print('Collection blocked: check configuration/protocol and retained evidence; credentials are not printed.')
        raise SystemExit(2)
