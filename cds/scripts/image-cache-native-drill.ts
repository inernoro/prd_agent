import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { OwnedResourceLifecycle } from '../src/services/owned-resource-task.js';
import { ImageCacheGovernance } from '../src/services/image-cache-governance.js';
import { ShellExecutor } from '../src/services/shell-executor.js';
import type { ServerEventLogSink, ServerEventRecord } from '../src/services/server-event-log-store.js';

// Only the disposable file-backed Linux guest used by the resource lifecycle drill.
assert.equal(process.env.CDS_NATIVE_RESOURCE_DRILL, '1');assert.equal(process.getuid?.(), 0);
assert.equal((await fs.readFile('/sys/block/vda/serial', 'utf8')).trim(), 'codex-cow-fixture-01');
const raw = new ShellExecutor();
const native = async (command: string) => {
  const result = await raw.exec(command, { timeout: 120000 });
  assert.equal(result.exitCode, 0, result.stderr);return result.stdout.trim();
};
const info = JSON.parse(await native("docker info --format '{{json .}}'"));assert.equal(info.DockerRootDir, '/data/docker');
const lifecycle = new OwnedResourceLifecycle({ shell: raw, instanceId: 'native-image-drill', workspaceBase: '/data/workspaces', catalog: '/data/catalog',
  reserveBytes: 32 * 1024 ** 2, maxBytes: 256 * 1024 ** 2, projectBudgetBytes: 4 * 1024 ** 3, globalBudgetBytes: 6 * 1024 ** 3, historyLimit: 8 });
