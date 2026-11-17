/** Explicit local-only drill against original SeaTunnel and disposable MongoDBs. Never runs in the default suite. */
import { readFile, appendFile, writeFile } from 'node:fs/promises';
import { MongoClient, Long } from 'mongodb';
import { DtsService } from '../src/services/dts.js';
import { DtsStore } from '../src/services/dts-store.js';
import type { StateService } from '../src/services/state.js';
import type { ServerEventLogSink } from '../src/services/server-event-log-store.js';
import { strict as assert } from 'node:assert';

const folder = process.env.DTS_DRILL_DIRECTORY;
if (!folder || !folder.startsWith('/tmp/')) throw new Error('DTS_DRILL_DIRECTORY must be a private disposable /tmp folder');
const auth = JSON.parse(await readFile(`${folder}/engine-private.json`, 'utf8'));
const env = { DTS_SOURCE: 'mongodb://127.0.0.1:18881', DTS_TARGET: 'mongodb://127.0.0.1:18882', DTS_ENGINE_USER: auth.username, DTS_ENGINE_PASSWORD: auth.password };
const project = 'dts_native_qa', database = 'dts_native_qa';
const src = new MongoClient(env.DTS_SOURCE), dst = new MongoClient(env.DTS_TARGET);
const store = new DtsStore(env.DTS_TARGET, database);
const actor = { kind: 'static' as const, id: 'qa' };
const events: unknown[] = [];
const sink = { async recordImmediate(event: unknown) { events.push(event); await appendFile(`${folder}/drill-audit.jsonl`, JSON.stringify(event) + '\n'); },
  async findRecent() { return events; } } as unknown as ServerEventLogSink;
