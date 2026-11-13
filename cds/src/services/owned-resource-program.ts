import { DISK_RESOURCE_NATIVE } from './disk-resource-native.js';

/** Fixed native protocol for explicitly ephemeral acceptance resources. No arbitrary commands. */
export const OWNED_RESOURCE_PROGRAM = DISK_RESOURCE_NATIVE + String.raw`
import subprocess,signal,socket,re
action=req['action'];now=req.get('nowMs',int(time.time()*1000));instance=req['instanceId']
deadline=time.monotonic()+(120 if action=='reconcile' else 25)
base,base_identity=directory(req['workspaceBase'],action in ['begin','reconcile'])
if base.stat().st_uid!=os.getuid() or base.stat().st_mode&0o077:raise ValueError('workspace-base-owner-unconfirmed')
catalog,catalog_identity=directory(req['catalog'],action!='preview')
if catalog.stat().st_uid!=os.getuid() or catalog.stat().st_mode&0o077:raise ValueError('catalog-owner-unconfirmed')
catalog_fd=os.open(catalog,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
root=catalog
if action=='cancel':
 execution=req.get('executionId','')
 if len(execution)!=32 or any(c not in '0123456789abcdef' for c in execution):raise ValueError('execution-identity-invalid')
 fd=os.open('cancel-'+execution,os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600,dir_fd=catalog_fd)
 s=os.fstat(fd)
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or s.st_nlink!=1:raise ValueError('cancel-file-identity-unconfirmed')
 os.fsync(fd);os.close(fd);print(json.dumps({'stopRequested':True}));sys.exit(0)
lock=os.open('lock',(os.O_RDONLY if action=='preview' else os.O_RDWR|os.O_CREAT)|os.O_NOFOLLOW,0o600,dir_fd=catalog_fd)
try:
 if action!='preview':fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:print(json.dumps({'retryable':'catalog-busy'}));sys.exit(3)
state={'schema':1,'tasks':{},'retired':[]}
try:
 fd=os.open('tasks.json',os.O_RDONLY|os.O_NOFOLLOW,dir_fd=catalog_fd)
 with os.fdopen(fd,'r') as f:state=json.load(f)
except FileNotFoundError:pass
if state.get('schema')!=1:raise ValueError('catalog-schema-unknown')
def save():
 if directory(catalog)[1]!=catalog_identity:raise ValueError('catalog-directory-replaced')
 name='write-'+secrets.token_hex(12);fd=os.open(name,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600,dir_fd=catalog_fd)
 with os.fdopen(fd,'w') as f:json.dump(state,f,separators=(',',':'));f.flush();os.fsync(f.fileno())
 os.replace(name,'tasks.json',src_dir_fd=catalog_fd,dst_dir_fd=catalog_fd);os.fsync(catalog_fd)
def native(args,seconds=8):
 check();p=subprocess.run(args,capture_output=True,text=True,timeout=max(.1,min(seconds,deadline-time.monotonic())))
 return p
def docker(*args):
 p=native(['docker',*args])
 if p.returncode:raise ValueError('docker-reference-query-unconfirmed')
 return p.stdout
class RetirementFailed(ValueError):pass
class RetirementPending(ValueError):pass
def mutate(*args):
 try:p=native(['docker',*args])
 except subprocess.TimeoutExpired:raise RetirementPending('native-retirement-still-unconfirmed')
 if p.returncode:raise RetirementFailed('native-retirement-failed')
 return p.stdout
def daemon():
 value=docker('info','--format','{{.ID}}').strip()
 if not re.fullmatch(r'[A-Za-z0-9:-]{20,128}',value):raise ValueError('daemon-identity-unconfirmed')
 return value
def get(kind,name):
 args=['docker']+([] if kind=='container' else [kind])+['inspect',name]
 p=native(args)
 if p.returncode:
  # Only an exact native absence is absence. Network, permissions and timeout are unknown.
  errors=['Error: No such object: '+name,'Error: No such image: '+name,'Error: No such volume: '+name,'Error: No such network: '+name,'Error response from daemon: No such container: '+name,'Error response from daemon: No such image: '+name,'Error response from daemon: get '+name+': no such volume','Error response from daemon: network '+name+' not found']
  if p.returncode==1 and p.stdout.strip() in ['', '[]'] and p.stderr.strip() in errors:return None
  raise ValueError('resource-inspection-unconfirmed')
 values=json.loads(p.stdout)
 if not isinstance(values,list) or len(values)!=1:raise ValueError('resource-inventory-incomplete')
 return values[0]
def labels(v,kind):return (v.get('Config') or {}).get('Labels') or {} if kind in ['container','image'] else v.get('Labels') or {}
def owned(task,resource,value):
 observed=labels(value,resource['kind'])
 expected={'cds.resource.task':task['id'],'cds.resource.birth':resource['nonce'],'cds.acceptance.owner':task['owner'],'cds.resource.instance':task['instanceId']}
 if any(observed.get(k)!=v for k,v in expected.items()):raise ValueError('resource-owner-or-birth-unconfirmed')
 if observed.get('cds.protected')=='true':raise ValueError('explicitly-protected-resource')
 identity=value.get('Id') if resource['kind']!='volume' else value.get('Name')
 if resource.get('identity') and resource['identity']!=identity:raise ValueError('resource-identity-replaced')
 if resource['kind']=='volume':
  fingerprint={'driver':value.get('Driver'),'options':value.get('Options') or {},'mountpoint':value.get('Mountpoint'),'directoryBirth':directory_birth_identity(value['Mountpoint'])}
  if fingerprint['driver']!='local' or fingerprint['options']!={}:raise ValueError('volume-birth-unconfirmed')
  if resource.get('nativeFingerprint') and resource['nativeFingerprint']!=fingerprint:raise ValueError('volume-identity-replaced')
  resource['nativeFingerprint']=fingerprint
 return identity
def task_for_write():
 task=state['tasks'].get(req.get('taskId'))
 if not task or task['instanceId']!=instance or hashlib.sha256(req.get('token','').encode()).hexdigest()!=task['tokenHash']:raise ValueError('task-lease-identity-unconfirmed')
 return task
def active_task():
 task=task_for_write()
 if task['state']!='active' or task['leaseUntil']<=now:raise ValueError('task-lease-expired-or-retiring')
 if list(directory(task['workspace'])[1])!=task['directoryIdentity']:raise ValueError('workspace-replaced')
 return task
def process_identity(pid):
 p=pathlib.Path('/proc',str(pid));parts=(p/'stat').read_text().split(') ',1)[1].split()
 return {'pid':pid,'start':parts[19],'group':int(parts[2]),'session':int(parts[3]),'uid':p.stat().st_uid,'boot':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
def private_docker(resource,*args,write=False):
 endpoint=resource['endpoint'];p=native(['docker','--host',endpoint,*args])
 if p.returncode:
  if write:raise RetirementFailed('private-daemon-retirement-failed')
  raise ValueError('private-daemon-query-unconfirmed')
 return p.stdout
def private_location(task,resource):
 location=pathlib.Path(resource['dataRoot'])
 volume=next((v for v in task['resources'] if v['kind']=='volume' and v.get('identity')==resource.get('volumeIdentity')),None)
 if not volume:raise ValueError('private-daemon-volume-birth-unconfirmed')
 observed=get('volume',volume['identity'])
 if observed is None:raise ValueError('private-daemon-volume-missing')
 owned(task,volume,observed)
 if observed['Mountpoint']!=str(location) or list(directory(location)[1])!=resource['directoryIdentity']:raise ValueError('private-daemon-data-root-replaced')
 return location
def entry_birth_at(parent,name):
 fd=os.open(name,os.O_PATH|os.O_NOFOLLOW,dir_fd=parent)
 try:return birth_identity(fd)
 finally:os.close(fd)
def private_runtime(task,resource,name):
 if name not in ['r','r2']:raise ValueError('private-runtime-name-unconfirmed')
 location=pathlib.Path(task['workspace'])/name;known=resource.setdefault('runtimeDirectories',{})
 if name in known:
  if directory_birth_identity(location)!=known[name]:raise ValueError('private-runtime-directory-replaced')
 elif not os.path.lexists(location):
  location.mkdir(mode=0o700);known[name]=directory_birth_identity(location);save()
 else:raise ValueError('legacy-private-runtime-needs-owner-review')
 return location
def record_private_endpoint(task,resource):
 parent=os.open(task['workspace'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  observed=os.stat('d.sock',dir_fd=parent,follow_symlinks=False)
  if not stat.S_ISSOCK(observed.st_mode) or observed.st_uid!=os.getuid():raise ValueError('private-daemon-socket-unconfirmed')
  resource['endpointBirth']=entry_birth_at(parent,'d.sock');save()
 finally:os.close(parent)
def private_config(task,resource,create=False):
 workspace=pathlib.Path(task['workspace']);location=private_location(task,resource);path=workspace/'d.json'
 if resource.get('configProof'):
  current=proof(path,'hash')
  if current!=resource['configProof']:raise ValueError('private-daemon-config-replaced')
  return path
 if not create:raise ValueError('private-daemon-config-unconfirmed')
 version=native(['dockerd','--version'])
 match=re.search(r'version\s+(\d+)\.',version.stdout)
 if version.returncode or not match:raise ValueError('private-daemon-binary-version-unconfirmed')
 # Docker20's ID uses a global trust key by default; it is not an isolated daemon ID.
 config={'deprecated-key-path':str(location/'daemon-trust-key.json')} if int(match.group(1))<=20 else {}
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as f:json.dump(config,f);f.flush();os.fsync(f.fileno())
 resource['configProof']=proof(path,'hash');save();return path
def verify_private(task,resource):
 location=private_location(task,resource)
 sock=pathlib.Path(resource['endpoint'].removeprefix('unix://'))
 observed=sock.lstat()
 if not stat.S_ISSOCK(observed.st_mode) or sock.parent!=pathlib.Path(task['workspace']) or sock.is_symlink():raise ValueError('private-daemon-socket-unconfirmed')
 info=json.loads(private_docker(resource,'info','--format','{{json .}}'))
 if not isinstance(info.get('ID'),str) or not info['ID'] or not isinstance(info.get('DockerRootDir'),str) or not info['DockerRootDir']:raise RetirementPending('private-daemon-server-not-ready; response fields='+','.join(info.keys()))
 if resource.get('daemonId') and info.get('ID')!=resource['daemonId']:raise ValueError('private-daemon-id-changed')
 if info.get('ID')==task['daemonId']:raise ValueError('private-daemon-shares-host-identity')
 if info.get('DockerRootDir')!=str(location):raise ValueError('private-daemon-root-changed')
 private_config(task,resource)
 if not resource.get('daemonId'):resource['daemonId']=info['ID'];save()
 return info
def retire_private(task,resource):
 verify_private(task,resource)
 ids=private_docker(resource,'ps','-aq','--no-trunc').splitlines()
 if len(ids)>256:raise ValueError('private-daemon-resource-budget')
 if ids:
  rows=json.loads(private_docker(resource,'inspect',*ids))
  if len(rows)!=len(ids):raise ValueError('private-daemon-container-inventory-unconfirmed')
  for value in rows:
   for mount in value.get('Mounts') or []:
    if mount.get('Type')=='bind' and not mount.get('RW') is False:
     source=pathlib.Path(mount.get('Source',''))
     if not source.is_absolute() or pathlib.Path(task['workspace']) not in source.parents:raise ValueError('private-daemon-foreign-writable-binding')
   if (value.get('State') or {}).get('Running'):private_docker(resource,'stop','--time','2',value['Id'],write=True)
   private_docker(resource,'rm',value['Id'],write=True)
 volumes=private_docker(resource,'volume','ls','-q').splitlines()
 for name in volumes:
  volume=json.loads(private_docker(resource,'volume','inspect',name))[0]
  if volume.get('Driver')!='local' or volume.get('Options') not in [None,{}]:raise ValueError('private-daemon-foreign-volume-options')
  private_docker(resource,'volume','rm',name,write=True)
 images=sorted(set(private_docker(resource,'image','ls','-aq','--no-trunc').splitlines()))
 for identity in images:
  # The daemon was born empty in this task's fresh private data root. Every alias is inside that namespace.
  image=json.loads(private_docker(resource,'image','inspect',identity))[0]
  for tag in image.get('RepoTags') or []:private_docker(resource,'image','rm','--no-prune',tag,write=True)
  if not image.get('RepoTags'):private_docker(resource,'image','rm','--no-prune',identity,write=True)
 if private_docker(resource,'ps','-aq').strip() or private_docker(resource,'volume','ls','-q').strip() or private_docker(resource,'image','ls','-aq').strip():raise ValueError('private-daemon-retirement-incomplete')
def recover_private(task,resource):
 p=native(['docker','--host',resource['endpoint'],'info','--format','{{json .}}'])
 location=private_location(task,resource);workspace=pathlib.Path(task['workspace'])
 if p.returncode==0:
  info=json.loads(p.stdout)
  if info.get('ID') and info.get('DockerRootDir'):verify_private(task,resource);return None
 # Docker20 may exit 0 with only ServerErrors/ClientInfo when the daemon is offline.
 # A failed formatted query is not absence: prove the exact private UNIX endpoint
 # refuses connections, then recheck all host process references before recovery.
 if resource['endpoint']!='unix://'+str(workspace/'d.sock'):raise ValueError('private-daemon-endpoint-replaced')
 probe=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);probe.settimeout(1)
 try:
  probe.connect(str(workspace/'d.sock'))
  raise RetirementPending('private-daemon-endpoint-live-but-query-unconfirmed')
 except (ConnectionRefusedError,FileNotFoundError):pass
 finally:probe.close()
 if any(workspace==value or workspace in value.parents for value in process_paths()):raise ValueError('private-daemon-offline-state-still-in-use')
 if any(location==value or location in value.parents for value in process_paths()):raise ValueError('private-daemon-data-still-in-use')
 config=private_config(task,resource,True)
 socket_path=pathlib.Path(resource['endpoint'].removeprefix('unix://'))
 if os.path.lexists(socket_path):
  observed=socket_path.lstat()
  if not stat.S_ISSOCK(observed.st_mode) or observed.st_uid!=os.getuid():raise ValueError('private-daemon-socket-replaced')
  socket_path.unlink()
 pidfile=workspace/'d.pid'
 if os.path.lexists(pidfile):
  seen=pidfile.lstat()
  if not stat.S_ISREG(seen.st_mode) or seen.st_uid!=os.getuid() or seen.st_nlink!=1:raise ValueError('private-daemon-pidfile-unconfirmed')
  pidfile.unlink()
 runtime=private_runtime(task,resource,'r2')
 args=['dockerd','--config-file='+str(config),'--data-root='+str(location),'--exec-root='+str(runtime),'--pidfile='+str(pidfile),'--host='+resource['endpoint'],'--storage-driver=vfs','--iptables=false','--bridge=none','--shutdown-timeout=3']
 server=subprocess.Popen(args,cwd=workspace,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
 resource['recoveryProcess']=process_identity(server.pid);save()
 for _ in range(50):
  check()
  if server.poll() is not None:raise ValueError('private-daemon-recovery-failed')
  p=native(['docker','--host',resource['endpoint'],'info','--format','{{json .}}'])
  if p.returncode==0:
   info=json.loads(p.stdout)
   if info.get('ID') and info.get('DockerRootDir'):verify_private(task,resource);record_private_endpoint(task,resource);return server
  time.sleep(.1)
 raise ValueError('private-daemon-recovery-unconfirmed')
def budget_usage(task):
 p=native(['du','-sx','-B1','--',task['workspace']])
 if p.returncode:raise ValueError('task-usage-unconfirmed')
 total=int(p.stdout.split()[0])
 for resource in task['resources']:
  if resource['stage']=='retired' or resource['kind']=='process':continue
  if resource['stage']=='issued':raise ValueError('resource-creation-usage-unconfirmed')
  if resource['kind']=='volume':
   value=get('volume',resource['identity'])
   if value is None:continue
   owned(task,resource,value)
   if value.get('Driver')!='local' or value.get('Options') not in [None,{}]:raise ValueError('volume-driver-unconfirmed')
   root,_=directory(value['Mountpoint']);usage=native(['du','-sx','-B1','--',str(root)])
   if usage.returncode:raise ValueError('volume-usage-unconfirmed')
   total+=int(usage.stdout.split()[0])
  elif resource['kind']=='container':
   value=get('container',resource['identity'])
   if value is None:continue
   owned(task,resource,value)
   rows=json.loads(docker('container','inspect','--size',resource['identity']))
   size=rows[0].get('SizeRw')
   if not isinstance(size,int) or size<0:raise ValueError('container-writable-usage-unconfirmed')
   total+=size+150*1024*1024 # Conservative reservation for the existing 50 MiB x 3 log policy.
  elif resource['kind']=='image':
   value=get('image',resource['identity'])
   if value is not None:
    owned(task,resource,value);total+=value['Size']
 return total
if action=='begin':
 if req.get('dataDisposition')!='ephemeral-test':raise ValueError('explicit-ephemeral-test-disposition-required')
 ttl=req.get('ttlSeconds',7200)
 if not isinstance(ttl,int) or not 10<=ttl<=7*86400:raise ValueError('lease-window-invalid')
 if not req.get('projectId') or not req.get('owner') or len(req['owner'])>128:raise ValueError('task-owner-unconfirmed')
 if any(p.name in ['.deployment-sources','.cds-worktrees'] or os.path.lexists(p/'.git') for p in [base,*base.parents]):raise ValueError('test-data-must-live-outside-source-checkouts')
 daemon_root,_=directory(json.loads(docker('info','--format','{{json .DockerRootDir}}')))
 fs=os.statvfs(base);docker_fs=os.statvfs(daemon_root)
 # Reuse the caller's existing disk guard before this protocol. This is the concrete peak reservation.
 if min(fs.f_bavail*fs.f_frsize,docker_fs.f_bavail*docker_fs.f_frsize)<req.get('reserveBytes',4*1024**3):raise ValueError('insufficient-peak-reservation')
 identifier=secrets.token_hex(16);token=secrets.token_hex(32);nonce=secrets.token_hex(24);workspace=base/identifier
 if len([t for t in state['tasks'].values() if t['projectId']==req['projectId'] and t['state']!='retired'])>=req.get('maxTasksPerProject',8):raise ValueError('project-task-budget-reached')
 outstanding=[t for t in state['tasks'].values() if t['state']!='retired']
 if len(outstanding)>=req.get('maxTasksTotal',32) or sum(budget_usage(t) for t in outstanding)>=req.get('globalBudgetBytes',32*1024**3):raise ValueError('host-task-budget-reached')
 project_budget=req.get('projectBudgetBytes',8*1024**3)
 if sum(budget_usage(t) for t in state['tasks'].values() if t['projectId']==req['projectId'] and t['state']!='retired')>=project_budget:raise ValueError('project-space-budget-reached')
 maximum=min(project_budget,req.get('maxBytes',4*1024**3));reserved=sum(t.get('maxBytes',4*1024**3) for t in outstanding)
 if sum(t.get('maxBytes',4*1024**3) for t in outstanding if t['projectId']==req['projectId'])+maximum>project_budget or reserved+maximum>req.get('globalBudgetBytes',32*1024**3):raise ValueError('task-peak-budget-reserved')
 if min(fs.f_bavail*fs.f_frsize,docker_fs.f_bavail*docker_fs.f_frsize)<reserved+maximum+req.get('reserveBytes',4*1024**3):raise ValueError('insufficient-unreserved-peak-space')
 producer=process_identity(req['producerPid'])
 if producer['uid']!=os.getuid():raise ValueError('producer-identity-unconfirmed')
 task={'id':identifier,'projectId':req['projectId'],'instanceId':instance,'retirementAuthority':'host-acceptance-v1','owner':req['owner'],'createdBy':req.get('createdBy','acceptance-runner'),'producer':producer,'hardDeadline':now+7*DAY,'createdAt':now,'leaseUntil':now+ttl*1000,'tokenHash':hashlib.sha256(token.encode()).hexdigest(),'nonce':nonce,'workspace':str(workspace),'state':'intent','dataDisposition':'ephemeral-test','resources':[],'daemonId':daemon(),'maxBytes':maximum}
 state['tasks'][identifier]=task;save();workspace.mkdir(mode=0o700)
 task['directoryIdentity']=list(directory(workspace)[1]);receipt={'taskId':identifier,'nonce':nonce,'instanceId':instance,'projectId':task['projectId']}
 fd=os.open(workspace/'.cds-resource-owner.json',os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as f:json.dump(receipt,f);f.flush();os.fsync(f.fileno())
 task['state']='active';save();print(json.dumps({'taskId':identifier,'token':token,'workspace':str(workspace),'leaseUntil':task['leaseUntil']}));sys.exit(0)
if action=='heartbeat':
 task=active_task();usage=budget_usage(task);task['budgetBytesEstimate']=usage
 if usage>task['maxBytes']:task['state']='closing';task['leaseUntil']=now;task['outcome']='space-budget-exceeded';save();raise ValueError('task-space-budget-exceeded')
 task['leaseUntil']=min(task.get('hardDeadline',task['createdAt']+7*DAY),now+max(10,min(3600,int(req.get('ttlSeconds',600))))*1000);save();print(json.dumps({'renewed':True,'leaseUntil':task['leaseUntil']}));sys.exit(0)
if action=='finish':
 task=task_for_write()
 if task['state'] not in ['retired','retiring','closing']:task['state']='closing';task['leaseUntil']=now;task['outcome']=req.get('outcome','finished');save()
 print(json.dumps({'closed':True,'alreadyRetired':task['state']=='retired'}));sys.exit(0)
if action=='intent':
 task=active_task();kind=req['kind'];name=req['name']
 if len(task['resources'])>=256:raise ValueError('task-resource-budget-reached')
 if budget_usage(task)+(150*1024*1024 if kind=='container' else 0)>task['maxBytes']:raise ValueError('task-resource-peak-budget-reached')
 if kind not in ['container','volume','network','image'] or not name or len(name)>255 or any(c in name for c in '\n\r\0'):raise ValueError('unsupported-resource')
 if daemon()!=task['daemonId']:raise ValueError('daemon-changed')
 if get(kind,name) is not None:raise ValueError('resource-already-exists-no-adoption')
 resource={'id':secrets.token_hex(16),'kind':kind,'name':name,'nonce':secrets.token_hex(24),'role':req.get('role',kind),'stage':'issued','createdAt':now};task['resources'].append(resource);save()
 print(json.dumps({'resourceId':resource['id'],'labels':{'cds.resource.task':task['id'],'cds.resource.birth':resource['nonce'],'cds.acceptance.owner':task['owner'],'cds.resource.instance':instance}}));sys.exit(0)
if action=='confirm':
 task=task_for_write();resource=next(v for v in task['resources'] if v['id']==req['resourceId'])
 if daemon()!=task['daemonId']:raise ValueError('daemon-changed')
 value=get(resource['kind'],resource['name'])
 if value is None:raise ValueError('issued-creation-not-yet-confirmed')
 resource['identity']=owned(task,resource,value);resource['stage']='created';save();print(json.dumps({'confirmed':True,'identity':resource['identity']}));sys.exit(0)
if action=='creation-ended':
 task=task_for_write();resource=next(v for v in task['resources'] if v['id']==req['resourceId'])
 if daemon()!=task['daemonId']:raise ValueError('daemon-changed')
 value=get(resource['kind'],resource['name'])
 if value is None:resource['stage']='retired';resource['creationOutcome']='native-failure-confirmed-absent'
 else:resource['identity']=owned(task,resource,value);resource['stage']='created'
 save();print(json.dumps({'settled':True}));sys.exit(0)
if action=='binding':
 task=active_task();resource=next(v for v in task['resources'] if v['kind']==req['kind'] and v.get('identity')==req['identity'] and v['stage']=='created')
 if daemon()!=task['daemonId']:raise ValueError('daemon-changed')
 value=get(resource['kind'],resource['identity'])
 if value is None:raise ValueError('resource-not-present')
 owned(task,resource,value);print(json.dumps({'confirmed':True}));sys.exit(0)
if action=='workspace-binding':
 task=active_task();p=pathlib.Path(req['path']);directory(p)
 if p!=pathlib.Path(task['workspace']) and pathlib.Path(task['workspace']) not in p.parents:raise ValueError('writable-bind-outside-owned-workspace')
 print(json.dumps({'confirmed':True}));sys.exit(0)
if action=='process':
 task=active_task();pid=req['pid'];identity=process_identity(pid)
 if identity['uid']!=os.getuid() or identity['group']!=pid or identity['session']!=pid or os.readlink('/proc/'+str(pid)+'/cwd')!=task['workspace']:raise ValueError('launcher-session-unconfirmed')
 args=pathlib.Path('/proc',str(pid),'cmdline').read_bytes().split(b'\0')
 if b'cds-owned-launcher-v1' not in args:raise ValueError('launcher-handshake-unconfirmed')
 task['resources'].append({'id':secrets.token_hex(16),'kind':'process','identity':identity,'role':req.get('role','launcher'),'privateDaemonId':req.get('privateDaemonId'),'relatedResourceId':req.get('resourceId'),'stage':'created'});save();print(json.dumps({'confirmed':True}));sys.exit(0)
if action=='daemon-intent':
 task=active_task();identifier=secrets.token_hex(16)
 if any(v['kind']=='private-daemon' and v['stage']!='retired' for v in task['resources']):raise ValueError('private-daemon-per-task-budget')
 volume=next(v for v in task['resources'] if v['kind']=='volume' and v.get('identity')==req['volumeIdentity'] and v['stage']=='created')
 value=get('volume',volume['identity']);owned(task,volume,value);location,_=directory(value['Mountpoint'])
 if list(location.iterdir()):raise ValueError('private-daemon-data-volume-not-born-empty')
 resource={'id':identifier,'kind':'private-daemon','stage':'intent','volumeIdentity':volume['identity'],'dataRoot':str(location),'endpoint':'unix://'+str(pathlib.Path(task['workspace'])/'d.sock'),'directoryIdentity':list(directory(location)[1])};task['resources'].append(resource);save()
 private_config(task,resource,True)
 private_runtime(task,resource,'r')
 print(json.dumps(resource));sys.exit(0)
if action=='daemon-confirm':
 task=active_task();resource=next(v for v in task['resources'] if v['id']==req['resourceId'] and v['kind']=='private-daemon')
 p=native(['docker','--host',resource['endpoint'],'info','--format','{{json .}}'])
 if p.returncode:print(json.dumps({'retryable':'daemon-not-ready'}));sys.exit(3)
 info=json.loads(p.stdout)
 if not info.get('ID') or not info.get('DockerRootDir'):print(json.dumps({'retryable':'daemon-server-not-ready'}));sys.exit(3)
 if info.get('ID')==task['daemonId'] or info.get('DockerRootDir')!=resource['dataRoot']:raise ValueError('private-daemon-identity-unconfirmed')
 resource['daemonId']=info['ID'];verify_private(task,resource);record_private_endpoint(task,resource)
 if private_docker(resource,'ps','-aq').strip() or private_docker(resource,'volume','ls','-q').strip() or private_docker(resource,'image','ls','-aq').strip():raise ValueError('private-daemon-not-born-empty')
 resource['stage']='created';save();print(json.dumps({'confirmed':True,'endpoint':resource['endpoint'],'resourceId':resource['id']}));sys.exit(0)
if action=='daemon-binding':
 task=active_task();resource=next(v for v in task['resources'] if v['id']==req['resourceId'] and v['kind']=='private-daemon' and v['stage']=='created');verify_private(task,resource);save();print(json.dumps({'confirmed':True}));sys.exit(0)
if action not in ['preview','reconcile']:raise ValueError('unsupported-resource-action')
out={'scanStatus':'complete','tasks':[],'removed':[],'held':[],'failed':[],'pending':[],'pendingReasons':[],'unknown':[],'filesystems':[]}
def held(task,reason):out['held'].append({'taskId':task['id'],'reason':reason})
def references():
 ids=sorted(set(docker('ps','-aq','--no-trunc').splitlines()))
 if len(ids)>5000:raise ValueError('container-inventory-budget')
 values=json.loads(docker('inspect',*ids)) if ids else []
 if len(values)!=len(ids) or ids!=sorted(set(docker('ps','-aq','--no-trunc').splitlines())):raise ValueError('container-inventory-changed')
 return values
def volume_references():
 names=sorted(set(docker('volume','ls','-q').splitlines()))
 if len(names)>5000:raise ValueError('volume-inventory-budget')
 values=json.loads(docker('volume','inspect',*names)) if names else []
 if len(values)!=len(names) or names!=sorted(set(docker('volume','ls','-q').splitlines())):raise ValueError('volume-inventory-changed')
 return values
def related(a,b):return a==b or a in b.parents or b in a.parents
def process_paths():
 result=[];networks=set()
 for pid in pathlib.Path('/proc').iterdir():
  if not pid.name.isdigit() or int(pid.name)==os.getpid():continue
  try:
   network=(pid/'ns/net').stat().st_ino
   if network not in networks:
    networks.add(network)
    for line in (pid/'net/unix').read_text().splitlines()[1:]:
     fields=line.split(maxsplit=7)
     if len(fields)==8 and fields[7].startswith('/'):result.append(pathlib.Path(fields[7]))
   for link in [pid/'cwd',pid/'root',*(pid/'fd').iterdir()]:
    try:
     value=os.readlink(link)
     if value.startswith('/'):result.append(pathlib.Path(value.removesuffix(' (deleted)')))
    except FileNotFoundError:continue
  except FileNotFoundError:continue
 return result
def mount_id(fd):
 values=[line.split(':',1)[1].strip() for line in pathlib.Path('/proc/self/fdinfo',str(fd)).read_text().splitlines() if line.startswith('mnt_id:')]
 if len(values)!=1 or not values[0].isdigit():raise ValueError('mount-identity-unconfirmed')
 return values[0]
def remove_tree(fd,device,keep_marker=False,expected_mount=None,runtime=False):
 if expected_mount is None:expected_mount=mount_id(fd)
 if mount_id(fd)!=expected_mount:raise ValueError('nested-mount-retained')
 for name in os.listdir(fd):
  if keep_marker and name=='.cds-resource-owner.json':continue
  check();s=os.stat(name,dir_fd=fd,follow_symlinks=False)
  if s.st_dev!=device:raise ValueError('nested-mount-retained')
  if stat.S_ISDIR(s.st_mode):
   child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
   try:
    if (os.fstat(child).st_dev,os.fstat(child).st_ino)!=(s.st_dev,s.st_ino):raise ValueError('child-directory-replaced')
    if keep_marker and name in runtime_roots and birth_identity(child)!=runtime_roots[name]:raise ValueError('private-runtime-directory-replaced')
    runtime_child=runtime or birth_identity(child) in runtime_births
    remove_tree(child,device,False,expected_mount,runtime_child)
   finally:os.close(child)
   current=os.stat(name,dir_fd=fd,follow_symlinks=False)
   if (current.st_dev,current.st_ino)!=(s.st_dev,s.st_ino):raise ValueError('child-directory-replaced')
   os.rmdir(name,dir_fd=fd)
  else:
   if keep_marker and name=='d.sock' and endpoint_births and entry_birth_at(fd,name) not in endpoint_births:raise ValueError('private-daemon-endpoint-replaced')
   if not (stat.S_ISREG(s.st_mode) or stat.S_ISLNK(s.st_mode)):
    known_runtime=(runtime and (stat.S_ISSOCK(s.st_mode) or stat.S_ISFIFO(s.st_mode))) or (stat.S_ISSOCK(s.st_mode) and entry_birth_at(fd,name) in endpoint_births)
    if not known_runtime or s.st_uid!=os.getuid() or s.st_nlink!=1:raise ValueError('unknown-special-file-retained')
   if stat.S_ISREG(s.st_mode) and s.st_nlink!=1:raise ValueError('shared-hardlink-retained')
   current=os.stat(name,dir_fd=fd,follow_symlinks=False)
   if (current.st_dev,current.st_ino)!=(s.st_dev,s.st_ino):raise ValueError('file-replaced')
   os.unlink(name,dir_fd=fd) # A link itself is removed; its target is never opened.
points={}
for point in [base,catalog,directory(json.loads(docker('info','--format','{{json .DockerRootDir}}')))[0]]:
 location,identity=directory(point);fs=os.statvfs(location)
 points[location.stat().st_dev]={'path':str(location),'identity':identity,'availableBefore':fs.f_bavail*fs.f_frsize}
device=base.stat().st_dev;attempted=0
known_containers={r.get('identity') for task in state['tasks'].values() for r in task['resources'] if r['kind']=='container'}
for value in references():
 observed=(value.get('Config') or {}).get('Labels') or {}
 if (observed.get('cds.acceptance.owner') or observed.get('cds.owned.owner')) and value.get('Id') not in known_containers:
  out['unknown'].append({'identity':value.get('Id'),'owner':observed.get('cds.acceptance.owner') or observed.get('cds.owned.owner'),'reason':'legacy-acceptance-resource-needs-manifest-adoption'})
if not req.get('taskId'):
 for kind in ['volume','network','image']:
  names=set()
  for label in ['cds.acceptance.owner','cds.owned.owner']:
   args=[kind,'ls','-q','--filter','label='+label]+([] if kind=='volume' else ['--no-trunc'])
   names.update(docker(*args).splitlines())
  if len(names)>256:raise ValueError('legacy-owned-resource-inventory-budget')
  for name in names:
   value=get(kind,name)
   if value is None:raise ValueError('legacy-owned-resource-inventory-changed')
   observed=labels(value,kind);identity=value.get('Name') if kind=='volume' else value.get('Id')
   known=any(r['kind']==kind and (r.get('identity')==identity or (r.get('nonce')==observed.get('cds.resource.birth') and t['id']==observed.get('cds.resource.task'))) for t in state['tasks'].values() for r in t['resources'])
   if not known:out['unknown'].append({'kind':kind,'identity':identity,'owner':observed.get('cds.acceptance.owner') or observed.get('cds.owned.owner'),'reason':'legacy-acceptance-resource-needs-manifest-adoption'})
known_workspaces={t['workspace'] for t in state['tasks'].values() if t['state']!='retired'}
for entry in base.iterdir():
 if str(entry) not in known_workspaces:
  out['unknown'].append({'kind':'workspace','identity':str(entry),'reason':'unregistered-workspace-needs-owner-review'})
 if len(out['unknown'])>2000:raise ValueError('unregistered-resource-inventory-budget')
ordered=sorted(state['tasks'].values(),key=lambda t:(t['createdAt'],t['id']))
cursor=next((i+1 for i,t in enumerate(ordered) if t['id']==state.get('scanCursor')),0)
ordered=ordered[cursor:]+ordered[:cursor]
for task in ordered:
 if req.get('taskId') and task['id']!=req['taskId']:continue
 if task['state']=='retired':continue
 out['tasks'].append({k:task.get(k) for k in ['id','projectId','owner','createdBy','createdAt','leaseUntil','state','workspace','dataDisposition']})
 if task['instanceId']!=instance and task.get('retirementAuthority')!='host-acceptance-v1':held(task,'foreign-instance');continue
 if task['state']=='active' and task['leaseUntil']>now:
  try:
   if budget_usage(task)<=task['maxBytes']:held(task,'active-lease');continue
   if action=='preview':held(task,'space-budget-exceeded-lease-must-be-fenced');continue
   task['state']='closing';task['leaseUntil']=now;task['outcome']='space-budget-exceeded';save()
  except Exception:held(task,'task-usage-unconfirmed');out['scanStatus']='partial';continue
 if attempted>=max(0,min(4,int(req.get('maxTasks',2)))):out['pending'].append(task['id']);continue
 attempted+=1
 if action=='reconcile':state['scanCursor']=task['id'];save()
 try:
  check();workspace=pathlib.Path(task['workspace'])
  if workspace.parent!=base or workspace.name!=task['id'] or task['dataDisposition']!='ephemeral-test':raise ValueError('workspace-owner-unconfirmed')
  if not os.path.lexists(workspace) and ((task['state']=='intent' and not task['resources']) or (task.get('phase')=='workspace-empty' and all(r['stage']=='retired' for r in task['resources']))):
   if action=='reconcile':task['state']='retired';task['retiredAt']=now;task['resources']=[];save()
   held(task,'previous-retirement-or-unissued-workspace-confirmed-absent');continue
  if list(directory(workspace)[1])!=task.get('directoryIdentity'):raise ValueError('workspace-replaced')
  marker=workspace/'.cds-resource-owner.json'
  if marker.exists():
   if marker.is_symlink():raise ValueError('workspace-receipt-is-an-alias')
   marker_fd,_,_=open_file(marker)
   try:
    marker_stat=os.fstat(marker_fd)
    if not stat.S_ISREG(marker_stat.st_mode) or marker_stat.st_size>4096 or marker_stat.st_uid!=os.getuid() or marker_stat.st_nlink!=1:raise ValueError('workspace-receipt-unconfirmed')
    receipt=json.loads(os.read(marker_fd,4097))
   finally:os.close(marker_fd)
   if receipt!={'taskId':task['id'],'nonce':task['nonce'],'instanceId':task['instanceId'],'projectId':task['projectId']}:raise ValueError('workspace-birth-unconfirmed')
  elif task.get('phase')!='workspace-empty' or list(workspace.iterdir()):raise ValueError('workspace-birth-unconfirmed')
  if daemon()!=task['daemonId']:raise ValueError('daemon-changed')
  if action=='reconcile':task['state']='retiring';save() # Fence any future creator handshake before native rechecks.
  current=references();owned_ids=set();volume_roots=[]
  for resource in task['resources']:
   if resource['stage']=='retired':continue
   if resource['kind'] in ['process','private-daemon']:continue
   value=get(resource['kind'],resource.get('identity') or resource['name'])
   if value is None:
    if resource['stage']=='issued':
     producer=task.get('producer');observed_producer=process_identity(producer['pid']) if producer and pathlib.Path('/proc',str(producer['pid'])).exists() else None
     if producer and observed_producer!=producer and not any(v.get('relatedResourceId')==resource['id'] for v in task['resources']):
      if action=='reconcile':resource['stage']='retired';resource['creationOutcome']='producer-gone-before-creator-handshake';save()
      continue
     raise ValueError('creation-still-unconfirmed')
    continue
   identity=owned(task,resource,value)
   if resource['kind']=='container':owned_ids.add(identity)
   if resource['kind']=='volume':volume_roots.append(pathlib.Path(value['Mountpoint']))
  # Another task/container reference cannot be retired along with this task.
  for value in current:
   if value.get('Id') in owned_ids:continue
   for mount in value.get('Mounts') or []:
    if mount.get('Type')!='tmpfs' and mount.get('Source'):
     source=pathlib.Path(mount['Source'])
     if related(workspace,source):raise ValueError('running-or-stopped-foreign-container-reference')
     if any(related(root,source) for root in volume_roots):raise ValueError('volume-still-referenced')
  if action=='preview':held(task,'eligible-expired-owned-ephemeral-task');continue
  task['state']='retiring';save()
  for resource in task['resources']:
   if resource['kind']!='process' or resource['stage']=='retired':continue
   recorded=resource['identity'];pid=recorded['pid'];private=None;recovery=None
   if resource.get('privateDaemonId'):
    private=next(v for v in task['resources'] if v['id']==resource['privateDaemonId'])
    if private['stage'] not in ['created','intent']:raise ValueError('private-daemon-creation-unconfirmed')
    recovery=recover_private(task,private);private['stage']='created';save();retire_private(task,private)
    if recovery:recorded=private['recoveryProcess'];pid=recorded['pid']
   try:
    observed=process_identity(pid)
    if observed!=recorded:
     # A reboot or reused PID proves the recorded process is gone, never authority to signal the new process.
     if observed['boot']!=recorded['boot'] or observed['start']!=recorded['start']:
      resource['stage']='retired';resource['replacementProcessPreserved']=True;save();continue
     raise ValueError('launcher-process-identity-changed')
    if private:os.kill(pid,signal.SIGTERM)
    else:os.killpg(pid,signal.SIGTERM)
    for _ in range(60 if private else 20):
     try:process_identity(pid)
     except FileNotFoundError:break
     time.sleep(.05)
    else:
     if process_identity(pid)!=recorded:raise ValueError('launcher-process-identity-changed')
     os.killpg(pid,signal.SIGKILL)
   except FileNotFoundError:pass
   if resource.get('privateDaemonId'):
    private=next(v for v in task['resources'] if v['id']==resource['privateDaemonId']);private['stage']='retired';save()
   resource['stage']='retired';save();out['removed'].append({'taskId':task['id'],'resourceId':resource['id'],'kind':'process'})
  for kind in ['container','image','volume','network']:
   for resource in task['resources']:
    if resource['kind']!=kind or resource['stage']=='retired':continue
    check();value=get(kind,resource.get('identity') or resource['name'])
    if value is None:
     if resource['stage']=='issued':raise ValueError('creation-still-unconfirmed')
     resource['stage']='retired';save();continue
    identity=owned(task,resource,value)
    resource['identity']=identity;save()
    if kind=='container':
     if (value.get('State') or {}).get('Running'):mutate('stop','--time','3',identity)
     value=get(kind,identity)
     if value is not None and (value.get('State') or {}).get('Running'):raise ValueError('owned-container-did-not-stop')
     mutate('rm',identity) # No --force, --volumes or global prune.
    elif kind=='image':
     if any(v.get('Image')==identity for v in references()):raise ValueError('image-still-referenced')
     mutate('image','rm','--no-prune',identity)
    elif kind=='volume':
     if any(any(m.get('Type')=='volume' and m.get('Name')==identity for m in v.get('Mounts') or []) for v in references()):raise ValueError('volume-still-referenced')
     volume_root=pathlib.Path(value['Mountpoint'])
     if any(volume_root==p or volume_root in p.parents for p in process_paths()):raise ValueError('host-process-still-uses-volume')
     mutate('volume','rm',identity)
    else:mutate('network','rm',identity)
    if get(kind,identity) is not None:raise ValueError('resource-retirement-not-confirmed')
    resource['stage']='retired';save();out['removed'].append({'taskId':task['id'],'resourceId':resource['id'],'kind':kind})
  # Re-read all native references after the owned containers have gone.
  for value in references():
   if any(m.get('Source') and related(workspace,pathlib.Path(m['Source'])) for m in value.get('Mounts') or []):raise ValueError('latest-container-reference')
  for value in volume_references():
   device_path=(value.get('Options') or {}).get('device')
   if device_path and pathlib.Path(device_path).is_absolute() and related(workspace,pathlib.Path(device_path)):raise ValueError('unmounted-volume-still-references-workspace')
  if any(workspace==p or workspace in p.parents for p in process_paths()):raise ValueError('host-process-still-uses-workspace')
  if list(directory(workspace)[1])!=task['directoryIdentity']:raise ValueError('workspace-replaced-before-removal')
  private_resources=[r for r in task['resources'] if r['kind']=='private-daemon']
  if any(r['stage']!='retired' for r in private_resources):raise ValueError('private-daemon-retirement-unconfirmed')
  runtime_births=[birth for r in private_resources for birth in r.get('runtimeDirectories',{}).values()]
  runtime_roots={name:birth for r in private_resources for name,birth in r.get('runtimeDirectories',{}).items()}
  endpoint_births=[r['endpointBirth'] for r in private_resources if r.get('endpointBirth')]
  fd=os.open(workspace,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  try:
   if [os.fstat(fd).st_dev,os.fstat(fd).st_ino]!=task['directoryIdentity']:raise ValueError('workspace-replaced-before-removal')
   remove_tree(fd,device,True)
   task['phase']='workspace-empty';save()
   if '.cds-resource-owner.json' in os.listdir(fd):os.unlink('.cds-resource-owner.json',dir_fd=fd)
  finally:os.close(fd)
  if list(directory(workspace)[1])!=task['directoryIdentity']:raise ValueError('workspace-replaced-before-finalization')
  os.rmdir(workspace);task['state']='retired';task['retiredAt']=now
  task['resourceCount']=len(task['resources']);task['resources']=[]
  history_limit=max(8,min(2000,int(req.get('historyLimit',1000))))
  state['retired'].append({'taskId':task['id'],'at':now});state['retired']=state['retired'][-history_limit:];save();out['removed'].append({'taskId':task['id'],'kind':'workspace'})
 except Exception as error:
  reason=str(error)
  if isinstance(error,RetirementFailed):out['failed'].append({'taskId':task['id'],'reason':reason})
  elif isinstance(error,(RetirementPending,subprocess.TimeoutExpired)) or reason in ['inspection-budget-exceeded','cancelled']:
   out['pending'].append(task['id']);out['pendingReasons'].append({'taskId':task['id'],'reason':reason[:1000]})
  else:held(task,reason)
  out['scanStatus']='partial'
if action=='reconcile':
 completed=sorted((t for t in state['tasks'].values() if t['state']=='retired'),key=lambda t:t.get('retiredAt',0),reverse=True)
 for old in completed[max(8,min(2000,int(req.get('historyLimit',1000)))):]:del state['tasks'][old['id']]
 save()
for dev,row in points.items():
 try:
  if directory(row['path'])[1]!=tuple(row.pop('identity')) or os.stat(row['path']).st_dev!=dev:raise ValueError('measurement-root-changed')
  after=os.statvfs(row['path']);row['availableAfter']=after.f_bavail*after.f_frsize;row['netAvailableBytesDelta']=row['availableAfter']-row['availableBefore']
 except Exception as error:row['availableAfter']=None;row['netAvailableBytesDelta']=None;row['error']=str(error);out['scanStatus']='partial'
 out['filesystems'].append(row)
if out['pending'] or out['unknown']:out['scanStatus']='partial'
out['counts']={key:len(out[key]) for key in ['tasks','removed','held','failed','pending','unknown']}
if action=='reconcile' and req.get('executionId'):
 try:os.unlink('cancel-'+req['executionId'],dir_fd=catalog_fd)
 except FileNotFoundError:pass
print(json.dumps(out,separators=(',',':')))
`;
