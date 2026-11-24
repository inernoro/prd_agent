"""Disk inspection must stay read-only and must not turn failed queries into zero usage."""
import json
import pytest
from test_cdscli_instances import cli, workspace, run  # noqa: F401

@pytest.mark.parametrize('args,path', [
    (('disk','state'), '/api/janitor/state'),
    (('disk','sources'), '/api/janitor/deployment-sources'),
    (('disk','target','target/owned'), '/api/releases/targets/target%2Fowned/disk-diagnosis'),
])
def test_disk_only_reads_existing_instance(workspace, monkeypatch, args, path):
    calls=[]
    monkeypatch.setattr(cli,'_request',lambda method,p,**kw:(calls.append((method,p)) or (200,{'scanned':1,'scanStatus':'complete'},{})))
    code,out=run(*args)
    assert code == 0 and json.loads(out)['data']['scanned'] == 1
    assert calls == [('GET',path)]

@pytest.mark.parametrize('status,body',[(503,{'error':'unavailable'}),(200,'not JSON')])
def test_disk_query_failure_is_not_zero_usage(workspace,monkeypatch,status,body):
    monkeypatch.setattr(cli,'_request',lambda *a,**kw:(status,body,{}))
    code,out=run('disk','sources')
    assert code != 0 and json.loads(out)['ok'] is False
    assert 'scanned' not in json.loads(out)

@pytest.mark.parametrize('body',[{'scanStatus':'partial','scanned':2,'held':[{'reason':'git-query-failed'}]}, {'scanned':0}])
def test_partial_or_unconfirmed_inventory_returns_nonzero_with_evidence(workspace,monkeypatch,body):
    monkeypatch.setattr(cli,'_request',lambda *a,**kw:(200,body,{}))
    code,out=run('disk','sources')
    result=json.loads(out)
    assert code==3 and result['ok'] is False and result['data']==body
