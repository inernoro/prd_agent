#!/usr/bin/env python3
"""Score observed KB runs; absent evidence is blocked, never a passing zero."""
import argparse
import hashlib
import json
import math
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent


def load_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def percentile(values, fraction):
    values = sorted(values)
    return values[max(0, math.ceil(len(values) * fraction) - 1)]


def blocked(reason):
    return {'status': 'blocked', 'value': None, 'reason': reason}


def metric(value, count):
    return {'status': 'measured', 'value': value, 'sampleCount': count}


def source_opens_entry(url, entry_id, store_id):
    parsed = urlsplit(url or '')
    query = parse_qs(parsed.query)
    return (parsed.scheme in ('', 'http', 'https') and parsed.path == '/document-store'
            and query.get('entry') == [entry_id] and query.get('store') == [store_id])


def evaluate(corpus, questions, observations, mode='real'):
    docs = {doc['entryId']: doc for doc in corpus['documents']}
    question_by_id = {q['queryId']: q for q in questions['questions']}
    if len(question_by_id) != len(questions['questions']):
        raise ValueError('duplicate queryId in fixed questions')
    rows = {}
    for row in observations:
        key = row.get('queryId')
        if key not in question_by_id or key in rows:
            raise ValueError(f'unknown or duplicate queryId: {key}')
        rows[key] = row
    missing = sorted(set(question_by_id) - set(rows))
    retrieval_complete = not missing
    answer_complete = not missing
    recall = []
    latency = []
    valid_citations = 0
    citation_count = 0
    answered = 0
    unsupported = 0
    leaks = []
    details = []
    for key, q in question_by_id.items():
        row = rows.get(key)
        if row is None:
            details.append({'queryId': key, 'status': 'blocked', 'reason': 'missing observation'})
            continue
        retrieved = row.get('retrievedEntryIds')
        contexts = row.get('contextEntryIds')
        if not isinstance(retrieved, list) or not isinstance(contexts, list):
            retrieval_complete = False
            answer_complete = False
            details.append({'queryId': key, 'status': 'blocked', 'reason': 'retrieval/context evidence missing'})
            continue
        if any(not isinstance(entry, str) for entry in retrieved + contexts):
            raise ValueError(f'{key}: entry IDs must be strings')
        allowed = {entry_id for entry_id, doc in docs.items()
                   if doc['ownerId'] == q['userId'] or doc['isPublic']}
        forbidden = sorted((set(retrieved + contexts) - allowed) | (set(retrieved + contexts) & set(q['forbiddenEntryIds'])))
        if forbidden:
            leaks.append({'queryId': key, 'entryIds': forbidden})
        expected = set(q['relevantEntryIds'])
        item = {'queryId': key, 'status': 'observed', 'unauthorizedEntryIds': forbidden}
        if expected:
            score = len(set(retrieved[:5]) & expected) / len(expected)
            recall.append(score)
            item['recallAt5'] = score
        elapsed = row.get('latencyMs')
        if isinstance(elapsed, (int, float)) and not isinstance(elapsed, bool) and math.isfinite(elapsed) and elapsed >= 0:
            latency.append(elapsed)
        else:
            retrieval_complete = False
            item['latencyStatus'] = 'blocked'
        status = row.get('answerStatus')
        citations = row.get('citations')
        if status not in ('answered', 'abstained') or not isinstance(citations, list):
            answer_complete = False
            item['answerStatus'] = 'blocked'
        else:
            row_valid = 0
            row_adjudication_complete = True
            for citation in citations:
                citation_count += 1
                entry = citation.get('entryId')
                doc = docs.get(entry)
                # opens/supports require actual browser verification and adjudication evidence.
                if type(citation.get('opens')) is not bool or type(citation.get('supports')) is not bool:
                    row_adjudication_complete = False
                quote = citation.get('quote')
                valid = (doc is not None and entry in allowed and citation.get('opens') is True
                         and citation.get('supports') is True and bool(citation.get('openEvidence'))
                         and bool(citation.get('supportEvidence')) and isinstance(quote, str) and bool(quote.strip())
                         and quote in doc['content']
                         and source_opens_entry(citation.get('url'), entry, doc['storeId']))
                if valid:
                    valid_citations += 1
                    row_valid += 1
                if entry not in allowed:
                    leaks.append({'queryId': key, 'entryIds': [entry], 'location': 'citation'})
            if not row_adjudication_complete:
                answer_complete = False
            if status == 'answered':
                answered += 1
                if type(row.get('answerSupported')) is not bool or not row.get('answerEvidence'):
                    answer_complete = False
                # A factually plausible answer without an openable, supporting source is ungrounded.
                if row.get('answerSupported') is not True or row_valid == 0 or not expected or forbidden:
                    unsupported += 1
            item['answerStatus'] = status
            item['validCitations'] = row_valid
        details.append(item)
    metrics = {
        'recallAt5': metric(sum(recall) / len(recall), len(recall)) if retrieval_complete and recall else blocked('incomplete retrieval observations'),
        'citationCorrectness': metric(valid_citations / citation_count, citation_count) if answer_complete and citation_count else blocked('no complete citation/open/support evidence'),
        'unsupportedAnswerRate': metric(unsupported / answered, answered) if answer_complete and answered else blocked('no complete answered observations'),
        'retrievalLatencyMs': ({'status': 'measured', 'sampleCount': len(latency), 'p50': percentile(latency, .5),
                                'p95': percentile(latency, .95), 'max': max(latency)}
                               if retrieval_complete and latency else blocked('incomplete retrieval timing evidence')),
    }
    return {
        'schemaVersion': 1, 'mode': mode,
        'scope': 'real deployment observations' if mode == 'real' else 'offline algorithm diagnostic; not deployed or model quality evidence',
        'questionCount': len(question_by_id), 'observedCount': len(rows), 'missingQueryIds': missing,
        'metrics': metrics,
        'categoryRecallAt5': {category: {
            'questionCount': sum(q['category'] == category for q in questions['questions']),
            'value': (sum(item['recallAt5'] for item in details if question_by_id[item['queryId']]['category'] == category and 'recallAt5' in item)
                      / sum(1 for item in details if question_by_id[item['queryId']]['category'] == category and 'recallAt5' in item))
                     if retrieval_complete and any(question_by_id[item['queryId']]['category'] == category and 'recallAt5' in item for item in details) else None
        } for category in sorted({q['category'] for q in questions['questions']})},
        'permissionIsolation': {'status': 'fail' if leaks else ('pass' if retrieval_complete else 'blocked'), 'violations': leaks},
        'verdict': 'fail' if leaks else ('measured' if all(v['status'] == 'measured' for v in metrics.values()) else 'blocked'),
        'perQuestion': details,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus', type=Path, default=ROOT / 'corpus.json')
    parser.add_argument('--questions', type=Path, default=ROOT / 'questions.json')
    parser.add_argument('--observations', type=Path)
    parser.add_argument('--mode', choices=['real', 'offline-diagnostic'], default='real')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    rows = [] if args.observations is None else [json.loads(line) for line in args.observations.read_text().splitlines() if line.strip()]
    result = evaluate(load_json(args.corpus), load_json(args.questions), rows, args.mode)
    result['inputSha256'] = {str(path.name): hashlib.sha256(path.read_bytes()).hexdigest()
                             for path in (args.corpus, args.questions, args.observations) if path is not None}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: result[k] for k in ('verdict', 'mode', 'questionCount', 'observedCount', 'metrics', 'permissionIsolation')}, ensure_ascii=False))
    return 1 if result['verdict'] == 'fail' else (2 if result['verdict'] == 'blocked' else 0)


if __name__ == '__main__':
    raise SystemExit(main())
