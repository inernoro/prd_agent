import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getMapLoginTarget, openGatewayLogicalModelDetails, selectGatewayImageLogicalModel, validateMapLoginSnapshot, assertScopedSyntheticUsername, getQuickEditInput, blockUnsafeProductionFixture, validateReadOnlyAvatarAsset, readGatewayNoCallLogProbe, blockUnscopedObservationFixture, blockPublicCommunityReads, blockRetiredAsrPoolAudit } from '../../e2e/utils/stableSmokeUiContract.mjs';
import { createStableSmokeVisualEvidence } from '../../e2e/utils/stableSmokeVisualEvidence.mjs';
import { productionReadOnlyGrep } from '../stable-smoke-run.mjs';
import { buildNotRunLedger, collectPlaywrightCases } from '../stable-smoke-results.mjs';

test('巡检主旅程接入语义登录与精确模型详情，且仅改被测文件也触发CI守卫',()=>{
 const spec=readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts',import.meta.url),'utf8');
 for(const helper of ['getMapLoginTarget','selectGatewayImageLogicalModel','openGatewayLogicalModelDetails'])assert.ok((spec.match(new RegExp(`${helper}\\(`,'g'))||[]).length>=1,`${helper}没有真实调用者`);
 assert.doesNotMatch(spec,/getByTestId\('login-card'\)/);
 const workflow=readFileSync(new URL('../../.github/workflows/ci.yml',import.meta.url),'utf8');
 assert.match(workflow,/'e2e\/utils\/stableSmoke\*\.mjs'/);
 assert.match(workflow,/'e2e\/specs\/stable-smoke\.spec\.ts'/);
});

const passwordSnapshot = { headingCount: 1, hasBrand: true, usernameCount: 1, passwordCount: 1, submitCount: 1, ssoCount: 0 };

test('REG-stsmk-account-scope-001 原GW配置不读取退场ASR池，原ASR断言保留且先于取数停跑', () => {
  const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  const config = source.split("test('[GW-001][GW-002][GW-003][GW-004][REG-llmgw-auth-001]")[1]?.split("\n  test('")[0];
  assert.ok(config);
  assert.doesNotMatch(config, /REG-asr-routing-001|pool-types|pools\?modelType=asr|asrType|asrPools/);
  for (const kept of ['/gw/auth/context', '/gw/models?enabled=true', '/gw/logical-models?enabled=true', '/gw/key-health', '/gw/config-authority/report', 'readGatewayNoCallLogProbe(', 'offering.protocol', 'offering.endpointPath', 'offering.priority', 'offering.weight']) assert.ok(config.includes(kept), `${kept}原配置合同不得丢失`);
  const asr = source.split("test('[REG-asr-routing-001] ASR实际路由不得由退场池主备替代'")[1]?.split("\n  test('")[0];
  assert.ok(asr, '原ASR REG必须独立保留，不能由配置绿关闭');
  const boundary = asr.indexOf("blockRetiredAsrPoolAudit(test, requiredEnv('STABLE_SMOKE_ENVIRONMENT'))");
  assert.ok(boundary >= 0 && boundary < asr.indexOf('loginGateway('));
  assert.ok(boundary < asr.indexOf('request.get('));
  for (const kept of ['/gw/pool-types', '/gw/pools?modelType=asr&sinceHours=168', 'ASR 默认池必须至少有主备两个成员', 'asrType?.ready', 'defaultAsrPool?.isDefaultForType', 'defaultAsrPool?.healthyMembers', 'model.platformId', 'model.priority']) assert.ok(asr.includes(kept), `${kept}旧失败判据必须保留`);
  assert.equal((asr.match(/toBeGreaterThanOrEqual\(2\)/g) || []).length, 3);
  assert.equal((source.match(/\[REG-asr-routing-001\]/g) || []).length, 1, '原ASR业务分母不能新增或借位');
});

