
import subprocess
deadline=time.monotonic()+(900 if req['action']=='register' else 300 if req['action']=='reconcile' else 25)
def backup_mount_references():
 def query(args):
  check();value=subprocess.run(['docker',*args],capture_output=True,text=True,timeout=8)
  if value.returncode:raise ValueError('docker-reference-query-unconfirmed')
  return value.stdout
 ids=sorted(set(query(['ps','-aq','--no-trunc']).splitlines()));rows=[]
 for offset in range(0,len(ids),100):
  lines=query(['inspect','--format','{"id":{{json .Id}},"pid":{{json .State.Pid}},"mounts":{{json .Mounts}}}',*ids[offset:offset+100]]).splitlines();rows.extend(json.loads(line) for line in lines)
 if len(ids)>5000 or len(rows)!=len(ids) or sorted(row['id'] for row in rows)!=ids or ids!=sorted(set(query(['ps','-aq','--no-trunc']).splitlines())):raise ValueError('docker-reference-inventory-incomplete')
 result=[]
 for row in rows:
  for mount in row['mounts']:
   if mount.get('Type')=='tmpfs':continue
   source=pathlib.Path(mount['Source']).resolve(strict=True);s=source.stat();result.append({'path':str(source),'identity':[s.st_dev,s.st_ino]})
   if row['pid']>0:
    target=pathlib.Path('/proc',str(row['pid']),'root')/mount['Destination'].lstrip('/')
    try:s=target.stat();result.append({'identity':[s.st_dev,s.st_ino]})
    except FileNotFoundError:
     if pathlib.Path('/proc',str(row['pid'])).exists():raise ValueError('running-container-mount-query-unconfirmed')
 return result
if req['action']=='source':
 def query(args):
  p=subprocess.run(['docker',*args],capture_output=True,text=True,timeout=8)
  if p.returncode:raise ValueError('backup-source-query-unconfirmed')
  return json.loads(p.stdout)
 rows=query(['inspect',req['containerName']])
 if not isinstance(rows,list) or len(rows)!=1 or (rows[0].get('Name','').removeprefix('/')!=req['containerName'].removeprefix('/') and rows[0].get('Id')!=req['containerName']):raise ValueError('backup-source-identity-unconfirmed')
 value=rows[0];mounts=value.get('Mounts')
 # Docker 20 omits --tmpfs entries from Mounts on some hosts. A container ID
 # survives restart while its tmpfs does not, so it cannot prove this lineage.
 if value.get('HostConfig',{}).get('Tmpfs'):raise ValueError('backup-source-volatile-mount-lineage-unconfirmed')
 if not isinstance(mounts,list):raise ValueError('backup-source-mounts-unconfirmed')
 data=[]
 for mount in mounts:
  if mount.get('RW') is not True:continue
  if mount.get('Type') in ['volume','bind']:
   location=pathlib.Path(mount['Source']);s=location.lstat()
   if stat.S_ISDIR(s.st_mode):birth=directory_birth_identity(location)
   elif stat.S_ISREG(s.st_mode):birth=file_birth_identity(location)
   else:raise ValueError('backup-source-special-file-or-alias')
   data.append([mount['Type'],mount.get('Destination'),birth])
  elif mount.get('Type')=='tmpfs':raise ValueError('backup-source-volatile-mount-lineage-unconfirmed')
  else:raise ValueError('backup-source-driver-unconfirmed')
 info=query(['info','--format','{{json .}}'])
 source={'daemon':info['ID'],'data':sorted(data),'layer':value['Id'] if not data else None}
 print(json.dumps({'sourceFingerprint':hashlib.sha256(json.dumps(source,sort_keys=True).encode()).hexdigest()}));sys.exit(0)
try:directory(req['directories'][0])
except FileNotFoundError:
 if req['action'] not in ['preview','reconcile']:raise
 print(json.dumps({'scanStatus':'complete','directoryMissing':True,'counts':{}}));sys.exit(0)
try:root,root_identity=directory(req['catalog'],req['action']!='preview')
except FileNotFoundError:
 print(json.dumps({'scanStatus':'partial','unknown':[{'path':req['directories'][0],'reason':'retention-catalog-not-initialized'}],'counts':{'unknown':1},'usageBytes':None}));sys.exit(0)
