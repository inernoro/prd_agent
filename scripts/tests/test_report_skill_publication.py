import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'scripts/reporting'))
import edition

def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.out=Path(self.tmp.name)
        self.ledger={'schemaVersion':1,'historyComplete':False,'workItems':[{'id':'export','title':'批量导出'}],
            'events':[{'id':'complete','kind':'code_complete','workItemId':'export','occurredAt':'2026-10-02T10:00:00+08:00','revision':'v1','source':{'uri':'https://example.test/complete','excerpt':'编码完成，待验收'}}]}
        self.bundle=edition.build_bundle(self.ledger,{},'2026-09-28','2026-10-04','weekly',self.out,baseline_sha='a'*40)
        self.pub=edition.publisher();self.state={'body':'OLD REPORT','metadata':{'kind':'weekly-report','dailyDate':'2026-10-04','lastCommit':'0'*40}}
        self.calls=[];self.persist_body=True;self.read_content=True;self.drop_ledger=False
    def transport(self,args,retries=5):
        method=args[args.index('-X')+1] if '-X' in args else 'GET';url=args[-1];data=json.loads(args[args.index('-d')+1]) if '-d' in args else None
        self.calls.append((method,url,copy.deepcopy(data)))
        if url.endswith('/content'):
            if method=='PUT':
                if self.persist_body:self.state['body']=data['content']
                return {'success':True}
            if not self.read_content:return {'success':False}
            return {'success':True,'data':{'content':self.state['body'],'hasContent':True}}
        if url.endswith('/entries/existing'):
            if method=='PUT' and 'metadata' in data:
                self.state['metadata']=copy.deepcopy(data['metadata'])
                if self.drop_ledger:self.state['metadata'].pop('deliveryEvidenceLedger',None)
            return {'success':True,'data':{'metadata':copy.deepcopy(self.state['metadata'])}}
        if url.endswith('/share-links'):return {'success':True,'data':{'token':'fixture-share'}}
        return {'success':True,'data':{}}
    def publish(self,include_bundle=True):
        argv=['publish.py','--base','https://example.test','--title',self.bundle['title'],'--kind','weekly-report','--daily-date','2026-10-04','--report-html',str(self.out/'report.html'),'--last-commit','a'*40,'--replace-same-date']
        if include_bundle:argv+=['--evidence-bundle',str(self.out/'bundle.json')]
        with patch.object(sys,'argv',argv),patch.object(self.pub,'headers',return_value=[]),patch.object(self.pub,'find_store',return_value={'id':'store','isPublic':False}),patch.object(self.pub,'list_entries_by_date',return_value=[('existing','2026-10-01')]),patch.object(self.pub,'shared_entry_ids',return_value=set()),patch.object(self.pub,'curl',side_effect=self.transport),contextlib.redirect_stdout(io.StringIO()):
            self.pub.main()
    def test_original_templates_build_and_verify_as_one_publication_bundle(self):
        m,ledger=edition.verify_bundle(self.out/'bundle.json');self.assertEqual(self.ledger,ledger);self.assertTrue(m['templateDigest']);self.assertIn('reference/report-template-html.html',m['templatePath'])
    def test_manual_html_change_is_rejected_even_when_file_hash_is_rewritten(self):
        p=self.out/'report.html';p.write_text(p.read_text().replace('批量导出','已上线并节省一百工时'))
        m=json.loads((self.out/'bundle.json').read_text());m['files']['report.html']=edition.digest(p.read_bytes());(self.out/'bundle.json').write_text(json.dumps(m))
        with self.assertRaisesRegex(ValueError,'正文与原模板和事实不一致'):edition.verify_bundle(self.out/'bundle.json')
    def test_ledger_tamper_without_regeneration_cannot_be_published(self):
        p=self.out/'ledger.json';d=json.loads(p.read_text());d['events'][0]['revision']='v2';p.write_text(json.dumps(d))
        with self.assertRaisesRegex(ValueError,'文件已改动'):self.publish()
        self.assertEqual([],self.calls)
    def test_missing_bundle_is_rejected_before_network(self):
        with self.assertRaisesRegex(RuntimeError,'缺少--evidence-bundle'):self.publish(False)
        self.assertEqual([],self.calls)
    def test_body_then_ledger_checkpoint_roundtrip_preserves_stable_entry(self):
        self.publish();m=self.state['metadata'];self.assertEqual('a'*40,m['lastCommit']);self.assertEqual('verified',m['deliveryEvidenceStatus']);self.assertEqual(self.ledger,json.loads(m['deliveryEvidenceLedger']))
        put_meta=next(i for i,c in enumerate(self.calls) if c[0]=='PUT' and c[2] and 'metadata' in c[2]);self.assertTrue(any(c[0]=='GET' and c[1].endswith('/content') for c in self.calls[:put_meta]))
        self.assertFalse(any(c[0]=='POST' and c[1].endswith('/entries') for c in self.calls))
    def test_body_write_not_persisted_does_not_advance_checkpoint(self):
        self.persist_body=False
        with self.assertRaisesRegex(RuntimeError,'正文写入未确认'):self.publish()
        self.assertEqual('0'*40,self.state['metadata']['lastCommit']);self.assertNotIn('deliveryEvidenceLedger',self.state['metadata'])
    def test_unavailable_content_verification_does_not_advance_checkpoint(self):
        self.read_content=False
        with self.assertRaisesRegex(RuntimeError,'未推进水位线'):self.publish()
        self.assertEqual('0'*40,self.state['metadata']['lastCommit'])
    def test_backend_ignoring_ledger_cannot_advance_the_sha_alone(self):
        self.drop_ledger=True
        with self.assertRaisesRegex(RuntimeError,'证据台账未确认'):self.publish()
        self.assertEqual('0'*40,self.state['metadata']['lastCommit'])
    def test_pending_failed_entry_does_not_hide_last_valid_checkpoint(self):
        coverage=module('skill_coverage_test',ROOT/'.claude/skills/daily-report-summary/reference/coverage_window.py')
        entries=[{'id':'failed','metadata':{'kind':'daily-report','dailyDate':'2026-10-03','deliveryEvidenceStatus':'pending'}},{'id':'good','metadata':{'kind':'daily-report','dailyDate':'2026-10-02','lastCommit':'a'*40}}]
        with patch.object(coverage,'curl',return_value={'success':True,'data':{'items':entries,'hasNextPage':False}}):
            result=coverage.latest_daily_entry('https://example.test',[],'store','daily-report')
        self.assertEqual('good',result[2])

if __name__=='__main__':unittest.main()