test('REG-stsmk-account-scope-001 退场ASR审计两环境零网络且原REG保留未执行原因', () => {
  for (const environment of ['cds', 'production']) {
    let network = 0;
    const annotations = [];
    assert.throws(() => {
      blockRetiredAsrPoolAudit({ skip: (condition, description) => {
        assert.equal(condition, true);
        annotations.push({ type: 'skip', description });
        throw Error('not-run-before-auth');
      } }, environment);
      network += 1;
    }, /not-run-before-auth/);
    assert.equal(network, 0);
    assert.match(annotations[0].description, /已退场.*不是真实ASR路由.*未执行/);
    for (const required of ['Offering', 'requestId', 'reference', '持久化', '清理', '旧失败保留']) assert.ok(annotations[0].description.includes(required));
    const rows = collectPlaywrightCases({ suites: [{ specs: [{ title: '[REG-asr-routing-001] ASR实际路由不得由退场池主备替代', tests: [{ results: [{ status: 'skipped', annotations }] }] }] }] }, environment);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].caseId, 'REG-ASR-ROUTING-001');
    assert.equal(rows[0].status, 'not-run');
    assert.equal(buildNotRunLedger(rows, { production: environment === 'production' })[0].reason, annotations[0].description);
  }
  assert.throws(() => blockRetiredAsrPoolAudit({}, 'unknown'), /已登记环境/);
});

test('REG-stsmk-account-scope-001 公开社区旁路在共享context及独立页面登录导航前均被阻断', async () => {
  let handler;
  const calls = [];
  await blockPublicCommunityReads({ route: async (pattern, callback) => {
    calls.push(pattern);
    handler = callback;
  } });
  assert.deepEqual(calls, ['**/api/submissions/public**'], '只阻断非本轮公开内容，不接管全部业务请求');
  let aborts = 0;
  let continued = 0;
  await handler({
    abort: async reason => { assert.equal(reason, 'blockedbyclient'); aborts += 1; },
    continue: async () => { continued += 1; },
  });
  assert.equal(aborts, 1);
  assert.equal(continued, 0, '不得读取后再丢弃公开用户数据');
  const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  const login = source.split('async function loginAndReadToken(')[1]?.split('\nasync function readStableAuthSnapshot')[0];
  assert.ok(login.indexOf('await blockPublicCommunityReads(page)') >= 0);
  assert.ok(login.indexOf('await blockPublicCommunityReads(page)') < login.indexOf('await issueTicket('), '独立手机context也必须先于登录导航阻断');
  const setup = source.split('test.beforeEach(async ({ context }) => {')[1]?.split("test('[CORE-001]")[0];
  assert.ok(setup?.includes('await blockPublicCommunityReads(context)'), '未登录首页检查同样不得加载公开用户内容');
});

test('REG-stsmk-account-scope-001 全局鉴权观测在两环境认证与导航前阻断，不能借配置绿关闭', () => {
  const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  const sections = [
    ['[REG-auth-diagnosis-001][REG-auth-health-entry-001] 授权健康中心从桌面搜索与移动抽屉均可进入并回读', 'authorization-health', 'loginAndReadToken('],
    ['[REG-auth-synthetic-001] 网关鉴权失败聚合观测须限定巡检范围', 'gateway-failure-health', 'loginGateway('],
  ];
  for (const [title, kind, authCall] of sections) {
    const body = source.split(`test('${title}'`)[1]?.split("\n  test('")[0];
    assert.ok(body, `原观测项必须保留：${title}`);
    const boundary = body.indexOf(`blockUnscopedObservationFixture(test, requiredEnv('STABLE_SMOKE_ENVIRONMENT'), '${kind}')`);
    assert.ok(boundary >= 0 && boundary < body.indexOf(authCall), `${kind}必须在认证与导航之前明确未执行`);
  }
  const config = source.split("test('[GW-001][GW-002][GW-003][GW-004][REG-llmgw-auth-001]")[1]?.split("\n  test('")[0];
  assert.ok(config);
  assert.equal(/REG-auth-synthetic-001|failure-health|authFailureBody/.test(config), false, '配置通过不得冒充全局鉴权聚合已验');
  for (const endpoint of ['/api/authorization-health', '/gw/auth/failure-health']) {
    const allowed = sections.map(([title]) => source.split(`test('${title}'`)[1]?.split("\n  test('")[0] || '').join('\n');
    assert.equal(source.split(endpoint).length - 1, allowed.split(endpoint).length - 1, `${endpoint}只能留在被护栏阻断的原观测段`);
  }
});