if root.stat().st_uid!=os.getuid() or root.stat().st_mode&0o077:raise ValueError('catalog-ownership-unconfirmed')
root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
if (os.fstat(root_fd).st_dev,os.fstat(root_fd).st_ino)!=root_identity:raise ValueError('catalog-directory-replaced')
lock=os.open('lock',(os.O_RDONLY if req['action']=='preview' else os.O_CREAT|os.O_RDWR)|os.O_NOFOLLOW,0o600,dir_fd=root_fd)
fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
db=root/'backups.json';state={'schema':1,'files':{},'leases':{}}
if db.exists():
 if db.is_symlink():raise ValueError('catalog-alias')
 db_fd=os.open('backups.json',os.O_RDONLY|os.O_NOFOLLOW,dir_fd=root_fd)
 with os.fdopen(db_fd,'r') as source:state=json.load(source)
 if state.get('schema')!=1:raise ValueError('catalog-schema-unknown')
def save():
 if directory(root)[1]!=root_identity:raise ValueError('catalog-directory-replaced')
 temp='write-'+secrets.token_hex(12);fd=os.open(temp,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600,dir_fd=root_fd)
 with os.fdopen(fd,'w') as f:json.dump(state,f,separators=(',',':'));f.flush();os.fsync(f.fileno())
 os.replace(temp,'backups.json',src_dir_fd=root_fd,dst_dir_fd=root_fd);os.fsync(root_fd)
def unlocked_proof(p,verify):
 global state
 # Integrity work must not prevent backup/restore leases from renewing.
 fcntl.flock(lock,fcntl.LOCK_UN)
 try:return proof(p,verify)
 finally:
  until=time.monotonic()+5
  while True:
   try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);break
   except BlockingIOError:
    if time.monotonic()>until:os._exit(2) # Do not save stale state without the metadata lock.
    time.sleep(.05)
  fd=os.open('backups.json',os.O_RDONLY|os.O_NOFOLLOW,dir_fd=root_fd)
  with os.fdopen(fd) as f:state=json.load(f)
  if state.get('schema')!=1:os._exit(2)
def execution_owner(pid):
 try:
  p=pathlib.Path('/proc',str(pid));parts=(p/'stat').read_text().split(') ',1)[1].split()
  return {'pid':pid,'start':parts[19],'uid':p.stat().st_uid,'boot':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
 except FileNotFoundError:return None
now=req.get('nowMs',int(time.time()*1000));action=req['action']
state.setdefault('outputs',{})
def key(project,service):return json.dumps([project,service],separators=(',',':'))
if action=='output':
 p=pathlib.Path(req['path']);parent,parent_identity=directory(p.parent)
 if not any(parent.parent==pathlib.Path(v)/'.tmp' for v in req['directories']):raise ValueError('temporary-output-outside-owned-round')
 if not req['projectId'] or not req['serviceId']:raise ValueError('temporary-output-owner-unconfirmed')
 if str(p) in state['outputs'] or os.path.lexists(p):raise ValueError('temporary-output-already-exists')
 disposition=req.get('disposition','business-backup');fingerprint=req.get('sourceFingerprint') or 'unconfirmed'
 if disposition not in ['business-backup','reproducible-artifact'] or (disposition=='reproducible-artifact' and (not req.get('attestedBy') or not req.get('dispositionReason'))):raise ValueError('temporary-output-data-disposition-unconfirmed')
 if fingerprint!='unconfirmed' and (len(fingerprint)!=64 or any(c not in '0123456789abcdef' for c in fingerprint)):raise ValueError('backup-source-fingerprint-invalid')
 row={'path':str(p),'projectId':req['projectId'],'serviceId':req['serviceId'],'instanceId':req['instanceId'],'createdAt':now,'parentIdentity':list(parent_identity),'stage':'intent','kind':'temporary-output','disposition':disposition,'sourceFingerprint':fingerprint,'attestedBy':req.get('attestedBy'),'dispositionReason':req.get('dispositionReason')}
 state['outputs'][str(p)]=row;save()
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);row['birthIdentity']=birth_identity(fd);os.fsync(fd);os.close(fd)
 row['stage']='created';save();print(json.dumps({'created':True}));sys.exit(0)
