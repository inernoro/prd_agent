import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { BACKUP_RETENTION_PROGRAM } from '../src/services/backup-retention-program.js';

const index = process.argv.indexOf('--image');
const image = index >= 0 ? process.argv[index + 1] : 'python:3.12-alpine';
const owner = `cds_backup_retention_${randomBytes(8).toString('hex')}`;
const driver = String.raw`
import pathlib,tempfile,gzip,os,json,subprocess,base64,sys,time
program=base64.b64decode(sys.argv[1]).decode();base=pathlib.Path(tempfile.mkdtemp(prefix='owned-backups-',dir='/owned'));now=int(time.time()*1000)
def request(**kw):return {'catalog':str(base/'.cds-retention'),'directories':[str(base)],'instanceId':'owned-instance','nowMs':now,**kw}
def run(**kw):
 req=request(**kw)
 p=subprocess.run(['python3','-c',program],input=json.dumps(req),text=True,capture_output=True,timeout=30)
 if p.returncode:raise RuntimeError('native worker failed: '+p.stderr[-1000:])
 return json.loads(p.stdout)
old=base/'historical-backup.gz';old.write_bytes(gzip.compress(os.urandom(4*1024*1024)));os.utime(old,((now-16*86400000)/1000,)*2)
run(action='register',path=str(old),projectId='owned-project',serviceId='retired-database',origin='historical',disposition='reproducible-artifact',attestedBy='isolated-fixture-owner',dispositionReason='synthetic random gzip in private tmpfs')
lease={'projectId':'owned-project','serviceId':'retired-database','token':'owned-restore-token','kind':'restore'}
run(action='lease',**lease);assert run(action='reconcile')['removed']==[];run(action='release',**lease)
with old.open('rb') as held:
 blocked=run(action='reconcile');assert not blocked['removed'] and any(v['reason']=='file-still-open' for v in blocked['held'])
result=run(action='reconcile');assert result['removed']==[str(old)] and not old.exists()
gain=result['filesystems'][0]['netAvailableBytesDelta'];assert gain>3*1024*1024,gain
assert run(action='reconcile')['removed']==[]
for phase in ['before-rename','after-rename']:
 interrupted=base/(phase+'.gz');interrupted.write_bytes(gzip.compress(os.urandom(1024*1024)));os.utime(interrupted,((now-17*86400000)/1000,)*2)
 run(action='register',path=str(interrupted),projectId='owned-project',serviceId='retired-database',origin='historical',disposition='reproducible-artifact',attestedBy='isolated-fixture-owner',dispositionReason='synthetic random gzip in private tmpfs')
 marker='    os.rename(pathlib.Path(p).name,quarantine,src_dir_fd=fd,dst_dir_fd=fd)'
 boundary="    print('READY',flush=True);time.sleep(60)"
 injected=program.replace(marker,boundary+'\n'+marker if phase=='before-rename' else marker+'\n'+boundary,1)
 assert injected!=program
 child=subprocess.Popen(['python3','-c',injected],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 child.stdin.write(json.dumps(request(action='reconcile')));child.stdin.close()
 assert child.stdout.readline().strip()=='READY';child.kill();child.wait(timeout=5)
 recovered=run(action='reconcile');assert recovered['removed']==[str(interrupted)] and recovered['previousInterruptedExecution']
 assert not interrupted.exists()
print(json.dumps({'provenance':'integration-live','scope':'actual file/FD worker, private Linux PID namespace and private tmpfs; Docker-reference provider is a fixture (separately tested in the live VM); SIGKILL at explicitly paused native retirement boundaries; not production disk throughput','restoreLeaseProtected':True,'nativeOpenDescriptorProtected':True,'expiredHistoricalBackupRetired':True,'restartAndRepeatSafe':True,'SIGKILLBeforeRenameRecovered':True,'SIGKILLAfterRenameRecovered':True,'filesystemNetAvailableBytesDelta':gain}))
`;
const raw = execFileSync('docker', ['run', '--rm', '--name', owner, '--label', `cds.acceptance.owner=${owner}`,
  '--label', `cds.resource.lease-until=${new Date(Date.now() + 60 * 60_000).toISOString()}`,
  '--network', 'none', '--memory', '192m', '--cpus', '1', '--user', '1000:1000',
  '--tmpfs', '/owned:rw,noexec,nosuid,size=128m,mode=1777', '--entrypoint', 'python3', image,
  '-c', driver, Buffer.from(BACKUP_RETENTION_PROGRAM.replace('def backup_mount_references():\n','def backup_mount_references():\n return [] # Private PID/tmpfs descriptor fixture, no host Docker access.\n')).toString('base64')], { encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
process.stdout.write(raw);
