#!/usr/bin/env python3
"""Offline diagnostic of KbSearchTool's literal substring predicate and recency order."""
import argparse
import json
from pathlib import Path
from time import perf_counter_ns

ROOT = Path(__file__).resolve().parent


def search(documents, query, user_id):
    # Regex.Escape(query), /i, Title|Summary|ContentIndex, SortByDescending(UpdatedAt), Limit(5).
    needle = query.strip().casefold()
    matches = [doc for doc in documents
               if (doc['ownerId'] == user_id or doc['isPublic'])
               and any(needle in doc.get(field, '').casefold() for field in ('title', 'summary', 'contentIndex'))]
    return [doc['entryId'] for doc in sorted(matches, key=lambda doc: doc['updatedAt'], reverse=True)[:5]]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    documents = json.loads((ROOT / 'corpus.json').read_text())['documents']
    questions = json.loads((ROOT / 'questions.json').read_text())['questions']
    rows = []
    for q in questions:
        start = perf_counter_ns()
        retrieved = search(documents, q['query'], q['userId'])
        rows.append({'queryId': q['queryId'], 'retrievedEntryIds': retrieved,
                     'contextEntryIds': [], 'latencyMs': (perf_counter_ns() - start) / 1e6,
                     'answerStatus': 'not_run', 'citations': None,
                     'diagnostic': 'Python reproduction of literal predicate; no API, Mongo, browser or model call'})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows))
    print(f'Wrote {len(rows)} retrieval-only diagnostic observations to {args.output}')


if __name__ == '__main__':
    main()
