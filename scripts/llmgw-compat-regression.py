#!/usr/bin/env python3
"""Fixed protocol corpus, semantic comparison and separate real-provider evidence.

Simulation captures come from ProtocolCompatibilityReplayTests (production HTTP
endpoints + gateway + adapters). Live mode never reads or falls back to captures.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import sys
import urllib.parse
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / 'scripts/fixtures/llmgw-compat/requests.json'
SPEC = importlib.util.spec_from_file_location('protocol_canary', ROOT / 'scripts/llmgw-protocol-canary.py')
CANARY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CANARY)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise OSError('credentialed target redirect refused')


def events(raw):
    result, done = [], False
    # SSE records, including event names, comments, and multi-line data.
    for record in raw.replace('\r\n', '\n').split('\n\n'):
        data = '\n'.join(line[5:].lstrip(' ') for line in record.splitlines() if line.startswith('data:'))
        if data == '[DONE]':
            done = True
        elif data:
            result.append(json.loads(data))
    return result, done


def get(obj, key, default=None):
    if key in obj:
        return obj[key]
    return obj.get(key[0].upper() + key[1:], default)


def response_error_code(raw, content_type):
    """Keep a bounded structured code, never an arbitrary error message/body."""
    try:
        frames = events(raw)[0] if 'text/event-stream' in content_type else [json.loads(raw)]
        for frame in frames:
            if not isinstance(frame, dict): continue
            error = get(frame, 'error')
            code = get(frame, 'errorCode') or (error.get('code') if isinstance(error, dict) else None)
            if isinstance(code, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{1,79}', code): return code
    except (ValueError, TypeError):
        pass
    return None


def normalize(case, status, content_type, raw, expected_usage=None):
    """Drop volatile IDs/timestamps/text wording; require protocol structure first."""
    assert 200 <= status < 300, f'HTTP {status}'
    stream, protocol = case['stream'], case['protocol']
    assert ('text/event-stream' if stream else 'application/json') in content_type, 'content type'
    frames, done = events(raw) if stream else ([json.loads(raw)], True)
    assert frames, 'empty response'
    reported_model = None
    text, finish, usage, tools, terminal = '', None, {}, {}, done if protocol == 'openai' else not stream

    def tool_delta(index, name=None, args=None, call_id=None):
        item = tools.setdefault(index, {'name': '', 'arguments': '', 'id': ''})
        if name: item['name'] += name
        if call_id: item['id'] = call_id
        if args is not None: item['arguments'] += args

    for f in frames:
        assert isinstance(f, dict), 'response event must be an object'
        assert not f.get('error') and get(f, 'success', True) is not False, 'error response'
        if protocol == 'native':
            reported_model = get(get(f, 'resolution') or {}, 'actualModel') or reported_model
            if stream:
                typ = get(f, 'type')
                # Native DTO enum is serialized as a number by the serving host.
                if typ in (1, 'Text'): text += get(f, 'content', '') or ''
                if typ in (5, 'Error'): raise AssertionError('native stream error')
                if typ in (4, 'Done'):
                    finish = get(f, 'finishReason'); terminal = True
                for t in get(f, 'toolCallDelta', []) or []:
                    fn = t['function']; tool_delta(t.get('index', 0), fn.get('name'), fn.get('arguments'), t.get('id'))
            else:
                text += get(f, 'content', '') or ''
                # Native non-stream DTO does not currently expose finish reason.
                finish = 'tools' if get(f, 'toolCalls') else 'stop'
                for i, t in enumerate(get(f, 'toolCalls', []) or []):
                    tool_delta(i, t['function']['name'], t['function']['arguments'], t.get('id'))
            u = get(f, 'tokenUsage') or {}
            for k in ('inputTokens', 'outputTokens'):
                if get(u, k) is not None: usage[k] = get(u, k)
        elif protocol == 'openai':
            reported_model = f.get('model') or reported_model
            for c in f.get('choices', []):
                d = c.get('delta' if stream else 'message', {})
                text += d.get('content') or ''
                if c.get('finish_reason') is not None: finish = c['finish_reason']
                for i, t in enumerate(d.get('tool_calls') or []):
                    fn = t['function']; tool_delta(t.get('index', i), fn.get('name'), fn.get('arguments'), t.get('id'))
            u = f.get('usage') or {}
            for src, dst in [('prompt_tokens', 'inputTokens'), ('completion_tokens', 'outputTokens')]:
                if u.get(src) is not None: usage[dst] = u[src]
        elif protocol == 'claude':
            reported_model = f.get('model') or f.get('message', {}).get('model') or reported_model
            if stream:
                typ = f.get('type')
                if typ == 'error': raise AssertionError('claude stream error')
                if typ == 'message_stop': terminal = True
                if typ == 'content_block_start' and f['content_block']['type'] == 'tool_use':
                    b = f['content_block']; tool_delta(f['index'], b['name'], call_id=b.get('id'))
                if typ == 'content_block_delta':
                    d = f['delta']; text += d.get('text', '')
                    if d.get('type') == 'input_json_delta': tool_delta(f['index'], args=d['partial_json'])
                if typ == 'message_delta': finish = f['delta'].get('stop_reason')
                u = f.get('usage') or f.get('message', {}).get('usage') or {}
            else:
                for i, b in enumerate(f['content']):
                    text += b.get('text', '')
                    if b['type'] == 'tool_use': tool_delta(i, b['name'], json.dumps(b['input']), b.get('id'))
                finish = f.get('stop_reason'); u = f.get('usage') or {}
            for src, dst in [('input_tokens', 'inputTokens'), ('output_tokens', 'outputTokens')]:
                if u.get(src) is not None: usage[dst] = u[src]
        elif protocol == 'gemini':
            reported_model = f.get('modelVersion') or reported_model
            for c in f.get('candidates', []):
                if c.get('finishReason'): finish = c['finishReason']; terminal = True
                for i, p in enumerate(c.get('content', {}).get('parts', [])):
                    text += p.get('text', '')
                    if 'functionCall' in p:
                        b = p['functionCall']; tool_delta(i, b['name'], json.dumps(b['args']))
            u = f.get('usageMetadata') or {}
            for src, dst in [('promptTokenCount', 'inputTokens'), ('candidatesTokenCount', 'outputTokens')]:
                if u.get(src) is not None: usage[dst] = u[src]
        else:
            raise AssertionError('unknown protocol')
    # The serving native enum order: Start, Text, Thinking, ToolCall, Done, Error.
    assert isinstance(reported_model, str) and reported_model.strip(), 'missing reported model'
    assert terminal, 'missing stream terminator'
    assert finish, 'missing finish reason'
    allowed = {'openai': {'stop','tool_calls'}, 'claude': {'end_turn','tool_use'}, 'gemini': {'STOP','FUNCTION_CALL'}}
    if protocol in allowed:
        assert finish in allowed[protocol], 'invalid finish enum for ingress protocol'
    finish = {'stop':'stop', 'end_turn':'stop', 'STOP':'stop', 'tools':'tools',
              'tool_calls':'tools', 'tool_use':'tools', 'FUNCTION_CALL':'tools'}.get(finish, finish)
    assert finish in ('stop', 'tools'), 'unexpected finish reason'
    assert usage.get('outputTokens') is not None, 'missing output usage'
    assert all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in usage.values()), 'invalid usage'
    if expected_usage is not None:
        assert all(value == expected_usage[key] for key, value in usage.items()), 'usage values changed'
    # Claude compatible streaming currently supplies output usage only; keep this debt explicit.
    if not (protocol == 'claude' and stream):
        assert usage.get('inputTokens') is not None, 'missing input usage'
    normalized_tools = []
    for t in tools.values():
        assert t['name'], 'missing tool name'
        if protocol != 'gemini': assert t['id'], 'missing tool id'
        normalized_tools.append({'name':t['name'], 'arguments':json.loads(t['arguments'])})
    if case['kind'] == 'tools':
        assert normalized_tools == [{'name':'echo_city','arguments':{'city':'北京'}}], 'tool arguments/name changed'
        assert finish == 'tools', 'tool finish reason'
    else:
        assert not normalized_tools, 'unexpected tool'
        expected_text = case.get('expectedText')
        assert isinstance(expected_text, str) and expected_text, 'fixed request has no text expectation'
        assert text.strip() == expected_text, 'fixed text meaning changed'
        assert finish == 'stop', 'text finish reason'
    return {'reportedModel': reported_model, 'text': text.strip() if case['kind'] != 'tools' else None, 'textPresent':bool(text.strip()), 'finish':finish, 'finishEvidence': 'inferred' if protocol == 'native' and not stream else 'wire', 'tools':normalized_tools,
            'usageFields':sorted(usage), 'usageValid':True}


def validate_rejection(case, status, content_type, raw):
    """A matching phrase in successful output is not an error contract."""
    code = 'PARAMETER_PROTOCOL_UNSUPPORTED'
    if status == 400:
        assert 'application/json' in content_type, 'rejection content type'
        payload = json.loads(raw)
        assert isinstance(payload, dict), 'rejection must be an object'
        assert get(payload, 'success') is False and get(payload, 'errorCode') == code, 'missing structured rejection'
    else:
        assert case['stream'] and status == 200 and 'text/event-stream' in content_type, 'rejection status or content type'
        frames, _ = events(raw)
        assert frames and all(isinstance(f, dict) for f in frames), 'invalid rejection events'
        assert any(get(f, 'type') in (5, 'Error') and get(f, 'errorCode') == code for f in frames), 'missing structured rejection'
        assert all(get(f, 'type') in (0, 5, 'Start', 'Error') for f in frames), 'rejected request produced successful output'
    return {'rejected': code}


def compare(before, after):
    assert before['schema'] == after['schema'] == 1, 'report schema mismatch'
    assert before['corpusSha256'] == after['corpusSha256'], 'different fixed requests'
    assert before['mode'] == after['mode'], 'cannot compare simulated and real evidence'
    assert before['status'] == after['status'] == 'pass', 'only passing reports are comparable'
    a = {c['id']:c['semantic'] for c in before['cases']}
    b = {c['id']:c['semantic'] for c in after['cases']}
    assert a == b, 'semantic results differ'
    if before['mode'] == 'provider':
        assert before['targetContract'] == after['targetContract'], 'different provider target contract'


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--mode', choices=['simulation','provider'], required=True)
    p.add_argument('--captures', type=Path)
    p.add_argument('--target', type=Path, help='provider JSON: base, model, upstream, keyEnv, caseIds, appCallerCode(optional), headersEnv(optional)')
    p.add_argument('--expected-commit', required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--baseline', type=Path)
    args = p.parse_args(argv)
    corpus = json.loads(CORPUS.read_text())['cases']
    report = {'schema':1,'mode':args.mode,'expectedCommit':args.expected_commit,
              'corpusSha256':hashlib.sha256(CORPUS.read_bytes()).hexdigest(), 'status':'fail','cases':[]}
    try:
        report['boundaries'] = ['native JSON finish reason is inferred: DTO does not expose it', 'Claude compatible SSE has output usage only', 'truncation/safety finish reasons are adapter-tested; compatible egress fidelity is not certified', 'native Responses uses separate xUnit fixtures; real Responses is unverified']
        if args.mode == 'simulation':
            assert args.captures and args.captures.is_dir(), 'missing simulation captures'
            jobs = [(c,u) for c in corpus for u in ['openai','claude']]
        else:
            assert args.expected_commit and len(args.expected_commit) == 40 and all(c in '0123456789abcdef' for c in args.expected_commit.lower()), 'exact 40-character deployed commit required'
            assert args.target, 'provider target is not configured; no provider validation performed'
            target = json.loads(args.target.read_text())
            caller = target.get('appCallerCode', 'report-agent.generate::chat')
            assert isinstance(caller, str) and caller.strip() == caller and caller, 'explicit nonempty appCallerCode required'
            target['appCallerCode'] = caller
            assert target['upstream'] in ('openai','claude'), 'declare actual upstream protocol'
            assert target['model'] and target['model'] != 'auto', 'fixed model required'
            parsed_base = urllib.parse.urlsplit(target['base'])
            assert parsed_base.scheme == 'https' and parsed_base.hostname and not (parsed_base.username or parsed_base.password or parsed_base.query or parsed_base.fragment), 'clean HTTPS target required'
            assert target['caseIds'] and len(set(target['caseIds'])) == len(target['caseIds']), 'explicit nonempty caseIds required'
            assert set(target['caseIds']) <= {c['id'] for c in corpus}, 'unknown caseIds'
            key = os.environ.get(target['keyEnv'], '')
            assert key, 'provider gateway key is unavailable'
            health, failures = CANARY._health_check(target['base'], args.expected_commit, 20)
            assert not failures and health['ok'] and health['commit'] == args.expected_commit.lower(), 'target version not verified'
            report['observedCommit'] = health['commit']
            report['targetContract'] = {k:target[k] for k in ('base','model','upstream','appCallerCode','caseIds')}
            report['unverified'] = [c['id'] for c in corpus if c['id'] not in target['caseIds']]
            jobs = [(c,target['upstream']) for c in corpus if c['id'] in target['caseIds']]
        for case, upstream in jobs:
            item = {'id':upstream+'--'+case['id'],'status':'fail'}
            try:
                rejected = upstream == 'claude' and case['kind'] == 'reasoning'
                if args.mode == 'simulation':
                    cap = json.loads((args.captures / (item['id']+'.json')).read_text())
                    assert isinstance(cap.get('sourceCommit'), str), 'missing capture assembly version'
                    assert cap['sourceCommit'].lower() == args.expected_commit.lower(), 'capture assembly version mismatch'
                    report['observedCommit'] = cap['sourceCommit']
                    status, content_type, raw = cap['status'], cap['contentType'], cap['raw']
                else:
                    body = copy.deepcopy(case['body'])
                    body['ExpectedModel' if case['protocol']=='native' else 'model'] = target['model']
                    if case['protocol'] == 'native': body['AppCallerCode'] = target['appCallerCode']
                    headers = {'X-Gateway-App-Caller':target['appCallerCode'],
                               'X-Gateway-Source':'compat-regression',
                               'X-Gateway-Include-Thinking':'false',
                               'X-Gateway-Run-Id':'compat-'+args.expected_commit[:12]}
                    headers.update(json.loads(os.environ.get(target.get('headersEnv',''), '{}')))
                    assert all(v == target['appCallerCode'] for k,v in headers.items() if k.lower() == 'x-gateway-app-caller'), 'caller header differs from target contract'
                    assert not any(k.lower() == 'x-gateway-dry-run' for k in headers), 'dry-run forbidden in provider mode'
                    headers.update({'Content-Type':'application/json', 'X-Gateway-Key':key})
                    url = target['base'].rstrip('/') + case['path'].replace('{model}', 'auto')
                    req = urllib.request.Request(url,data=json.dumps(body,ensure_ascii=False).encode(),headers=headers,method='POST')
                    try:
                        response = urllib.request.build_opener(NoRedirect()).open(req,timeout=90)
                    except urllib.error.HTTPError as exc:
                        response = exc
                    with response:
                        status = response.code
                        content_type = response.headers.get('Content-Type','')
                        raw = response.read(2_000_001).decode('utf-8')
                    assert len(raw.encode('utf-8')) <= 2_000_000, 'response evidence limit exceeded'
                    # Save safe response facts, never arbitrary upstream text or credentials.
                    item['httpStatus'] = status
                    item['contentType'] = content_type
                    item['responseBytes'] = len(raw.encode('utf-8'))
                    item['responseSha256'] = hashlib.sha256(raw.encode()).hexdigest()
                    code = response_error_code(raw, content_type)
                    if code: item['errorCode'] = code
                if rejected:
                    item['semantic'] = validate_rejection(case, status, content_type, raw)
                else:
                    item['semantic'] = normalize(case,status,content_type,raw, {'inputTokens':11,'outputTokens':7} if args.mode == 'simulation' else None)
                item['status'] = 'pass'
            except (AssertionError, KeyError, ValueError, TypeError, OSError) as exc:
                item['failure'] = str(exc) if isinstance(exc, AssertionError) else 'invalid protocol shape or unavailable transport/capture'
            report['cases'].append(item)
        assert report['cases'] and all(c['status']=='pass' for c in report['cases']), 'one or more protocol cases failed'
        report['status'] = 'pass'
        if args.baseline: compare(json.loads(args.baseline.read_text()),report)
    except (AssertionError, KeyError, ValueError, TypeError, OSError) as exc:
        report['status'] = 'fail'
        # Never include HTTP exception bodies, headers, credentials or model output in public CI reports.
        report['failure'] = str(exc) if isinstance(exc, AssertionError) else type(exc).__name__
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(f"{args.mode}: {report['status']} ({sum(c['status']=='pass' for c in report['cases'])}/{len(report['cases'])})")
    return 0 if report['status']=='pass' else 1

if __name__ == '__main__': sys.exit(main())
