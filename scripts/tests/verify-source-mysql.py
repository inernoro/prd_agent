#!/usr/bin/env python3
"""Manual isolated MySQL/source retention experiment. Never targets production."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--execute', action='store_true')
    ap.add_argument('--node', default='node')
    ap.add_argument('--evidence', type=Path)
    ap.add_argument('--work-dir', type=Path)
    args = ap.parse_args()
    if not args.execute:
        print('Preview only: requires built CDS backend, local Docker and mysql:8.0; creates only synthetic data, no published ports, and removes its exact fixture containers/volumes.')
        return
    if not (ROOT / 'cds/dist/services/deployment-source-retention.js').is_file():
        raise SystemExit('Build the CDS backend before this manual experiment.')
    def run(cmd, **kwargs):
        return subprocess.check_output(cmd, stderr=subprocess.PIPE, timeout=120, **kwargs)
    run(['docker','image','inspect','mysql:8.0'])
    owned=[]
    passwords={}
    label=str(uuid.uuid4())
    def docker(*cmd, **kw): return run(['docker',*cmd],**kw)
    def sql(container, text):
        return docker('exec','-i','-e','MYSQL_PWD='+passwords[container],container,'mysql','-uroot','--batch','--skip-column-names',input=text.encode()).decode().strip()
    def start(role):
        # Fixture credentials have no external authority; no port is published.
        password='owned-'+role+'-'+label
        container=docker('run','-d','--network','none','--memory','768m','--cpus','1','--label','codex.disk-mysql='+label,
                         '-e','MYSQL_ROOT_PASSWORD='+password,'mysql:8.0').decode().strip()
        owned.append(container);passwords[container]=password
        deadline=time.monotonic()+90
        while time.monotonic()<deadline:
            try:
                if sql(container,'SELECT @@skip_networking;')=='0':
                    print(json.dumps({'stage':role+'-ready'}),flush=True)
                    return container
            except subprocess.CalledProcessError:
                pass
            time.sleep(1)
        raise RuntimeError(role+' initialization did not finish')
    try:
        with tempfile.TemporaryDirectory(prefix='owned-mysql-disk-',dir=args.work_dir) as scratch:
            root=Path(scratch);repo=root/'repo';repo.mkdir()
            def git(*cmd): return run(['git','-C',str(repo),*cmd]).decode().strip()
            git('init');git('config','user.name','Owned database fixture');git('config','user.email','owned@invalid')
            (repo/'application.txt').write_text('private synthetic test only');git('add','.');git('commit','-m','fixture')
            sha=git('rev-parse','HEAD');base=root/'worktrees';source=base/'mysql-proof/.deployment-sources/branch'/str(uuid.uuid4())
            source.parent.mkdir(parents=True);git('worktree','add','--detach',str(source),sha)
            original=start('source')
            values=','.join('(%d,REPEAT("owned-synthetic-%d",64))'%(n,n) for n in range(1,65))
            sql(original,'CREATE DATABASE governance; CREATE TABLE governance.fixture(id INT PRIMARY KEY,payload TEXT) ENGINE=InnoDB; INSERT INTO governance.fixture VALUES '+values+';')
            query='SET SESSION group_concat_max_len=1048576; SELECT COUNT(*),SUM(id),SHA2(GROUP_CONCAT(CONCAT(id,":",SHA2(payload,256)) ORDER BY id SEPARATOR "|"),256) FROM governance.fixture;'
            expected=sql(original,query)
            dump=docker('exec','-e','MYSQL_PWD='+passwords[original],original,'mysqldump','-uroot','--single-transaction','--set-gtid-purged=OFF','--routines','--events','--triggers','--databases','governance')
            archive=gzip.compress(dump);archive_sha=hashlib.sha256(archive).hexdigest()
            assert gzip.decompress(archive)==dump
            restored=start('restored')
            docker('exec','-i','-e','MYSQL_PWD='+passwords[restored],restored,'mysql','-uroot',input=gzip.decompress(archive))
            assert sql(restored,query)==expected
            print(json.dumps({'stage':'backup-restored-verified','rows':64}),flush=True)
            docker('stop','--time','30',original)
            physical=source/'.cds-data/mysql';physical.mkdir(parents=True)
            docker('cp',original+':/var/lib/mysql/.',str(physical))
            assert (physical/'governance/fixture.ibd').is_file()
            env={k:v for k,v in os.environ.items() if not k.startswith(('CDS_','MAP_')) and k!='AI_ACCESS_KEY'}
            retained=json.loads(run([args.node,str(ROOT/'cds/scripts/verify-source-mysql.mjs'),str(base),str(source)],env=env))
            # Consumer switches to the restored database; recovery returns to
            # the original stable volume after an orderly server restart.
            assert sql(restored,query)==expected
            docker('start',original)
            deadline=time.monotonic()+60
            while True:
                try:
                    assert sql(original,query)==expected
                    break
                except subprocess.CalledProcessError:
                    if time.monotonic()>deadline:raise
                    time.sleep(1)
            result={'scope':'isolated MySQL 8.0 synthetic data; not a production migration or production backup proof',
                    'backupArchiveBytes':len(archive),'archiveSha256':archive_sha,'backupRestoredVerified':True,
                    'logicalDataDigest':expected,'switchToRestoredVerified':True,'returnToOriginalAfterRestartVerified':True,
                    'sourceSnapshot':retained,'cleanup':'only exact labelled fixture containers and their anonymous volumes; private generated directories'}
            if args.evidence:
                args.evidence.write_text(json.dumps(result,indent=2))
            print(json.dumps(result),flush=True)
    finally:
        for container in owned:
            observed=docker('inspect','--format','{{index .Config.Labels "codex.disk-mysql"}}',container).decode().strip()
            if observed!=label:raise RuntimeError('fixture ownership changed; preserving container')
            docker('rm','-f','-v',container)

if __name__=='__main__':
    main()
