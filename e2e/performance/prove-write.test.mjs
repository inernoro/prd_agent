import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { workload, browserScenarios, summarize } from './metrics.mjs';

test('真实CLI接受当前v4写入合同，未知版本、错误流程和原始核账不一致仍拒绝', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'map-write-proof-'));
  const rows=['home','knowledge-list','document-open','write-save','write-readback','write-versions','write','journey']
    .flatMap(name=>Array.from({length:32},()=>({phase:'normal',name,ok:true,ms:20,app:18,external:0})));
  const result={commit:'test-sha',contract:{workload:structuredClone(workload)},
    execution:{profile:'normal',state:'complete'},finishedAt:'2026-11-16T00:00:00Z',
    browser:{pass:true,samples:Object.fromEntries(browserScenarios.map(name=>[name,[100,100,100]]))},
    buildIdentity:{api:{actualCommit:'test-sha',expectedCommit:'test-sha',commitMatch:'match'},webEntries:['/assets/index-test-sha.js']},
    phases:[{name:'normal',seconds:120,metrics:summarize(rows,120)}]};
  const fixture={writers:Array.from({length:128},(_,i)=>`writer-${i}`),totalDocuments:248};
  const invoke=()=>{
    fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result));
    fs.writeFileSync(path.join(dir,'fixture.json'),JSON.stringify(fixture));
    fs.writeFileSync(path.join(dir,'requests.ndjson'),rows.map(r=>JSON.stringify(r)).join('\n'));
    return spawnSync(process.execPath,[fileURLToPath(new URL('./prove-write.mjs',import.meta.url)),dir],{encoding:'utf8'});
  };
  try {
    assert.equal(workload.version,4,'本轮回归针对已部署执行入口的v4合同');
    const valid=invoke();assert.equal(valid.status,0,valid.stderr);assert.equal(JSON.parse(valid.stdout).verified,true);
    result.contract.workload.version=5;assert.notEqual(invoke().status,0,'未知合同不得自动放行');
    result.contract.workload.version=4;result.contract.workload.writeFlow='create-and-delete';assert.notEqual(invoke().status,0);
    result.contract.workload.writeFlow='edit-existing-document';rows[0].ok=false;
    const inconsistent=invoke();assert.notEqual(inconsistent.status,0);assert.match(inconsistent.stderr,/原始请求与成功失败统计不一致/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
