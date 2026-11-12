#!/usr/bin/env python3
"""固定知识库评测：离线重放现有字面量检索，或对已准备的隔离测试库走真实问答 API。

不创建或重建任何知识库；live 模式从环境读取 KB_EVAL_TOKEN，映射文件必须提供固定语料的条目ID。
报告写到 --output；令牌、正文和完整上游响应不写报告。CLI/API 测量不是浏览器用户路径验收。
"""
import argparse
import collections
import hashlib
import json
import os
from pathlib import Path
import re
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request

FIXTURES = Path(__file__).resolve().parents[1] / 'fixtures' / 'knowledge-retrieval'


def load(name):
    return json.loads((FIXTURES / name).read_text())


def percentile(values, p):
    if not values:
        return None
    return sorted(values)[max(0, int(len(values) * p + .999) - 1)]


def summarize(rows, mode):
    recalls = [r['recallAt5'] for r in rows if r.get('recallAt5') is not None]
    citations = [c['correct'] for r in rows for c in r.get('citations', [])]
    answers = [r for r in rows if r.get('completed')]
    ungrounded = [r for r in answers if r.get('ungrounded')]
    retrieval = [r['retrievalMs'] for r in rows if r.get('retrievalMs') is not None]
    return {
        'mode': mode, 'questions': len(rows), 'completedAnswers': len(answers),
        'errors': sum(bool(r.get('error')) for r in rows),
        'recallAt5': statistics.mean(recalls) if recalls else None,
        'recallDenominator': len(recalls),
        'citationCorrectness': statistics.mean(citations) if citations else None,
        'citationDenominator': len(citations),
        'ungroundedAnswerRate': len(ungrounded) / len(answers) if answers else None,
        'ungroundedDenominator': len(answers),
        'retrievalLatencyMs': {'p50': percentile(retrieval, .5), 'p95': percentile(retrieval, .95)},
        'forbiddenLeaks': sum(r.get('forbiddenLeak', False) for r in rows) if mode == 'live' else None,
        'failuresAreNotSuccessfulAbstentions': True,
    }


def baseline(corpus, questions):
    """与 ListEntries 相同的字面量、大小写不敏感语义；Python计时不是API延迟。"""
    rows = []
    for q in questions:
        start = time.perf_counter()
        keyword = q['question'].strip().casefold()
        hits = [d['id'] for d in corpus if d['access'] == 'reader'
                and any(keyword in text.casefold() for text in [d['title'], d['text'][:2000]])][:5]
        expected = set(q['relevantDocuments'])
        rows.append({'id': q['id'], 'category': q['category'], 'hits': hits,
                     'recallAt5': len(expected.intersection(hits)) / len(expected) if expected else None,
                     'localLiteralReplayMs': (time.perf_counter() - start) * 1000,
                     'retrievalMs': None, 'completed': False})
    return rows


class Client:
    def __init__(self, base, token):
        self.base, self.token = base.rstrip('/'), token

    def request(self, path, body=None):
        request = urllib.request.Request(self.base + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization': 'Bearer ' + self.token,
                     'Content-Type': 'application/json', 'Accept': 'text/event-stream, application/json'})
        return urllib.request.urlopen(request, timeout=150)

    def content(self, entry):
        with self.request('/api/document-store/entries/' + urllib.parse.quote(entry, safe='') + '/content') as r:
            return json.load(r)['data'].get('content', '')


def frames(response):
    event, data = '', []
    for raw in response:
        line = raw.decode('utf-8').rstrip('\r\n')
        if not line:
            if data:
                yield event, json.loads('\n'.join(data))
            event, data = '', []
        elif line.startswith('event:'):
            event = line[6:].strip()
        elif line.startswith('data:'):
            data.append(line[5:].strip())