if action=='close-output':
 row=state['outputs'].get(req['path'])
 if not row or row['instanceId']!=req['instanceId']:raise ValueError('temporary-output-owner-unconfirmed')
 if os.path.lexists(row['path']):
  q=proof(row['path'])
  if file_birth_identity(row['path'])!=row.get('birthIdentity'):raise ValueError('temporary-output-identity-changed')
  if tuple(q['signature'][:2]) in live_files():raise ValueError('temporary-output-writer-still-open')
 row['closedAt']=now;save();print(json.dumps({'closed':True}));sys.exit(0)
if action=='promote-output':
 row=state['outputs'].get(req['path']);destination=pathlib.Path(req['destination'])
 if not row or row['instanceId']!=req['instanceId'] or row.get('kind')!='temporary-output':raise ValueError('temporary-output-owner-unconfirmed')
 source=pathlib.Path(row['path']);parent,parent_identity=directory(source.parent);target_parent,target_identity=directory(destination.parent)
 if str(target_parent) not in req['directories'] or list(parent_identity)!=row['parentIdentity'] or destination.name.startswith('.'):raise ValueError('promotion-directory-unconfirmed')
 value=proof(source)
 if file_birth_identity(source)!=row.get('birthIdentity') or tuple(value['signature'][:2]) in live_files():raise ValueError('promotion-source-replaced-or-still-open')
 if row.get('promotionTarget') and row['promotionTarget']!=str(destination):raise ValueError('promotion-destination-changed')
 row['promotionTarget']=str(destination);row['promotionParentIdentity']=list(target_identity);save()
 source_fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);target_fd=os.open(target_parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  import ctypes
  if signature(os.stat(source.name,dir_fd=source_fd,follow_symlinks=False))!=value['signature'] or directory(parent)[1]!=parent_identity or directory(target_parent)[1]!=target_identity:raise ValueError('promotion-identity-changed')
  libc=ctypes.CDLL(None,use_errno=True)
  if libc.renameat2(source_fd,source.name.encode(),target_fd,destination.name.encode(),1)!=0:raise OSError(ctypes.get_errno(),'atomic-promotion-refused-no-overwrite')
  os.fsync(source_fd);os.fsync(target_fd)
 finally:os.close(source_fd);os.close(target_fd)
 row['promotedAt']=now;save();print(json.dumps({'promoted':True}));sys.exit(0)
if action=='lease':
 owner=key(req['projectId'],req['serviceId']);token=req['token'];old=state['leases'].get(owner)
 if old and old['until']>now and old['token']!=token:raise ValueError('backup-or-restore-lease-held')
 state['leases'][owner]={'token':token,'until':now+600000,'kind':req['kind']};save();print(json.dumps({'leased':True}));sys.exit(0)
if action=='release':
 owner=key(req['projectId'],req['serviceId']);old=state['leases'].get(owner)
 if old and old['token']==req['token']:del state['leases'][owner];save()
 print(json.dumps({'released':True}));sys.exit(0)
if action=='register':
 p=str(pathlib.Path(req['path']));parent,_=directory(pathlib.Path(p).parent)
 if not any(parent==pathlib.Path(v) or pathlib.Path(v) in parent.parents for v in req['directories']):raise ValueError('outside-declared-backup-directories')
 if '.tmp' in pathlib.Path(p).parts:raise ValueError('incomplete-output-is-not-a-recovery-point')
 if not req['projectId'] or not req['serviceId'] or req['origin'] not in ['automatic','manual','pre-restore','historical']:raise ValueError('backup-owner-unconfirmed')
 def managed_promotion():
  entries=[value for value in state['outputs'].values() if value.get('promotionTarget')==p and value['projectId']==req['projectId'] and value['serviceId']==req['serviceId'] and value['instanceId']==req['instanceId']]
  if req.get('requireManagedOutput') or entries:
   if len(entries)!=1 or file_birth_identity(p)!=entries[0].get('birthIdentity') or list(directory(pathlib.Path(p).parent)[1])!=entries[0].get('promotionParentIdentity'):raise ValueError('promoted-backup-identity-changed-before-registration')
 managed_promotion()
 old=state['files'].get(p)
 if old and (old['projectId']!=req['projectId'] or old['serviceId']!=req['serviceId'] or old['instanceId']!=req['instanceId']):raise ValueError('backup-owner-already-registered')
 save() # Establish a catalog before releasing its metadata lock.
 integrity=req.get('producerIntegrity') or {}
 inherited_integrity=req['origin']=='automatic' and integrity.get('gzipValidated') is True and len(integrity.get('sha256',''))==64 and len(integrity.get('receiptSha256',''))==64
 q=unlocked_proof(p,True) # Producer receipts supplement, never replace, native integrity verification.
 if inherited_integrity and q['sha256']!=integrity['sha256']:raise ValueError('completed-export-checksum-changed')
 if proof(p)['signature']!=q['signature']:raise ValueError('backup-changed-before-registration')
 if tuple(q['signature'][:2]) in live_files():raise ValueError('backup-still-open')
 managed_promotion()
 old=state['files'].get(p)
 if old and (old['projectId']!=req['projectId'] or old['serviceId']!=req['serviceId'] or old['instanceId']!=req['instanceId']):raise ValueError('backup-owner-changed-during-verification')
 if old and old['signature']!=q['signature']:raise ValueError('registered-path-was-replaced')
 disposition=req.get('disposition','business-backup')
 if disposition not in ['business-backup','reproducible-artifact']:raise ValueError('backup-disposition-unconfirmed')
 if disposition=='reproducible-artifact' and (not req.get('attestedBy') or not req.get('dispositionReason')):raise ValueError('non-business-data-attestation-required')
 fingerprint=req.get('sourceFingerprint') or 'unconfirmed'
 if fingerprint!='unconfirmed' and (len(fingerprint)!=64 or any(c not in '0123456789abcdef' for c in fingerprint)):raise ValueError('backup-source-fingerprint-invalid')
 if req['origin']!='automatic' and disposition=='business-backup' and fingerprint!='unconfirmed' and (not req.get('lineageAttestation') or not req.get('attestedBy')):raise ValueError('historical-source-lineage-needs-explicit-owner-attestation')
 state['files'][p]={**q,'path':p,'instanceId':req['instanceId'],'projectId':req['projectId'],'serviceId':req['serviceId'],'origin':req['origin'],'createdAt':min(now,q['signature'][3]//1000000,req.get('recoveryPointAt',now)),'verifiedAt':now,'disposition':disposition,'attestedBy':req.get('attestedBy'),'dispositionReason':req.get('dispositionReason'),'lineageAttestation':req.get('lineageAttestation'),'sourceFingerprint':fingerprint,'recoveryVerified':req['origin']=='automatic' and req.get('sourceComplete') is True and fingerprint!='unconfirmed','producerIntegrity':integrity if inherited_integrity else None}
 save();print(json.dumps({'registered':True,'receipt':state['files'][p]}));sys.exit(0)
if action not in ['preview','reconcile']:raise ValueError('unsupported-retention-action')
out={'maxAgeDays':15,'scanStatus':'complete','candidates':[],'held':[],'removed':[],'failed':[],'pending':[],'unknown':[],'policyConflicts':[],'filesystems':[]}
def hold(p,reason):out['held'].append({'path':p,'reason':reason})
active={key(v['projectId'],v['serviceId']) for v in req.get('activeServices',[])}
try:mount_references=backup_mount_references();mount_query_error=False
except Exception:
 mount_references=[];mount_query_error=True;out['scanStatus']='partial';out['unknown'].append({'path':str(req['directories'][0]),'reason':'container-or-stopped-container-references-unconfirmed'})
def backup_is_mounted(p):
 location=pathlib.Path(p);identities=[]
 for part in [location,*location.parents]:
  s=part.stat();identities.append([s.st_dev,s.st_ino])
 return any(item.get('identity') in identities or (item.get('path') and (pathlib.Path(item['path'])==location or pathlib.Path(item['path']) in location.parents)) for item in mount_references)
def actual_location(row):
 retiring=row.get('retiringPath')
 return retiring if retiring and os.path.lexists(retiring) else row['path']
leases={k for k,v in state['leases'].items() if v['until']>now}
rows=[];before={};parents={};known_paths=set(state['files']);absent=[]
for name in req['directories']:
 try:
  parent,identity=directory(name);parents[str(parent)]=identity
  fs=os.statvfs(parent);before[os.stat(parent).st_dev]={'path':str(parent),'availableBefore':fs.f_bavail*fs.f_frsize}
  entries=list(parent.iterdir())
  if len(entries)>5000:raise ValueError('backup-inventory-budget-exceeded')
  for p in entries:
   check()
   if p.name=='.cds-retention':continue
   if not p.is_symlink() and p.is_dir() and str(p) in req['directories']:continue
   if p.name.startswith('.retiring-') and str(p) in {r.get('retiringPath') for r in [*state['files'].values(),*state['outputs'].values()]}:continue
   if p.name=='.tmp' and not p.is_symlink() and p.is_dir():
    for child in p.iterdir():
     if child.is_symlink() or not child.is_dir():out['unknown'].append({'path':str(child),'reason':'incomplete-outputs-need-writer-identity-and-retirement'});continue
     known={r['path'] for r in state['outputs'].values() if pathlib.Path(r['path']).parent==child}
     if not known or any(str(entry) not in known for entry in child.iterdir()):out['unknown'].append({'path':str(child),'reason':'incomplete-outputs-need-writer-identity-and-retirement'})
    continue
   if str(p) not in known_paths:out['unknown'].append({'path':str(p),'reason':'backup-ownership-not-registered'})
 except FileNotFoundError:continue
 except Exception as e:out['scanStatus']='partial';out['unknown'].append({'path':name,'reason':str(e)})
for p,row in state['files'].items():
 try:
  check()
  if row.get('instanceId')!=req['instanceId']:hold(p,'foreign-instance-owner');continue
  parent=pathlib.Path(p).parent
  if str(parent) not in parents:hold(p,'directory-not-in-current-inventory');continue
  physical=row.get('retiringPath',p)
  if row.get('path')!=p:raise ValueError('catalog-file-identity-unconfirmed')
  if physical!=p:
   retired=pathlib.Path(physical)
   if retired.parent!=parent or not retired.name.startswith('.retiring-') or len(retired.name)!=42:raise ValueError('retirement-location-unconfirmed')
   if not os.path.lexists(physical) and os.path.lexists(p):physical=p
  seen=proof(physical)
  if seen['signature']!=row['signature']:raise ValueError('file-identity-changed')
  if row.get('disposition','business-backup')!='reproducible-artifact' and not row.get('recoveryVerified') and not (row.get('sourceFingerprint') not in [None,'unconfirmed'] and row.get('lineageAttestation') and row.get('attestedBy')):out['unknown'].append({'path':p,'reason':'backup-replacement-proof-unconfirmed'})
  rows.append(row)
 except FileNotFoundError:
  if action=='reconcile' and row.get('retiringPath') and not os.path.lexists(p) and not os.path.lexists(row['retiringPath']):
   state.setdefault('retired',[]).append({'path':p,'sha256':row['sha256'],'at':now,'reconciledAbsent':True});state['retired']=state['retired'][-2000:];absent.append(p)
  hold(p,'registered-file-absent')
 except Exception as e:hold(p,str(e));out['scanStatus']='partial'
for p in absent:del state['files'][p]
if absent:save()
groups={}
def lineage(row):return json.dumps([row['projectId'],row['serviceId'],row.get('sourceFingerprint','unconfirmed')],separators=(',',':'))
for row in rows:groups.setdefault(lineage(row),[]).append(row)
for owner,values in groups.items():
 values.sort(key=lambda r:r['createdAt'],reverse=True)
 fresh=[r for r in values if now-r['createdAt']<=MAX_AGE and r.get('recoveryVerified') and r.get('disposition','business-backup')=='business-backup']
 for index,row in enumerate(values):
  p=row['path'];age=now-row['createdAt'];expired=age>MAX_AGE
  if mount_query_error:hold(p,'container-or-stopped-container-references-unconfirmed')
  elif backup_is_mounted(actual_location(row)):hold(p,'running-or-stopped-container-mount')
  elif key(row['projectId'],row['serviceId']) in leases:hold(p,'active-backup-or-restore-lease');
  elif expired and any(value['path']==p for value in out['unknown']):
   hold(p,'backup-replacement-proof-unconfirmed');out['policyConflicts'].append({'path':p,'projectId':row['projectId'],'serviceId':row['serviceId'],'reason':'15-day-limit-exceeded-original-source-still-unconfirmed'})
  elif expired and row.get('disposition','business-backup')!='reproducible-artifact' and not fresh:
   hold(p,'policy-conflict-no-fresh-recovery-point');out['policyConflicts'].append({'path':p,'projectId':row['projectId'],'serviceId':row['serviceId'],'reason':'15-day-limit-exceeded-create-and-verify-replacement-before-retirement'})
  elif expired or (index>=7 and len(fresh)>1) or (index>0 and age>14*DAY and len(fresh)>1):out['candidates'].append(row)
  else:hold(p,'within-retention-window-or-required-recovery-point')
for p,row in list(state['outputs'].items()):
 try:
  check()
  target=row.get('promotionTarget')
  if target and not os.path.lexists(p) and os.path.lexists(target):
   if str(pathlib.Path(target).parent) not in req['directories'] or list(directory(pathlib.Path(target).parent)[1])!=row.get('promotionParentIdentity'):raise ValueError('promoted-output-directory-replaced')
   complete=state['files'].get(target)
   if file_birth_identity(target)!=row.get('birthIdentity'):raise ValueError('promoted-output-identity-changed')
   if complete and complete['projectId']==row['projectId'] and complete['serviceId']==row['serviceId'] and proof(target)['signature']==complete['signature']:
    if action=='reconcile':del state['outputs'][p];save()
   else:out['unknown'].append({'path':target,'reason':'promoted-backup-awaits-owner-registration'});hold(target,'promoted-backup-awaits-owner-registration')
   continue
  parent,parent_identity=directory(pathlib.Path(p).parent)
  if row['instanceId']!=req['instanceId']:hold(p,'foreign-instance-owner');continue
  if list(parent_identity)!=row['parentIdentity']:raise ValueError('temporary-output-directory-replaced')
  physical=row.get('retiringPath',p)
  if not os.path.lexists(physical) and os.path.lexists(p):physical=p
  if not os.path.lexists(physical):
   # The exporter cannot resume after its bounded command + 24h expiry; unknown births stay held.
   if action=='reconcile' and row['stage']=='created' and (row.get('closedAt') or now-row['createdAt']>DAY) and key(row['projectId'],row['serviceId']) not in leases:del state['outputs'][p];save()
   continue
  q=proof(physical)
  if file_birth_identity(physical)!=row.get('birthIdentity'):raise ValueError('temporary-output-identity-changed')
  row['signature']=q['signature'];row['allocatedBytes']=q['allocatedBytes']
  if mount_query_error:hold(p,'container-or-stopped-container-references-unconfirmed')
  elif backup_is_mounted(physical):hold(p,'running-or-stopped-container-mount')
  elif key(row['projectId'],row['serviceId']) in leases:hold(p,'active-backup-or-restore-lease')
  elif not row.get('closedAt') and now-row['createdAt']<=DAY:hold(p,'temporary-output-within-bounded-writer-window')
  elif q['signature'][2]>0 and row.get('disposition','business-backup')!='reproducible-artifact' and (row.get('sourceFingerprint') in [None,'unconfirmed'] or not any(v.get('recoveryVerified') and now-v['createdAt']<=MAX_AGE for v in groups.get(lineage(row),[]))):
   hold(p,'unfinished-business-backup-needs-verified-replacement');out['policyConflicts'].append({'path':p,'reason':'incomplete-business-data-is-not-disposable-without-a-verified-same-source-backup'})
  else:out['candidates'].append(row)
 except FileNotFoundError:
  if action=='reconcile' and row['stage']=='created' and (row.get('closedAt') or now-row['createdAt']>DAY) and key(row['projectId'],row['serviceId']) not in leases:del state['outputs'][p];save()
  else:hold(p,'temporary-output-birth-or-parent-unconfirmed')
 except Exception as e:hold(p,str(e));out['scanStatus']='partial'
maximum=max(0,min(20,int(req.get('maxRemovals',8))))
ordered=sorted(out['candidates'],key=lambda r:r['path']);cursor=next((i for i,r in enumerate(ordered) if r['path']>state.get('scanAfterPath','')),0)
ordered=ordered[cursor:]+ordered[:cursor];selected=ordered[:maximum]
out['pending']=[r['path'] for r in ordered[maximum:]]
if action=='reconcile':
 def clear_cancel(execution):
  identifier=(execution or {}).get('id','')
  if len(identifier)!=32 or any(c not in '0123456789abcdef' for c in identifier):return
  name='cancel-'+identifier
  try:
   s=os.stat(name,dir_fd=root_fd,follow_symlinks=False)
   if stat.S_ISREG(s.st_mode) and s.st_uid==os.getuid() and s.st_nlink==1:os.unlink(name,dir_fd=root_fd)
  except FileNotFoundError:pass
 previous=state.get('activeExecution')
 if previous:
  try:
   owner=previous.get('owner')
   if not owner or execution_owner(owner['pid'])==owner:
    out['scanStatus']='partial';hold(str(root),'independent-retirement-execution-still-active-or-unconfirmed')
    out['counts']={k:len(out[k]) for k in ['candidates','held','removed','failed','pending','unknown','policyConflicts']};print(json.dumps(out));sys.exit(0)
  except Exception:
   out['scanStatus']='partial';hold(str(root),'retirement-execution-identity-unconfirmed');print(json.dumps(out));sys.exit(0)
 out['previousInterruptedExecution']=previous;clear_cancel(previous)
 identifier=req.get('executionId') or secrets.token_hex(16)
 state['activeExecution']={'id':identifier,'startedAt':now,'owner':execution_owner(os.getpid())};save()
 verified_replacements={}
 for row_index,row in enumerate(selected):
  p=row['path'];parent=pathlib.Path(p).parent;fd=None
  state['scanAfterPath']=p;save()
  try:
   check();owner=key(row['projectId'],row['serviceId'])
   if mount_query_error:hold(p,'container-or-stopped-container-references-unconfirmed');continue
   mount_references=backup_mount_references()
   if backup_is_mounted(actual_location(row)):hold(p,'running-or-stopped-container-mount');continue
   group=lineage(row)
   if row.get('disposition','business-backup')!='reproducible-artifact' and (row.get('kind')!='temporary-output' or row['signature'][2]>0):
    if group not in verified_replacements:
     valid=False
     for replacement in groups.get(group,[]):
      if replacement['path']==p or now-replacement['createdAt']>MAX_AGE or not replacement.get('recoveryVerified'):continue
      try:
       candidate=unlocked_proof(replacement['path'],'hash')
       latest=state['files'].get(replacement['path'])
       if latest and candidate['signature']==latest['signature']==replacement['signature'] and candidate['sha256']==latest['sha256']==replacement['sha256'] and proof(replacement['path'])['signature']==candidate['signature']:valid=True;break
      except Exception:continue
     verified_replacements[group]=valid
    if not verified_replacements[group]:
     hold(p,'policy-conflict-no-verified-replacement');out['policyConflicts'].append({'path':p,'reason':'create-and-verify-fresh-recovery-point'});continue
   physical=row.get('retiringPath',p)
   if not os.path.lexists(physical) and os.path.lexists(p):physical=p
   q=proof(physical) if row.get('kind')=='temporary-output' else unlocked_proof(physical,'hash')
   latest=state['outputs' if row.get('kind')=='temporary-output' else 'files'].get(p)
   if not latest or latest.get('signature')!=row['signature'] or latest.get('sha256')!=row.get('sha256'):raise ValueError('catalog-object-changed-during-verification')
   row=latest
   clock_now=req.get('nowMs',int(time.time()*1000))
   if state['leases'].get(owner,{}).get('until',0)>clock_now:hold(p,'active-backup-or-restore-lease');continue
   if q['signature']!=row['signature'] or (row.get('kind')!='temporary-output' and q['sha256']!=row['sha256']):raise ValueError('identity-or-content-changed')
   if tuple(q['signature'][:2]) in live_files():hold(p,'file-still-open');continue
   mount_references=backup_mount_references()
   if backup_is_mounted(physical):hold(p,'running-or-stopped-container-mount');continue
   expected_parent=tuple(row['parentIdentity']) if row.get('kind')=='temporary-output' else parents[str(parent)]
   if directory(parent)[1]!=expected_parent:raise ValueError('parent-directory-replaced')
   fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
   if (os.fstat(fd).st_dev,os.fstat(fd).st_ino)!=expected_parent:raise ValueError('parent-directory-replaced')
   if signature(os.stat(pathlib.Path(physical).name,dir_fd=fd,follow_symlinks=False))!=row['signature']:raise ValueError('file-replaced-before-removal')
   # Move under the same pinned parent, then recheck the exact moved inode.
   quarantine=pathlib.Path(row['retiringPath']).name if row.get('retiringPath') else '.retiring-'+secrets.token_hex(16)
   if physical==p:
    row['retiringPath']=str(parent/quarantine);save()
    os.rename(pathlib.Path(p).name,quarantine,src_dir_fd=fd,dst_dir_fd=fd)
   if signature(os.stat(quarantine,dir_fd=fd,follow_symlinks=False))!=row['signature']:raise ValueError('retirement-identity-unconfirmed')
   # A bind may have appeared while hashing or renaming. Once quarantined, new
   # users of the original name cannot acquire this inode. Keep on any doubt.
   mount_references=backup_mount_references()
   if backup_is_mounted(parent/quarantine):hold(p,'running-or-stopped-container-mount');continue
   if tuple(q['signature'][:2]) in live_files():hold(p,'file-still-open');continue
   os.unlink(quarantine,dir_fd=fd);os.fsync(fd);del state['outputs' if row.get('kind')=='temporary-output' else 'files'][p]
   state.setdefault('retired',[]).append({'path':p,'sha256':row.get('sha256'),'at':now});state['retired']=state['retired'][-2000:]
   save();out['removed'].append(p)
   if row.get('kind')=='temporary-output' and list(directory(parent)[1])==row['parentIdentity']:
    try:os.rmdir(parent)
    except OSError:pass
  except (InterruptedError,TimeoutError) as e:
   out['pending'].extend(r['path'] for r in selected[row_index:]);out['stopReason']=str(e);out['scanStatus']='partial';break
  except Exception as e:
   if str(e)=='inspection-budget-exceeded':
    out['pending'].extend(r['path'] for r in selected[row_index:]);out['stopReason']=str(e);out['scanStatus']='partial';break
   out['failed'].append({'path':p,'reason':str(e)});out['scanStatus']='partial'
  finally:
   if fd is not None:os.close(fd)
 state.pop('activeExecution',None);save();clear_cancel({'id':identifier})
for dev,row in before.items():
 try:
  p,identity=directory(row['path'])
  if identity!=parents[str(p)] or os.stat(p).st_dev!=dev:raise ValueError('measurement-filesystem-changed')
  fs=os.statvfs(p);row['availableAfter']=fs.f_bavail*fs.f_frsize;row['netAvailableBytesDelta']=row['availableAfter']-row['availableBefore']
 except Exception as e:row['availableAfter']=None;row['netAvailableBytesDelta']=None;row['error']=str(e);out['scanStatus']='partial'
 out['filesystems'].append(row)
if out['unknown'] or out['policyConflicts'] or out['pending']:out['scanStatus']='partial'
out['counts']={k:len(out[k]) for k in ['candidates','held','removed','failed','pending','unknown','policyConflicts']}
print(json.dumps(out,separators=(',',':')))