test('REG-stsmk-account-scope-001 两环境全局观测前置停跑且具体原因进入原REG未执行账本', () => {
  const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  const configTitle = source.match(/test\('([^']+网关配置与路由可由专用身份审计)'/)?.[1];
  const observationTitle = source.match(/test\('([^']+网关鉴权失败聚合观测须限定巡检范围)'/)?.[1];
  const authorizationTitle = source.match(/test\('([^']+授权健康中心从桌面搜索与移动抽屉均可进入并回读)'/)?.[1];
  assert.ok(configTitle && observationTitle && authorizationTitle);
  for (const environment of ['cds', 'production']) {
    for (const observation of ['authorization-health', 'gateway-failure-health']) {
      let network = 0;
      const annotations = [];
      assert.throws(() => {
        blockUnscopedObservationFixture({ skip: (condition, description) => {
          assert.equal(condition, true);
          annotations.push({ type: 'skip', description });
          throw Error('not-run-before-network');
        } }, environment, observation);
        network += 1;
      }, /not-run-before-network/);
      assert.equal(network, 0);
      assert.match(annotations[0].description, /验收债务.*未执行/);
      assert.match(annotations[0].description, /本轮/);
      const rows = collectPlaywrightCases({ suites: [{ specs: [
        { title: configTitle, tests: [{ results: [{ status: 'passed' }] }] },
        { title: observation === 'authorization-health' ? authorizationTitle : observationTitle, tests: [{ results: [{ status: 'skipped', annotations }] }] },
      ] }] }, environment);
      for (const caseId of observation === 'authorization-health'
        ? ['REG-AUTH-DIAGNOSIS-001', 'REG-AUTH-HEALTH-ENTRY-001'] : ['REG-AUTH-SYNTHETIC-001']) {
        const original = rows.filter(row => row.caseId === caseId);
        assert.equal(original.length, 1, '配置旅程不能借位为聚合观测打勾');
        assert.equal(original[0].status, 'not-run');
        assert.equal(buildNotRunLedger(original, { production: environment === 'production' })[0].reason, annotations[0].description);
      }
    }
  }
  assert.throws(() => blockUnscopedObservationFixture({}, 'unknown', 'authorization-health'), /已登记环境/);
  assert.throws(() => blockUnscopedObservationFixture({}, 'production', 'other'), /原观测项/);
});

