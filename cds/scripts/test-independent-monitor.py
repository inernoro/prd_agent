import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
s=importlib.util.spec_from_file_location('monitor', Path(__file__).with_name('independent-monitor.py'))
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)

class IndependentMonitorTest(unittest.TestCase):
    def test_one_incident_during_outage_and_stable_recovery(self):
        state={}; bad={'reason':'collection','reachable':True,'dataOk':False}
        self.assertIsNone(m.advance(state,bad,1000));self.assertIsNone(m.advance(state,bad,1060))
        self.assertEqual(m.advance(state,bad,1120),'down'); first=state['incident']['id']
        for now in range(1180,1720,60): self.assertIsNone(m.advance(state,bad,now))
        self.assertEqual(state['incident']['id'],first)
        self.assertEqual(m.advance(state,{**bad,'reason':'unreachable','reachable':False},1720),'escalated')
        good={'reason':None,'reachable':True,'dataOk':True}
        for now in range(1780,2380,60): self.assertIsNone(m.advance(state,good,now))
        self.assertEqual(m.advance(state,good,2380),'recovered')
        self.assertEqual(state['history'][0]['id'],first)
    def test_monitor_downtime_does_not_count_as_recovery(self):
        state={'incident':{'id':'a','reason':'collection'},'checkedAt':1000,'healthySince':1000}
        self.assertIsNone(m.advance(state,{'reason':None},2000));self.assertIsNotNone(state['incident'])
    def test_reachable_again_keeps_incident_but_updates_reason_without_repeated_escalation(self):
        state={'incident':{'id':'a','reason':'collection'},'checkedAt':1000}
        self.assertEqual(m.advance(state,{'reason':'unreachable'},1060),'escalated')
        self.assertIsNone(m.advance(state,{'reason':'collection'},1120))
        self.assertEqual(state['incident']['reason'],'collection')
        self.assertIsNone(m.advance(state,{'reason':'unreachable'},1180))
    def test_no_recovery_notification_without_accepted_fault(self):
        state={'history':[{'id':'a'}]}
        with patch.object(m.urllib.request,'urlopen') as request:
            self.assertTrue(m.notify({'bark':{'key':'private'}},state,'recovered',1000))
            request.assert_not_called()
    def test_public_snapshot_excludes_credentials_and_raw_errors(self):
        config={'cdsBase':'https://example.com','headers':{'key':'secret'},'bark':{'key':'secret'}}
        state={'headers':config['headers'],'deliveries':[{'private':'secret'}],'observation':{'rawError':'secret'}}
        self.assertNotIn('secret',str(m.public_snapshot(state,config,2000)))
    def test_outage_preserves_last_known_unresolved_target(self):
        state={'observation':{'metrics':[{'id':'m1','name':'Webhook','state':'down','lastKnownState':'down'}]}}
        m.advance(state,{'reason':'unreachable','metrics':[]},1000)
        self.assertEqual(state['observation']['metrics'][0]['state'],'unknown')
        self.assertEqual(state['observation']['metrics'][0]['lastKnownState'],'down')
    def test_snapshot_failure_keeps_notification_pending(self):
        state={'failures':2,'checkedAt':1000}
        with patch.object(m,'inspect',return_value={'reason':'unreachable'}),patch.object(m,'publish',side_effect=RuntimeError()):
            with self.assertRaises(RuntimeError):m.tick({'cdsBase':'https://example.com'},state,1060)
        self.assertEqual(state['pending']['transition'],'down')
    def test_fresh_cds_report_does_not_duplicate_internal_notification(self):
        state={'failures':2,'checkedAt':1000}
        with patch.object(m,'inspect',return_value={'reason':'collection','notifyEligible':False}),patch.object(m,'publish'):
            m.tick({'cdsBase':'https://example.com'},state,1060)
        self.assertIsNotNone(state['incident']);self.assertNotIn('pending',state)
        with patch.object(m,'inspect',return_value={'reason':'collection','notifyEligible':True}),patch.object(m,'publish'):
            m.tick({'cdsBase':'https://example.com'},state,1120)
        self.assertEqual(state['pending']['transition'],'down')

    def test_public_projection_never_exports_private_identity_or_metrics(self):
        state={'observation':{'metrics':[{'name':'private-metric'}]},'incident':{'id':'example','reason':'collection','secret':'private-event'}}
        config={'identity':{'observer':{'name':'private-host','location':'private-address'}},'cdsBase':'https://private.invalid',
                'publicIdentity':{'observer':{'name':'示例 B','environment':'测试','location':'private-location','key':'private-key'}}}
        snapshot=m.public_snapshot(state,config,1000)
        self.assertNotIn('private',str(snapshot))
        self.assertEqual(snapshot['identity']['observer']['name'],'示例 B')
    def test_notification_link_keeps_runtime_feed_out_of_repository(self):
        url=m.incident_url({'publicUrl':'https://example.com/#feed=https%3A%2F%2Fstorage.example%2Fstatus.json'},'sample')
        self.assertIn('incident=sample',url);self.assertIn('#feed=',url)

if __name__=='__main__':unittest.main()
