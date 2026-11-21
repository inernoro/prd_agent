import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_CACHE_PROGRAM } from '../../src/services/image-cache-program.js';
import { ImageCacheGovernance, collectImageCacheReferences } from '../../src/services/image-cache-governance.js';
import { captureDeploymentIntent, readDeploymentIntent } from '../../src/services/deployment-intent.js';
import type { DeploymentRun, IShellExecutor } from '../../src/types.js';
import { resumedReclaimExecution, recordReclaimExecution } from '../../src/services/reclaim-execution-journal.js';
import { StateService } from '../../src/services/state.js';

const roots: string[] = [], now = Date.now(), id = 'sha256:' + 'a'.repeat(64), digest = 'registry.example/test@sha256:' + 'b'.repeat(64);
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-cache-native-unit-'));roots.push(root);
  const db = path.join(root, 'docker.json'), calls = path.join(root, 'calls.jsonl');
  let values: any = { images: [], containers: [], fail: false };
  const save = () => fs.writeFileSync(db, JSON.stringify(values));save();
  fs.writeFileSync(path.join(root, 'docker'), `#!/usr/bin/env python3
import json,sys,pathlib
p=pathlib.Path(${JSON.stringify(db)});v=json.loads(p.read_text());a=sys.argv[1:]
with open(${JSON.stringify(calls)},'a') as f:f.write(json.dumps(a)+chr(10))
if v.get('fail'):sys.exit(2)
if a[0]=='info':print(json.dumps({'ID':'owned-daemon','DockerRootDir':${JSON.stringify(root)},'Architecture':'x86_64','OSType':'linux'}))
elif a[:2]==['image','ls']:sys.stdout.write(chr(10).join(r['Id'] for r in v['images']))
elif a[:2]==['ps','-aq']:sys.stdout.write(chr(10).join(r['Id'] for r in v['containers']))
elif a[:2]==['image','inspect']:
 rows=[r for r in v['images'] if any(q in [r['Id'],*r['RepoTags'],*r['RepoDigests']] for q in a[2:])]
 if not rows and len(a)==3:print('Error response from daemon: No such image: '+a[2],file=sys.stderr);sys.exit(1)
 print(json.dumps(rows))
elif a[0]=='inspect':print(json.dumps([r for r in v['containers'] if r['Id'] in a[1:]]))
elif a[:2]==['image','rm']:
 q=a[-1];r=next(r for r in v['images'] if q in [r['Id'],*r['RepoTags']])
 if v.get('referenceDuringRemoval'):v['containers'].append({'Id':'late-container','Image':r['Id']})
 if any(c['Image']==r['Id'] for c in v['containers']):p.write_text(json.dumps(v));sys.exit(1)
 if q in r['RepoTags']:r['RepoTags'].remove(q)
 if not r['RepoTags']:v['images'].remove(r)
 p.write_text(json.dumps(v));print('deleted')
else:sys.exit(2)
`, { mode: 0o700 });
  const request = (input: any, dockerHost?: string) => JSON.parse(execFileSync('python3', ['-c', IMAGE_CACHE_PROGRAM], { input: JSON.stringify({ action: 'preview', catalog: path.join(root, 'catalog'), instanceId: 'master-a', budgetBytes: 1024 ** 3, nowMs: now, ...input }), env: { ...process.env, PATH: root + ':' + process.env.PATH, ...(dockerHost ? { DOCKER_HOST: dockerHost } : {}) }, encoding: 'utf8', timeout: 30_000 }));
  const image = (aliases = ['registry.example/test:old']) => ({ Id: id, Created: '2026-10-01T00:00:00Z', RepoTags: aliases, RepoDigests: [digest], Size: 1024, Os: 'linux', Architecture: 'amd64', Config: { Labels: {} } });
  const born = () => { request({ action: 'publish', references: [] });const pin = request({ action: 'prepare', image: 'registry.example/test:old', peakBytes: 1024 });values.images = [image()];save();request({ action: 'confirm', token: pin.token });request({ action: 'publish', references: [], nowMs: now + 600001 }); };
  const reconcile = () => request({ action: 'reconcile', targetIdentities: [id], registryProofs: { [digest]: { manifest: { config: { digest: id } }, verifiedAt: Date.now() } } });
  return { root, request, image, born, reconcile, save, values, calls };
}
describe('image ID governance native protocol with a simulated Docker CLI', () => {
  it('uses the same daemon’s bulk inventory, preserving existing size units and stopped references', async () => {
    const f = fixture();
    const socket = path.join(f.root, 'engine.sock');
    const server = spawn('python3', ['-c', `
import socketserver,http.server,json
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  value={
   '/info':{'ID':'owned-daemon','DockerRootDir':${JSON.stringify(f.root)}},
   '/images/json?all=1&digests=1&manifests=1':[{'Id':${JSON.stringify(id)},'Created':1790812800,'Size':65536,'RepoDigests':[${JSON.stringify(digest)}],
    'Manifests':[{'Kind':'image','Available':True,'Size':{'Content':1024,'Total':65536}}]}],
   '/containers/json?all=1':[{'Id':'stopped','ImageID':${JSON.stringify(id)},'Names':['/stopped'],'State':'exited'}],
  }[self.path]
  content=json.dumps(value).encode()
  self.send_response(200);self.send_header('Content-Length',str(len(content)));self.end_headers();self.wfile.write(content)
with socketserver.UnixStreamServer(${JSON.stringify(socket)},Handler) as server:
 print('ready',flush=True);server.serve_forever()
`], { stdio: ['ignore', 'pipe', 'ignore'] });
    const exited = once(server, 'exit');
    try {
      await once(server.stdout!, 'data');
      const report = f.request({}, 'unix://' + socket);
      expect(report.imageBytesEstimate).toBe(1024);
      expect(report.held[0]).toMatchObject({ identity: id, reason: 'running-or-stopped-container-reference' });
      expect(fs.readFileSync(f.calls, 'utf8')).not.toContain('inspect');
    } finally { server.kill(); await exited; }
  });
  it('retires all known aliases once by physical identity with exact registry config proof', () => {
    const f = fixture();f.born();expect(f.request({}).candidates).toHaveLength(1);
    expect(f.reconcile().removed).toEqual([id]);expect(JSON.parse(fs.readFileSync(path.join(f.root, 'docker.json'), 'utf8')).images).toEqual([]);
    expect(f.request({}).candidates).toEqual([]);
  });
  it.each([false, true])('accepts the Docker 29 descriptor for a manifest or index (index=%s) and rejects drift', (index) => {
    const f = fixture();
    const mediaType = 'application/vnd.oci.image.manifest.v1+json';
    const indexType = 'application/vnd.oci.image.index.v1+json';
    const reference = 'registry.example/test@' + id;
    const child = 'sha256:' + 'd'.repeat(64);
    const config = 'sha256:' + 'c'.repeat(64);
    const manifest = { schemaVersion: 2, mediaType, config: { digest: config }, layers: [{ digest: child }] };
    const indexManifest = { schemaVersion: 2, mediaType: indexType, manifests: [{ digest: child, platform: { os: 'linux', architecture: 'amd64' } }] };
    const image = { ...f.image(), RepoDigests: [reference], Descriptor: { digest: id, mediaType: index ? indexType : mediaType } };
    f.values.images = [image];
    f.save();
    const adoption = {
      action: 'adopt', identity: id, created: image.Created, aliases: image.RepoTags, digests: image.RepoDigests,
      projectId: 'project', ownershipEvidence: 'immutable artifact', attestedBy: 'owner', dataDisposition: 'reproducible-artifact',
      registryProofs: {
        [reference]: { manifest: index ? indexManifest : manifest, verifiedAt: Date.now() },
        ['registry.example/test@' + child]: { manifest, verifiedAt: Date.now() },
      },
    };
    image.Descriptor.digest = config;
    f.save();
    expect(() => f.request(adoption)).toThrow(/registry-rehydration-identity-unconfirmed/);
    image.Descriptor.digest = id;
    f.save();
    expect(f.request(adoption).registered).toBe(true);
    expect(f.request({ action: 'reconcile', targetIdentities: [id], registryProofs: adoption.registryProofs }).removed).toEqual([id]);
  });
  it('never adopts a pre-existing foreign image through a new pull/tag', () => {
    const f = fixture();f.values.images = [f.image()];f.save();f.request({ action: 'publish', references: [] });
    const pin = f.request({ action: 'prepare', image: 'registry.example/test:old' });f.request({ action: 'confirm', token: pin.token });f.request({ action: 'publish', references: [], nowMs: now + 600001 });
    expect(f.request({}).held[0].reason).toBe('legacy-image-ownership-needs-review');
  });
  it('matches tagged immutable rollback references to the Docker repository digest', () => {
    const f = fixture();
    f.born();
    const pinned = digest.replace('@', ':old@');
    f.request({ action: 'publish', references: [pinned] });
    expect(f.request({}).held[0]).toMatchObject({
      identity: id, reason: 'current-rollback-or-inflight-reference',
      referenceSources: [{ reference: pinned }],
    });
    const pin = f.request({ action: 'prepare', image: pinned, requirePresent: true });
    expect(pin.alreadyPresent).toBe(true);
    expect(f.request({ action: 'confirm', token: pin.token }).confirmed).toBe(true);
    expect(f.request({ action: 'prepare', image: pinned.replace('/test:', '/other:'), requirePresent: true })).toEqual({ absent: true });
  });
  it('pins and confirms an already local immutable image without a host inventory scan', () => {
    const f = fixture();
    f.values.images = [f.image()];
    f.save();
    const pinned = digest.replace('@', ':old@');
    const pin = f.request({ action: 'prepare', image: pinned, budgetBytes: 1, requirePresent: true });
    expect(pin.alreadyPresent).toBe(true);
    expect(f.request({ action: 'confirm', token: pin.token }).confirmed).toBe(true);
    const calls = fs.readFileSync(f.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(args => args[0] === 'image')).toEqual([
      ['image', 'inspect', digest],
      ['image', 'inspect', digest],
    ]);
    expect(f.request({}).held[0].reason).toBe('current-rollback-or-inflight-reference');
  });
  it('protects stopped containers, pending pulls, other masters, and newly added aliases', () => {
    const f = fixture();f.born();f.values.containers = [{ Id: 'stopped', Image: id, State: { Running: false } }];f.save();
    expect(f.request({}).held[0].reason).toBe('running-or-stopped-container-reference');
    f.values.containers = [];f.save();f.request({ action: 'prepare', image: digest });expect(f.request({}).held[0].reason).toBe('current-rollback-or-inflight-reference');
    const g = fixture();g.born();g.request({ action: 'publish', instanceId: 'other-master', references: [digest] });expect(g.request({}).held[0].reason).toBe('current-rollback-or-inflight-reference');
    const h = fixture();h.born();h.values.images[0].RepoTags.push('foreign:alias');h.save();expect(h.request({}).held[0].reason).toBe('foreign-alias-needs-review');
  });
  it('revalidates changed references and refuses a mismatched recovery identity or failed query', () => {
    const f = fixture();f.born();const result = f.request({ action: 'reconcile', targetIdentities: [id], registryProofs: { [digest]: { manifest: { config: { digest: 'sha256:' + 'c'.repeat(64) } }, verifiedAt: Date.now() } } });
    expect(result.removed).toEqual([]);expect(result.failed[0].reason).toBe('registry-rehydration-identity-unconfirmed');
    f.values.referenceDuringRemoval = true;f.save();expect(f.reconcile().removed).toEqual([]);
    f.values.fail = true;f.save();expect(f.request({})).toMatchObject({ scanStatus: 'partial', catalogError: 'docker-query-or-operation-unconfirmed', imageBytesEstimate: null, canExecute: false });expect(() => f.request({ action: 'reconcile' })).toThrow();
  });
  it('reserves peak capacity before pulling and does not invent a budget from released bytes', () => {
    const f = fixture();f.request({ action: 'publish', references: [] });
    expect(() => f.request({ action: 'prepare', image: 'missing:tag', budgetBytes: 1024, peakBytes: 2048 })).toThrow();
    expect(f.request({}).filesystem.netAvailableBytesDelta).toEqual(expect.any(Number));
  });
  it('settles completed failed refreshes of unchanged cached IDs across independent worker invocations', () => {
    const f=fixture();f.values.images=[f.image()];f.save();f.request({action:'publish',references:[]});
    for(let retry=0;retry<2;retry++){
      const pin=f.request({action:'prepare',image:'registry.example/test:old',forceNew:true,peakBytes:1024});
      expect(()=>f.request({action:'abort',token:pin.token})).toThrow(/failed-pull-created-an-image/);
      expect(f.request({action:'abort',token:pin.token,completedNativeOperation:true}).settled).toBe(true);
      expect(f.request({}).pullReservations).toEqual([]);
    }
  });
  it('keeps failed pull reservations when contents changed or native identity queries fail', () => {
    const f=fixture();f.values.images=[f.image()];f.save();f.request({action:'publish',references:[]});
    const pin=f.request({action:'prepare',image:'registry.example/test:old',forceNew:true,peakBytes:1024});
    f.values.images[0].Id='sha256:'+'c'.repeat(64);f.save();
    expect(()=>f.request({action:'abort',token:pin.token,completedNativeOperation:true})).toThrow(/failed-pull-created-an-image/);
    expect(f.request({}).pullReservations[0].reservedBytesEstimate).toBe(1024);
    f.values.fail=true;f.save();expect(()=>f.request({action:'abort',token:pin.token,completedNativeOperation:true})).toThrow();
    f.values.fail=false;f.save();expect(f.request({}).pullReservations[0].reservedBytesEstimate).toBe(1024);
  });
  it('adopts an explicitly attested legacy build only after exact metadata and registry proof, then keeps fresh native references protected', () => {
    const f=fixture();f.values.images=[f.image()];f.save();f.request({action:'publish',references:[]});
    const adoption={action:'adopt',identity:id,created:f.image().Created,aliases:f.image().RepoTags,digests:[digest],projectId:'retired-project',ownershipEvidence:'Original deployment record and reproducible image artifact',attestedBy:'system-owner-fixture',dataDisposition:'reproducible-artifact',registryProofs:{[digest]:{manifest:{config:{digest:id}},verifiedAt:Date.now()}}};
    expect(()=>f.request({...adoption,aliases:['unrelated:tag']})).toThrow();
    expect(()=>f.request({...adoption,registryProofs:{[digest]:{manifest:{config:{digest:'sha256:'+'c'.repeat(64)}},verifiedAt:Date.now()}}})).toThrow();
    expect(f.request(adoption).registered).toBe(true);expect(f.request({}).candidates).toHaveLength(1);
    f.values.containers=[{Id:'late-stopped-reference',Image:id,State:{Running:false}}];f.save();expect(f.reconcile().removed).toEqual([]);
    f.values.containers=[];f.save();expect(f.reconcile().removed).toEqual([id]);
  });
  it('exposes unresolved peak reservations without disclosing the capability token or treating them as zero usage', () => {
    const f=fixture();f.request({action:'publish',references:[]});const pin=f.request({action:'prepare',image:'pending:image',peakBytes:1024});
    const plan=f.request({});expect(plan.scanStatus).toBe('partial');expect(plan.pullReservations).toHaveLength(1);expect(plan.pullReservations[0].reservedBytesEstimate).toBe(1024);expect(JSON.stringify(plan)).not.toContain(pin.token);
  });
  it('tracks a second platform pull alias on the same ID without claiming unrelated aliases', () => {
    const f=fixture();f.born();const alias='registry.example/test:canonical';const pin=f.request({action:'prepare',image:alias,peakBytes:1});
    f.values.images[0].RepoTags.push(alias);f.save();f.request({action:'confirm',token:pin.token});f.request({action:'publish',references:[],nowMs:now+600001});
    expect(f.request({}).candidates[0].aliases).toEqual(expect.arrayContaining([alias,'registry.example/test:old']));
    expect(f.reconcile().removed).toEqual([id]);
  });
});
describe('image cache orchestration and durable status', () => {
  it('retries a busy runtime catalog with freshly read protection references', async () => {
    const exec = vi.fn<IShellExecutor['exec']>()
      .mockResolvedValueOnce({ exitCode: 3, stdout: '{"catalogError":"catalog-busy"}', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"published":true}', stderr: '' });
    const references = vi.fn<() => string[]>().mockReturnValueOnce(['previous']).mockReturnValueOnce(['current']);
    const service = new ImageCacheGovernance({ shell: { exec }, catalog: '/unused', instanceId: 'owned', budgetBytes: 1, protectedReferences: references });

    await expect(service.publish()).resolves.toEqual({ published: true });

    expect(exec.mock.calls.map(([, options]) => JSON.parse(options!.stdin!).references)).toEqual([['previous'], ['current']]);
    expect(exec.mock.calls[1][1]!.timeout).toBeLessThan(exec.mock.calls[0][1]!.timeout!);
  });

  it('does not retry a lock-busy request after its deployment lease expires', async () => {
    let current = true;
    const exec = vi.fn<IShellExecutor['exec']>().mockImplementationOnce(async () => {
      setTimeout(() => { current = false; }, 0);
      return { exitCode: 3, stdout: '{"catalogError":"catalog-busy"}', stderr: '' };
    });
    const service = new ImageCacheGovernance({ shell: { exec }, catalog: '/unused', instanceId: 'owned', budgetBytes: 1, protectedReferences: () => [] });
    await expect(service.prepare(digest, () => { if (!current) throw new Error('lease expired'); })).rejects.toThrow('lease expired');
    expect(exec).toHaveBeenCalledOnce();
  });

  it('does not repeat a native operation with an unconfirmed outcome', async () => {
    const exec = vi.fn<IShellExecutor['exec']>().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'native operation failed' });
    const service = new ImageCacheGovernance({ shell: { exec }, catalog: '/unused', instanceId: 'owned', budgetBytes: 1, protectedReferences: () => [] });
    await expect(service.confirm('receipt', () => {})).rejects.toThrow('对象身份或引用未确认');
    expect(exec).toHaveBeenCalledOnce();
  });

  it.each([
    { versionId: 'fixed-version' },
    { hasOneShotOptions: true },
  ])('protects an in-flight one-shot deployment without making it replayable (%j)', (oneShot) => {
    const commitSha = 'a'.repeat(40);
    const run = { id: 'run', branchId: 'branch', projectId: 'project', operationId: 'operation', operationGeneration: 4,
      configHash: 'config', commitSha, versionId: oneShot.versionId } as DeploymentRun;
    const intent = captureDeploymentIntent(run, {
      request: { kind: 'deploy', branchId: run.branchId, projectId: run.projectId, configHash: run.configHash,
        commitSha, commitPinned: true, trigger: 'manual', ...oneShot },
      input: { profiles: [{ id: 'web', dockerImage: digest }] as any, configuredEnv: {}, configHash: run.configHash,
        targetCommitSha: commitSha, ciTargetSha: undefined, profileOverrides: undefined },
    });
    const state = {
      getDeploymentIntents: () => [intent], getDeploymentRun: () => run,
      getBranch: () => ({ id: run.branchId }), getDeploymentVersions: () => [], getReleaseBatches: () => [],
    };
    expect(() => readDeploymentIntent(run, intent)).toThrow('Deployment intent target mismatch');
    expect(collectImageCacheReferences(state as any)).toContain(digest);
    expect(() => readDeploymentIntent(run, { ...intent, inputDigest: 'invalid' }, 'image-protection'))
      .toThrow('Deployment intent content mismatch');
    if (oneShot.versionId) {
      expect(() => readDeploymentIntent({ ...run, versionId: 'wrong-version' }, intent, 'image-protection'))
        .toThrow('Deployment intent target mismatch');
    }
  });
  it('does not call a registry or delete when durable audit is unavailable', async () => {
    const shell = { exec: vi.fn() };
    const service = new ImageCacheGovernance({ shell: shell as any, catalog: '/unused', instanceId: 'owned', budgetBytes: 1, protectedReferences: () => [] });
    const request = vi.spyOn(service, 'request').mockImplementation(async action => action === 'preview' ? { nextBatch: [{ identity: id, recoveryDigests: [digest] }] } : action === 'reconcile' ? { held: [], pending: [id], failed: [], counts: {} } : {});
    const result: any = await service.inspect(false);expect(shell.exec).not.toHaveBeenCalled();expect(result.failed).toHaveLength(1);
    const reconcile = request.mock.calls.find(c => c[0] === 'reconcile')?.[1];
    expect(typeof reconcile === 'function' ? reconcile() : reconcile).toMatchObject({ targetIdentities: [] });
  });
  it('preserves the current ledger anchor independently of idle cache generation order', () => {
    const state = { getDeploymentVersions: () => Array.from({ length: 8 }, (_, i) => ({ id: String(i), projectId: 'p', branchId: 'b', createdAt: '2026-11-' + String(10 - i).padStart(2, '0'), profiles: [{ profileId: 'web', artifactImage: 'image:' + i, reusable: true }] })), getBranch: () => ({ id: 'b', projectId: 'p', status: 'idle', currentVersionId: '7', lastAccessedAt: '2026-01-01' }), getProject: () => undefined, getDefaultBranchFor: () => undefined, getDeploymentIntents: () => [], getReleaseBatches: () => [] };
    const refs = collectImageCacheReferences(state as any);expect(refs).toContain('image:7');expect(refs).toContain('image:0');
  });
  it('pins the real default reusable rollback even when it lies outside both cache-generation windows', () => {
    const state = { getDeploymentVersions: () => Array.from({ length: 8 }, (_, i) => ({ id: String(i), projectId: 'p', branchId: 'b', createdAt: '2026-11-' + String(10 - i).padStart(2, '0'), profiles: [{ profileId: 'web', artifactImage: 'image:' + i, reusable: i === 7 }] })), getBranch: () => ({ id: 'b', projectId: 'p', status: 'idle', currentVersionId: '0', lastAccessedAt: '2026-01-01' }), getProject: () => undefined, getDefaultBranchFor: () => undefined, getDeploymentIntents: () => [], getReleaseBatches: () => [] };
    const refs = collectImageCacheReferences(state as any);expect(refs).toEqual(expect.arrayContaining(['image:0', 'image:1', 'image:7']));expect(refs).not.toContain('image:3');
  });
  it('restores an interrupted execution honestly and bounds retained evidence', () => {
    let saved: any;const journal = { read: () => saved, write: (v: any) => { saved = v; } };
    recordReclaimExecution(journal, { id: 'a'.repeat(32), status: 'running', report: { held: Array(2000).fill({ reason: 'protected' }), counts: { held: 2000 } } });
    const restored = resumedReclaimExecution(journal);expect(restored.status).toBe('interrupted');expect(restored.report.held).toHaveLength(20);expect(restored.report.counts.held).toBe(2000);
  });
  it('pins an old prepared batch version and releases its cache pin after cancellation without removing the version record', () => {
    const batch: any = { versionId:'7',branchId:'b',projectId:'p',status:'ready',targets:[] };
    const versions = Array.from({ length:8 },(_,i)=>({id:String(i),projectId:'p',branchId:'b',createdAt:new Date(2026,10,10-i).toISOString(),profiles:[{profileId:'web',artifactImage:'image:'+i,reusable:true}]}));
    const state = { getDeploymentVersions:()=>versions,getReleaseBatches:()=>[batch],getBranch:()=>({id:'b',projectId:'p',status:'idle',currentVersionId:'0',lastAccessedAt:'2026-01-01'}),getProject:()=>undefined,getDefaultBranchFor:()=>undefined,getDeploymentIntents:()=>[] };
    expect(collectImageCacheReferences(state as any)).toContain('image:7');
    batch.status='cancelled';expect(collectImageCacheReferences(state as any)).not.toContain('image:7');
    expect(versions.find(v=>v.id==='7')).toBeTruthy();
    batch.status='ready';batch.versionId='missing';expect(()=>collectImageCacheReferences(state as any)).toThrow(/未确认/);
  });
  it('preserves a batch fixed version when version-ledger pruning crosses its ordinary limit, including after restart', async () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'batch-version-retention-'));roots.push(root);const file=path.join(root,'state.json');
    const state=new StateService(file,root);state.load();state.addProject({id:'p',slug:'p',name:'p'} as any);state.addBranch({id:'b',projectId:'p',branch:'feature/batch',status:'idle',services:{}} as any);
    state.saveReleaseBatch({id:'batch',projectId:'p',branchId:'b',versionId:'v0',status:'ready',targets:[],createdAt:new Date().toISOString()} as any);
    for(let i=0;i<102;i++)state.addDeploymentVersion({id:'v'+i,projectId:'p',branchId:'b',commitSha:'a'.repeat(40),createdAt:new Date(2026,10,1,0,0,i).toISOString(),profiles:{}} as any);
    await state.flush();const restarted=new StateService(file,root);restarted.load();
    expect(restarted.getDeploymentVersion('v0')).toBeTruthy();expect(restarted.getDeploymentVersion('v1')).toBeUndefined();
    expect(restarted.getReleaseBatch('batch')?.versionId).toBe('v0');
  });
  it('recovers the same job identity from the actual state file after a service restart', async () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'resource-job-restart-'));roots.push(root);const file=path.join(root,'state.json');
    const state=new StateService(file,root);state.load();
    recordReclaimExecution(state.resourceRetirementJournal('owned-host','images'),{id:'c'.repeat(32),status:'running',startedAt:new Date().toISOString()});await state.flush();
    const restarted=new StateService(file,root);restarted.load();
    const result=resumedReclaimExecution(restarted.resourceRetirementJournal('owned-host','images'));expect(result.id).toBe('c'.repeat(32));expect(result.status).toBe('interrupted');
  });
});
