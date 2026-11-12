#!/usr/bin/env python3
"""Compare frozen legacy replays and current reports against independent labelled facts."""
import argparse
import json
from pathlib import Path
from evidence import analyze


def score(claims, gold, evidence):
    expected = {(wid, field): value for wid, fields in gold["states"].items() for field, value in fields.items()}
    grouped = {}
    for c in claims:
        grouped.setdefault((c["workItemId"], c["field"]), []).append(c)
    missing = [dict(workItemId=k[0], field=k[1], expected=v) for k, v in expected.items() if k not in grouped]
    duplicates = [dict(workItemId=k[0], field=k[1], extra=len(v)-1) for k, v in grouped.items() if len(v) > 1]
    errors = [dict(c, expected=expected.get(k, "未出现在预期中")) for k, cs in grouped.items() for c in cs if k not in expected or c["value"] != expected[k]]
    # Unknown / false are evidence-absence statements, not positive assertions.
    def supported(c):
        if c["value"] in ("unknown", False):
            return True
        sources = [evidence.get(eid) for eid in c.get("sources", [])]
        if not sources or not all(sources) or any(e.get("workItemId") != c["workItemId"] for e in sources):
            return False
        kinds = {e["kind"] for e in sources}
        if c["field"] == "code" and c["value"] == "complete":
            return "code_complete" in kinds
        if c["field"] == "validation" and c["value"] in {"passed", "failed"}:
            return any(e["kind"] == "validation_" + c["value"] and e.get("scope") == "feature" for e in sources)
        if c["field"] == "release" and c["value"] == "released":
            return any(e["kind"] == "release_succeeded" and e.get("environment") == "production" for e in sources)
        if c["field"] == "blocked" and c["value"] is True:
            return "blocked" in kinds
        return True
    unsupported = [c for c in claims if not supported(c)]
    return {"omissions": len(missing), "duplicates": sum(d["extra"] for d in duplicates),
            "wrongConclusions": len(errors), "unsupportedPositiveClaims": len(unsupported),
            "failures": {"omissions": missing, "duplicates": duplicates, "wrongConclusions": errors,
                         "unsupportedPositiveClaims": unsupported}}


def evaluate(fixtures):
    fixture_dir = Path(fixtures)
    ledger = json.loads((fixture_dir / 'cases.json').read_text())
    gold = json.loads((fixture_dir / 'gold.json').read_text())
    legacy = json.loads((fixture_dir / 'legacy-replay.json').read_text())
    rows = []
    evidence = {e['id']:e for e in ledger['events']}
    for g in gold:
        current = analyze(ledger, g['start'], g['end'], g['cadence'])
        before = score(legacy['reports'][g['id']]['claims'], g, evidence)
        after = score(current['claims'], g, evidence)
        if current['newMilestones'] != g['newMilestones']:
            raise AssertionError(f"{g['id']} 新增里程碑不符")
        if any(m['available'] for m in current['metrics'].values()) != g['metricsAvailable']:
            raise AssertionError(f"{g['id']} 指标证据边界不符")
        rows.append({'id':g['id'], 'before':before, 'after':after})
    keys = ('omissions', 'duplicates', 'wrongConclusions', 'unsupportedPositiveClaims')
    totals = {side:{key:sum(r[side][key] for r in rows) for key in keys} for side in ('before','after')}
    return {'baselineMethod':legacy['method'], 'scope':'固定人工旧模板复演对比；不是线上历史质量改善率，也不是模型随机多次运行统计。',
            'totals':totals, 'cases':rows}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--fixtures',default='scripts/tests/fixtures/report_evidence')
    p.add_argument('--out',required=True)
    a=p.parse_args()
    result=evaluate(a.fixtures)
    Path(a.out).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(result['totals'],ensure_ascii=False))
    if any(result['totals']['after'].values()):
        raise SystemExit(1)


if __name__=='__main__':
    main()
