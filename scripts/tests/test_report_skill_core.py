import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('report_evidence_core', ROOT/'scripts/reporting/evidence.py')
e = importlib.util.module_from_spec(spec);spec.loader.exec_module(e)

def event(id, kind, day='2026-10-02', **extra):
    return {'id':id,'kind':kind,'workItemId':'export','occurredAt':day+'T10:00:00+08:00','revision':'v1','source':{'uri':'fixture://report/'+id,'excerpt':kind},**extra}
def ledger(*events):
    return {'schemaVersion':1,'historyComplete':True,'workItems':[{'id':'export','title':'批量导出'}],'events':list(events)}

class SkillCoreTests(unittest.TestCase):
    def test_recollection_and_source_outage_retain_current_period_evidence(self):
        saved=ledger(event('code','code_complete'),event('verify','validation_passed',scope='feature'))
        outage={'schemaVersion':1,'historyComplete':False,'workItems':[],'events':[],'limitations':['本次采集失败']}
        merged=e.merge_ledgers([saved,saved,outage]);r=e.analyze(merged,'2026-10-01','2026-10-31')
        self.assertEqual(2,len(merged['events']));self.assertEqual('passed',r['items'][0]['current']['validation'])
        self.assertIn('本次采集失败',r['limitations']);self.assertIsNone(r['newMilestones']['code'])
    def test_observation_is_not_feature_completion_or_new_milestone(self):
        r=e.analyze(ledger(event('note','observation')),'2026-10-01','2026-10-31')
        self.assertEqual('unknown',r['items'][0]['current']['code']);self.assertEqual(0,r['newMilestones']['code'])
    def test_ci_failure_is_visible_without_claiming_feature_validation_failed(self):
        r=e.analyze(ledger(event('code','code_complete'),event('ci','validation_failed',scope='ci')),'2026-10-01','2026-10-31')
        self.assertTrue(r['items'][0]['current']['ciFailed']);self.assertEqual('unknown',r['items'][0]['current']['validation'])
        self.assertIn('CI 失败',e.render_markdown(r));self.assertIn('#e-ci',e.render_markdown(r))
    def test_later_revision_requires_new_ci_and_future_events_are_excluded(self):
        r=e.analyze(ledger(event('ci','validation_failed',scope='ci'),event('change','commit',revision='v2'),event('future','validation_passed',day='2026-11-01',revision='v2',scope='feature')),'2026-10-01','2026-10-31')
        self.assertFalse(r['items'][0]['current']['ciFailed']);self.assertEqual('unknown',r['items'][0]['current']['validation']);self.assertNotIn('future',r['evidence'])
    def test_unassigned_failure_is_visible_without_counting_an_outcome(self):
        d=ledger(event('orphan','validation_failed',scope='ci',workItemId=None))
        r=e.analyze(d,'2026-10-01','2026-10-31')
        self.assertEqual(1,len(r['unassignedRisks']));self.assertEqual([],r['items'])
        self.assertIn('闭环未核查',e.render_markdown(r));self.assertEqual(0,r['newMilestones']['code'])
    def test_explicit_artifact_bindings_survive_merge_and_conflicts_fail(self):
        d=ledger();d['artifactBindings']={'acceptance:one':{'workItemIds':['export'],'scope':'feature'}}
        self.assertEqual(d['artifactBindings'],e.merge_ledgers([d,ledger()])['artifactBindings'])
        conflicting=ledger();conflicting['artifactBindings']={'acceptance:one':{'workItemIds':['export'],'scope':'ci'}}
        with self.assertRaisesRegex(ValueError,'归属冲突'):e.merge_ledgers([d,conflicting])

    def test_same_id_conflicting_evidence_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'冲突'):e.merge_ledgers([ledger(event('a','commit')),ledger(event('a','code_complete'))])

if __name__=='__main__':unittest.main()