test('REG-stsmk-account-scope-001 网关配置先确认上下文且不得无筛选读取日志', () => {
  const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  const audit = source.split("test('[GW-001][GW-002][GW-003][GW-004][REG-llmgw-auth-001]")[1]?.split("\n  test('")[0];
  assert.ok(audit);
  assert.equal(/\/gw\/logs\?limit=/.test(source), false, 'limit不被服务端识别，旧查询会读取租户或团队日志');
  assert.deepEqual([...source.matchAll(/\/gw\/logs([^`'"]*)/g)].map(match => match[1]), [
    '?requestId=${encodeURIComponent(requestId)}&pageSize=10', '/${matched!.id}',
  ], '实际调用只允许按捕获的requestId查询及其已匹配日志详情，配置审计须走独立空探针');
  const contextRead = audit.indexOf('const context = await request.get(');
  const contextChecked = audit.indexOf('expect(contextBody.success).toBe(true)');
  const parallel = audit.indexOf('await Promise.all(');
  assert.ok(contextRead >= 0 && contextRead < contextChecked && contextChecked < parallel, '必须先回读上下文再发并行配置请求');
  assert.match(audit, /readGatewayNoCallLogProbe\(request, \{ baseUrl, headers, runId: requiredEnv\('STABLE_SMOKE_RUN_ID'\) \}\)/);
  assert.match(audit, /testInfo\.attach\('gateway-log-no-call-probe'/);
  assert.doesNotMatch(audit, /waitForGatewayLog\(|request\.get\([^\n]*\/gw\/logs/);
});

test('REG-stsmk-account-scope-001 日志空探针仅发本轮唯一精确查询且不充当模型调用', async () => {
  const calls = [];
  const options = { baseUrl: 'https://fixture.test/', headers: {}, runId: 'stsmk-this-run' };
  const request = { get: async (url, init) => {
    calls.push({ url, init });
    return { ok: () => true, json: async () => ({ success: true, data: { items: [], total: 0, pageSize: 1 } }) };
  } };
  const first = await readGatewayNoCallLogProbe(request, options);
  const second = await readGatewayNoCallLogProbe(request, options);
  assert.notEqual(first.requestId, second.requestId, '每次空查询必须有独立随机命名空间');
  for (const [index, proof] of [first, second].entries()) {
    const url = new URL(calls[index].url);
    assert.equal(url.origin, options.baseUrl.slice(0, -1));
    assert.equal(url.pathname, '/gw/logs');
    assert.deepEqual([...url.searchParams], [['requestId', proof.requestId], ['pageSize', '1']]);
    assert.match(proof.requestId, /^stsmk-this-run:no-call-audit:[a-f0-9-]{36}$/);
    assert.equal(proof.modelCalls, 0);
    assert.deepEqual(proof.items, []);
    assert.match(proof.proofBoundary, /不证明任何真实模型调用/);
  }
  assert.equal(calls.length, 2);
});

test('REG-stsmk-account-scope-001 日志空探针拒绝无范围输入且错误响应绝不回退裸列表', async () => {
  let calls = 0;
  const options = { baseUrl: 'https://fixture.test', headers: {}, runId: 'stsmk-this-run', nonce: '00000000-0000-4000-8000-000000000001' };
  const request = { get: async () => { calls += 1; throw Error('非法范围不得发送请求'); } };
  for (const runId of ['', undefined, 'real-user', 'stsmk_', 'stsmk-', 'stsmk-run?userId=other', 'stsmk-run\n', 'stsmk-run/other']) {
    await assert.rejects(() => readGatewayNoCallLogProbe(request, { ...options, runId }), /test\/resource-scope/);
  }
  for (const nonce of ['', 'other', '00000000-0000-4000-8000-000000000001&userId=other']) {
    await assert.rejects(() => readGatewayNoCallLogProbe(request, { ...options, nonce }), /test\/resource-scope/);
  }
  assert.equal(calls, 0);
  for (const data of [undefined, { records: [], total: 0, pageSize: 1 }, { items: {}, total: 0, pageSize: 1 }, { items: [{ requestId: 'unexpected' }], total: 1, pageSize: 1 }, { items: [], total: 1, pageSize: 1 }, { items: [], total: 0, pageSize: 50 }]) {
    calls = 0;
    await assert.rejects(() => readGatewayNoCallLogProbe({ get: async () => {
      calls += 1;
      return { ok: () => true, json: async () => ({ success: true, data }) };
    } }, options), /test\/(?:resource-scope|api-contract)/);
    assert.equal(calls, 1, '坏响应只能停止，不能重发无范围请求');
  }
  calls = 0;
  await assert.rejects(() => readGatewayNoCallLogProbe({ get: async () => {
    calls += 1;
    return { ok: () => false, json: async () => { throw Error('鉴权失败后不读取正文'); } };
  } }, options), /test\/api-contract/);
  assert.equal(calls, 1);
});

test('REG-stsmk-account-scope-001 正式危险夹具在任何写入前阻断，CDS原夹具不被误放行到正式', () => {
  for (const caseId of ['LIT-004', 'MVIS-010']) {
    let writes = 0;
    const execute = boundary => {
      boundary({ skip: (condition, reason) => {
        assert.equal(condition, true);
        assert.match(reason, /验收债务/);
        assert.match(reason, /未执行/);
        throw new Error(`not-run:${caseId}`);
      } }, 'production', caseId);
      writes += 1;
    };
    assert.throws(() => execute(blockUnsafeProductionFixture), new RegExp(`not-run:${caseId}`));
    assert.equal(writes, 0, '正式拦截之后不得签发钥匙或创建人为失败任务');
    blockUnsafeProductionFixture({ skip: () => { throw Error('CDS夹具不应被正式策略误拦'); } }, 'cds', caseId);
  }
  assert.throws(() => blockUnsafeProductionFixture({}, 'production', 'not-registered'), /绑定已登记/);
});

test('REG-stsmk-account-scope-001 正式危险夹具拦截接入原case并发生在认证和创建之前', () => {
  const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  for (const [title, caseId] of [
    ['[LIT-003][LIT-004] 文学续写停止后内容稳定且改写只替换选中段落', 'LIT-004'],
    ['[MVIS-010] 多图引用失败只显示结果与恢复动作', 'MVIS-010'],
  ]) {
    const body = source.split(`test('${title}'`)[1]?.split("\n  test('")[0];
    assert.ok(body);
    const boundary = `blockUnsafeProductionFixture(test, requiredEnv('STABLE_SMOKE_ENVIRONMENT'), '${caseId}')`;
    assert.ok(body.indexOf(boundary) >= 0 && body.indexOf(boundary) < body.indexOf('loginAndReadToken('), `${caseId}必须先阻断再认证/写入`);
  }
});

test('REG-stsmk-account-scope-001 正式停跑原因经当前reporter形状进入每轮未执行账本', () => {
  const annotations = [];
  assert.throws(() => blockUnsafeProductionFixture({ skip: (condition, description) => {
    assert.equal(condition, true);
    annotations.push({ type: 'skip', description });
    throw new Error('not-run');
  } }, 'production', 'MVIS-010'), /not-run/);
  const rows = collectPlaywrightCases({ suites: [{ specs: [{ title: '[MVIS-010] 多图失败', tests: [{ results: [{ status: 'skipped', annotations }] }] }] }] }, 'production');
  assert.equal(rows[0].status, 'not-run');
  assert.equal(buildNotRunLedger(rows, { production: true })[0].reason, annotations[0].description);
});

const avatarSnapshot = { pageUrl: 'https://fixture.test/', source: 'https://fixture.test/avatars/nohead.webp', complete: true, width: 128, height: 128, status: 200, mime: 'image/webp', byteLength: 5_120 };
test('REG-avatar-asset-001 默认头像同源、解码、真实MIME和轻量字节必须同时成立', () => {
  assert.equal(validateReadOnlyAvatarAsset(avatarSnapshot).byteLength, 5_120);
  for (const bad of [
    { source: 'https://objects.test/nohead.png' }, { source: '/avatars/nohead.png' },
    { complete: false }, { width: 0 }, { height: 0 }, { status: 404 },
    { mime: 'text/html' }, { byteLength: 0 }, { byteLength: 3 * 1024 * 1024 },
  ]) assert.throws(() => validateReadOnlyAvatarAsset({ ...avatarSnapshot, ...bad }), /test\/ui-contract/);
});

test('REG-avatar-asset-001 正式原case走现有身份的只读菜单和资源，不创建头像用户或调用模型', () => {
  const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  const body = source.split("test('[REG-avatar-asset-001]")[1]?.split("\n  test('")[0];
  const readOnly = body?.split("if (requiredEnv('STABLE_SMOKE_ENVIRONMENT') === 'production') {")[1]?.split('      return;')[0];
  assert.ok(readOnly, '原REG须有真实正式只读变体，不能整体skip');
  for (const call of ['loginAndReadToken(page, request,', 'validateReadOnlyAvatarAsset(', 'expectNoBrokenImages(', 'account.click()', "page.request.get('/avatars/nohead.webp')", "'CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-10'", "page.route('**/api/submissions/public**'"]) assert.ok(readOnly.includes(call), `${call}未接入`);
  assert.doesNotMatch(readOnly, /(?:request|page\.request)\.(?:post|put|patch|delete)\(|issueTicketDetails|\/api\/users|apply-generated|avatar\/generate|test\.skip/);
  assert.match(readOnly, /proofBoundary: '仅默认头像资源和真实用户菜单，不证明上传\/生成\/保存专项'/);
});

test('REG-visual-policy-001 快捷编辑同时识别已部署英文placeholder和当前中文aria，不取第一个冒充唯一', async () => {
  for (const layout of ['deployed','current','missing','duplicate']) {
    const locator = count => ({or: other=>locator(count+other.value),and:()=>locator(count),count:async()=>count,value:count});
    const page={getByRole:(role,options)=>{assert.equal(role,'textbox');assert.deepEqual(options,{name:'快捷编辑描述',exact:true});return locator(['current','duplicate'].includes(layout)?1:0);},getByPlaceholder:(text,options)=>{assert.equal(text,'Describe your edit here');assert.deepEqual(options,{exact:true});return locator(['deployed','duplicate'].includes(layout)?1:0);},locator:selector=>{assert.equal(selector,':visible');return {};}};
    assert.equal(await getQuickEditInput(page).count(),layout==='missing'?0:layout==='duplicate'?2:1);
  }
  const source=readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts',import.meta.url),'utf8');
  assert.match(source,/const quickEdit = getQuickEditInput\(page\)/);
});

test('REG-stsmk-account-scope-001 下划线替代与其它轮次账号在写入前变红', () => {
  for (const username of ['stsmk_avatar_abc', 'stsmk_noauth_abc', 'stsmk-other-avatar', 'real-user']) {
    assert.throws(() => assertScopedSyntheticUsername(username, 'stsmk-this-run'), /test\/resource-scope/);
  }
  assert.doesNotThrow(() => assertScopedSyntheticUsername('stsmk-this-run-avatar', 'stsmk-this-run'));
});

test('REG-stsmk-account-scope-001 基础登录不得混入头像专项或临时账号写入', () => {
  const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  const login = source.split("test('[CORE-002][CORE-003] 专用巡检身份登录与刷新保持同一会话'")[1]?.split("test('")[0];
  assert.ok(login, '双环境须有独立的只读登录旅程');
  assert.doesNotMatch(login, /test\.skip|\/api\/users|avatar-editor/);
  assert.match(login, /readStableAuthSnapshot/);
  assert.doesNotMatch(source, /\[CORE-002\]\[CORE-003\]\[REG-avatar-asset-001\]/);
  for (const name of ['avatar', 'noauth']) {
    const fragment = source.split('const username = `stsmk_' + name + '_')[1]?.split('await request.post(\'/api/users\'')[0];
    assert.ok(fragment?.includes('assertScopedSyntheticUsername(username,'), `${name}账号写入必须先做本轮资源范围检查`);
  }
});

test('REG-stsmk-account-scope-001 正式受限模式仍复测登录、身份权限与手机真实入口，不夹带业务写入', () => {
  const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  const matcher = new RegExp(productionReadOnlyGrep);
  const selected = [...source.matchAll(/test\('([^']+)'/g)].filter(match => matcher.test(match[1]));
  for (const caseId of ['CORE-001', 'CORE-002', 'CORE-003', 'CORE-010']) {
    assert.ok(selected.some(match => match[1].includes(`[${caseId}]`)), `${caseId}未进入正式只读集合`);
  }
  for (const match of selected) {
    const body = source.slice(match.index + match[0].length).split("\n  test('")[0];
    assert.ok(body);
    assert.doesNotMatch(body, /(?:request|page\.request)\.(?:post|put|patch|delete)\(/, match[1]);
    assert.doesNotMatch(match[1], /avatar|COMMON-002|CORE-009|白桃|生成/);
  }
});

test('登录页不依赖已删除的 login-card；账号表单和仅SSO均可核验，残缺入口变红', async () => {
  assert.deepEqual(validateMapLoginSnapshot(passwordSnapshot), { authenticationMethods: ['password'] });
  assert.deepEqual(validateMapLoginSnapshot({ ...passwordSnapshot, usernameCount: 0, passwordCount: 0, submitCount: 0, ssoCount: 1 }), { authenticationMethods: ['sso'] });
  assert.throws(() => validateMapLoginSnapshot({ ...passwordSnapshot, headingCount: 2 }), /唯一/);
  assert.throws(() => validateMapLoginSnapshot({ ...passwordSnapshot, passwordCount: 0 }), /完整表单/);
  assert.throws(() => validateMapLoginSnapshot({ ...passwordSnapshot, usernameCount: 0, passwordCount: 0, submitCount: 0 }), /没有可用/);
  const target = { waitFor: async () => {}, count: async () => 1, evaluate: async () => passwordSnapshot };
  const page = {
    url: () => 'https://fixture.test/login', locator: () => ({}),
    getByRole: (role, options) => {
      assert.equal(role, 'heading'); assert.deepEqual(options, { name: '欢迎回来', exact: true });
      return { and: () => ({ waitFor: async () => {}, count: async () => 1, locator: (selector) => { assert.match(selector, /ancestor::div/); return target; } }) };
    },
    getByTestId: () => { throw Error('旧 login-card 不再是部署合同'); },
  };
  assert.equal((await getMapLoginTarget(page)).target, target);
  await assert.rejects(() => getMapLoginTarget({ ...page, url: () => 'https://fixture.test/' }), /真实登录页/);
});

test('真实LoginCard的SSO使用href井号与点击桥接，按显式可用属性识别而不是误判为坏链接', async () => {
  const originalStyle = globalThis.getComputedStyle;
  const visibleNode = (textContent) => ({ textContent, title: textContent, getBoundingClientRect: () => ({ width: 100, height: 30 }) });
  const element = {
    textContent: 'MAP Admin 欢迎回来 米多星球登录',
    querySelectorAll: (selector) => selector === 'h1' ? [visibleNode('欢迎回来')]
      : selector === 'a[href][aria-disabled="false"]' ? [visibleNode('米多星球登录')] : [],
  };
  const target = { waitFor: async () => {}, count: async () => 1, evaluate: async (probe) => probe(element) };
  const page = {
    url: () => 'https://fixture.test/login', locator: () => ({}),
    getByRole: () => ({ and: () => ({ waitFor: async () => {}, count: async () => 1, locator: () => target }) }),
  };
  try {
    globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
    assert.deepEqual((await getMapLoginTarget(page)).authenticationMethods, ['sso']);
  } finally {
    if (originalStyle === undefined) delete globalThis.getComputedStyle; else globalThis.getComputedStyle = originalStyle;
  }
});

function model(publicId, overrides = {}) {
  return { id: publicId, publicId, modelType: 'generation', enabled: true, offerings: [{ enabled: true }], ...overrides };
}

test('图片模型来自真实API身份，不硬编码 default-generation、不用停用或无Offering配置顶替', () => {
  const selected = model('peach.v2+real', { isDefaultForType: true });
  assert.equal(selectGatewayImageLogicalModel([model('default-generation', { enabled: false }), model('other'), selected]), selected);
  assert.throws(() => selectGatewayImageLogicalModel([model('default-generation', { offerings: [] })]), /configuration\/gateway.*未找到/);
  assert.throws(() => selectGatewayImageLogicalModel(undefined), /test\/api-contract/);
  assert.throws(() => selectGatewayImageLogicalModel([model('a', { modelType: 'chat' })]), /未找到/);
  assert.throws(() => selectGatewayImageLogicalModel([model('same'), model('same')]), /publicId 重复/);
});

function gatewayPage({ layout = 'inline', publicId = 'peach.v2+real', ids = ['peachXv2real', 'peach.v2+real-old', 'peach.v2+real'], detailIdentity = publicId, routes = 1, searchCount } = {}) {
  const calls = [];
  let expanded = false;
  let query = '';
  const node = (count = 1) => ({
    count: async () => count,
    waitFor: async () => { assert.ok(count > 0, 'required UI node missing'); },
  });
  const routeDetails = { ...node(routes), first: () => node(routes) };
  const detail = {
    ...node(), locator: (selector) => {
      if (selector === '.lg-logical-model-route-detail') return routeDetails;
      assert.equal(selector, 'header code');
      return { filter: ({ hasText }) => node(hasText.test(detailIdentity) ? 1 : 0) };
    }, getByRole: (role, options) => {
      assert.equal(role, 'button'); assert.equal(options.name, '上游线路');
      return { ...node(), getAttribute: async () => 'true' };
    },
  };
  const list = {
    ...node(), and: () => list,
    getByRole: (role, options) => {
      if (role === 'combobox') return { ...node(), selectOption: async value => { assert.equal(value, ''); calls.push('filter:all'); } };
      assert.equal(role, 'searchbox'); assert.equal(options.name, '搜索模型名称或公开标识');
      return { ...node(searchCount ?? (layout === 'collection-pane' ? 1 : 0)), fill: async value => { query = value; calls.push(`search:${value}`); } };
    },
    locator: (selector) => {
      assert.equal(selector, '.lg-logical-model-grid:not(.lg-logical-model-heading)');
      return { filter: ({ has }) => {
        const matching = ids.filter(id => (!query || id.includes(query)) && has.idRegex.test(has.legacy ? `${id} · 所有应用` : id));
        const row = {
          ...node(matching.length), locator: selector => { assert.equal(selector, '..'); return detail; },
          getByRole: (role, options) => {
            assert.equal(role, 'button'); assert.equal(options.exact, true);
            const actual = expanded ? '收起' : layout === 'collection-pane' ? '查看' : '展开';
            return { ...node(options.name === actual ? matching.length : 0),
              click: async () => { assert.equal(options.name, actual); expanded = true; calls.push(`open:${matching[0]}`); },
              getAttribute: async name => { assert.equal(name, 'aria-expanded'); return expanded ? 'true' : 'false'; },
            };
          },
        };
        return row;
      } };
    },
  };
  return {
    calls,
    page: {
      url: () => 'https://fixture.test/logical-models',
      locator: selector => {
        if (selector === '.lg-logical-model-list') return list;
        if (selector === ':visible') return {};
        assert.equal(selector, 'code'); return { filter: ({ hasText }) => ({ idRegex: hasText }) };
      },
      getByText: regex => ({ idRegex: regex, legacy: true }),
      getByRole: (role, options) => { assert.equal(role, 'complementary'); assert.equal(options.name, '清单详情'); return detail; },
    },
  };
}

test('65347c 行内展开与新清单详情各走真实按钮，publicId精确匹配不误点前缀或正则近似行', async () => {
  for (const layout of ['inline', 'collection-pane']) {
    const fixture = gatewayPage({ layout });
    const result = await openGatewayLogicalModelDetails(fixture.page, model('peach.v2+real'));
    assert.equal(result.publicId, 'peach.v2+real'); assert.equal(result.layout, layout);
    assert.deepEqual(fixture.calls, layout === 'inline'
      ? ['open:peach.v2+real'] : ['search:peach.v2+real', 'filter:all', 'open:peach.v2+real']);
  }
});

test('模型重复、详情张冠李戴、空Offering和重复搜索入口都变红，不退到第一行或整页', async () => {
  const duplicate = gatewayPage({ ids: ['peach.v2+real', 'peach.v2+real'] });
  await assert.rejects(() => openGatewayLogicalModelDetails(duplicate.page, model('peach.v2+real')), /唯一/);
  const wrong = gatewayPage({ layout: 'collection-pane', detailIdentity: 'default-generation' });
  await assert.rejects(() => openGatewayLogicalModelDetails(wrong.page, model('peach.v2+real')), /missing/);
  const empty = gatewayPage({ routes: 0 });
  await assert.rejects(() => openGatewayLogicalModelDetails(empty.page, model('peach.v2+real')), /missing/);
  const ambiguous = gatewayPage({ layout: 'collection-pane', searchCount: 2 });
  await assert.rejects(() => openGatewayLogicalModelDetails(ambiguous.page, model('peach.v2+real')), /搜索入口重复/);
});

test('REC-006保留真实局部主题门禁：暗色计划配浅色测量必须红，不靠metadata迁就', async () => {
  const parent = process.env.STABLE_SMOKE_UI_CONTRACT_TMP || tmpdir();
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'ui-contract-theme-'));
  const outputPath = join(root, 'evidence');
  const planPath = join(root, 'plan.json');
  const slotId = 'CDS-VISUAL-RECORDING-AUDIO-02';
  const slot = { slotId, environment: 'cds', module: '录音', primaryState: '录音', coverageStates: ['录音'],
    testType: '视觉', theme: 'dark', viewportClass: 'desktop', methodAnchor: '#recording',
    breadcrumb: 'CDS → 首页 → 知识库 → 录音', pageOrigin: 'https://fixture.test', entryPath: '/document-store', expectedProof: '局部录音面板真实暗色可读' };
  const runId = 'stsmk-ui-contract-test';
  const commit = 'a'.repeat(40);
  writeFileSync(planPath, JSON.stringify({ runId, commit, captureStartedAt: '2026-01-01T00:00:00Z', slots: [slot] }));
  const environment = { STABLE_SMOKE_ENVIRONMENT: 'cds', STABLE_SMOKE_RUN_ID: runId, STABLE_SMOKE_COMMIT: commit,
    STABLE_SMOKE_VISUAL_PLAN: planPath, STABLE_SMOKE_VISUAL_OUTPUT: outputPath };
  const target = { waitFor: async () => {}, count: async () => 1 };
  const page = { url: () => 'https://fixture.test/document-store' };
  let actualTheme = 'light';
  const capture = createStableSmokeVisualEvidence({ environment, harnessLoader: async () => ({
    box: async () => {}, clearBoxes: async () => {},
    shot: async (_page, output, name, caption, options) => {
      assert.equal(options.themeTarget, target);
      const { themeTarget: _target, ...metadata } = options;
      const path = join(output, `${name}.png`); writeFileSync(path, 'isolated fixture');
      return { ...metadata, name, caption, path, theme: actualTheme, themeProbe: 'target', viewportClass: 'desktop',
        pageOrigin: slot.pageOrigin, pagePath: slot.entryPath, automatedStatus: '通过', capturedAt: new Date().toISOString() };
    },
  }) });
  try {
    await assert.rejects(() => capture(page, undefined, { slotId, target, themeTarget: target }), /theme 不一致.*dark.*light/);
    assert.equal(existsSync(join(outputPath, 'manifest.json')), false);
    actualTheme = 'dark';
    const result = await capture(page, undefined, { slotId, target, themeTarget: target });
    assert.equal(result.record.theme, 'dark');
    assert.equal(JSON.parse(readFileSync(join(outputPath, 'manifest.json'), 'utf8'))[0].themeProbe, 'target');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
