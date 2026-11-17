#!/usr/bin/env python3
"""Full online logical Mongo backup streamed over SSH; never restore on production."""
import re,shlex
import argparse,datetime as dt,fcntl,gzip,hashlib,json,os,socket,subprocess,time,shutil,sys
from pathlib import Path
DATABASES=('prdagent','llm_gateway','admin')
SOURCE_RECEIPT_SCRIPT="import json,sys,pathlib,hashlib,fcntl,re,os\nreceipt=json.load(sys.stdin)\nbase=pathlib.Path('/var/lib/prd-agent/business-backups')\ncurrent=pathlib.Path(receipt['sourceDirectory'])\nif current.parent!=base or not re.fullmatch(r'[0-9]{8}T[0-9]{6}Z',current.name) or current.is_symlink():raise ValueError('Unsafe source scope')\nif receipt.get('restoreStatus')!='passed':raise ValueError('Actual isolated restore required')\nlock=open('/run/lock/prd-agent-business-backup.lock','a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)\ndef sha(p):\n h=hashlib.sha256()\n with p.open('rb') as f:\n  for b in iter(lambda:f.read(4*1024*1024),b''):h.update(b)\n return h.hexdigest()\nallowed={'prdagent.archive.gz','llm_gateway.archive.gz','admin.archive.gz'}\nif {x['file'] for x in receipt['archives']}!=allowed:raise ValueError('Incomplete archive receipt')\nfor row in receipt['archives']:\n p=current/row['file']\n if p.is_symlink() or p.stat().st_size!=row['bytes'] or (current/(row['file']+'.sha256')).read_text().split()[0]!=row['sha256']:raise ValueError('Source receipt mismatch')\ntarget=current/'offsite-restored.json';temporary=current/'offsite-restored.tmp';temporary.write_text(json.dumps(receipt));temporary.chmod(0o600);temporary.replace(target)\nfolders=sorted([p for p in base.iterdir() if p.is_dir() and not p.is_symlink() and re.fullmatch(r'[0-9]{8}T[0-9]{6}Z',p.name) and (p/'status').is_file() and not (p/'status').is_symlink() and (p/'status').read_text().strip()=='completed'],reverse=True)\npruned=[]\nfor folder in folders[1:]:\n proof=folder/'offsite-restored.json'\n if not proof.is_file() or proof.is_symlink():continue\n old=json.loads(proof.read_text())\n if old.get('restoreStatus')!='passed' or old.get('sourceDirectory')!=str(folder) or {x['file'] for x in old.get('archives',[])}!=allowed:continue\n files=[(folder/x['file'],x) for x in old['archives']]\n if not all(p.is_file() and not p.is_symlink() and p.stat().st_size==x['bytes'] and sha(p)==x['sha256'] for p,x in files):continue\n for path,_ in files:path.unlink()\n (folder/'status').write_text('offsite-only\\n');pruned.append(folder.name)\nprint(json.dumps({'receiptStored':True,'keptSourceCopies':min(len(folders),1),'prunedSourceCopies':pruned}))\n"

