#!/usr/bin/env python3
"""Guard the actual skill baseline and keep source review separate from LLM claims."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
SCRIPT=ROOT/'scripts/reporting/skill-baseline/replay.py'
spec=importlib.util.spec_from_file_location('skill_baseline_replay',SCRIPT)
replay=importlib.util.module_from_spec(spec);spec.loader.exec_module(replay)
FIX=ROOT/'scripts/tests/fixtures/report_skill_generation'


class SkillReportEvaluationTests(unittest.TestCase):
    def test_complete_original_artifacts_have_pinned_provenance(self):
        manifest=replay.verify_archive();self.assertEqual(13,len(manifest['artifacts']))
        paths={a['path'] for a in manifest['artifacts']}
        self.assertIn('archive/report.2026-W38.html',paths)
        self.assertIn('archive/daily-2026-09-29.html',paths)
        self.assertTrue(all('sourceUrl' in a for a in manifest['artifacts']))
        collector=next(a for a in manifest['artifacts'] if a['path']=='archive/old-collect-week-context.py')
        self.assertEqual('3035365def7b30a28309b89a21756717fda846dd',collector['gitRef'])
        self.assertEqual('d483ff6547698d6bb065e75e93cfeaa69e6564f2e016787b579119051ad8b596',collector['sha256'])
        self.assertNotIn('PrdAgent.Api',collector['sourceUrl'])

    def test_actual_old_collector_loses_revision_date_body_and_watermark(self):
        result=replay.replay_collector(FIX/'archive/old-collect-week-context.py','old_skill_for_test')
        self.assertEqual({'missingFullRevision':2,'wrongObservationDateBucket':1,'missingDailyBody':3,'missingDailyWatermark':3,'missingDirectAcceptanceLink':0},result['metrics'])
        self.assertTrue(all(item['deeplink'] for item in result['acceptance']['items']))
        failure=next(f for f in result['retainedFailures'] if f['field']=='observationDate')
        self.assertEqual('2026-10-04',failure['actual']);self.assertEqual('2026-10-05',failure['expected'])

    def test_original_daily_bodies_and_watermarks_are_present_in_frozen_source(self):
        daily,_=replay.raw_records();self.assertEqual(3,len(daily))
        self.assertTrue(all(len(i['content'])>20000 for i in daily))
        for item in daily:
            self.assertEqual((FIX/'archive'/('daily-'+item['metadata']['dailyDate']+'.html')).read_text(),item['content'])
        self.assertTrue(all(len(i['metadata']['lastCommit'])==40 for i in daily))
        self.assertEqual('f474bb5761ba4a3088aa9f5da504f5aa',daily[1]['id'])
        self.assertIn('跨',daily[0]['content'])
        self.assertEqual('b543be5be63fd83d52597768823a053975786955',daily[1]['metadata']['lastCommit'])

    def test_review_keeps_true_old_limits_and_does_not_make_them_failures(self):
        review=replay.review_history();self.assertEqual(4,len(review['findings']))
        self.assertEqual(3,len(review['positiveControls']))
        self.assertTrue(all(x['spanFound'] for x in review['positiveControls']))
        ambiguous=next(x for x in review['findings'] if x['category']=='completionStageNeedsClarification')
        self.assertFalse(ambiguous['scored'])
        self.assertFalse(any(x['category']=='correctValidationScope' for x in review['findings']))

    def test_fixed_real_source_cases_cover_boundaries_without_unsupported_metrics(self):
        cases=replay.read_json(FIX/'cases.json');labels={c['id']:c for c in replay.read_json(FIX/'gold.json')['cases']}
        self.assertEqual(7,len(cases['cases']))
        for case in cases['cases']:
            self.assertFalse(case['strictSameInputLlmReplay'])
            report=replay.evidence.analyze(case['ledger'],case['start'],case['end'],case['cadence'])
            self.assertEqual([],replay.audit_current(report,labels[case['id']]),case['id'])
            self.assertTrue(all(e['source']['uri'].startswith('https://') and e['source']['excerpt'] for e in case['ledger']['events']))
            self.assertFalse(any(m['available'] for m in report['metrics'].values()))
        monthly=next(c for c in cases['cases'] if c['cadence']=='monthly')
        self.assertNotIn('archive/old-monthly',str(monthly['historicalArtifacts']))

    def test_wrong_stage_duplicate_and_omission_are_detected(self):
        case=replay.read_json(FIX/'cases.json')['cases'][0];gold=replay.read_json(FIX/'gold.json')['cases'][0]
        report=replay.evidence.analyze(case['ledger'],case['start'],case['end'],case['cadence'])
        report['items'][0]['current']['release']='released';report['items'].append(copy.deepcopy(report['items'][0]))
        report['items']=[i for i in report['items'] if i['workItemId']!='kb-sync']
        failures=replay.audit_current(report,gold)
        self.assertTrue({'duplicate','omission','wrongConclusion'}<={f['type'] for f in failures})

    def test_required_real_edition_cannot_silently_fall_back_to_facts_only(self):
        with tempfile.TemporaryDirectory(prefix='skill-report-required-') as temp:
            result=subprocess.run([sys.executable,str(SCRIPT),'--out',temp+'/comparison.json','--work',temp+'/work','--edition-script',temp+'/missing.py','--require-edition'],cwd=ROOT,capture_output=True,text=True)
            self.assertNotEqual(0,result.returncode)
            self.assertIn('实际技能edition入口不存在',result.stderr)


if __name__=='__main__':unittest.main()
