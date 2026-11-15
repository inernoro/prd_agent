#!/usr/bin/env python3
"""Prove fixed production behavior against an old Git revision in an isolated worktree.
Only deterministic provider HTTP fixtures run. No deployed service is modified.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
FILES = ['scripts/llmgw-compat-regression.py', 'scripts/llmgw-protocol-canary.py',
         'scripts/fixtures/llmgw-compat/requests.json',
         'prd-api/tests/PrdAgent.Api.Tests/Gateway/ProtocolCompatibilityReplayTests.cs']
REQUIRED_RED = ['openai--gemini-tools-stream', 'claude--openai-text-stream', 'claude--native-text-stream']
PROJECT = 'prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj'


def revision(ref):
    return subprocess.check_output(['git','rev-parse','--verify',ref+'^{commit}'],cwd=ROOT,text=True).strip()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--old-ref',required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--dotnet',default='dotnet')
    args=parser.parse_args()
    output=args.output.resolve()
    if output.exists() and any(output.iterdir()):
        parser.error('use a new empty evidence directory')
    output.mkdir(parents=True,exist_ok=True)
    tree=output/'old-source'
    report={'provenance':'deterministic-fixture','status':'fail','phases':{}}
    def run(command,cwd,log,env=None):
        with (output/log).open('w') as stream:
            return subprocess.run(command,cwd=cwd,env=env,stdout=stream,stderr=subprocess.STDOUT).returncode
    try:
        old,new=revision(args.old_ref),revision('HEAD')
        assert old != new,'old and fixed revisions must differ'
        report.update(oldVersion=old,fixedVersion=new)
        hashes={f:hashlib.sha256((ROOT/f).read_bytes()).hexdigest() for f in FILES}
        report['suiteSha256']=hashes
        suite=output/'frozen-suite'
        for f in FILES:
            path=suite/f;path.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/f,path)
        subprocess.run(['git','worktree','add','--detach',str(tree),old],cwd=ROOT,check=True,stdout=subprocess.DEVNULL)
        # Inject the same client requests and test driver, never a production source file.
        for f in (FILES[2],FILES[3]):
            path=tree/f;path.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(suite/f,path)
        expected=len(json.loads((suite/FILES[2]).read_text())['cases'])*2
        for label,source,sha in [('old',tree,old),('fixed',ROOT,new)]:
            phase=output/label;phase.mkdir()
            assert run([args.dotnet,'restore',PROJECT],source,label+'-restore.log')==0,label+' restore failed (not a red test)'
            assert run([args.dotnet,'build',PROJECT,'--no-restore'],source,label+'-build.log')==0,label+' build failed (not a red test)'
            env=dict(os.environ,LLMGW_COMPAT_CAPTURE_DIR=str(phase/'captures'))
            code=run([args.dotnet,'test',PROJECT,'--no-build','--filter','FullyQualifiedName~ProtocolCompatibilityReplayTests',
                      '--logger','trx;LogFileName=replay.trx','--results-directory',str(phase)],source,label+'-tests.log',env)
            assert code==0,label+' transport/test execution failed (not an accepted red proof)'
            assert len(list((phase/'captures').glob('*.json')))==expected,label+' incomplete captures'
            status=run([sys.executable,str(suite/FILES[0]),'--mode','simulation','--captures',str(phase/'captures'),
                        '--expected-commit',sha,'--output',str(phase/'simulation.json')],ROOT,label+'-semantic.log')
            result=json.loads((phase/'simulation.json').read_text())
            failed={c['id']:c.get('failure') for c in result['cases'] if c['status']=='fail'}
            report['phases'][label]={'sourceVersion':sha,'exitCode':status,'status':result['status'],
                                     'cases':len(result['cases']),'failed':failed}
            if label=='old':
                assert status!=0 and all(x in failed for x in REQUIRED_RED),'old production behavior was not discriminated'
                assert all(c.get('sourceCommit')==sha for c in (json.loads(p.read_text()) for p in (phase/'captures').glob('*.json'))),'old assembly mismatch'
            else:assert status==0 and not failed,'fixed production behavior failed'
        assert hashes=={f:hashlib.sha256((ROOT/f).read_bytes()).hexdigest() for f in FILES},'suite changed during proof'
        report['status']='pass'
    except (AssertionError,OSError,ValueError,subprocess.SubprocessError) as exc:
        report['failure']=str(exc)
    finally:
        if tree.exists():
            cleanup=subprocess.run(['git','worktree','remove','--force',str(tree)],cwd=ROOT,capture_output=True)
            report['isolatedWorktreeRemoved']=cleanup.returncode==0
        (output/'proof.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'status':report['status'],'oldVersion':report.get('oldVersion'),'fixedVersion':report.get('fixedVersion'),'evidence':str(output/'proof.json')},ensure_ascii=False))
    return 0 if report['status']=='pass' else 1

if __name__=='__main__':sys.exit(main())