const begin = () => lifecycle.begin({ projectId: 'fixed-native-image-project', owner: 'native-image-cache-drill', createdBy: 'file-backed-linux-vm', ttlSeconds: 3600, dataDisposition: 'ephemeral-test' });
const server = await begin();
const daemon = await server.startPrivateDaemon();
const privateNative = async (command: string) => {const result=await raw.exec(command,{env:{DOCKER_HOST:daemon.endpoint},timeout:120000});assert.equal(result.exitCode,0,result.stderr);return result.stdout.trim();};
const docker = async (args: string[]) => {const result=await daemon.exec(args);assert.equal(result.exitCode,0,result.stderr);return result.stdout.trim();};
const registry = '127.0.0.1:19587', repository = registry + '/fixed-resource';
const seed = repository + ':seed', alias = repository + ':alias';
const auditPath = path.join(server.handle.workspace, 'upstream-audit.jsonl');
const config = path.join(server.handle.workspace, 'registry.yml');
await fs.writeFile(config, `version: 0.1\nstorage:\n  filesystem:\n    rootdirectory: ${server.handle.workspace}/registry-data\nhttp:\n  addr: ${registry}\nlog:\n  level: error\n`, { mode: 0o600 });
const registryRun = server.run(['/usr/local/bin/registry', 'serve', config], { ttlSeconds: 600 }).catch(() => undefined);
const readyUntil = Date.now() + 30000;
while (true) {
  try { if ((await fetch('http://' + registry + '/v2/')).status === 200) break; } catch { /* Genuine local startup. */ }
  if (Date.now() > readyUntil) throw new Error('Private loopback registry did not become ready');
  await new Promise(resolve => setTimeout(resolve, 100));
}
const payload = randomBytes(4 * 1024 ** 2), checksum = createHash('sha256').update(payload).digest('hex');
const context=path.join(server.handle.workspace,'build-context');await fs.mkdir(context);await fs.writeFile(path.join(context,'payload'),payload);
await fs.writeFile(path.join(context,'Dockerfile'),'FROM alpine:3.21\nCOPY payload /payload\n');
await docker(['load','-i','/alpine.tar']);
await docker(['build','--quiet','--label','cds.acceptance.owner=native-image-cache-drill','-t',seed,context]);
await docker(['push',seed]);await docker(['tag',seed,alias]);await docker(['push',alias]);
const image=JSON.parse(await docker(['image','inspect',seed]))[0], built={identity:image.Id};
const digest:string=image.RepoDigests.find((value:string)=>value.startsWith(repository+'@sha256:'));assert(digest);
// Clear this born-empty private daemon through supported image APIs, including build parents.
for(let batch=0;batch<20;batch++){
 const identities=[...new Set((await docker(['image','ls','-aq','--no-trunc'])).split('\n').filter(Boolean))];if(!identities.length)break;
 const rows=JSON.parse(await docker(['image','inspect',...identities]));const parents=new Set(rows.map((row:any)=>row.Parent).filter(Boolean));
 const leaves=rows.filter((row:any)=>!parents.has(row.Id));assert(leaves.length);
 for(const row of leaves){for(const tag of row.RepoTags||[])await docker(['image','rm','--no-prune',tag]);if(!row.RepoTags?.length)await docker(['image','rm','--no-prune',row.Id]);}
}
assert.equal(await docker(['image','ls','-aq','--no-trunc']),'');
await docker(['load','-i','/alpine.tar']); // A shared base remains protected throughout cache retirement.
const audit: ServerEventLogSink = {
  record() { throw new Error('The drill requires synchronous durable audit'); },
  async recordImmediate(record) {
    const fd = await fs.open(auditPath, 'a', 0o600);
    try { await fd.writeFile(JSON.stringify({ _id: randomUUID(), ts: new Date().toISOString(), ...record }) + '\n');await fd.sync(); }
    finally { await fd.close(); }
  },
  async findRecent(filter) {
    const rows = (await fs.readFile(auditPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    return rows.filter(row => (!filter?.requestId || row.requestId === filter.requestId) && (!filter?.projectId || row.projectId === filter.projectId)).slice(-(filter?.limit || 100)) as ServerEventRecord[];
  },
};
let connectionFailure = false, afterManifest: (() => Promise<void>) | undefined;
const shell = { exec: async (command: string, options?: Parameters<ShellExecutor['exec']>[1]) => {
  // Transport exception is confined to this guest's synthetic loopback registry.
  if (command.startsWith("docker manifest inspect '127.0.0.1:19587/")) command = command.replace('docker manifest inspect ', 'docker manifest inspect --insecure ');
  const result = await raw.exec(command, { ...options, env:{...options?.env,DOCKER_HOST:connectionFailure?'unix://'+server.handle.workspace+'/missing.sock':daemon.endpoint} });
  if (command.startsWith('docker manifest inspect ') && result.exitCode === 0 && afterManifest) { const hook = afterManifest;afterManifest = undefined;await hook(); }
  return result;
} };
let current: string[] = [];
const cache = new ImageCacheGovernance({ shell, catalog: path.join(server.handle.workspace, 'image-catalog'), instanceId: 'native-image-main', budgetBytes: 64 * 1024 ** 2, peakBytes: 16 * 1024 ** 2, protectedReferences: () => current, audit });
for (const reference of [seed, alias]) {
  const pin = await cache.prepare(reference, () => {});await privateNative(`docker pull ${reference}`);await cache.confirm(pin.token, () => {});
}
// Accelerated bridge-window expiry, not ten minutes of real production observation.
await cache.request('publish', { references: [], nowMs: Date.now() + 600001 });
const plan = await cache.inspect();assert(plan.candidates.some((row: any) => row.identity === built.identity && row.aliases.length === 2));
current = [digest];assert((await cache.inspect()).held.some((row: any) => row.identity === built.identity && row.reason === 'current-rollback-or-inflight-reference'));
current = [];
const peer = new ImageCacheGovernance({ ...cache.options, instanceId: 'native-image-peer', protectedReferences: () => [digest] });
await peer.publish();assert((await cache.inspect()).held.some((row: any) => row.identity === built.identity && row.reason === 'current-rollback-or-inflight-reference'));
await peer.request('publish', { references: [] });
let protectedContainer: string | undefined;
afterManifest = async () => {
  protectedContainer=await docker(['create','--network','none',built.identity,'sleep','3600']);await docker(['start',protectedContainer]);await docker(['stop','--time','1',protectedContainer]);
};
const concurrent: any = await cache.inspect(false);assert.deepEqual(concurrent.removed, []);
assert(concurrent.held.some((row: any) => row.identity === built.identity && row.reason === 'running-or-stopped-container-reference'));
assert(protectedContainer);await docker(['rm',protectedContainer]);
connectionFailure = true;await assert.rejects(() => cache.inspect());connectionFailure = false;
assert((await cache.inspect()).candidates.some((row: any) => row.identity === built.identity));
// A real EISDIR audit-write failure must hold the exact artifact, after preserving earlier evidence.
await fs.rename(auditPath, auditPath + '.preserved');await fs.mkdir(auditPath);
const failedAudit: any = await cache.inspect(false);assert.deepEqual(failedAudit.removed, []);assert(failedAudit.failed.some((row: any) => row.identity === built.identity));
await fs.rmdir(auditPath);await fs.rename(auditPath + '.preserved', auditPath);
const removed: any = await cache.inspect(false);assert.deepEqual(removed.removed, [built.identity]);assert(removed.filesystem.netAvailableBytesDelta > 3 * 1024 ** 2);
const pin = await cache.prepare(digest, () => {});await privateNative(`docker pull ${digest}`);await cache.confirm(pin.token, () => {});
assert.equal(JSON.parse(await privateNative(`docker image inspect ${digest}`))[0].Id, built.identity);
assert.equal((await docker(['run','--rm','--network','none',digest,'sha256sum','/payload'])).split(' ')[0],checksum);
await cache.request('publish', { references: [], nowMs: Date.now() + 600001 });await cache.inspect(false);
// Native pull outside the birth protocol is legacy until an owner explicitly verifies it.
await privateNative(`docker pull ${digest}`);const legacy = (await cache.inspect()).held.find((row: any) => row.identity === built.identity);assert.equal(legacy.reason, 'legacy-image-ownership-needs-review');
await cache.adopt({ identity: built.identity, created: legacy.created, aliases: legacy.aliases, digests: legacy.digests, projectId: 'fixed-native-image-project', ownershipEvidence: 'This drill built the synthetic random payload and published this exact registry config', attestedBy: 'isolated-native-fixture-owner', dataDisposition: 'reproducible-artifact' });
assert.deepEqual((await cache.inspect(false)).removed, [built.identity]);
const records = await audit.findRecent!({ limit: 100 });assert(records.length >= 3);assert(records.every(row => row.operationId && row.requestId));
assert(records.some(row => String(row.details?.snapshot).includes(built.identity)));
await docker(['image','inspect','alpine:3.21']);
const result = { provenance: 'integration-live', scope: 'actual private XFS/Docker/loopback OCI registry, production governance and audit factory, durable file test sink; production Mongo sink is not replaced in application code',
  exactRegistryIdentityVerified: true, sameIdAliasesRetiredOnce: true, stoppedContainerCreatedAfterPlanProtected: true, currentRollbackAndOtherMasterProtected: true,
  realConnectionFailureRetained: true, realAuditWriteFailureRetained: true, rehydratedIdAndPayloadChecksumPreserved: true, explicitLegacyAdoptionValidated: true,
  registryAuditEvents: records.length, filesystemNetAvailableBytesDelta: removed.filesystem.netAvailableBytesDelta, bridgeWindowAccelerated: true };
await fs.writeFile('/data/image-cache-integration-result.json', JSON.stringify(result));
await server.finish('completed');await registryRun;
console.log('IMAGE_CACHE_NATIVE_RESULT', JSON.stringify(result));console.log('DRILL_COMPLETE');
