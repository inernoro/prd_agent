#!/usr/bin/env python3
"""Verify an SSH inventory against a private workstation mirror; issue a deletion receipt.

Copy with rsync -a (no --delete), then verify. Upload the receipt to the production
host only after success. Renew it before the seven-day receipt expires.
"""
import argparse,gzip,hashlib,json,os,socket,time
from pathlib import Path

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--inventory',required=True);p.add_argument('--mirror',required=True);p.add_argument('--source-host',required=True);p.add_argument('--receipt',required=True);p.add_argument('--max-file-bytes',type=int,default=100*1024*1024);a=p.parse_args()
 root=Path(a.mirror).resolve(strict=True);os.chmod(root,0o700)
 rows=json.loads(Path(a.inventory).read_text());verified=[];invalid=[]
 for row in rows:
  if row.get('bytes',0)>a.max_file_bytes:continue
  rel=Path(row['path'])
  if rel.is_absolute() or '..' in rel.parts:raise RuntimeError('Unsafe inventory path')
  f=root/rel
  if 'symlink' in row:
   if not f.is_symlink() or os.readlink(f)!=row['symlink']:raise RuntimeError('Symlink mismatch')
   continue
  if f.is_symlink() or not f.is_file() or f.stat().st_size!=row['bytes']:raise RuntimeError('Mirror file absent or size mismatch: '+str(rel))
  h=hashlib.sha256()
  with f.open('rb') as stream:
   for chunk in iter(lambda:stream.read(4*1024*1024),b''):h.update(chunk)
  if h.hexdigest()!=row['sha256']:raise RuntimeError('Digest mismatch: '+str(rel))
  if str(f).endswith(('.archive.gz','.tar.gz','.tgz')):
   try:
    with gzip.open(f,'rb') as stream:
     while stream.read(4*1024*1024):pass
    row={**row,'gzipValid':True}
   except (OSError,EOFError):
    row={**row,'gzipValid':False};invalid.append(str(rel))
  f.chmod(0o600);verified.append(row)
 receipt={'sourceHost':a.source_host,'sourceRoot':'/root/backups','offsiteHost':socket.gethostname(),'offsiteRoot':str(root),'verifiedAtEpoch':time.time(),'files':verified,'invalidCompressedFiles':invalid,'checks':['per-file SHA256','gzip integrity for compressed database and tar archives']}
 out=Path(a.receipt);out.write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n');out.chmod(0o600)
 print(json.dumps({'verifiedFiles':len(verified),'bytes':sum(r['bytes'] for r in verified),'invalidCompressedFiles':len(invalid)}))
if __name__=='__main__':main()
