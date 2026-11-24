#!/usr/bin/env python3
"""Offline merge of distinct fixed-question runs, without dropping failures or citations."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil

from collect import CollectionError, review_template


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path):
    return json.loads(path.read_text())


def merge(plan_path, directories, output):
    plan = load(plan_path)
    if output.exists():
        raise CollectionError('use a new merge directory; raw evidence must remain immutable')
    expected = plan['expectedQueryIds']
    if len(expected) != len(set(expected)) or len(expected) != 40:
        raise CollectionError('plan must contain the complete unique fixed question set')
    raw_by_id = {}
    source_records = []
    canonical = None
    for directory in directories:
        manifest = load(directory / 'manifest.json')
        if manifest.get('baseUrl') != plan['baseUrl'] or manifest.get('fixedInputSha256') != plan['fixedInputSha256']:
            raise CollectionError('source origin or fixed input hashes differ from the frozen plan')
        for name, expected_hash in plan['runtimeInputSha256'].items():
            if sha256(directory / name) != expected_hash:
                raise CollectionError('runtime corpus/questions differ across runs or from the frozen plan')
        question_ids = [question['queryId'] for question in load(directory / 'runtime-questions.json')['questions']]
        if question_ids != expected:
            raise CollectionError('runtime question order differs from the fixed plan')
        rows_path = directory / 'observations.jsonl'
        row_count = 0
        for raw_line in rows_path.read_bytes().splitlines(keepends=True):
            if not raw_line.strip():
                continue
            row = json.loads(raw_line)
            if not isinstance(row, dict) or not isinstance(row.get('citations'), list):
                raise CollectionError('observation citation structure is missing; preserve and inspect the producer output')
            key = row.get('queryId')
            if key not in expected or key in raw_by_id:
                raise CollectionError('unknown or duplicate question; never silently select the better attempt')
            raw_by_id[key] = raw_line if raw_line.endswith(b'\n') else raw_line + b'\n'
            row_count += 1
        if row_count != manifest.get('questionCount'):
            raise CollectionError('source row count differs from its run manifest')
        source_records.append({'directory': str(directory.resolve()), 'observationsSha256': sha256(rows_path),
                               'manifestSha256': sha256(directory / 'manifest.json'), 'rowCount': row_count})
        canonical = canonical or directory
    if set(raw_by_id) != set(expected):
        raise CollectionError('fixed questions are missing; an incomplete run is not a complete 40-question merge')
    # Validation is complete before any output is created. Every raw JSONL row is copied verbatim.
    output.mkdir(parents=True, mode=0o700)
    for name in ('runtime-corpus.json', 'runtime-questions.json'):
        shutil.copyfile(canonical / name, output / name)
        os.chmod(output / name, 0o600)
    descriptor = os.open(output / 'observations.jsonl', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as destination:
        for key in expected:
            destination.write(raw_by_id[key])
    template = review_template([json.loads(raw_by_id[key]) for key in expected])
    descriptor = os.open(output / 'review-template.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as destination:
        json.dump(template, destination, ensure_ascii=False, indent=2)
        destination.write('\n')
    result = {'schemaVersion': 1, 'status': 'merged_original_observations_pending_review', 'questionCount': len(expected),
              'baseUrl': plan['baseUrl'], 'fixedInputSha256': plan['fixedInputSha256'],
              'runtimeInputSha256': plan['runtimeInputSha256'], 'planSha256': sha256(plan_path), 'sources': source_records,
              'serviceRevisionDeclaredByPlan': plan.get('serviceRevisionForCollection'),
              'serviceRevisionVerifiedByMerge': False,
              'reviewsStillRequired': True, 'failedOrBlockedRowsRetained': True,
              'note': 'Raw JSONL and every citation are preserved; this offline merge cannot verify deployment, browser opening or answer support.'}
    descriptor = os.open(output / 'merge-manifest.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as destination:
        json.dump(result, destination, ensure_ascii=False, indent=2)
        destination.write('\n')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--input', type=Path, action='append', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        result = merge(args.plan, args.input, args.output)
        print(json.dumps({'status': result['status'], 'questionCount': result['questionCount'], 'reviewsStillRequired': True}))
        return 0
    except (CollectionError, KeyError, ValueError, OSError):
        print('Merge blocked: preserve original runs and check duplicate/missing questions and frozen input hashes.')
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
