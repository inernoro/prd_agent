import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_CACHE_PROGRAM } from '../../src/services/image-cache-program.js';
import { ImageCacheGovernance, collectImageCacheReferences } from '../../src/services/image-cache-governance.js';
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
 rows=[r for r in v['images'] if any(q in [r['Id'],*r['RepoTags'],*r['RepoDigests']] for q in a[2:])];print(json.dumps(rows))
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
  const request = (input: any) => JSON.parse(execFileSync('python3', ['-c', IMAGE_CACHE_PROGRAM], { input: JSON.stringify({ action: 'preview', catalog: path.join(root, 'catalog'), instanceId: 'master-a', budgetBytes: 1024 ** 3, nowMs: now, ...input }), env: { ...process.env, PATH: root + ':' + process.env.PATH }, encoding: 'utf8', timeout: 30_000 }));
  const image = (aliases = ['registry.example/test:old']) => ({ Id: id, Created: '2026-10-01T00:00:00Z', RepoTags: aliases, RepoDigests: [digest], Size: 1024, Os: 'linux', Architecture: 'amd64', Config: { Labels: {} } });
  const born = () => { request({ action: 'publish', references: [] });const pin = request({ action: 'prepare', image: 'registry.example/test:old', peakBytes: 1024 });values.images = [image()];save();request({ action: 'confirm', token: pin.token });request({ action: 'publish', references: [], nowMs: now + 600001 }); };
  const reconcile = () => request({ action: 'reconcile', targetIdentities: [id], registryProofs: { [digest]: { manifest: { config: { digest: id } }, verifiedAt: Date.now() } } });
  return { root, request, image, born, reconcile, save, values, calls };
}
describe('image ID governance native protocol with a simulated Docker CLI', () => {
  it('retires all known aliases once by physical identity with exact registry config proof', () => {
    const f = fixture();f.born();expect(f.request({}).candidates).toHaveLength(1);
    expect(f.reconcile().removed).toEqual([id]);expect(JSON.parse(fs.readFileSync(path.join(f.root, 'docker.json'), 'utf8')).images).toEqual([]);
    expect(f.request({}).candidates).toEqual([]);
  });
  it('never adopts a pre-existing foreign image through a new pull/tag', () => {
    const f = fixture();f.values.images = [f.image()];f.save();f.request({ action: 'publish', references: [] });
    const pin = f.request({ action: 'prepare', image: 'registry.example/test:old' });f.request({ action: 'confirm', token: pin.token });f.request({ action: 'publish', references: [], nowMs: now + 600001 });
    expect(f.request({}).held[0].reason).toBe('legacy-image-ownership-needs-review');
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
    f.values.fail = true;f.save();expect(() => f.request({})).toThrow();
  });
  it('reserves peak capacity before pulling and does not invent a budget from released bytes', () => {
    const f = fixture();f.request({ action: 'publish', references: [] });
    expect(() => f.request({ action: 'prepare', image: 'missing:tag', budgetBytes: 1024, peakBytes: 2048 })).toThrow();
    expect(f.request({}).filesystem.netAvailableBytesDelta).toEqual(expect.any(Number));
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
  it('does not call a registry or delete when durable audit is unavailable', async () => {
    const shell = { exec: vi.fn() };
    const service = new ImageCacheGovernance({ shell: shell as any, catalog: '/unused', instanceId: 'owned', budgetBytes: 1, protectedReferences: () => [] });
    const request = vi.spyOn(service, 'request').mockImplementation(async action => action === 'preview' ? { nextBatch: [{ identity: id, recoveryDigests: [digest] }] } : action === 'reconcile' ? { held: [], pending: [id], failed: [], counts: {} } : {});
    const result: any = await service.inspect(false);expect(shell.exec).not.toHaveBeenCalled();expect(result.failed).toHaveLength(1);
    expect(request.mock.calls.find(c => c[0] === 'reconcile')?.[1]).toMatchObject({ targetIdentities: [] });
  });
  it('preserves the current ledger anchor independently of idle cache generation order', () => {
    const state = { getDeploymentVersions: () => Array.from({ length: 8 }, (_, i) => ({ id: String(i), projectId: 'p', branchId: 'b', createdAt: '2026-11-' + String(10 - i).padStart(2, '0'), profiles: [{ profileId: 'web', artifactImage: 'image:' + i, reusable: true }] })), getBranch: () => ({ id: 'b', projectId: 'p', status: 'idle', currentVersionId: '7', lastAccessedAt: '2026-01-01' }), getProject: () => undefined, getDefaultBranchFor: () => undefined, getDeploymentIntents: () => [] };
    const refs = collectImageCacheReferences(state as any);expect(refs).toContain('image:7');expect(refs).toContain('image:0');
  });
  it('pins the real default reusable rollback even when it lies outside both cache-generation windows', () => {
    const state = { getDeploymentVersions: () => Array.from({ length: 8 }, (_, i) => ({ id: String(i), projectId: 'p', branchId: 'b', createdAt: '2026-11-' + String(10 - i).padStart(2, '0'), profiles: [{ profileId: 'web', artifactImage: 'image:' + i, reusable: i === 7 }] })), getBranch: () => ({ id: 'b', projectId: 'p', status: 'idle', currentVersionId: '0', lastAccessedAt: '2026-01-01' }), getProject: () => undefined, getDefaultBranchFor: () => undefined, getDeploymentIntents: () => [] };
    const refs = collectImageCacheReferences(state as any);expect(refs).toEqual(expect.arrayContaining(['image:0', 'image:1', 'image:7']));expect(refs).not.toContain('image:3');
  });
  it('restores an interrupted execution honestly and bounds retained evidence', () => {
    let saved: any;const journal = { read: () => saved, write: (v: any) => { saved = v; } };
    recordReclaimExecution(journal, { id: 'a'.repeat(32), status: 'running', report: { held: Array(2000).fill({ reason: 'protected' }), counts: { held: 2000 } } });
    const restored = resumedReclaimExecution(journal);expect(restored.status).toBe('interrupted');expect(restored.report.held).toHaveLength(20);expect(restored.report.counts.held).toBe(2000);
  });
  it('recovers the same job identity from the actual state file after a service restart', async () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'resource-job-restart-'));roots.push(root);const file=path.join(root,'state.json');
    const state=new StateService(file,root);state.load();
    recordReclaimExecution(state.resourceRetirementJournal('owned-host','images'),{id:'c'.repeat(32),status:'running',startedAt:new Date().toISOString()});await state.flush();
    const restarted=new StateService(file,root);restarted.load();
    const result=resumedReclaimExecution(restarted.resourceRetirementJournal('owned-host','images'));expect(result.id).toBe('c'.repeat(32));expect(result.status).toBe('interrupted');
  });
});
