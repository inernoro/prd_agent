#!/usr/bin/env python3
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import re
import subprocess
import unittest
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
 def test_reassembles_real_tool_json_fragments(self):
  result=m.normalize(CASE,200,'text/event-stream',wire(FRAMES))
  self.assertEqual([{'name':'echo_city','arguments':{'city':'北京'}}],result['tools'])

 def test_key_field_mutations_are_detected(self):
  for mutation in ['finish_reason','arguments','name','id','usage','terminator','error']:
   with self.subTest(mutation=mutation):
    frames=copy.deepcopy(FRAMES)
    raw=None
    if mutation=='finish_reason': del frames[-1]['choices'][0]['finish_reason']
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

if __name__=='__main__':unittest.main()