def live(client, questions, mapping):
    # mapping: siteId, storeId, deniedStoreId, entries: {fixtureId: realEntryId}
    for required in ('siteId', 'storeId', 'deniedStoreId', 'entries'):
        if not mapping.get(required):
            raise ValueError('映射缺少 ' + required + '，不得跳过权限样本')
    expected_keys = {d['id'] for d in load('corpus.json') if d['access'] == 'reader'}
    if not expected_keys <= set(mapping['entries']):
        raise ValueError('映射必须列全十二篇可读语料的条目ID')
    rows = []
    reverse = {v: k for k, v in mapping['entries'].items()}
    for q in questions:
        row = {'id': q['id'], 'category': q['category'], 'recallAt5': None,
               'retrievalMs': None, 'completed': False, 'citations': []}
        expected = set(q['relevantDocuments'])
        selected_store = mapping['deniedStoreId'] if q['category'] == 'forbidden' else mapping['storeId']
        start = time.perf_counter()
        refs, text, hits, observed = [], '', [], ''
        try:
            with client.request('/api/web-pages/' + urllib.parse.quote(mapping['siteId'], safe='') + '/ask/stream',
                {'question': q['question'], 'knowledgeStoreId': selected_store, 'history': []}) as response:
                for event, data in frames(response):
                    observed += json.dumps(data, ensure_ascii=False)
                    if event == 'retrieval':
                        hits = [reverse.get(h['entryId'], 'UNKNOWN') for h in data.get('hits', [])]
                        row['retrievalMs'] = data.get('elapsedMs')
                    elif event == 'reference':
                        refs = data.get('references', [])
                    elif event == 'done':
                        row['completed'] = True
                        text = data.get('text', '')
                    elif event == 'error':
                        row['error'] = data.get('code', 'SSE_ERROR')
                        row['errorMessage'] = data.get('message', '')
            if not row['completed'] and not row.get('error'):
                row['error'] = 'EOF_WITHOUT_DONE'
        except urllib.error.HTTPError as exc:
            observed += exc.read().decode('utf-8', errors='replace')
            row['httpStatus'] = exc.code
            if q['category'] == 'forbidden' and exc.code == 403:
                row['permissionDenied'] = True
            else:
                row['error'] = 'HTTP_' + str(exc.code)
        except (OSError, ValueError) as exc:
            row['error'] = type(exc).__name__
        row['endToEndMs'] = (time.perf_counter() - start) * 1000
        row['hits'] = hits
        # 失败也计入有答案题召回率分母，避免以剔除错误虚增结果。
        row['recallAt5'] = len(expected.intersection(hits)) / len(expected) if expected else None
        row['forbiddenLeak'] = (q['category'] == 'forbidden' and bool(hits or refs or row['completed'] or 'SAPPHIRE-7391' in observed or '87321' in observed))
        refusal = text.strip() == '在当前可读知识库中没有找到足够依据，无法回答。'
        row['ungrounded'] = bool(row['completed'] and not refusal and (not refs or not expected))
        for ref in refs:
            fixture = reverse.get(ref.get('entryId'), 'UNKNOWN')
            parsed = urllib.parse.urlparse(ref.get('url', ''))
            query = urllib.parse.parse_qs(parsed.query)
            opens = False
            try:
                content = client.content(ref['entryId'])
                # 固定语料均短于一个切块；真原文回读成功，且链接指向对应库和条目。
                opens = bool(content) and query.get('entry') == [ref['entryId']] and query.get('store') == [selected_store]
                opens = opens and parsed.path == '/document-store' and not parsed.netloc
                excerpt = ref.get('text', '')
                expected_hash = hashlib.sha256((ref.get('model', '') + '\0' + excerpt).encode()).hexdigest()[:32]
                normalized = re.sub(r'\n{3,}', '\n\n', content.replace('\r\n', '\n').replace('\r', '\n')).strip()
                opens = opens and bool(excerpt) and excerpt in normalized and expected_hash == ref.get('hash')
            except (OSError, ValueError, KeyError):
                pass
            row['citations'].append({'document': fixture, 'opensOriginalApi': opens,
                                      'correct': opens and fixture in expected})
        if row['completed'] and expected and not refs:
            row['falseAbstention'] = True
        if row['completed'] and refs and any(not c['correct'] for c in row['citations']):
            row['ungrounded'] = True
        rows.append(row)
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['baseline', 'live'], default='baseline')
    parser.add_argument('--base-url')
    parser.add_argument('--mapping', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    corpus, questions = load('corpus.json'), load('questions.json')
    assert len(questions) >= 30 and len({q['id'] for q in questions}) == len(questions)
    if args.mode == 'live':
        if not args.base_url or not args.mapping or not os.environ.get('KB_EVAL_TOKEN'):
            parser.error('live需要 --base-url、--mapping 和环境变量 KB_EVAL_TOKEN；不在命令行传密码')
        rows = live(Client(args.base_url, os.environ['KB_EVAL_TOKEN']), questions, json.loads(args.mapping.read_text()))
    else:
        rows = baseline(corpus, questions)
    report = {'schemaVersion': 1, 'fixtureSha256': hashlib.sha256((FIXTURES / 'questions.json').read_bytes()).hexdigest(),
              'summary': summarize(rows, args.mode), 'categoryCounts': dict(collections.Counter(q['category'] for q in questions)),
              'limits': ['离线字面量重放不是线上API基线', '原文API回读不代替浏览器登录导航及点击链接验收',
                         '引用内容是否充分回答问题仍需逐题人工复核；本工具先按固定相关文档标注计分'], 'rows': rows}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report['summary'], ensure_ascii=False))


if __name__ == '__main__':
    main()