def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for chunk in iter(lambda:f.read(4*1024*1024),b''):h.update(chunk)
 return h.hexdigest()

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--host',required=True);p.add_argument('--destination',required=True);p.add_argument('--restore',action='store_true',help='Perform an actual isolated restore before publishing success');p.add_argument('--source-directory',help='Existing private, durable source dump directory; download only');a=p.parse_args()
 if a.source_directory and (not a.source_directory.startswith('/var/lib/prd-agent/business-backups/') or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/_-' for c in a.source_directory)):raise ValueError('Invalid source spool directory')
 if not re.fullmatch(r'(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*',a.host):raise ValueError('Invalid SSH host')
 base=Path(a.destination).expanduser().resolve();base.mkdir(mode=0o700,parents=True,exist_ok=True);base.chmod(0o700)
 lock=(base/'backup.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 stamp=dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
 active=base/'active.json'
 previous=json.loads(active.read_text()) if active.exists() else None
 if previous and previous.get('sourceHost')==a.host:
  folder=base/previous['folder']
  if folder.parent!=base:raise ValueError('Invalid active backup path')
  a.source_directory=previous.get('sourceDirectory')
 else:
  folder=base/stamp;folder.mkdir(mode=0o700)
  if not a.source_directory:
   a.source_directory='/var/lib/prd-agent/business-backups/'+stamp
   subprocess.run(['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',a.host,
       'systemd-run --unit=prd-agent-business-backup-'+stamp+' --property=Nice=19 --property=IOSchedulingClass=idle /usr/local/sbin/prd-agent-business-backup-source '+stamp],check=True)
  active.write_text(json.dumps({'sourceHost':a.host,'folder':folder.name,'sourceDirectory':a.source_directory}));active.chmod(0o600)
 manifest={'startedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'sourceHost':a.host,'offsiteHost':socket.gethostname(),'scope':list(DATABASES),'exclusions':[],'consistency':'online standalone logical backup; not a transaction-wide point-in-time snapshot','status':'running','archives':[]}
 def save():
  f=folder/'manifest.json';f.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n');f.chmod(0o600)
 if (folder/'manifest.json').exists():manifest=json.loads((folder/'manifest.json').read_text());manifest['status']='running'
 save()
 try:
  if not a.source_directory or not re.fullmatch(r'/var/lib/prd-agent/business-backups/[0-9]{8}T[0-9]{6}Z',a.source_directory):raise ValueError('Invalid source directory')
  ssh=['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15',a.host]
  # Only operator-readable private files; never print configuration values.
  for name,cmd in [('environment.snapshot','cat /root/inernoro/prd_agent/.env'),('compose.snapshot.yml','cat /root/inernoro/prd_agent/docker-compose.yml'),('logging-overlay.snapshot.yml','cat /etc/prd-agent/compose.logging.yml'),('api-environment.snapshot.json',"docker inspect prdagent-api --format '{{json .Config.Env}}'")]:
   with (folder/name).open('wb') as out:subprocess.run(ssh+[cmd],stdout=out,check=True)
   (folder/name).chmod(0o600)
  manifest['configuration']=[{'file':x.name,'bytes':x.stat().st_size,'sha256':digest(x)} for x in folder.iterdir() if '.snapshot' in x.name];save()
  for database in DATABASES:
   done=next((x for x in manifest['archives'] if x['database']==database),None)
   if done and (folder/done['file']).is_file() and digest(folder/done['file'])==done['sha256']:continue
   partial=folder/(database+'.archive.gz.partial');log=folder/(database+'.dump.log')
   command='docker exec prdagent-mongodb nice -n 19 ionice -c 3 mongodump --numParallelCollections=1 --db '+database+' --archive --gzip'
   print('Streaming '+database+' (all collections, serial low-priority reader)',flush=True)
   if a.source_directory:
    remote=a.source_directory+'/'+database+'.archive.gz'
    deadline=time.monotonic()+12*3600
    while subprocess.run(ssh+['test -f '+remote+'.sha256'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
     state=subprocess.check_output(ssh+['cat '+a.source_directory+'/status'],text=True).strip()
     if state=='failed' or time.monotonic()>deadline:raise RuntimeError('Durable source backup failed or timed out')
     time.sleep(15)
    remote_size=int(subprocess.check_output(ssh+['stat -c %s '+remote],text=True).strip())
    if shutil.disk_usage(base).free<remote_size+10*1024**3:raise RuntimeError('Insufficient offsite disk reserve')
    expected=subprocess.check_output(ssh+['cat '+remote+'.sha256'],text=True).split()[0]
    subprocess.run(['rsync','--partial','--inplace','-e','ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=6',a.host+':'+remote,str(partial)],check=True,timeout=12*3600)
    partial.chmod(0o600)
    if digest(partial)!=expected:raise RuntimeError('Offsite SHA256 differs from source')
    with log.open('wb') as err:subprocess.run(ssh+['cat '+a.source_directory+'/'+database+'.dump.log'],stdout=err,check=True)
    log.chmod(0o600)
   else:
    with partial.open('wb') as out,log.open('wb') as err:
     partial.chmod(0o600);log.chmod(0o600)
     subprocess.run(ssh+[command],stdout=out,stderr=err,check=True,timeout=12*3600)
   with gzip.open(partial,'rb') as stream:
    while stream.read(4*1024*1024):pass
   final=partial.with_suffix('');partial.rename(final)
   row={'database':database,'file':final.name,'bytes':final.stat().st_size,'sha256':digest(final),'gzipVerified':True}
   for field,suffix in [('dumpStartedAt','started'),('dumpCompletedAt','completed')]:
    row[field]=subprocess.check_output(ssh+['cat '+a.source_directory+'/'+database+'.'+suffix],text=True).strip()
   manifest['archives'].append(row);save()
  with (folder/'indexes.json').open('wb') as out:
   subprocess.run(ssh+['cat '+a.source_directory+'/indexes.json'],stdout=out,check=True)
  (folder/'indexes.json').chmod(0o600)
  manifest['indexSnapshotSha256']=digest(folder/'indexes.json')
  manifest['sourceDirectory']=a.source_directory
  manifest['sourceWindowStart']=min(x.get('dumpStartedAt',manifest['startedAt']) for x in manifest['archives'])
  manifest['sourceWindowEnd']=max(x.get('dumpCompletedAt',manifest['startedAt']) for x in manifest['archives'])
  manifest['status']='completed';manifest['completedAt']=dt.datetime.now(dt.timezone.utc).isoformat();save()
  if a.restore:
   restore=folder/('restore-check-'+dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
   subprocess.run([sys.executable,str(Path(__file__).with_name('prd-agent-isolated-restore.py')),'--backup',str(folder),'--work',str(restore)],check=True)
   proof=json.loads((restore/'result.json').read_text())
   if proof.get('status')!='passed' or not proof.get('isolatedProcessStopped'):raise RuntimeError('Isolated restore proof incomplete')
   manifest['restoreVerifiedAt']=dt.datetime.now(dt.timezone.utc).isoformat();manifest['restoreReport']=str(restore/'result.json');save()
   # Only the stopped, freshly created drill database is a disposable duplicate.
   shutil.rmtree(restore/'data')
   receipt={'sourceDirectory':a.source_directory,'offsiteHost':socket.gethostname(),'offsiteFolder':str(folder),
            'verifiedAt':manifest['restoreVerifiedAt'],'restoreStatus':'passed','archives':manifest['archives'],
            'restoreReportSha256':digest(restore/'result.json')}
   completed=subprocess.run(ssh+['nice -n 19 ionice -c 3 python3 -c '+shlex.quote(SOURCE_RECEIPT_SCRIPT)],input=json.dumps(receipt),text=True,capture_output=True,check=True)
   manifest['sourceRetention']=json.loads(completed.stdout);save()
  # Commit a latest pointer only after every stream and checksum succeeds.
  latest=base/'latest.json';tmp=base/'latest.tmp';tmp.write_text(json.dumps({'folder':str(folder),'manifestSha256':digest(folder/'manifest.json')}));tmp.chmod(0o600);tmp.replace(latest)
  active.unlink(missing_ok=True)
  print('Backup complete: '+str(folder),flush=True)
 except Exception as e:
  manifest['status']='failed';manifest['errorType']=type(e).__name__;save();raise
if __name__=='__main__':main()