const service = new DtsService(store, { getCustomEnv: () => env } as unknown as StateService, sink, async () => true);
const fields = { _id: 'string', name: 'string', revision: 'int' };
async function wait(id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const run = await service.refresh(project, id);
    if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('native job did not finish within drill budget');
}
try {
  await src.connect(); await dst.connect();
  // Only this dedicated drill database may be reset, on loopback ports fixed above.
  await src.db(database).dropDatabase(); await dst.db(database).dropDatabase();
  await src.db(database).collection('records').insertMany([{ _id: 'existing', name: 'production', revision: 2 }, { _id: 'new', name: 'new account', revision: 1 }] as never);
  await dst.db(database).collection('records').insertMany([{ _id: 'existing', name: 'standby', revision: 1, localOnly: 'keep' }, { _id: 'target-only', name: 'acceptance', revision: 1 }] as never);
  await service.configureEngine(project, { baseUrl: 'http://127.0.0.1:18885', version: '3.0.0', usernameEnv: 'DTS_ENGINE_USER', passwordEnv: 'DTS_ENGINE_PASSWORD' });
  const base = { kind: 'mongo', database, collection: 'records', contract: { id: 'account-profile', version: 1, accepts: [1], fields }, accountFields: ['name', 'revision'] };
  const source = await service.addConnection(project, { ...base, environmentRole: 'production', name: 'production', uriEnv: 'DTS_SOURCE' });
  const target = await service.addConnection(project, { ...base, environmentRole: 'standby', allowWrite: true, name: 'standby', uriEnv: 'DTS_TARGET' });
  const append = await service.plan(project, source.id, target.id, 'append-only', actor);
  assert.equal(append.insertCount, 1); assert.equal(append.skipCount, 1);
  const a = await service.start(project, append.id, 'native-append', actor);
  assert.equal((await service.start(project, append.id, 'native-append', actor)).id, a.id);
  const appended = await wait(a.id); assert.equal(appended.status, 'completed', appended.message);
  assert.equal((await dst.db(database).collection('records').findOne({ _id: 'existing' as never }))?.name, 'standby');
  const daily = await service.plan(project, source.id, target.id, 'account-authority', actor);
  const b = await service.start(project, daily.id, 'native-daily', actor);
  const reconciled = await wait(b.id); assert.equal(reconciled.status, 'completed', reconciled.message);
  const existing = await dst.db(database).collection('records').findOne({ _id: 'existing' as never });
  assert.equal(existing?.name, 'production'); assert.equal(existing?.localOnly, 'keep');
  assert.equal(await dst.db(database).collection('records').countDocuments(), 3);
  const repeat = await service.plan(project, source.id, target.id, 'append-only', actor);
  assert.equal(repeat.insertCount, 0);
  // A policy must insert the full approved contract before daily profile-only updates.
  await src.db(database).collection('policy_accounts').insertMany([{ _id: 'existing', name: 'production', revision: 2 }, { _id: 'policy-new', name: 'new account', revision: 7 }] as never);
  await dst.db(database).collection('policy_accounts').insertOne({ _id: 'existing', name: 'standby', revision: 19, localOnly: 'keep' } as never);
  const policyBase = { ...base, collection: 'policy_accounts', accountFields: ['name'] };
  const ps = await service.addConnection(project, { ...policyBase, environmentRole: 'production', name: 'policy source', uriEnv: 'DTS_SOURCE' });
  const pt = await service.addConnection(project, { ...policyBase, environmentRole: 'standby', allowWrite: true, name: 'policy target', uriEnv: 'DTS_TARGET' });
  await assert.rejects(service.plan(project, ps.id, pt.id, 'account-authority', actor), /只追加/);
  const scheduled = await service.addPolicy(project, { sourceId: ps.id, targetId: pt.id }, actor);
  await store.put('policies', { ...scheduled, reconcileHour: 0 }); await service.tick([project]);
  let saved = (await service.policies(project)).find(p => p.id === scheduled.id)!;
  const discovered = await wait(saved.lastRunId!); assert.equal(discovered.status, 'completed', discovered.message); assert.equal(discovered.plan.mode, 'append-only');
  assert.equal((await dst.db(database).collection('policy_accounts').findOne({ _id: 'policy-new' as never }))?.revision, 7);
  assert.equal((await dst.db(database).collection('policy_accounts').findOne({ _id: 'existing' as never }))?.name, 'standby');
  saved = (await service.policies(project)).find(p => p.id === scheduled.id)!;
  await store.put('policies', { ...saved, nextDiscoveryAt: new Date(0).toISOString() }); await service.tick([project]);
  saved = (await service.policies(project)).find(p => p.id === scheduled.id)!;
  const calibrated = await wait(saved.lastRunId!); assert.equal(calibrated.status, 'completed', calibrated.message); assert.equal(calibrated.plan.mode, 'account-authority');
  const preserved = await dst.db(database).collection('policy_accounts').findOne({ _id: 'existing' as never });
  assert.equal(preserved?.name, 'production'); assert.equal(preserved?.revision, 19); assert.equal(preserved?.localOnly, 'keep');
  await service.setPolicy(project, scheduled.id, false, actor);
  console.log('PASS MongoDB policy inserts full approved records before whitelist-only daily updates');
  await dst.db(database).collection('records').createIndex({name:1},{unique:true});
  await src.db(database).collection('records').insertOne({_id:'conflict',name:'production',revision:3} as never);
  const conflictPlan=await service.plan(project,source.id,target.id,'append-only',actor);
  const conflictRun=await service.start(project,conflictPlan.id,'native-conflict',actor),failed=await wait(conflictRun.id);
  assert.equal(failed.status,'failed',failed.message);
  assert.equal((await dst.db(database).collection('records').findOne({name:'production'}))?._id,'existing');
  await src.db(database).collection('records').updateOne({_id:'conflict' as never},{$set:{name:'recovered'}});
  const resumed=await service.control(project,failed.id,'resume',actor),recovered=await wait(resumed.id);assert.equal(recovered.status,'completed',recovered.message);
  console.log('PASS MongoDB native uniqueness failure preserves target; fresh resume completes');
  // Exercise every admitted BSON type using the official connector, including an Int64 beyond JS safe precision.
  const typedFields = { _id: 'string', text: 'string', flag: 'boolean', count: 'int', big: 'bigint', amount: 'double', at: 'timestamp' };
  await src.db(database).collection('typed').insertOne({ _id: 'types', text: '中文', flag: true, count: 42, big: Long.fromString('9223372036854775806'), amount: 1.25, at: new Date('2026-11-17T00:00:00Z') } as never);
  await dst.db(database).createCollection('typed');
  const ts = await service.addConnection(project, { ...base, name: 'typed source', uriEnv: 'DTS_SOURCE', collection: 'typed', contract: { ...base.contract, id: 'bson-types', fields: typedFields }, accountFields: [] });
  const tt = await service.addConnection(project, { ...base, allowWrite: true, name: 'typed target', uriEnv: 'DTS_TARGET', collection: 'typed', contract: { ...base.contract, id: 'bson-types', fields: typedFields }, accountFields: [] });
  const tp = await service.plan(project, ts.id, tt.id, 'append-only', actor);
  const tr = await service.start(project, tp.id, 'native-types', actor); const typed = await wait(tr.id);
  assert.equal(typed.status, 'completed', typed.message);
  await writeFile(`${folder}/drill-results.json`, JSON.stringify({ engine: '3.0.0', append: service.publicRun(appended), daily: service.publicRun(reconciled), repeatInsertCount: repeat.insertCount, auditCount: events.length, typed: service.publicRun(typed), policy: { newAccount: service.publicRun(discovered), daily: service.publicRun(calibrated), fullContractInserted: true, targetOnlyFieldsPreserved: true } }, null, 2));
  console.log('PASS: real SeaTunnel REST → native MongoDB append, daily selected-field reconciliation, independent verification and idempotent start');
} finally { await store.close(); await src.close(); await dst.close(); }
