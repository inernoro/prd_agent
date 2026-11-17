#!/usr/bin/env python3
"""Delete expired local snapshots only after recent off-host per-file verification."""
import argparse,datetime as dt,fcntl,hashlib,json,os,shutil,time
from pathlib import Path

def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(4*1024*1024),b''):h.update(b)
 return h.hexdigest()

def eligible(files,receipt,cutoff):
 if not files:return False,'empty or symlink-containing snapshot'
 for p,rel in files:
  r=receipt.get(rel)
  if not r or p.stat().st_mtime>cutoff:return False,'recent or no verified off-host copy'
  before=p.stat()
  if before.st_mtime!=r['mtime'] or before.st_size!=r['bytes'] or digest(p)!=r['sha256']:return False,'off-host digest differs'
  after=p.stat()
  if (before.st_mtime_ns,before.st_size)!=(after.st_mtime_ns,after.st_size):return False,'file changed during verification'
 return True,'expired and verified off-host'

def main():
 a=argparse.ArgumentParser(description=__doc__);a.add_argument('--root',required=True);a.add_argument('--receipt',required=True);a.add_argument('--days',type=int,default=90);a.add_argument('--execute',action='store_true');a.add_argument('--json-out',required=True);args=a.parse_args()
 if args.days<30:a.error('minimum retention is 30 days')
 lock=open('/run/lock/prd-agent-production.lock','a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 root=Path(args.root).resolve(strict=True)
 if root!=Path('/root/backups'):raise RuntimeError('Unexpected production backup root')
 receipt=json.loads(Path(args.receipt).read_text())
 if receipt['sourceRoot']!=str(root) or receipt['sourceHost']==receipt['offsiteHost']:raise RuntimeError('Off-host identity mismatch')
 if time.time()-receipt['verifiedAtEpoch']>7*86400:raise RuntimeError('Offsite receipt stale: verify off-host files again')
 rows={r['path']:r for r in receipt['files'] if 'sha256' in r}
 # Keep the latest substantial full snapshot for each database, even beyond TTL.
 protected=set()
 for name in ['prdagent.archive.gz','llm_gateway.archive.gz']:
  choices=[p for p in root.rglob(name) if p.is_file() and not p.is_symlink() and p.stat().st_size>=256*1024*1024]
  if choices:protected.add(max(choices,key=lambda p:p.stat().st_mtime).relative_to(root).parts[0])
 report={'at':dt.datetime.now(dt.timezone.utc).isoformat(),'days':args.days,'protected':sorted(protected),'removed':[],'kept':{},'candidates':[]}
 for directory in sorted(root.iterdir()):
  if not directory.is_dir() or directory.is_symlink() or directory.name in protected:
   report['kept'][directory.name]='latest full database snapshot or non-directory';continue
  if directory.stat().st_mtime>time.time()-args.days*86400:
   report['kept'][directory.name]='recent snapshot directory';continue
  paths=list(directory.rglob('*'))
  files=[(p,str(p.relative_to(root))) for p in paths if p.is_file() and not p.is_symlink()]
  if any(p.is_symlink() for p in paths):report['kept'][directory.name]='symlink';continue
  ok,reason=eligible(files,rows,time.time()-args.days*86400)
  if not ok:report['kept'][directory.name]=reason;continue
  report['candidates'].append({'name':directory.name,'bytes':sum(p.stat().st_size for p,_ in files)})
  if args.execute:
   # Check the exact file set again; never remove a newly added backup.
   now={str(p.relative_to(root)) for p in directory.rglob('*') if p.is_file()}
   if now!={rel for _,rel in files} or any(p.is_symlink() for p in directory.rglob('*')):raise RuntimeError('Snapshot changed before removal')
   if any(p.stat().st_mtime!=rows[rel]['mtime'] or p.stat().st_size!=rows[rel]['bytes'] for p,rel in files):raise RuntimeError('File changed before removal')
   shutil.rmtree(directory);report['removed'].append(directory.name)
 out=Path(args.json_out);tmp=out.with_suffix('.tmp');tmp.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');tmp.chmod(0o600);tmp.replace(out)
 print(json.dumps({'candidates':len(report['candidates']),'removed':len(report['removed']),'bytes':sum(x['bytes'] for x in report['candidates']),'protected':report['protected']}))
if __name__=='__main__':main()
