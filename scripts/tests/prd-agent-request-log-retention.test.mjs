import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test} from 'node:test';
const source = readFileSync(new URL('../prd-agent-request-log-retention.js', import.meta.url), 'utf8').split("if (typeof module")[0];
const scope = vm.createContext({Date, Number, Error});
vm.runInContext(source, scope);
const now = new Date('2026-11-15T00:00:00Z');
function fakeDb(indexed = true) {
  let rows = [{_id:1, date: '2026-01-01'}, {_id:2, date: '2026-11-14'}];
  let deleted = 0;
  const collection = {
    getIndexes: async () => indexed ? [{key:{StartedAt:-1}}] : [],
    find(filter) {
      const cutoff = filter.$or[0].StartedAt.$lt;
      let limit = 1;
      return {sort(){return this},limit(n){limit=n;return this},maxTimeMS(){return this},
        toArray:async()=> rows.filter(r => r.date < cutoff).slice(0,limit)};
    },
    deleteMany: async filter => {
      assert.equal(filter.$and[0].$or.length,2);
      const ids = filter.$and[1]._id.$in;
      const count = rows.filter(r=>ids.includes(r._id)).length;
      rows=rows.filter(r=>!ids.includes(r._id));deleted+=count;return {deletedCount:count};
    }
  };
  return {getCollection:n=>{assert.equal(n,'apirequestlogs');return collection},getName:()=> 'prdagent',
    deleted:()=>deleted, rows:()=>rows};
}
test('dry run preserves every record and reports eligible backlog', async()=>{
  const db=fakeDb(); const r=await scope.retainRequestLogs(db,{now});
  assert.equal(db.deleted(),0); assert.equal(r.backlog,true); assert.equal(r.cutoff,'2026-10-16T00:00:00.000Z');
});
test('execution removes only expired rows with bounded batches',async()=>{
  const db=fakeDb();const r=await scope.retainRequestLogs(db,{now,execute:true,batchSize:1,maxBatches:1});
  assert.equal(r.deleted,1); assert.equal(db.rows()[0]._id,2);assert.equal(r.backlog,false);
});
test('missing time index and unsafe retention fail closed', async()=>{
  await assert.rejects(scope.retainRequestLogs(fakeDb(false),{now}),/index required/);
  await assert.rejects(scope.retainRequestLogs(fakeDb(),{now,days:0}),/Invalid bounded/);
});
