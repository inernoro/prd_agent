# Embedded by the existing release retention command; no credentials or app data are read into output.
import base64,fcntl,json,os,pathlib,re,stat,subprocess,sys
repo,wt,public,spec=sys.argv[1:]
repo=pathlib.Path(repo);wt=pathlib.Path(wt);public=pathlib.Path(public) if public else None
spec=json.loads(base64.b64decode(spec));names=spec['worktrees'];versions=spec['versions']
def emit(key,value):print(key+'='+value,flush=True)
def held(name,reason):emit('CDS_RELEASE_HELD_WORKTREE',name+'\t'+reason)
def query(args):return subprocess.check_output(args,stderr=subprocess.PIPE,timeout=15).decode()
def valid(name):return re.fullmatch(r'rel_[0-9a-f]{16}(?:-auto-restore)?',name) is not None
def ordinary(path):
 s=path.lstat()
 if not stat.S_ISDIR(s.st_mode) or path.resolve()!=path.absolute():raise ValueError('directory-identity-unconfirmed')
 return str(s.st_dev)+':'+str(s.st_ino)
def anchors():
 root=public if public else wt.parent
 result=[]
 for name in ['current','previous']:
  p=root/name
  if not os.path.lexists(p):
   if name=='current':raise ValueError('current-reference-unconfirmed')
   continue
  if not p.is_symlink():raise ValueError('reference-is-not-a-link')
  value=p.resolve(strict=True)
  if not value.is_dir():raise ValueError('reference-target-unconfirmed')
  result.append(value)
 return result
before=None
try:
 ordinary(wt);ordinary(wt.parent)
 before=os.statvfs(wt)
 lock_path=wt.parent/'.retention.lock';lock=None
 if not spec.get('dryRun') or os.path.lexists(lock_path):
  lock=os.open(lock_path,(os.O_RDONLY if spec.get('dryRun') else os.O_RDWR|os.O_CREAT)|os.O_NOFOLLOW,0o600)
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:raise ValueError('release-or-reclaim-in-progress')
 ids=query(['docker','ps','-aq','--no-trunc']).splitlines()
 if len(ids)>5000 or any(not re.fullmatch('[a-f0-9]{64}',v) for v in ids):raise ValueError('container-query-unconfirmed')
 mounts=[]
 if ids:
  output=query(['docker','inspect','--format','{{json .Mounts}}']+ids)
  if len(output)>16*1024*1024:raise ValueError('container-query-budget-exceeded')
  rows=output.splitlines()
  if len(rows)!=len(ids):raise ValueError('container-query-incomplete')
  for row in rows:
   values=json.loads(row)
   if not isinstance(values,list):raise ValueError('mount-query-invalid')
   for m in values:
    if m.get('Type')=='tmpfs':continue
    source=m.get('Source')
    if not source or not os.path.isabs(source):raise ValueError('mount-source-unconfirmed')
    mounts.append(pathlib.Path(source).resolve(strict=True))
 current=anchors()
 common=pathlib.Path(query(['git','-C',str(repo),'rev-parse','--git-common-dir']).strip())
 common=(common if common.is_absolute() else repo/common).resolve(strict=True)
 for name in names:
  if not valid(name):continue
  p=wt/name
  try:
   identity=ordinary(p)
   if identity!=spec.get('identities',{}).get(name):held(name,'identity-changed-or-unconfirmed');continue
   commit=spec.get('commits',{}).get(name)
   if not isinstance(commit,str) or not re.fullmatch('[a-f0-9]{40}',commit):held(name,'ledger-owner-unconfirmed');continue
   if any(p==q or p in q.parents or q in p.parents or (public and q.name==name) for q in anchors()):held(name,'current-or-previous');continue
   if any(p==q or p in q.parents or q in p.parents for q in mounts):held(name,'running-or-stopped-container');continue
   gitroot=pathlib.Path(query(['git','-C',str(p),'rev-parse','--show-toplevel']).strip()).resolve(strict=True)
   shared=pathlib.Path(query(['git','-C',str(p),'rev-parse','--git-common-dir']).strip())
   shared=(shared if shared.is_absolute() else p/shared).resolve(strict=True)
   if gitroot!=p or shared!=common or query(['git','-C',str(p),'rev-parse','HEAD']).strip()!=commit:held(name,'git-owner-or-commit-unconfirmed');continue
   if any(os.path.lexists(p/x) for x in ['.cds-data','.cds-run-data']):held(name,'persistent-data');continue
   if query(['git','-C',str(p),'status','--porcelain','--untracked-files=normal','--ignored=matching']).strip():held(name,'modified-or-unknown-files');continue
   if ordinary(p)!=identity or anchors()!=current:held(name,'identity-or-references-changed');continue
   if spec.get('dryRun'):
    emit('CDS_RELEASE_RECLAIMABLE_WORKTREE',name);continue
   # Only supported Git removal. No --force, recursive fallback, global prune or data-volume operation.
   try:subprocess.run(['git','-C',str(repo),'worktree','remove',str(p)],check=True,timeout=30,stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=(lock,))
   except Exception:
    emit('CDS_RELEASE_RECLAIM_FAILED_WORKTREE',name);continue
   emit('CDS_RELEASE_RECLAIMED_WORKTREE' if not os.path.lexists(p) else 'CDS_RELEASE_RECLAIM_FAILED_WORKTREE',name)
  except Exception:
   held(name,'native-query-or-removal-unconfirmed')
 for name in versions:
  if valid(name):emit('CDS_RELEASE_HELD_VERSION',name+'\tstatic-object-content-proof-unconfirmed')
except Exception as error:
 reason=str(error) if isinstance(error,ValueError) else 'native-reference-query-failed'
 emit('CDS_RELEASE_QUERY_ERROR',reason)
 for name in names:
  if valid(name):held(name,reason)
 for name in versions:
  if valid(name):emit('CDS_RELEASE_HELD_VERSION',name+'\t'+reason)
finally:
 if before is not None:
  try:
   after=os.statvfs(wt)
   emit('CDS_RELEASE_FILESYSTEM_NET_AVAILABLE_CHANGE',str(after.f_bavail*after.f_frsize-before.f_bavail*before.f_frsize))
  except Exception:emit('CDS_RELEASE_QUERY_ERROR','filesystem-observation-unconfirmed')
