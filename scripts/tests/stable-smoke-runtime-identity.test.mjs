import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeProductCommits, productCommitForEnvironment, validateInspectionSourceContext } from '../stable-smoke-runtime-identity.mjs';
import { canReuseVisualPlan, validateProductionVisualUnlock, mergeVisualPlans } from '../stable-smoke-run.mjs';
const a='a'.repeat(40), b='b'.repeat(40), c='c'.repeat(40);
test('运行版本只接受有限环境与完整提交',()=>{
 assert.deepEqual(normalizeProductCommits({cds:a,production:b}),{cds:a,production:b});
 for(const value of [{prod:a},{cds:'abc'},[],null]) assert.throws(()=>normalizeProductCommits(value));
 assert.equal(productCommitForEnvironment({commit:a},'production'),a);
});
test('巡检客户端可独立更新，业务代码差异必须阻断',()=>{
 assert.equal(validateInspectionSourceContext({sourceCommit:b,productCommit:a,changedFiles:['e2e/specs/stable-smoke.spec.ts','scripts/stable-smoke-run.mjs']}).runtimeEquivalent,true);
 for(const path of ['prd-api/src/App.cs','prd-admin/src/App.tsx','llmgw/src/main.ts']) assert.throws(()=>validateInspectionSourceContext({sourceCommit:b,productCommit:a,changedFiles:[path]}));
 assert.throws(()=>validateInspectionSourceContext({sourceCommit:'bad',productCommit:a}));
});
const identity={runId:'stsmk-current',commit:a};
const plan={schemaVersion:'3.0',...identity,scope:'full',captureStartedAt:'2026-11-06T00:00:00Z',environments:['cds'],environmentOrigins:{cds:'https://cds.example.test'},slots:[{moduleId:'file-parsing'}],modules:[]};
test('正式版本更新不污染既有CDS截图计划，但旧正式解锁失效',()=>{
 const expected={...identity,environments:['cds'],productCommits:{cds:a,production:c}};
 assert.equal(canReuseVisualPlan(plan,expected),true);
 const unlock={...identity,status:'unlocked',cdsFunctionalGate:'pass',cdsVisualVerdict:'通过',unlockedAt:'2026-11-06T00:00:00Z',productCommits:{cds:a,production:b}};
 assert.equal(validateProductionVisualUnlock(unlock,{...identity,productCommits:{cds:a,production:b}}).valid,true);
 assert.equal(validateProductionVisualUnlock(unlock,{...identity,productCommits:{cds:a,production:c}}).valid,false);
 const prod={...plan,environments:['production'],environmentOrigins:{production:'https://prod.example.test'},productCommits:{cds:a,production:b}};
 assert.equal(canReuseVisualPlan(prod,{...expected,environments:['production']}),false);
 const merged=mergeVisualPlans(plan,prod);assert.deepEqual(merged.productCommits,{cds:a,production:b});
 assert.throws(()=>mergeVisualPlans(plan,{...prod,productCommits:{cds:c,production:b}}));
});
