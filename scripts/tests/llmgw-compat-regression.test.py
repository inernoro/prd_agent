#!/usr/bin/env python3
import copy
import importlib.util
import json
import io
from pathlib import Path
import tempfile
import re
import subprocess
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('compat', ROOT/'scripts/llmgw-compat-regression.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

CASE = {'protocol':'openai','kind':'tools','stream':True}
# External wire example, independent of the runner implementation.
FRAMES = [
 {'model':'fixed-model','choices':[{'index':0,'delta':{'role':'assistant'}}]},
 {'choices':[{'index':0,'delta':{'tool_calls':[{'index':0,'id':'call_unique','type':'function','function':{'name':'echo_city','arguments':'{"city":'}}]}}]},
 {'choices':[{'index':0,'delta':{'tool_calls':[{'index':0,'function':{'arguments':'"北京"}'}}]}}]},
 {'choices':[{'index':0,'delta':{},'finish_reason':'tool_calls'}],'usage':{'prompt_tokens':11,'completion_tokens':7}},
]

def wire(frames):
 return ''.join('data: '+json.dumps(f,ensure_ascii=False)+'\n\n' for f in frames)+'data: [DONE]\n\n'

class CompatibilityTests(unittest.TestCase):
 def test_error_reports_keep_structured_codes_without_error_bodies(self):
  self.assertEqual('PARAMETER_PROTOCOL_UNSUPPORTED',m.response_error_code('{"Success":false,"ErrorCode":"PARAMETER_PROTOCOL_UNSUPPORTED","Error":"private body"}','application/json'))
  self.assertEqual('invalid_request',m.response_error_code('data: {"error":{"code":"invalid_request","message":"private body"}}\n\n','text/event-stream'))
  self.assertIsNone(m.response_error_code('{"error":{"code":"private body containing credentials"}}','application/json'))
  self.assertIsNone(m.response_error_code('incomplete','application/json'))

 def test_reassembles_real_tool_json_fragments(self):
  result=m.normalize(CASE,200,'text/event-stream',wire(FRAMES))
  self.assertEqual([{'name':'echo_city','arguments':{'city':'北京'}}],result['tools'])

 def test_key_field_mutations_are_detected(self):
  for mutation in ['finish_reason','finish_enum','arguments','name','id','usage','terminator','error']:
   with self.subTest(mutation=mutation):
    frames=copy.deepcopy(FRAMES)
    raw=None
    if mutation=='finish_reason': del frames[-1]['choices'][0]['finish_reason']
    elif mutation=='finish_enum': frames[-1]['choices'][0]['finish_reason']='tool_use'
    elif mutation=='usage': del frames[-1]['usage']
    elif mutation=='terminator': raw=wire(frames).replace('data: [DONE]\n\n','')
    elif mutation=='error': frames.append({'error':{'message':'upstream failure'}})
    elif mutation=='arguments': frames[2]['choices'][0]['delta']['tool_calls'][0]['function']['arguments']='"上海"}'
    elif mutation=='name': frames[1]['choices'][0]['delta']['tool_calls'][0]['function']['name']='other_tool'
    elif mutation=='id': del frames[1]['choices'][0]['delta']['tool_calls'][0]['id']
    with self.assertRaises((AssertionError,ValueError)):
     m.normalize(CASE,200,'text/event-stream',raw or wire(frames))

 def test_semantic_comparison_ignores_generated_ids_and_token_counts(self):
  frames=copy.deepcopy(FRAMES)
  frames[1]['choices'][0]['delta']['tool_calls'][0]['id']='call_another'
  frames[-1]['usage']['completion_tokens']=12
  self.assertEqual(m.normalize(CASE,200,'text/event-stream',wire(FRAMES)),m.normalize(CASE,200,'text/event-stream',wire(frames)))

 def test_fixed_text_rejects_a_different_answer_and_preserves_meaning(self):
  case={'protocol':'openai','kind':'text','stream':False,'expectedText':'OK'}
  payload={'model':'fixed','choices':[{'message':{'content':'OK'},'finish_reason':'stop'}], 'usage':{'prompt_tokens':11,'completion_tokens':7}}
  self.assertEqual('OK',m.normalize(case,200,'application/json',json.dumps(payload))['text'])
  payload['choices'][0]['message']['content']='WRONG'
  with self.assertRaisesRegex(AssertionError,'fixed text meaning changed'):
   m.normalize(case,200,'application/json',json.dumps(payload))
  case['stream']=True
  good=[{'model':'fixed','choices':[{'delta':{'content':'O'}}]}, {'choices':[{'delta':{'content':'K'},'finish_reason':'stop'}],'usage':payload['usage']}]
  self.assertEqual('OK',m.normalize(case,200,'text/event-stream',wire(good))['text'])
  good[1]['choices'][0]['delta']['content']='X'
  with self.assertRaisesRegex(AssertionError,'fixed text meaning changed'):
   m.normalize(case,200,'text/event-stream',wire(good))

 def test_unsupported_parameters_require_a_structured_rejection(self):
  case={'protocol':'native','kind':'reasoning','stream':True}
  good='data: {"Type":5,"ErrorCode":"PARAMETER_PROTOCOL_UNSUPPORTED","Error":"unsupported"}\n\n'
  self.assertEqual({'rejected':'PARAMETER_PROTOCOL_UNSUPPORTED'},m.validate_rejection(case,200,'text/event-stream',good))
  bad='data: {"Type":1,"Content":"PARAMETER_PROTOCOL_UNSUPPORTED is answer text"}\n\n'
  for raw,status,media in [(bad,200,'text/event-stream'),(good+bad,200,'text/event-stream'),(good,503,'text/event-stream'),('{"Success":true,"ErrorCode":"PARAMETER_PROTOCOL_UNSUPPORTED"}',400,'application/json')]:
   with self.subTest(status=status,raw=raw),self.assertRaises(AssertionError):m.validate_rejection(case,status,media,raw)
  case['stream']=False
  self.assertEqual({'rejected':'PARAMETER_PROTOCOL_UNSUPPORTED'},m.validate_rejection(case,400,'application/json','{"Success":false,"ErrorCode":"PARAMETER_PROTOCOL_UNSUPPORTED"}'))

 def test_bad_evidence_fails_reports_then_parallel_recovery_is_isolated(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);caps=root/'captures';caps.mkdir();corpus=root/'requests.json'
   corpus.write_text(json.dumps({'cases':[{'id':'ack','protocol':'openai','kind':'text','stream':False,'expectedText':'OK'}]}))
   raw=json.dumps({'model':'fixed','choices':[{'message':{'content':'OK'},'finish_reason':'stop'}],'usage':{'prompt_tokens':11,'completion_tokens':7}})
   cap={'sourceCommit':'a'*40,'status':200,'contentType':'application/json','raw':raw}
   for upstream in ('openai','claude'):(caps/(upstream+'--ack.json')).write_text(json.dumps(cap))
   broken=copy.deepcopy(cap);broken['sourceCommit']=None;(caps/'openai--ack.json').write_text(json.dumps(broken))
   def run(name):return m.main(['--mode','simulation','--captures',str(caps),'--expected-commit','a'*40,'--output',str(root/(name+'.json'))])
   with patch.object(m,'CORPUS',corpus):
    self.assertEqual(1,run('failure'))
    self.assertEqual('missing capture assembly version',json.loads((root/'failure.json').read_text())['cases'][0]['failure'])
    (caps/'openai--ack.json').write_text(json.dumps(cap))
    with ThreadPoolExecutor(max_workers=2) as pool:self.assertEqual([0,0],list(pool.map(run,['recovered-a','recovered-b'])))
   self.assertEqual('fail',json.loads((root/'failure.json').read_text())['status'])
   m.compare(json.loads((root/'recovered-a.json').read_text()),json.loads((root/'recovered-b.json').read_text()))
   with self.assertRaisesRegex(AssertionError,'response event must be an object'):
    m.normalize({'protocol':'openai','kind':'text','stream':True,'expectedText':'OK'},200,'text/event-stream','data: []\n\ndata: [DONE]\n\n')

 def test_compare_never_mixes_real_and_simulated_or_missing_cases(self):
  a={'schema':1,'mode':'simulation','status':'pass','corpusSha256':'fixed','cases':[{'id':'a','semantic':{'finish':'stop'}}]}
  m.compare(a,copy.deepcopy(a))
  for field,value in [('mode','provider'),('corpusSha256','changed'),('cases',[]),('status','fail')]:
   b=copy.deepcopy(a);b[field]=value
   with self.subTest(field=field),self.assertRaises(AssertionError):m.compare(a,b)

 def test_ci_status_rejects_provider_failure_independently_of_simulation(self):
  workflow=(ROOT/'.github/workflows/ci.yml').read_text()
  aggregate=workflow[workflow.index('  ci-status:'):]
  self.assertIn('llmgw-provider',aggregate.split('if: always()')[0])
  provider=workflow[workflow.index('  llmgw-provider:'):workflow.index('  server-required:')]
  self.assertNotIn('continue-on-error',provider)
  self.assertNotIn('needs:',provider)
  gate=aggregate[aggregate.index('          if [['):aggregate.index('          # main push')]
  for requested,result,expected in [('true','failure',1),('true','cancelled',1),('true','skipped',1),('true','success',0),('false','skipped',0)]:
   script=re.sub(r"\$\{\{ github.event_name == 'workflow_dispatch' && inputs.llmgw_provider \}\}",requested,gate)
   script=script.replace('${{ needs.llmgw-provider.result }}',result)+'\nexit 0\n'
   with self.subTest(requested=requested,result=result):
    self.assertEqual(expected,subprocess.run(['bash','-c',script],capture_output=True).returncode)

 def test_provider_missing_config_is_failure_and_emits_separate_report(self):
  with tempfile.TemporaryDirectory() as d:
   output=Path(d)/'provider.json'
   rc=m.main(['--mode','provider','--expected-commit','a'*40,'--output',str(output)])
   report=json.loads(output.read_text())
   self.assertEqual(1,rc);self.assertEqual('provider',report['mode'])
   self.assertEqual('fail',report['status']);self.assertEqual([],report['cases'])

 def test_provider_transport_failure_does_not_fall_back_to_captures(self):
  with tempfile.TemporaryDirectory() as d,patch.dict('os.environ',{'COMPAT_TEST_KEY':'synthetic'}):
   target=Path(d)/'target.json';output=Path(d)/'provider.json'
   target.write_text(json.dumps({'base':'https://gateway.invalid','model':'fixed','upstream':'openai','keyEnv':'COMPAT_TEST_KEY','caseIds':['openai-text-json']}))
   with patch.object(m.CANARY,'_health_check',return_value=({'ok':True,'commit':'a'*40},[])),patch.object(m.urllib.request.OpenerDirector,'open',side_effect=OSError('secret upstream detail')):
    rc=m.main(['--mode','provider','--target',str(target),'--expected-commit','a'*40,'--output',str(output),'--captures',d])
   report=json.loads(output.read_text())
   self.assertEqual(1,rc);self.assertEqual('fail',report['cases'][0]['status'])
   self.assertNotIn('secret upstream detail',output.read_text())

 def test_provider_uses_one_configured_caller_in_native_body_headers_and_report(self):
  caller='llmgw.compat-regression::chat'
  native={'Success':True,'Content':'OK','Resolution':{'ActualModel':'fixed'},'TokenUsage':{'InputTokens':11,'OutputTokens':7}}
  openai={'model':'fixed','choices':[{'message':{'content':'OK'},'finish_reason':'stop'}],'usage':{'prompt_tokens':11,'completion_tokens':7}}
  sent=[]
  def respond(opener,request,**kwargs):
   sent.append(request)
   response=io.BytesIO(json.dumps(native if request.full_url.endswith('/invoke') else openai).encode())
   response.code=200;response.headers={'Content-Type':'application/json'}
   return response
  with tempfile.TemporaryDirectory() as d,patch.dict('os.environ',{'COMPAT_TEST_KEY':'synthetic'}):
   target=Path(d)/'target.json';output=Path(d)/'provider.json'
   target.write_text(json.dumps({'base':'https://gateway.invalid','model':'fixed','upstream':'openai','keyEnv':'COMPAT_TEST_KEY','appCallerCode':caller,'caseIds':['native-text-json','openai-text-json']}))
   with patch.object(m.CANARY,'_health_check',return_value=({'ok':True,'commit':'a'*40},[])),patch.object(m.urllib.request.OpenerDirector,'open',respond):
    self.assertEqual(0,m.main(['--mode','provider','--target',str(target),'--expected-commit','a'*40,'--output',str(output)]))
   self.assertEqual(2,len(sent))
   for request in sent:
    self.assertEqual(caller,{k.lower():v for k,v in request.header_items()}['x-gateway-app-caller'])
   self.assertEqual(caller,json.loads(sent[0].data)['AppCallerCode'])
   self.assertEqual(caller,json.loads(output.read_text())['targetContract']['appCallerCode'])
   config=json.loads(target.read_text());config['headersEnv']='COMPAT_TEST_HEADERS';target.write_text(json.dumps(config))
   with patch.dict('os.environ',{'COMPAT_TEST_HEADERS':json.dumps({'X-Gateway-App-Caller':'other.identity::chat'})}),patch.object(m.CANARY,'_health_check',return_value=({'ok':True,'commit':'a'*40},[])),patch.object(m.urllib.request.OpenerDirector,'open',respond):
    self.assertEqual(1,m.main(['--mode','provider','--target',str(target),'--expected-commit','a'*40,'--output',str(output)]))
   self.assertEqual(2,len(sent),'identity mismatch must be rejected before transport')

if __name__=='__main__':unittest.main()
