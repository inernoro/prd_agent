import { DISK_RESOURCE_NATIVE } from './disk-resource-native.js';

/** Host image-ID receipts and cross-master pins. Never accesses Docker layer directories. */
export const IMAGE_CACHE_PROGRAM = DISK_RESOURCE_NATIVE + String.raw`
import datetime,http.client,socket,subprocess
root_fd=None;root=pathlib.Path(req['catalog'])
if req['action']=='cancel':
 root,_=directory(root);identifier=req.get('executionId','')
 if len(identifier)!=32 or any(c not in '0123456789abcdef' for c in identifier):raise ValueError('execution-identity-invalid')
 parent=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 fd=os.open('cancel-'+identifier,os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600,dir_fd=parent);s=os.fstat(fd)
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or s.st_nlink!=1:raise ValueError('cancel-identity-unconfirmed')
 os.fsync(fd);os.close(fd);os.close(parent);print(json.dumps({'stopRequested':True}));sys.exit(0)
try:
 root,root_identity=directory(root,req['action']!='preview')
 if root.stat().st_uid!=os.getuid() or root.stat().st_mode&0o077:raise ValueError('cache-catalog-owner-unconfirmed')
 root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 lock=os.open('images.lock',(os.O_RDONLY if req['action']=='preview' else os.O_RDWR|os.O_CREAT)|os.O_NOFOLLOW,0o600,dir_fd=root_fd)
 try:
  if req['action']!='preview':fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError:print(json.dumps({'scanStatus':'partial','catalogError':'catalog-busy','usageBytes':None}));sys.exit(3)
except FileNotFoundError:
 if req['action']!='preview':raise
 if not root.is_absolute() or root.resolve()!=root:raise ValueError('cache-catalog-alias')
state={'schema':1,'masters':{},'images':{},'pulls':{},'retired':[]}
try:
 if root_fd is None:raise FileNotFoundError()
 fd=os.open('images.json',os.O_RDONLY|os.O_NOFOLLOW,dir_fd=root_fd)
 with os.fdopen(fd) as f:state=json.load(f)
except FileNotFoundError:pass
if state.get('schema')!=1:raise ValueError('cache-schema-unconfirmed')
action=req['action'];now=req.get('nowMs',int(time.time()*1000));instance=req['instanceId']
def save():
 if directory(root)[1]!=root_identity:raise ValueError('catalog-replaced')
 name='image-write-'+secrets.token_hex(8);fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=root_fd)
 with os.fdopen(fd,'w') as f:json.dump(state,f,separators=(',',':'));f.flush();os.fsync(f.fileno())
 os.replace(name,'images.json',src_dir_fd=root_fd,dst_dir_fd=root_fd);os.fsync(root_fd)
def preview_unavailable(reason):
 if action!='preview':raise ValueError(reason)
 print(json.dumps({'scanStatus':'partial','catalogError':reason,'budgetBytes':req.get('budgetBytes',0),'imageBytesEstimate':None,'protectedBytesEstimate':None,'canExecute':False,'counts':{'candidates':None,'held':None,'unknown':None,'pending':None},'unknown':[{'reason':reason}]}));sys.exit(0)
def docker(args,seconds=8):
 if time.monotonic()>deadline:preview_unavailable('inspection-budget-exceeded')
 check()
 try:p=subprocess.run(['docker',*args],capture_output=True,text=True,timeout=max(.1,min(seconds,deadline-time.monotonic())))
 except subprocess.TimeoutExpired:preview_unavailable('docker-query-timeout')
 except OSError:preview_unavailable('docker-query-unavailable')
 if p.returncode:preview_unavailable('docker-query-or-operation-unconfirmed')
 return p.stdout
info=json.loads(docker(['info','--format','{{json .}}']))
if state.get('daemonId') and state['daemonId']!=info['ID']:raise ValueError('daemon-identity-changed')
state['daemonId']=info['ID']

class DockerUnixConnection(http.client.HTTPConnection):
 def connect(self):
  self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
  self.sock.settimeout(self.timeout)
  self.sock.connect(self.unix_path)

def local_docker_json(socket_path,endpoint):
 check()
 conn=DockerUnixConnection('localhost',timeout=max(.1,min(20,deadline-time.monotonic())))
 conn.unix_path=socket_path
 try:
  conn.request('GET',endpoint)
  response=conn.getresponse()
  if response.status!=200:raise ValueError('docker-api-response-unconfirmed')
  data=response.read(16*1024**2+1)
  if len(data)>16*1024**2:raise ValueError('docker-api-inventory-too-large')
  return json.loads(data)
 finally:conn.close()

def matched_local_docker_socket():
 target=os.environ.get('DOCKER_HOST') or 'unix:///var/run/docker.sock'
 if not target.startswith('unix:///'):return None
 socket_path=target[len('unix://'):]
 if not os.path.exists(socket_path):return None
 try:
  observed=local_docker_json(socket_path,'/info')
  if observed.get('ID')==info['ID'] and observed.get('DockerRootDir')==info['DockerRootDir']:return socket_path
 except (OSError,ValueError,http.client.HTTPException):pass
 return None

local_socket=matched_local_docker_socket()
def docker_summary(endpoint):
 try:
  rows=local_docker_json(local_socket,endpoint)
  if not isinstance(rows,list) or len(rows)>5000 or any(not isinstance(row,dict) for row in rows):
   raise ValueError('docker-api-inventory-unconfirmed')
  if len({row.get('Id') for row in rows})!=len(rows):raise ValueError('docker-api-duplicate-id')
  return rows
 except (OSError,ValueError,http.client.HTTPException):preview_unavailable('docker-api-inventory-unconfirmed')

def created_second(value):
 if isinstance(value,int):return value
 try:
  stamp=datetime.datetime.fromisoformat(value)
  return int(stamp.timestamp()) if stamp.tzinfo else None
 except (ValueError,TypeError,OverflowError):return None

def same_created(left,right):
 a,b=created_second(left),created_second(right)
 return a is not None and a==b

def image_content_size(row):
 # Containerd's summary Size includes unpacked snapshots. The existing
 # admission budget uses image inspect Size (compressed content).
 manifests=[item for item in row.get('Manifests') or [] if item.get('Kind')=='image' and item.get('Available')]
 if len(manifests)==1:
  content=(manifests[0].get('Size') or {}).get('Content')
  if type(content) is int and content>=0:return content
 containerd_store=any(flag==['driver-type','io.containerd.snapshotter.v1'] for flag in info.get('DriverStatus') or [])
 if containerd_store:
  inspected=json.loads(docker(['image','inspect',row['Id']]))
  if len(inspected)!=1 or inspected[0].get('Id')!=row['Id'] or type(inspected[0].get('Size')) is not int or inspected[0]['Size']<0:
   preview_unavailable('docker-api-content-size-unconfirmed')
  return inspected[0]['Size']
 return row['Size']

def images():
 if local_socket:
  rows=docker_summary('/images/json?all=1&digests=1&manifests=1')
  for row in rows:
   if not isinstance(row.get('Id'),str) or not row['Id'].startswith('sha256:') or type(row.get('Size')) is not int or row['Size']<0 or type(row.get('Created')) is not int:
    preview_unavailable('docker-api-image-summary-unconfirmed')
   row['Created']=datetime.datetime.fromtimestamp(row['Created'],datetime.timezone.utc).isoformat().replace('+00:00','Z')
   row['Size']=image_content_size(row)
   row['RepoTags']=[tag for tag in row.get('RepoTags') or [] if tag!='<none>:<none>']
   row['RepoDigests']=[ref for ref in row.get('RepoDigests') or [] if ref!='<none>@<none>']
   row['Config']={'Labels':row.get('Labels') or {}}
  return rows
 ids=sorted(set(docker(['image','ls','-aq','--no-trunc']).splitlines()))
 if len(ids)>5000:raise ValueError('image-inventory-budget')
 rows=[]
 for offset in range(0,len(ids),100):rows+=json.loads(docker(['image','inspect',*ids[offset:offset+100]]))
 if len(rows)!=len(ids) or sorted(r['Id'] for r in rows)!=ids or ids!=sorted(set(docker(['image','ls','-aq','--no-trunc']).splitlines())):raise ValueError('image-inventory-incomplete-or-changed')
 return rows
def refs(row):return [row['Id'],*(row.get('RepoTags') or []),*(row.get('RepoDigests') or [])]
def repository(reference):
 value=reference.split('@',1)[0]
 return value[:value.rfind(':')] if value.rfind(':')>value.rfind('/') else value
def reference_key(reference):
 # Docker resolves name:tag@digest by the digest; its inventory lists name@digest.
 if not isinstance(reference,str) or '@sha256:' not in reference:return reference
 name,digest=reference.rsplit('@',1)
 return repository(name)+'@'+digest
def containers():
 if local_socket:
  rows=docker_summary('/containers/json?all=1')
  for row in rows:
   if not isinstance(row.get('Id'),str) or not isinstance(row.get('ImageID'),str) or not row['ImageID'].startswith('sha256:'):
    preview_unavailable('docker-api-container-reference-unconfirmed')
   row['Image']=row['ImageID'];row['Name']=(row.get('Names') or [None])[0]
   row['Config']={'Labels':row.get('Labels') or {}}
   row['State']={'Running':row.get('State') in ('running','restarting','paused')}
  return rows
 ids=sorted(set(docker(['ps','-aq','--no-trunc']).splitlines()));rows=[]
 for offset in range(0,len(ids),100):rows+=json.loads(docker(['inspect',*ids[offset:offset+100]]))
 if len(rows)!=len(ids) or ids!=sorted(set(docker(['ps','-aq','--no-trunc']).splitlines())):raise ValueError('container-reference-inventory-incomplete')
 return rows
if action=='publish':
 # Offline masters keep their last pins. A timeout is never proof their rollback anchors are disposable.
 state['masters'][instance]={'references':list(set(req['references'])),'updatedAt':now}
 # Clear only this master's acknowledged pulls after its current + persisted in-flight pins were published.
 for token,pull in list(state['pulls'].items()):
  if pull['instanceId']==instance and pull.get('confirmed') and now-pull['createdAt']>600000:del state['pulls'][token]
 save();print(json.dumps({'published':True}));sys.exit(0)
rows=images();by_ref={reference_key(value):row for row in rows for value in refs(row)}
if action=='prepare':
 image=req['image'];present=by_ref.get(reference_key(image));budget=req.get('budgetBytes',0)
 if req.get('requirePresent') and not present:print(json.dumps({'absent':True}));sys.exit(0)
 if sum(not p.get('confirmed') for p in state['pulls'].values())>=32:raise ValueError('unsettled-image-pull-budget-reached')
 foreign=set(state.get('seenForeignIds',[]))&{r['Id'] for r in rows}
 starting={reference_key(p['image']) for p in state['pulls'].values() if not p.get('beforeId')}
 for row in rows:
  if row['Id'] not in state['images'] and not any(reference_key(value) in starting for value in refs(row)):foreign.add(row['Id'])
 state['seenForeignIds']=sorted(foreign)
 reserved=sum(p.get('reserveBytes',0) for p in state['pulls'].values() if not p.get('confirmed'))
 peak=req.get('peakBytes',4*1024**3) if not present or req.get('forceNew') else 0
 if peak and budget and sum(r['Size'] for r in rows)+reserved+peak>budget:raise ValueError('host-image-cache-budget-exceeded')
 token=secrets.token_hex(16);state['pulls'][token]={'image':image,'instanceId':instance,'createdAt':now,'beforeId':present['Id'] if present else None,'reserveBytes':peak};save()
 print(json.dumps({'token':token,'alreadyPresent':bool(present)}));sys.exit(0)
if action=='confirm':
 pull=state['pulls'].get(req['token'])
 if not pull or pull['instanceId']!=instance:raise ValueError('pull-owner-unconfirmed')
 row=by_ref.get(reference_key(pull['image']))
 if not row:raise ValueError('pulled-identity-unconfirmed')
 if row['Id']!=pull['beforeId'] and row['Id'] not in state.get('seenForeignIds',[]):
  previous=state['images'].get(row['Id'])
  if not previous:state['images'][row['Id']]={'id':row['Id'],'created':row['Created'],'instanceId':instance,'digests':[d for d in row.get('RepoDigests') or [] if repository(d)==repository(pull['image'])],'aliases':[tag for tag in row.get('RepoTags') or [] if tag==pull['image']],'bornAt':now}
 receipt=state['images'].get(row['Id'])
 if receipt and same_created(receipt['created'],row['Created']) and set(row.get('RepoTags') or [])-set(receipt.get('aliases',[]))<={pull['image']}:
  # A confirmed native pull can claim its own added alias, never an unrelated tag.
  receipt['aliases']=sorted(set(receipt.get('aliases',[]))|set(row.get('RepoTags') or []))
  receipt['digests']=sorted(set(receipt.get('digests',[]))|{d for d in row.get('RepoDigests') or [] if repository(d)==repository(pull['image'])})
 pull['confirmed']=True;pull['identity']=row['Id'];save();print(json.dumps({'confirmed':True}));sys.exit(0)
if action=='abort':
 pull=state['pulls'].get(req['token'])
 if not pull or pull['instanceId']!=instance:raise ValueError('pull-owner-unconfirmed')
 row=by_ref.get(reference_key(pull['image']))
 if row and (row['Id']!=pull.get('beforeId') or not req.get('completedNativeOperation')):raise ValueError('failed-pull-created-an-image-needs-confirmation')
 del state['pulls'][req['token']];save();print(json.dumps({'settled':True}));sys.exit(0)
if action not in ['preview','reconcile','adopt']:raise ValueError('cache-action-unsupported')
refs_now=containers();in_use={r['Image'] for r in refs_now};protected={reference_key(ref) for ref in req.get('references',[])}
reference_sources={}
for master,pins in state['masters'].items():
 for ref in pins['references']:
  reference_sources.setdefault(reference_key(ref),[]).append({'kind':'master-ledger-current-rollback-or-inflight','instanceId':master,'reference':ref})
for pull in state['pulls'].values():
 ref=reference_key(pull['image']);keys={ref,pull.get('identity') or ref}
 for key in keys:
  reference_sources.setdefault(key,[]).append({'kind':'pending-artifact','instanceId':pull['instanceId'],'reference':pull['image']})
protected.update(reference_sources)
foreign_masters={((r.get('Config') or {}).get('Labels') or {}).get('cds.instance') for r in refs_now}-set(state['masters'])-{None,'',instance}
out={'scanStatus':'complete','daemonId':state['daemonId'],'platform':{'os':info.get('OSType'),'architecture':{'x86_64':'amd64','aarch64':'arm64'}.get(info.get('Architecture'),info.get('Architecture'))},'budgetBytes':req.get('budgetBytes',0),'imageBytesEstimate':sum(r['Size'] for r in rows),'protectedBytesEstimate':0,'candidates':[],'held':[],'removed':[],'failed':[],'pending':[],'unknown':[],'measurement':'unique-image-logical-size-is-a-conservative-budget-not-released-bytes'}
out['pullReservations']=[{'identity':'pull:'+hashlib.sha256(token.encode()).hexdigest()[:16],'image':pull['image'],'instanceId':pull['instanceId'],'createdAt':pull['createdAt'],'confirmed':bool(pull.get('confirmed')),'reservedBytesEstimate':pull.get('reserveBytes',0),'reason':'awaiting-current-and-inflight-reference-publication' if pull.get('confirmed') else 'native-pull-result-unconfirmed'} for token,pull in state['pulls'].items()]
out['unknown'].extend({'identity':pull['identity'],'reason':pull['reason']} for pull in out['pullReservations'] if not pull['confirmed'])
for row in rows:
 identity=row['Id'];receipt=state['images'].get(identity);reason=None
 keys=list(dict.fromkeys(reference_key(value) for value in refs(row)))
 sources=[{'kind':'running-container' if (v.get('State') or {}).get('Running') else 'stopped-container','identity':v['Id'],'name':v.get('Name')} for v in refs_now if v.get('Image')==identity]
 for key in keys:
  for source in reference_sources.get(key,[]):
   if source not in sources:sources.append(source)
 ownership={'instanceId':receipt.get('instanceId'),'projectId':receipt.get('ownerProject'),'source':'explicit-owner-adoption' if receipt.get('adoptedAt') else 'platform-native-birth'} if receipt else None
 if identity in in_use:reason='running-or-stopped-container-reference'
 elif any(value in protected for value in keys):reason='current-rollback-or-inflight-reference'
 elif ((row.get('Config') or {}).get('Labels') or {}).get('cds.protected')=='true':reason='explicit-protection'
 elif foreign_masters:reason='other-master-has-not-published-rollback-pins'
 elif not receipt:reason='legacy-image-ownership-needs-review'
 elif not same_created(receipt['created'],row['Created']):reason='image-birth-identity-changed'
 elif not receipt['digests'] or (not receipt.get('retiring') and not set(receipt['digests'])&set(row.get('RepoDigests') or [])):reason='registry-recovery-reference-unconfirmed'
 elif any(tag not in receipt.get('aliases',[]) for tag in row.get('RepoTags') or []):reason='foreign-alias-needs-review'
 elif any(digest not in receipt.get('digests',[]) for digest in row.get('RepoDigests') or []):reason='foreign-alias-needs-review'
 if reason:
  out['held'].append({'identity':identity,'reason':reason,'aliases':row.get('RepoTags') or [],'created':row['Created'],'digests':row.get('RepoDigests') or [],'ownership':ownership,'referenceSources':sources[:100],'referenceSourceCount':len(sources)});out['protectedBytesEstimate']+=row['Size']
  if reason in ['legacy-image-ownership-needs-review','other-master-has-not-published-rollback-pins','image-birth-identity-changed','foreign-alias-needs-review']:out['unknown'].append({'identity':identity,'reason':reason})
 else:out['candidates'].append({'identity':identity,'aliases':row.get('RepoTags') or [],'digests':row.get('RepoDigests') or [],'recoveryDigests':receipt['digests'],'sizeBytesEstimate':row['Size'],'ownership':ownership,'referenceSources':sources[:100],'referenceSourceCount':len(sources)})
point,_=directory(info['DockerRootDir']);before=os.statvfs(point);out['filesystem']={'path':str(point),'availableBefore':before.f_bavail*before.f_frsize}
maximum=max(0,min(8,int(req.get('maxRemovals',2))))
ordered=sorted(out['candidates'],key=lambda v:v['identity']);cursor=next((i for i,v in enumerate(ordered) if v['identity']>state.get('scanAfterImage','')),0)
ordered=ordered[cursor:]+ordered[:cursor];out['nextBatch']=ordered[:maximum]

def registry_manifest(reference):
 evidence=req.get('registryProofs',{}).get(reference)
 if not evidence or not 0<=int(time.time()*1000)-evidence.get('verifiedAt',0)<=60000:raise ValueError('registry-proof-missing-or-stale')
 return evidence['manifest']
def verify_registry(row,digest):
 requested_digest=digest.rsplit('@',1)[-1]
 manifest_digest=requested_digest
 manifest=registry_manifest(digest)
 index_types={'application/vnd.oci.image.index.v1+json','application/vnd.docker.distribution.manifest.list.v2+json'}
 manifest_types={'application/vnd.oci.image.manifest.v1+json','application/vnd.docker.distribution.manifest.v2+json'}
 root_type=manifest.get('mediaType')
 if isinstance(manifest.get('manifests'),list):
  architecture={'x86_64':'amd64','aarch64':'arm64'}.get(info.get('Architecture'),info.get('Architecture'))
  choices=[v for v in manifest['manifests'] if (v.get('platform') or {}).get('os')==row.get('Os') and (v.get('platform') or {}).get('architecture')==architecture and ((v.get('platform') or {}).get('variant') or '')==(row.get('Variant') or '')]
  if len(choices)!=1:raise ValueError('registry-platform-recovery-unconfirmed')
  manifest_digest=choices[0]['digest']
  manifest=registry_manifest(digest.split('@',1)[0]+'@'+manifest_digest)
 if (manifest.get('config') or {}).get('digest')==row['Id']:return
 # The containerd image store can expose the manifest or index digest as
 # Id. Bind it to Docker's local descriptor and immutable repository digest.
 descriptor=row.get('Descriptor') or {}
 media_type=descriptor.get('mediaType')
 identity=descriptor.get('digest')
 if digest in (row.get('RepoDigests') or []) and identity==row['Id'] and manifest.get('schemaVersion')==2 and isinstance(manifest.get('layers'),list) and manifest['layers']:
  if media_type in manifest_types and media_type==manifest.get('mediaType') and identity==manifest_digest:return
  if media_type in index_types and media_type==root_type and identity==requested_digest and manifest_digest!=requested_digest:return
 raise ValueError('registry-rehydration-identity-unconfirmed')

if action=='adopt':
 identity=req.get('identity','');row=by_ref.get(identity)
 if not row or row['Id']!=identity:raise ValueError('adoption-image-identity-unconfirmed')
 if req.get('dataDisposition')!='reproducible-artifact' or not req.get('attestedBy') or not req.get('projectId') or not req.get('ownershipEvidence'):raise ValueError('explicit-build-artifact-ownership-required')
 if not same_created(row['Created'],req.get('created')) or sorted(row.get('RepoTags') or [])!=sorted(req.get('aliases',[])) or sorted(row.get('RepoDigests') or [])!=sorted(req.get('digests',[])):raise ValueError('adoption-plan-identity-or-alias-changed')
 digests=row.get('RepoDigests') or []
 if not digests:raise ValueError('immutable-registry-recovery-reference-unconfirmed')
 # Use the current per-ID inspection for platform descriptors not present
 # in the list response, with an exact check against the planned aliases.
 full=json.loads(docker(['image','inspect',identity]))[0]
 if full.get('Id')!=identity or not same_created(full.get('Created'),row['Created']) or set(refs(full))!=set(refs(row)):
  raise ValueError('adoption-plan-identity-or-alias-changed')
 verify_registry(full,digests[0])
 if identity in state['images']:print(json.dumps({'registered':True,'alreadyRegistered':True}));sys.exit(0)
 state['images'][identity]={'id':identity,'created':row['Created'],'instanceId':instance,'digests':digests,'aliases':row.get('RepoTags') or [],'bornAt':now,'adoptedAt':now,'ownerProject':req['projectId'],'attestedBy':req['attestedBy'],'ownershipEvidence':req['ownershipEvidence'],'dataDisposition':'reproducible-artifact','registryAuditId':req.get('registryAuditId')}
 state['seenForeignIds']=[value for value in state.get('seenForeignIds',[]) if value!=identity]
 save();print(json.dumps({'registered':True,'identity':identity,'deletionAuthorized':False}));sys.exit(0)
if action=='reconcile':
 selected=[v for v in ordered if v['identity'] in req.get('targetIdentities',[])][:maximum]
 if req.get('attemptedIdentities'):state['scanAfterImage']=req['attemptedIdentities'][-1];save()
 for index,item in enumerate(selected):
  if not req.get('attemptedIdentities'):state['scanAfterImage']=item['identity'];save()
  try:
   check();identity=item['identity'];row=json.loads(docker(['image','inspect',identity]))[0]
   if row['Id']!=identity or set(row.get('RepoTags') or [])!=set(item['aliases']) or set(row.get('RepoDigests') or [])!=set(item['digests']):raise ValueError('image-alias-or-identity-changed')
   if ((row.get('Config') or {}).get('Labels') or {}).get('cds.protected')=='true':raise ValueError('explicit-protection')
   # Verify the exact registry config digest, never merely that a tag exists. Multi-platform ambiguity is held.
   verify_registry(row,item['recoveryDigests'][0])
   state['images'][identity]['retiring']=True;save()
   for alias in item['aliases']:
    if any(v['Image']==identity for v in containers()):raise ValueError('latest-running-or-stopped-reference')
    latest=json.loads(docker(['image','inspect',alias]))[0]
    if latest['Id']!=identity:raise ValueError('alias-was-retargeted')
    docker(['image','rm','--no-prune',alias])
   if not item['aliases']:
    if any(v['Image']==identity for v in containers()):raise ValueError('latest-running-or-stopped-reference')
    docker(['image','rm','--no-prune',identity])
   remaining=set(docker(['image','ls','-aq','--no-trunc']).splitlines())
   if identity in remaining:raise ValueError('image-retirement-still-pending')
   del state['images'][identity];state['retired'].append({'id':identity,'at':now,'registryAuditId':req.get('registryAuditId')});state['retired']=state['retired'][-1000:];save();out['removed'].append(identity)
  except Exception as e:
   if str(e) in ['cancelled','inspection-budget-exceeded']:
    out['pending'].extend(v['identity'] for v in selected[index:]);out['stopReason']=str(e);out['scanStatus']='partial';break
   out['failed'].append({'identity':item['identity'],'reason':str(e)});out['scanStatus']='partial'
 out['pending'].extend(v['identity'] for v in ordered if v['identity'] not in {item['identity'] for item in selected})
after=os.statvfs(point);out['filesystem'].update({'availableAfter':after.f_bavail*after.f_frsize,'netAvailableBytesDelta':(after.f_bavail-before.f_bavail)*after.f_frsize})
for identity in list(state['images']):
 if identity not in {r['Id'] for r in rows}:del state['images'][identity]
if action=='reconcile':save()
if action=='reconcile' and req.get('executionId'):
 try:os.unlink('cancel-'+req['executionId'],dir_fd=root_fd)
 except FileNotFoundError:pass
if out['unknown'] or out['pending']:out['scanStatus']='partial'
out['capacityGapEstimate']=max(0,out['protectedBytesEstimate']-req.get('budgetBytes',0)) if req.get('budgetBytes') else None
out['counts']={key:len(out[key]) for key in ['candidates','held','removed','failed','pending','unknown']}
print(json.dumps(out,separators=(',',':')))
`;
