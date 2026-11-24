import importlib.util
from pathlib import Path
import unittest
import json
s = importlib.util.spec_from_file_location('relay', Path(__file__).with_name('independent-alarm-relay.py'))
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)

class RelayTests(unittest.TestCase):
    def item(self, identifier, target='one', key='shared', recovered=False, project='business'):
        return {'id':identifier,'channelId':'phone','receivedAt':0,'message':{'title':'业务检查','body':'测试'},
            'event':{'targetId':target,'correlationKey':key,'projectId':project,'assessment':'observation-unavailable',
                     'kind':'business-recovered' if recovered else 'business-down'}}
    def state(self, items):
        return {'channels':[{'id':'phone','enabled':True}], 'inbox':{i['id']:i for i in items}}
    def test_group_restart_independent_and_recovery(self):
        state=self.state([self.item('a'),self.item('b','two'),self.item('c','three','independent')]); calls=[]
        send=lambda c,msg: calls.append(msg) or True
        m.process(state,31,lambda:None,send); self.assertEqual(len(calls),2)
        state=json.loads(json.dumps(state))
        state['inbox']={'d':self.item('d','one')};m.process(state,60,lambda:None,send)
        self.assertEqual(len(calls),2)
        state['inbox']={'e':self.item('e','one',recovered=True)};m.process(state,90,lambda:None,send)
        self.assertEqual(len(calls),2)
        state['inbox']={'f':self.item('f','two',recovered=True)};m.process(state,120,lambda:None,send)
        self.assertEqual(len(calls),3)
    def test_uncertain_delivery_not_blindly_retried_and_does_not_send_recovery(self):
        state=self.state([self.item('a')]);calls=[]
        m.process(state,31,lambda:None,lambda c,msg:calls.append(msg) or False)
        state['inbox']={'b':self.item('b','two')};m.process(state,60,lambda:None,lambda c,msg:calls.append(msg) or True)
        self.assertEqual(len(calls),1);self.assertFalse(state['receipts']['a']['ok'])
    def test_platform_parent_does_not_swallow_independent_business_failure(self):
        state=self.state([self.item('a',project='cds-self-monitor'),self.item('b',key='business')]);calls=[]
        m.process(state,31,lambda:None,lambda c,msg:calls.append(msg) or True,platform_incident={'id':'parent'})
        self.assertEqual(len(calls),1)
        self.assertEqual(state['incidents']['phone/shared']['deliveries'][0]['state'],'merged')
    def test_restart_between_send_and_ack_does_not_send_again(self):
        state=self.state([self.item('a')]);snapshots=[]
        m.process(state,31,lambda:snapshots.append(json.loads(json.dumps(state))),lambda c,msg:True)
        state=snapshots[0]; calls=[]
        m.process(state,40,lambda:None,lambda c,msg:calls.append(msg) or True)
        self.assertEqual(calls,[]);self.assertFalse(state['receipts']['a']['ok'])

    def test_recovery_after_handover_uses_primary_accepted_receipt(self):
        item=self.item('migration',recovered=True);item['event']['recoveryConfirmed']=True
        state=self.state([item]);calls=[]
        m.process(state,31,lambda:None,lambda c,msg:calls.append(msg) or True)
        self.assertEqual(len(calls),1)
        state['inbox']={'migration':item};m.process(state,40,lambda:None,lambda c,msg:calls.append(msg) or True)
        self.assertEqual(len(calls),1)

if __name__=='__main__':unittest.main()
