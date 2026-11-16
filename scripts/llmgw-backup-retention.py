#!/usr/bin/env python3
"""LLMGW adapter for the same identity/lease/15-day policy used by CDS.

Dry-run is the default. Unknown files and unique business recovery points stay
protected. Explicit ownership and non-business attestations are never inferred
from names, age, absence from a ledger, or lack of a container mount.
"""
from __future__ import annotations
import argparse, datetime as dt, hashlib, json, os, pathlib, subprocess, sys, tempfile

CONFIRM_PHRASE='DELETE_REDUNDANT_FULL_BACKUPS'

def engine():
    roots=[pathlib.Path(__file__).resolve().parent.parent/'cds/src/services',pathlib.Path('/usr/local/lib/cds-disk-retention')]
    for root in roots:
        common=root/'disk-resource-native.py';policy=root/'backup-retention-native.py'
        if common.is_file() and policy.is_file() and not common.is_symlink() and not policy.is_symlink():
            return common.read_text()+'\n'+policy.read_text()
    raise RuntimeError('Shared versioned backup policy is missing; no fallback deletion is allowed')

def run(program,request):
    timeout=905 if request['action']=='register' else 305 if request['action']=='reconcile' else 30
    p=subprocess.run([sys.executable,'-c',program],input=json.dumps(request),text=True,capture_output=True,timeout=timeout)
    if p.returncode:raise RuntimeError('Native identity, source, lease or integrity query is unconfirmed; objects retained')
    return json.loads(p.stdout)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',default='/root/backups');parser.add_argument('--catalog');parser.add_argument('--instance-id',default='llmgw-host-backups')
    parser.add_argument('--project',default='llmgw-production');parser.add_argument('--service',default='production-data')
    parser.add_argument('--source-container');parser.add_argument('--register-export');parser.add_argument('--adopt-plan')
    parser.add_argument('--register-only',action='store_true')
    parser.add_argument('--max-removals',type=int,default=8);parser.add_argument('--json-out');parser.add_argument('--execute',action='store_true');parser.add_argument('--confirm',default='')
    # Old timer arguments remain accepted for a reviewable upgrade, but cannot override the hard limit.
    for option in ['keep-daily','keep-weekly','keep-monthly','minimum-full-mb','minimum-age-hours']:parser.add_argument('--'+option,type=float)
    parser.add_argument('--protect',action='append',default=[])
    args=parser.parse_args();program=engine()
    if args.source_container:
        print(json.dumps(run(program,{'action':'source','containerName':args.source_container,'projectId':args.project,'serviceId':args.service})));return 0
    root=pathlib.Path(args.root).absolute()
    if root.resolve()!=root or not root.is_dir():raise RuntimeError('Backup root is missing or aliased; occupancy remains unknown')
    directories=[root]
    for child in sorted(root.iterdir()):
        if child.name=='.cds-retention':continue
        if child.is_dir() and not child.is_symlink():directories.append(child)
        if len(directories)>256:raise RuntimeError('Directory enumeration budget exceeded; nothing deleted')
    base={'catalog':str(pathlib.Path(args.catalog).absolute() if args.catalog else root/'.cds-retention'),'directories':list(map(str,directories)),'instanceId':args.instance_id}
    if args.execute and args.confirm!=CONFIRM_PHRASE:raise RuntimeError('--execute requires the explicit retention confirmation phrase')
    if not 1<=args.max_removals<=20:raise RuntimeError('Batch size must be 1..20')
    if args.adopt_plan:
        plan=pathlib.Path(args.adopt_plan)
        if plan.is_symlink() or plan.stat().st_uid!=os.getuid():raise RuntimeError('Ownership plan author is unconfirmed')
        values=json.loads(plan.read_text())
        if not isinstance(values,list) or len(values)>20:raise RuntimeError('Ownership registration requires a bounded explicit file list')
        for item in values:
            allowed={'path','projectId','serviceId','origin','disposition','dispositionReason','sourceContainer','lineageAttestation'}
            if not isinstance(item,dict) or set(item)-allowed:raise RuntimeError('Ownership plan fields are not allowed')
            source=item.pop('sourceContainer',None);fingerprint=None
            if source:
                if not isinstance(item.get('lineageAttestation'),str) or not item['lineageAttestation'].strip():raise RuntimeError('Binding a historical archive to a current source requires explicit owner lineage evidence')
                fingerprint=run(program,{'action':'source','containerName':source})['sourceFingerprint']
            run(program,{**base,**item,'sourceFingerprint':fingerprint,'action':'register','attestedBy':'local-owner-uid-'+str(os.getuid()),'sourceComplete':False})
    if args.register_export:
        receipt=pathlib.Path(args.register_export)
        if receipt.is_symlink() or receipt.stat().st_uid!=os.getuid() or receipt.stat().st_size>262144:raise RuntimeError('Exporter receipt identity is unconfirmed')
        report=json.loads(receipt.read_text());folder=pathlib.Path(report['backupDir']).absolute()
        if folder.resolve()!=folder or folder not in directories or report.get('verdict')!='pass' or report.get('dryRun') is not False:raise RuntimeError('Exporter completion is unconfirmed')
        expected={}
        if report.get('mode')=='full':
            expected={str(folder/(db+'.archive.gz')):db for db in report.get('databases',[]) if isinstance(db,str) and db and '/' not in db and '..' not in db}
        elif report.get('mode')=='critical':
            for spec in report.get('criticalCollections',[]):
                if not isinstance(spec,str) or '/' in spec or '..' in spec or '.' not in spec:raise RuntimeError('Declared collection coverage is invalid')
                db,collection=spec.split('.',1);scope=db if collection=='*' else db+'/'+collection
                expected[str(folder/((db if collection=='*' else db+'.'+collection)+'.archive.gz'))]=scope
        declared=report.get('archives')
        if not expected or not isinstance(declared,list) or set(declared)!=set(expected):raise RuntimeError('Declared database/collection coverage is incomplete')
        source=report.get('sourceFingerprint');complete=isinstance(source,str) and len(source)==64 and report.get('sourceIdentityStable') is True
        sums=folder/'SHA256SUMS'
        if sums.is_symlink() or sums.stat().st_uid!=os.getuid():raise RuntimeError('Producer checksum file identity is unconfirmed')
        checksums={}
        for line in sums.read_text().splitlines():
            parts=line.split(maxsplit=1)
            if len(parts)!=2 or len(parts[0])!=64 or any(c not in '0123456789abcdef' for c in parts[0]):raise RuntimeError('Producer checksum format is unconfirmed')
            name=parts[1].lstrip('*');name=name[2:] if name.startswith('./') else name
            if '/' in name or name in checksums:raise RuntimeError('Producer checksum path or uniqueness is unconfirmed')
            checksums[name]=parts[0]
        if set(checksums)!={pathlib.Path(p).name for p in expected}:raise RuntimeError('Producer checksums do not cover the complete declared export')
        receipt_hash=hashlib.sha256(receipt.read_bytes()+sums.read_bytes()).hexdigest()
        recovered_at=int(dt.datetime.fromisoformat(report.get('backupStartedAt',report['generatedAt']).replace('Z','+00:00')).timestamp()*1000)
        registered=0
        for file,database in expected.items():
            run(program,{**base,'action':'register','path':file,'projectId':args.project,'serviceId':args.service+'/'+database,'origin':'automatic','sourceFingerprint':source if complete else None,'sourceComplete':complete,'recoveryPointAt':recovered_at,'producerIntegrity':{'gzipValidated':True,'sha256':checksums[pathlib.Path(file).name],'receiptSha256':receipt_hash}});registered+=1
        for file in [receipt,folder/'SHA256SUMS']:
            if file.parent==folder and file.is_file() and not file.is_symlink():run(program,{**base,'action':'register','path':str(file),'projectId':args.project,'serviceId':args.service+'/export-evidence','origin':'automatic','disposition':'reproducible-artifact','attestedBy':'completed-exporter','dispositionReason':'This exact producer generated bounded metadata/checksums; contains no business data'})
        if args.register_only:
            print(json.dumps({'registered':True,'archives':registered,'replacementVerified':complete,'maxAgeDays':15}));return 0
    report=run(program,{**base,'action':'reconcile' if args.execute else 'preview','maxRemovals':args.max_removals})
    report.update({'status':'executed' if args.execute else 'dry-run','root':str(root),'policy':{'maxAgeDays':15,'unknownOwnership':'retain','uniqueBusinessRecoveryPoint':'explicit-policy-conflict-until-valid-replacement'}})
    rendered=json.dumps(report,ensure_ascii=False,indent=2);print(rendered)
    if args.json_out:
        output=pathlib.Path(args.json_out)
        if output.is_symlink():raise RuntimeError('Report destination is aliased')
        if output.parent.absolute().resolve()!=output.parent.absolute():raise RuntimeError('Report directory is aliased')
        fd,temp=tempfile.mkstemp(prefix='.retention-report-',dir=output.parent)
        with os.fdopen(fd,'w') as f:f.write(rendered+'\n');f.flush();os.fsync(f.fileno())
        os.replace(temp,output)
    return 0 if report.get('scanStatus')=='complete' else 3

if __name__=='__main__':
    try:raise SystemExit(main())
    except (RuntimeError,OSError,ValueError,KeyError,TypeError,subprocess.TimeoutExpired) as error:
        print(json.dumps({'scanStatus':'partial','usageBytes':None,'error':str(error),'retained':True},ensure_ascii=False));raise SystemExit(3)
