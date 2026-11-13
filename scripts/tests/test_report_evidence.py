#!/usr/bin/env python3
"""Behavioural regressions for cross-period delivery evidence, run by the existing Python CI loop."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts/reporting'))
from evidence import analyze, collect_git, normalize, render_html, render_markdown
from evaluate import evaluate
FIX=ROOT/'scripts/tests/fixtures/report_evidence'


def event(id,kind,revision='v1',day='2026-02-01',**kwargs):
    return dict(id=id,kind=kind,revision=revision,occurredAt=day+'T10:00:00+08:00',workItemId='one',
                source={'uri':'fixture://tests/'+id,'excerpt':kind},**kwargs)


def single(events):
    return {'schemaVersion':1,'historyComplete':True,'workItems':[{'id':'one','title':'一件事'}],'events':events}


class ReportEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.ledger=json.loads((FIX/'cases.json').read_text())

    def test_independent_gold_for_all_cadences(self):
        for g in json.loads((FIX/'gold.json').read_text()):
            with self.subTest(g['id']):
                r=analyze(self.ledger,g['start'],g['end'],g['cadence'])
                actual={i['workItemId']:{f:i['current'][f] for f in ('code','validation','release','blocked')} for i in r['items']}
                self.assertEqual(g['states'],actual)
                self.assertEqual(g['newMilestones'],r['newMilestones'])

    def test_retries_and_repairs_do_not_recount_code_completion(self):
        r=analyze(self.ledger,'2026-02-05','2026-02-06')
        self.assertEqual(0,r['newMilestones']['code'])
        retry=next(i for i in r['items'] if i['workItemId']=='retry')
        self.assertEqual('complete',retry['current']['code'])
        self.assertEqual('延续推进',retry['movement'])
        self.assertEqual(1,len([e for e in normalize(self.ledger)['events'] if e['id']=='export-check']))

    def test_conflicting_source_id_fails_closed(self):
        d=single([event('same','commit'),event('same','code_complete')])
        with self.assertRaisesRegex(ValueError,'冲突'):normalize(d)

    def test_missing_source_revision_scope_and_timezone_are_rejected(self):
        for field in ('source','revision','scope','occurredAt'):
            e=event('test','validation_passed',scope='feature')
            if field=='occurredAt': e[field]='2026-02-01T10:00:00'
            else:del e[field]
            with self.subTest(field),self.assertRaises((ValueError,KeyError)):normalize(single([e]))

    def test_ci_and_preview_never_become_feature_validation_or_production(self):
        r=analyze(single([event('code','code_complete'),event('ci','validation_passed',scope='ci'),event('preview','release_succeeded',environment='preview')]),'2026-02-01','2026-02-01')
        self.assertEqual({'code':1,'validation':0,'release':0},r['newMilestones'])
        self.assertEqual('unknown',r['items'][0]['current']['validation'])
        self.assertEqual('unknown',r['items'][0]['current']['release'])

    def test_revision_mismatch_cannot_certify_current_code(self):
        r=analyze(single([event('code','code_complete','v2'),event('test','validation_passed','v1',scope='feature'),event('release','release_succeeded','v1',environment='production')]),'2026-02-01','2026-02-01')
        self.assertEqual('unknown',r['items'][0]['current']['validation'])
        self.assertEqual('unknown',r['items'][0]['current']['release'])
        self.assertEqual('v1',r['items'][0]['current']['releasedRevision'])

    def test_failed_test_and_failed_release_are_visible(self):
        r=analyze(single([event('code','code_complete'),event('test','validation_failed',scope='feature'),event('release','release_failed',environment='production')]),'2026-02-01','2026-02-01')
        self.assertEqual('failed',r['items'][0]['current']['validation'])
        self.assertEqual('failed',r['items'][0]['current']['release'])
        self.assertIn('验证失败',render_markdown(r))

    def test_zero_commit_day_retains_external_blocker(self):
        r=analyze(self.ledger,'2026-02-20','2026-02-20','daily')
        row=next(i for i in r['items'] if i['workItemId']=='external')
        self.assertTrue(row['current']['blocked'])
        self.assertEqual('延续（本期无新证据）',row['movement'])
        self.assertEqual([],row['periodEvidence'])
        self.assertIn('供应商',render_markdown(r))

    def test_unblock_does_not_claim_delivery(self):
        r=analyze(single([event('block','blocked',reason='待供应商'),event('unblock','unblocked',day='2026-02-02')]),'2026-02-02','2026-02-02')
        self.assertFalse(r['items'][0]['current']['blocked'])
        self.assertEqual('unknown',r['items'][0]['current']['code'])

    def test_timezone_cutoff_and_future_no_leak(self):
        e=event('boundary','code_complete');e['occurredAt']='2026-02-01T16:00:00Z'
        r=analyze(single([e]),'2026-02-01','2026-02-01')
        self.assertEqual([],r['items'])
        self.assertEqual(1,analyze(single([e]),'2026-02-02','2026-02-02')['newMilestones']['code'])

    def test_previous_month_completion_is_not_new_in_march(self):
        r=analyze(self.ledger,'2026-03-01','2026-03-31','monthly')
        self.assertEqual({'code':0,'validation':0,'release':1},r['newMilestones'])
        self.assertIn('不代填、不提交',render_markdown(r))
        self.assertNotIn('partners',r)

    def test_old_finished_work_is_not_repackaged(self):
        r=analyze(self.ledger,'2026-04-01','2026-04-30','monthly')
        self.assertNotIn('cross-month',[i['workItemId'] for i in r['items']])

    def test_measurements_missing_stay_unavailable(self):
        r=analyze(self.ledger,'2026-02-01','2026-02-28','monthly')
        self.assertTrue(all(not x['available'] for x in r['metrics'].values()))
        self.assertEqual(['unassigned'],r['unassignedEvidence'])

    def test_metrics_compare_only_equal_method_unit_population_and_window(self):
        d=single([event('code','code_complete')])
        d['measurements']=[{'metric':'hours','start':a,'end':b,'value':v,'unit':'小时','method':'本人登记','population':'同一团队','sources':[{'uri':'fixture://time/'+a,'excerpt':str(v)}]} for a,b,v in [('2026-01-31','2026-01-31',8),('2026-02-01','2026-02-01',6)]]
        r=analyze(d,'2026-02-01','2026-02-01')
        self.assertEqual(-2,r['metrics']['hours']['comparison']['delta'])
        d['measurements'][0]['population']='别的团队'
        self.assertIsNone(analyze(d,'2026-02-01','2026-02-01')['metrics']['hours']['comparison'])

    def test_output_escapes_untrusted_sources(self):
        d=single([event('code','code_complete')]);d['workItems'][0]['title']='<script>oops</script>'
        d['events'][0]['source']['uri']='https://example.test/path?a=1&b=2'
        h=render_html(analyze(d,'2026-02-01','2026-02-01'))
        self.assertNotIn('<script>',h)
        self.assertIn('&lt;script&gt;',h)
        self.assertIn('href="https://example.test/path?a=1&amp;b=2"',h)
        self.assertIn('name="viewport"',h)

    def test_positive_claims_reference_existing_evidence(self):
        r=analyze(self.ledger,'2026-02-01','2026-02-28')
        for c in r['claims']:
            for eid in c['sources']+c['basis']:self.assertIn(eid,r['evidence'])
            if c['value'] not in ('unknown',False):self.assertTrue(c['sources'])

    def test_frozen_before_after_keeps_failure_examples(self):
        r=evaluate(FIX)
        self.assertTrue(r['totals']['before']['wrongConclusions']>0)
        self.assertTrue(r['cases'][0]['before']['failures']['wrongConclusions'])
        self.assertTrue(all(v==0 for v in r['totals']['after'].values()))

    def test_week_context_consumes_same_ledger_and_marks_missing(self):
        p=ROOT/'.claude/skills/weekly-update-summary/scripts/collect_week_context.py'
        spec=importlib.util.spec_from_file_location('week_context_evidence',p)
        m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        adapter=m._delivery_module()
        collected=adapter.context_ledger({'acceptance':{'available':False,'reason':'source offline'}},self.ledger)
        self.assertTrue(any('source offline' in reason for reason in collected['limitations']))
        combined=adapter.engine()['merge_ledgers']([self.ledger,collected])
        report=adapter.engine()['analyze'](combined,'2026-02-01','2026-02-28')
        self.assertIsNone(report['newMilestones']['code'])
        self.assertEqual(2,report['observedMilestones']['code'])
        self.assertEqual(normalize(self.ledger)['events'],combined['events'])

    def test_cli_renders_three_reviewable_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            out=Path(directory)/'weekly'
            subprocess.run([sys.executable,str(ROOT/'scripts/reporting/evidence.py'),'render','--ledger',str(FIX/'cases.json'),'--start','2026-02-01','--end','2026-02-28','--cadence','weekly','--out',str(out)],check=True)
            report=json.loads(out.with_suffix('.json').read_text())
            self.assertEqual(2,report['newMilestones']['code'])
            self.assertIn('本台账有证据的首次里程碑',out.with_suffix('.html').read_text())
            self.assertIn('供应商',out.with_suffix('.md').read_text())

    def test_completion_source_survives_same_revision_merge(self):
        d=single([event('a-code','code_complete'),event('b-merge','merged')])
        r=analyze(d,'2026-02-01','2026-02-01')
        self.assertEqual(['a-code'],next(c for c in r['claims'] if c['field']=='code')['sources'])

    def test_validation_without_commit_is_independent_evidence(self):
        d=single([event('test','validation_passed',scope='feature')])
        r=analyze(d,'2026-02-01','2026-02-01')
        self.assertEqual('passed',r['items'][0]['current']['validation'])
        self.assertEqual('unknown',r['items'][0]['current']['code'])

    def test_late_archive_observation_is_not_new_completion(self):
        d=single([event('test','validation_passed',scope='feature',timeBasis='observed')])
        r=analyze(d,'2026-02-01','2026-02-01')
        self.assertEqual('passed',r['items'][0]['current']['validation'])
        self.assertEqual(0,r['newMilestones']['validation'])
        self.assertIn('不计本期首次完成',render_markdown(r))

    def test_real_history_does_not_extend_old_branch_acceptance_to_new_mainline(self):
        d=json.loads((FIX/'historical.json').read_text())
        r=analyze(d,'2026-09-28','2026-10-04')
        rows={i['workItemId']:i for i in r['items']}
        self.assertEqual('延续（本期无新证据）',rows['kb-sync']['movement'])
        self.assertEqual('stale',rows['kb-sync']['current']['validation'])
        self.assertEqual('passed',rows['kb-sync']['current']['lastValidation']['status'])
        self.assertNotEqual(rows['kb-sync']['current']['revision'],rows['kb-sync']['current']['lastValidation']['revision'])
        self.assertEqual('failed',rows['core-smoke']['current']['lastValidation']['status'])
        self.assertTrue(all(i['current']['release']=='unknown' for i in rows.values()))
        self.assertEqual({'code':None,'validation':None,'release':None},r['newMilestones'])

    def test_incomplete_history_cannot_be_counted_as_new_delivery(self):
        d=single([event('done','code_complete')]);d.pop('historyComplete')
        r=analyze(d,'2026-02-01','2026-02-01')
        self.assertEqual({'code':None,'validation':None,'release':None},r['newMilestones'])
        self.assertEqual(1,r['observedMilestones']['code'])
        self.assertIn('历史覆盖不完整',render_markdown(r))

    def test_git_merge_expansion_and_explicit_cross_pr_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            def git(*args):
                return subprocess.run(['git','-C',directory,*args],check=True,text=True,capture_output=True).stdout.strip()
            git('init','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture')
            git('remote','add','origin','https://github.com/example/report-fixture.git')
            git('commit','--allow-empty','-m','base');base=git('rev-parse','HEAD')
            git('switch','-c','feature');git('commit','--allow-empty','-m','feat: 一个功能');git('commit','--allow-empty','-m','fix: 同功能返修')
            git('switch','main');git('merge','--no-ff','feature','-m','Merge pull request #10 from feature')
            head=git('rev-parse','HEAD');git('update-ref','refs/remotes/origin/main',head)
            d=single([]);d['evidenceBindings']={'pr:10':'one'}
            data=collect_git(directory,base,head,d)
            self.assertEqual(3,len(data['events']))
            self.assertTrue(all(x['workItemId']=='one' for x in data['events']))
            when=data['events'][-1]['occurredAt'][:10]
            r=analyze(data,when,when,timezone='UTC')
            self.assertEqual(head,r['items'][0]['current']['revision'])
            self.assertEqual({'code':0,'validation':0,'release':0},r['newMilestones'])
            self.assertEqual(data['events'],collect_git(directory,base,head,data)['events'])
            unassigned=collect_git(directory,base,head,single([]))
            self.assertTrue(all(e['workItemId'] is None for e in unassigned['events']))
            unassigned['evidenceBindings']={'pr:10':'one'}
            rebound=collect_git(directory,head,head,unassigned)
            self.assertTrue(all(e['workItemId']=='one' for e in rebound['events']))
            git('switch','-c','unmerged');git('commit','--allow-empty','-m','feat: 尚未合并')
            self.assertEqual(3,len(collect_git(directory,base,'main',d)['events']))
            with self.assertRaises(subprocess.CalledProcessError):collect_git(directory,base,'unmerged',d)


if __name__=='__main__':
    unittest.main()
