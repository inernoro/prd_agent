
import os,sys,json,stat,hashlib,gzip,fcntl,time,secrets,pathlib
req=json.load(sys.stdin);deadline=time.monotonic()+25
DAY=86400000;MAX_AGE=15*DAY
def check():
 if time.monotonic()>deadline:raise ValueError('inspection-budget-exceeded')
 if req.get('executionId') and 'root' in globals() and os.path.lexists(root/('cancel-'+req['executionId'])):raise InterruptedError('cancelled')
def directory(p,create=False):
 p=pathlib.Path(p)
 if not p.is_absolute() or p.resolve()!=p:raise ValueError('directory-alias-or-relative')
 if create:p.mkdir(parents=True,mode=0o700,exist_ok=True)
 s=p.lstat()
 if not stat.S_ISDIR(s.st_mode):raise ValueError('not-an-ordinary-directory')
 return p,(s.st_dev,s.st_ino)
def signature(s):return [s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns]
def birth_identity(fd):
 import ctypes,struct
 s=os.fstat(fd);identity=(s.st_dev,s.st_ino)
 libc=ctypes.CDLL(None,use_errno=True);buffer=ctypes.create_string_buffer(256)
 if libc.statx(fd,b'',0x1100,0x900,ctypes.byref(buffer))!=0:raise ValueError('entry-birth-query-unconfirmed')
 raw=buffer.raw;mask=struct.unpack_from('I',raw,0)[0]
 if mask&0x900!=0x900 or struct.unpack_from('Q',raw,32)[0]!=identity[1]:raise ValueError('entry-birth-identity-unconfirmed')
 return [*identity,struct.unpack_from('q',raw,80)[0],struct.unpack_from('I',raw,88)[0]]
def directory_birth_identity(p):
 location,identity=directory(p);fd=os.open(location,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  result=birth_identity(fd)
  if directory(location)[1]!=identity:raise ValueError('directory-replaced-during-birth-query')
  return result
 finally:os.close(fd)
def file_birth_identity(p):
 fd,_,_=open_file(p)
 try:return birth_identity(fd)
 finally:os.close(fd)
def open_file(p):
 p=pathlib.Path(p);parent,identity=directory(p.parent)
 fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:return os.open(p.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd),parent,identity
 finally:os.close(fd)
def proof(p,verify=False):
 fd,parent,identity=open_file(p)
 try:
  s=os.fstat(fd)
  if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or s.st_nlink!=1:raise ValueError('file-owner-type-or-hardlink-unconfirmed')
  out={'signature':signature(s),'allocatedBytes':s.st_blocks*512}
  if verify:
   if s.st_size<=0:raise ValueError('empty-backup')
   digest=hashlib.sha256()
   while True:
    check();b=os.read(fd,1024*1024)
    if not b:break
    digest.update(b)
   if verify is True and str(p).endswith('.gz'):
    os.lseek(fd,0,0)
    with os.fdopen(os.dup(fd),'rb') as raw:
     with gzip.GzipFile(fileobj=raw) as compressed:
      while compressed.read(1024*1024):check()
   if signature(os.fstat(fd))!=out['signature']:raise ValueError('file-changed-during-verification')
   out['sha256']=digest.hexdigest()
  return out
 finally:os.close(fd)
def live_files():
 # Any failed enumeration is unknown. Do not turn it into an empty reference set.
 out=set()
 for pid in pathlib.Path('/proc').iterdir():
  if not pid.name.isdigit() or int(pid.name)==os.getpid():continue
  try:
   for fd in (pid/'fd').iterdir():
    try:s=fd.stat();out.add((s.st_dev,s.st_ino))
    except FileNotFoundError:continue
  except FileNotFoundError:continue
 return out
