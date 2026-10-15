import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertDefaultPeachRequest} from '../../e2e/utils/stableSmokeDefaultJourney.mjs';
const proof={pool:{isDefault:true,code:'configured-public-id',name:'具体配置型号'},selectedLabel:'具体配置型号',request:{prompt:'白桃',size:'1024x1024',modelId:'configured-public-id',platformId:'logical-model',expectedImageRefCount:0,targetKey:'owned-canvas'}};
test('REG-visual-policy-001 真人默认白桃实际发送合同成立',()=>assert.doesNotThrow(()=>assertDefaultPeachRequest(proof)));
for(const [label,patch] of [['蓝杯不能替代白桃',{prompt:'蓝色陶瓷杯'}],['错误尺寸',{size:'1536x1024'}],['静默换型',{modelId:'another'}],['缺引用声明',{expectedImageRefCount:undefined}],['静默引用',{imageRefs:[{refId:1}]}],['缺画布身份',{targetKey:''}]])test(`REG-visual-policy-001 ${label}必须变红`,()=>assert.throws(()=>assertDefaultPeachRequest({...proof,request:{...proof.request,...patch}})));
test('REG-visual-policy-001 抽象池名和界面漂移不得算具体默认',()=>{assert.throws(()=>assertDefaultPeachRequest({...proof,pool:{...proof.pool,name:'图片生成默认池'}}));assert.throws(()=>assertDefaultPeachRequest({...proof,selectedLabel:'别的型号'}));});
test('REG-visual-policy-001 原主例必须接真人创建与发送，不直调API冒充',()=>{
 const source=readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts',import.meta.url),'utf8');
 const primary=source.split("test('[CORE-004][GW-005][GW-008]")[1].split("test('[VIS-003]")[0];
 assert.match(primary,/createDefaultWorkspaceThroughUi\(/);
 assert.match(primary,/submitDefaultPeachThroughUi\(/);
 assert.match(primary,/const generationPrompt = '白桃'/);
});
