import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getMapLoginTarget, openGatewayLogicalModelDetails, selectGatewayImageLogicalModel, validateMapLoginSnapshot, assertScopedSyntheticUsername, getQuickEditInput, blockUnsafeProductionFixture, validateReadOnlyAvatarAsset, readGatewayNoCallLogProbe, blockUnscopedObservationFixture, blockPublicCommunityReads, blockRetiredAsrPoolAudit } from '../../e2e/utils/stableSmokeUiContract.mjs';
import { createStableSmokeVisualEvidence } from '../../e2e/utils/stableSmokeVisualEvidence.mjs';
import { productionReadOnlyGrep } from '../stable-smoke-run.mjs';
import { buildNotRunLedger, collectPlaywrightCases } from '../stable-smoke-results.mjs';
import * as uiContract from '../../e2e/utils/stableSmokeUiContract.mjs';
import { redactStableSmokeDiagnosticText } from '../../e2e/utils/stableSmokeDiagnostics.mjs';
import * as recordingTools from '../../e2e/utils/stableSmokeRecording.mjs';

test('REG-stsmk-account-scope-001 REC010有界等待真实归档与同源run终态，不以首次pending或确定性ID冒充清理', async () => {
  assert.equal(typeof recordingTools.waitForRecordingIdempotencySettlement, 'function');
  for (const bad of ['', 'archive', 'running', 'identity', 'retrying']) {
    let clock = 0; let reads = 0;
    const result = await recordingTools.waitForRecordingIdempotencySettlement({
      sessionId: 'own-session', storeId: 'own-store', entryId: 'own-entry', runIds: ['own-run'],
      timeoutMs: 3, intervalMs: 1, now: () => clock, sleep: async ms => { clock += ms; },
      readSession: async () => ({ sessionId: 'own-session', entryId: 'own-entry', status: 'completed', archiveStatus: bad === 'archive' || reads++ === 0 ? 'pending' : 'completed' }),
      readRun: async id => { assert.equal(id, 'own-run'); return { id, storeId: bad === 'identity' ? 'foreign' : 'own-store', sourceEntryId: 'own-entry', kind: 'transcribe', status: bad === 'running' ? 'running' : bad === 'retrying' ? 'failed' : 'done', automaticRetryNextAt: bad === 'retrying' ? 'later' : null }; },
    });
    assert.equal(result.settled, !bad, bad);
    assert.ok(result.observations.length >= 1);
    if (!bad) assert.ok(result.observations.length >= 2, '首次pending必须继续等到归档完成');
    else assert.ok(result.errors.length > 0, '有界等待失败必须保留红项');
    assert.ok(clock <= 3, '不得无限轮询');
  }
});

test('REG-stsmk-account-scope-001 REC010原case真实完成前缀登记两次run并拒绝缺失或漂移，清理能拿到所有已知ID', async () => {
  const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  const body = source.split("test('[REC-010]")[1].split('} catch (error) {')[0];
  const prefix = body.slice(body.indexOf('const firstComplete =')).replace(/readEnvelope<[^]*?>\(/g, 'readEnvelope(');
  for (const [firstId, secondId, duplicate, expected] of [['own-run', 'own-run', false, true], [null, 'own-run', false, false], ['own-run', null, false, false], ['own-run', 'other-own-run', false, false], ['own-run', 'own-run', true, false]]) {
    const ids = []; const attachments = []; let calls = 0;
    const complete = () => ({ entry: { id: 'own-entry' }, sessionId: 'own-session', reused: true, deferredTranscriptionRunId: ++calls === 1 ? firstId : secondId });
    const page = { request: { post: async path => { assert.equal(path, '/api/document-store/recording-uploads/own-session/complete'); return complete(); }, get: async path => { assert.equal(path, '/api/document-store/stores/own-store/entries?all=true&pageSize=500'); return { items: [{ id: 'own-entry', storeId: 'own-store' }], total: duplicate ? 2 : 1 }; } } };
    const expectValue = value => ({ toBe: expectedValue => assert.equal(value, expectedValue), toBeTruthy: () => assert.ok(value), toHaveLength: length => assert.equal(value.length, length) });
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const execute = new AsyncFunction('page', 'token', 'storeId', 'sessionId', 'entryId', 'deferredRunIds', 'testInfo', 'readEnvelope', 'authHeaders', 'expect', 'assertRecordingIdempotencyRuns', prefix);
    const action = () => execute(page, 'offline-only', 'own-store', 'own-session', '', ids,
      { attach: async (name, value) => attachments.push({ name, value: JSON.parse(value.body) }) }, async response => response, () => ({}), expectValue, recordingTools.assertRecordingIdempotencyRuns);
    if (expected) await action(); else await assert.rejects(action);
    if (firstId) assert.ok(ids.includes(firstId), '首次真实返回的run立即登记');
    assert.ok(attachments.some(item => item.value.deferredTranscriptionRunId === firstId));
    if (calls === 2 && secondId) assert.ok(ids.includes(secondId), '不一致的第二run也须纳入finally清理');
  }
  const localSuite = source.split("test.describe('REC010清理闭环不自动重试'")[1]?.split("test('[REC-001]")[0];
  assert.ok(localSuite);
  const configs = [];
  const configCall = localSuite.match(/test\.describe\.configure\([^]*?\);/)?.[0];
  assert.ok(configCall);
  new Function('test', configCall)({ describe: { configure: value => configs.push(value) } });
  assert.deepEqual(configs, [{ retries: 0 }], '原case失败后不得自动再创建一轮付费资源');
});

test('REG-stsmk-account-scope-001 GWBASE API入口与真实控制台入口按现存发布合同分离', () => {
  assert.equal(typeof uiContract.resolveGatewayUiBaseUrl, 'function');
  const apiBase = 'https://inspection.invalid';
  const release = readFileSync(new URL('../../exec_dep.sh', import.meta.url), 'utf8');
  const mount = release.match(/PRD_AGENT_PUBLIC_LLMGW_PAGE_PATH:-([^}]+)/)?.[1];
  assert.equal(mount, '/llmgw/');
  const runtime = readFileSync(new URL('../../llmgw/web/src/lib/runtimeBase.ts', import.meta.url), 'utf8');
  const runtimeFunction = runtime.match(/export function getRuntimeBasePath[^]*?\n}/)?.[0];
  assert.ok(runtimeFunction);
  const runtimeBase = new Function('pathname', runtimeFunction.slice(runtimeFunction.indexOf('{') + 1, runtimeFunction.lastIndexOf('}')));
  for (const environment of ['cds', 'production']) {
    const uiBase = uiContract.resolveGatewayUiBaseUrl(`${apiBase}/`, environment);
    const expected = environment === 'production' ? new URL(mount, apiBase).href.replace(/\/$/, '') : apiBase;
    assert.equal(uiBase, expected);
    assert.equal(runtimeBase(new URL(`${uiBase}/login`).pathname), environment === 'production' ? '/llmgw' : '');
  }
  for (const [base, environment] of [['https://inspection.invalid/unknown', 'production'], ['http://inspection.invalid', 'cds'],
    ['https://user:secret@inspection.invalid', 'production'], ['https://inspection.invalid?x=1', 'cds'], [apiBase, 'unknown']]) {
    assert.throws(() => uiContract.resolveGatewayUiBaseUrl(base, environment), /test\//);
  }
});

test('REG-stsmk-account-scope-001 GWBASE 已证前缀日志使用同一精确allowlist且不改写请求', async () => {
  const requestId = '92921338e63541b89a8f0298dff54309-0-0';
  const logId = 'verified-own-log';
  const baseUrl = 'https://inspection.invalid';
  const routes = [];
  await uiContract.installGatewayLogReadScope({ route: async (pattern, handler) => routes.push({ pattern, handler }) }, {
    baseUrl, requestId, verifiedLog: { id: logId, requestId },
  });
  for (const prefix of ['', '/llmgw']) {
    for (const [path, allowed, method = 'GET', origin = baseUrl] of [
      [`/gw/logs?requestId=${requestId}&view=logical&pageSize=30`, true], [`/gw/logs/${logId}`, true],
      ['/gw/logs', false], ['/gw/logs?requestId=other-run', false],
      [`/gw/logs?requestId=${requestId}&requestId=other-run`, false],
      ...['meta', 'summary', 'timeseries', 'sessions', 'other-log'].map(id => [`/gw/logs/${id}?requestId=${requestId}`, false]),
      [`/gw/logs/${logId}?requestId=other-run`, false],
      [`/gw/logs?requestId=${requestId}`, false, 'POST'], [`/gw/logs/${logId}`, false, 'DELETE'],
      [`/gw/logs?requestId=${requestId}`, false, 'GET', 'https://other.invalid'],
    ]) {
      const url = new URL(`${prefix}${path}`, origin);
      const route = routes.find(entry => entry.pattern(url));
      assert.ok(route, `网络前未守住${url.pathname}`);
      let result = '';
      await route.handler({
        request: () => ({ url: () => url.href, method: () => method }),
        continue: async (...args) => { assert.equal(args.length, 0, '真实URL/请求不能被改写'); result = 'continue'; },
        abort: async reason => { assert.equal(reason, 'blockedbyclient'); result = 'abort'; },
        fulfill: () => assert.fail('不得伪造成功响应'), fetch: () => assert.fail('不得额外读取'),
      });
      assert.equal(result, allowed ? 'continue' : 'abort', url.pathname);
    }
  }
});

test('REG-stsmk-account-scope-001 GWBASE 前缀后台用量在网络前阻断而非读后过滤', async () => {
  const routes = [];
  await uiContract.blockUnscopedBackgroundReads({ route: async (pattern, handler) => routes.push({ pattern, handler }) });
  const url = new URL('https://inspection.invalid/llmgw/gw/logical-models/usage?days=30');
  const route = routes.find(entry => typeof entry.pattern === 'function' && entry.pattern(url));
  assert.ok(route, '真实子路径控制台的历史用量未被阻断');
  let aborted = false;
  await route.handler({ abort: async () => { aborted = true; }, continue: () => assert.fail('不得发送历史用量请求'), fulfill: () => assert.fail('不得伪造用量') });
  assert.equal(aborted, true);
});

test('REG-stsmk-account-scope-001 GWBASE 执行原登录返回及两条日志UI接线，前缀响应必须真正匹配', async () => {
  const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  const login = source.split('async function loginGateway(')[1].split('  const signingKeyId')[0];
  const prefix = login.slice(login.indexOf('{') + 1);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const apiBase = 'https://inspection.invalid';
  const loginResult = await new AsyncFunction('request', 'requiredEnv', 'process', 'resolveGatewayUiBaseUrl', prefix)(
    {}, key => ({ STABLE_SMOKE_GW_BASE_URL: apiBase, STABLE_SMOKE_ENVIRONMENT: 'production' })[key],
    { env: { STABLE_SMOKE_GW_TOKEN: 'offline-only' } }, uiContract.resolveGatewayUiBaseUrl,
  );
  assert.equal(loginResult.baseUrl, apiBase);
  assert.equal(loginResult.uiBaseUrl, `${apiBase}/llmgw`);
  assert.equal((source.split('async function loginGateway(')[1].split('\nasync function seedGatewayConsoleSession(')[0].match(/\buiBaseUrl\b/g) || []).length, 4, '三个鉴权返回必须共享同一UI入口');
  assert.doesNotMatch(source, /\.goto\(`\$\{gateway(?:Session)?\.baseUrl\}/, '所有网关页面都必须使用UI而非API入口');
  const requestId = '92921338e63541b89a8f0298dff54309-0-0';
  const log = { id: 'verified-own-log', requestId };
  for (const [pageName, gatewayName, extra] of [['gatewayAuditPage', 'gatewaySession', { gatewayLog: log, runId: requestId.slice(0, 32) }],
    ['gatewayFailurePage', 'gateway', { failedLog: log, failedRequestId: requestId }]]) {
    const raw = source.split(`const ${pageName} = await page.context().newPage();`)[1];
    assert.ok(raw);
    const code = raw.slice(raw.indexOf('try {') + 'try {'.length).split('const scopedListResponse = await scopedListResponsePromise;')[0];
    const events = []; let matches;
    const response = { url: () => `${apiBase}/llmgw/gw/logs?requestId=${requestId}&pageSize=30`, request: () => ({ method: () => 'GET' }) };
    const page = {
      waitForResponse: predicate => { matches = predicate; return Promise.resolve(response); },
      goto: async url => {
        assert.equal(events[0], 'guard', '首个导航前必须安装真实守卫');
        events.push(url);
        assert.ok(url.startsWith(`${loginResult.uiBaseUrl}/`), '真实页面不得落到MAP根控制台');
        assert.equal(new URL(url).searchParams.has('transaction'), false, '不得强塞详情ID');
        if (new URL(url).pathname.endsWith('/logs')) {
          assert.equal(matches(response), true, '真实prefixed列表响应未被等待器识别');
          assert.equal(matches({ ...response, url: () => `https://other.invalid/llmgw/gw/logs?requestId=${requestId}` }), false, '不得匹配其他origin');
        }
      },
    };
    const bindings = {
      [pageName]: page, [gatewayName]: loginResult, request: {}, ...extra,
      installGatewayLogReadScope: async () => { events.push('guard'); }, seedGatewayConsoleSession: async () => {},
      gatewayApiPolicyPath: uiContract.gatewayApiPolicyPath,
    };
    await new AsyncFunction(...Object.keys(bindings), code)(...Object.values(bindings));
    assert.equal(events.filter(value => value.startsWith('https:')).length, 2);
  }
});

test('REG-stsmk-account-scope-001 网关日志UI只放精确本轮列表和已核实详情，拒绝元信息与汇总', async () => {
  assert.equal(typeof uiContract.installGatewayLogReadScope, 'function');
  const requestId = '92921338e63541b89a8f0298dff54309-0-0';
  const logId = 'verified-own-log';
  const baseUrl = 'https://gateway.inspection.invalid';
  const routes = [];
  await uiContract.installGatewayLogReadScope({ route: async (pattern, handler) => routes.push({ pattern, handler }) }, {
    baseUrl, requestId, verifiedLog: { id: logId, requestId },
  });
  const exercise = async (path, allowed, method = 'GET', origin = baseUrl) => {
    const url = new URL(path, origin);
    const route = routes.find(entry => entry.pattern(url));
    assert.ok(route, `日志网络未被范围护栏接管：${path}`);
    let result = '';
    await route.handler({
      request: () => ({ url: () => url.href, method: () => method }),
      abort: async reason => { assert.equal(reason, 'blockedbyclient'); result = 'abort'; },
      continue: async () => { result = 'continue'; },
      fulfill: () => assert.fail('不允许伪造日志或成功响应'),
      fetch: () => assert.fail('范围护栏不能额外读取日志'),
    });
    assert.equal(result, allowed ? 'continue' : 'abort', path);
  };
  await exercise(`/gw/logs?requestId=${requestId}&view=logical&pageSize=30`, true);
  await exercise(`/gw/logs/${logId}`, true);
  for (const path of ['/gw/logs', '/gw/logs?requestId=', '/gw/logs?requestId=another-run',
    `/gw/logs?requestId=${requestId}&requestId=another-run`, '/gw/logs/meta',
    `/gw/logs/meta?requestId=${requestId}`, `/gw/logs/summary?requestId=${requestId}`,
    `/gw/logs/timeseries?requestId=${requestId}`, `/gw/logs/sessions?requestId=${requestId}`,
    '/gw/logs/another-log', `/gw/logs/${logId}?requestId=another-run`]) await exercise(path, false);
  await exercise(`/gw/logs?requestId=${requestId}`, false, 'POST');
  await exercise(`/gw/logs/${logId}`, false, 'DELETE');
  await exercise(`/gw/logs?requestId=${requestId}`, false, 'GET', 'https://different.invalid');
  for (const path of ['/gw/logical-models', '/gw/auth/context', '/api/document-store/stores/owned']) {
    assert.equal(routes.some(entry => entry.pattern(new URL(path, baseUrl))), false, '不得吞掉非日志原合同');
  }
});

test('REG-stsmk-account-scope-001 日志UI缺真实关联或非法输入时安装前即拒绝', async () => {
  const requestId = '92921338e63541b89a8f0298dff54309-0-0';
  const valid = { baseUrl: 'https://gateway.inspection.invalid', requestId, verifiedLog: { id: 'verified-own-log', requestId } };
  for (const patch of [{ requestId: '' }, { requestId: 'stsmk-no-call-probe' }, { baseUrl: 'not-a-url' },
    { verifiedLog: { id: '', requestId } }, { verifiedLog: { id: 'meta', requestId } },
    { verifiedLog: { id: 'verified-own-log', requestId: 'different-run' } }]) {
    let installed = 0;
    await assert.rejects(() => uiContract.installGatewayLogReadScope({ route: async () => { installed += 1; } }, { ...valid, ...patch }));
    assert.equal(installed, 0);
  }
});

test('REG-stsmk-account-scope-001 原真实生图日志页在首个导航前守范围并先核真实列表后看详情', () => {
  const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  const audit = source.split('const gatewayAuditPage = await page.context().newPage();')[1]?.split('await gatewayAuditPage.close();')[0];
  assert.ok(audit, '原主旅程日志UI证据不得删除');
  assert.ok(audit.indexOf('await installGatewayLogReadScope(') >= 0 && audit.indexOf('await installGatewayLogReadScope(') < audit.indexOf('await gatewayAuditPage.goto('), '必须在网关首个导航前安装');
  assert.match(audit, /verifiedLog: gatewayLog/);
  assert.ok(audit.indexOf('const scopedListResponsePromise = gatewayAuditPage.waitForResponse(') < audit.indexOf('/logs?requestId='));
  assert.match(audit, /url\.searchParams\.getAll\('requestId'\)/);
  assert.match(audit, /scopedListBody\.data\.items\.every\(item => item\.requestId === requestId\)/);
  assert.match(audit, /scopedListBody\.data\.items\.some\(item => item\.id === gatewayLog\.id\)/);
  assert.ok(audit.indexOf('const scopedListBody =') < audit.indexOf("getByRole('dialog', { name: '请求详情', exact: true })"));
  assert.match(audit, /searchParams\.get\('transaction'\)\)\.toBe\(gatewayLog\.id\)/);
  assert.match(audit, /\[aria-label="前后请求导航"\]/);
  assert.doesNotMatch(audit, /getByText\(requestId, \{ exact: true \}\)\.first|logs\?[^\n]*transaction|route\.fulfill/);
  const failure = source.split('const gatewayFailurePage = await page.context().newPage();')[1]?.split('await gatewayFailurePage.close();')[0];
  assert.ok(failure?.indexOf('await installGatewayLogReadScope(') >= 0 && failure.indexOf('await installGatewayLogReadScope(') < failure.indexOf('await gatewayFailurePage.goto('), 'CDS原故障取证旁路也必须在首个导航前保护');
  assert.match(failure, /verifiedLog: failedLog/);
  assert.match(failure, /scopedListBody\.data\.items\.every\(item => item\.requestId === requestId\)/);
  assert.match(failure, /scopedListBody\.data\.items\.some\(item => item\.id === failedLog\.id\)/);
  assert.match(failure, /searchParams\.get\('transaction'\)\)\.toBe\(failedLog\.id\)/);
  assert.doesNotMatch(failure, /getByText\(failedRequestId, \{ exact: true \}\)\.first|logs\?[^\n]*transaction|route\.fulfill/);
});

test('REG-stsmk-account-scope-001 后台团队用量与历史通知必须在网络前真实阻断', async () => {
  assert.equal(typeof uiContract.blockUnscopedBackgroundReads, 'function', '缺少后台越界读取保护');
  const routes = [];
  await uiContract.blockUnscopedBackgroundReads({ route: async (pattern, handler) => routes.push({ pattern, handler }) });
  for (const path of ['/gw/logical-models/usage?days=30', '/api/dashboard/notifications', '/api/dashboard/notifications?includeHandled=true']) {
    const url = new URL(path, 'https://inspection.invalid');
    const route = routes.find(entry => typeof entry.pattern === 'function' && entry.pattern(url));
    assert.ok(route, `真实越界后台读取未被保护：${path}`);
    let aborted = 0;
    await route.handler({
      abort: async reason => { assert.equal(reason, 'blockedbyclient'); aborted += 1; },
      fulfill: () => assert.fail('禁止伪造成功响应'),
      continue: () => assert.fail('禁止先读取历史数据再丢弃'),
    });
    assert.equal(aborted, 1);
  }
  for (const path of ['/gw/logical-models', '/gw/logical-models/owned-id', '/gw/logical-models/usage-other', '/api/dashboard/notifications/events', '/api/document-store/stores/owned-id']) {
    assert.equal(routes.some(entry => typeof entry.pattern === 'function' && entry.pattern(new URL(path, 'https://inspection.invalid'))), false,
      `不得吞掉原静态目录、事件或本轮业务读取：${path}`);
  }
});

test('REG-stsmk-account-scope-001 后台保护接入共享context、独立登录及网关首个导航前', () => {
  const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  const setup = source.split('test.beforeEach(async ({ context }) => {')[1]?.split("test('[CORE-001]")[0];
  assert.ok(setup?.includes('await blockUnscopedBackgroundReads(context)'), '共享context初始化未接线');
  const login = source.split('async function loginAndReadToken(')[1]?.split('\nasync function readStableAuthSnapshot')[0];
  assert.ok(login?.indexOf('await blockUnscopedBackgroundReads(page)') >= 0);
  assert.ok(login.indexOf('await blockUnscopedBackgroundReads(page)') < login.indexOf('await issueTicket('), '独立手机登录前未保护');
  const console = source.split("test('[GW-001][GW-003][GW-004][VIS-GW-001]")[1]?.split("\n  test('")[0];
  assert.ok(console?.indexOf('await blockUnscopedBackgroundReads(page)') >= 0);
  assert.ok(console.indexOf('await blockUnscopedBackgroundReads(page)') < console.indexOf('await page.goto('), '网关真实导航前未保护');
  for (const original of ['selectGatewayImageLogicalModel(', 'openGatewayLogicalModelDetails(', 'routeDetails']) {
    assert.ok(console.includes(original), `原静态目录/Offering判据必须保留：${original}`);
  }
});

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
  assert.ok(login.indexOf('await blockUnscopedBackgroundReads(page)') >= 0);
  assert.ok(login.indexOf('await blockUnscopedBackgroundReads(page)') < login.indexOf('await issueTicket('), '独立手机context也必须先于登录导航阻断');
  const setup = source.split('test.beforeEach(async ({ context }) => {')[1]?.split("test('[CORE-001]")[0];
  assert.ok(setup?.includes('await blockUnscopedBackgroundReads(context)'), '未登录首页检查同样不得加载公开用户内容');
});

test('REG-stsmk-account-scope-001 全局鉴权观测在两环境认证与导航前阻断，不能借配置绿关闭', () => {
  const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  const sections = [
    ['[REG-auth-diagnosis-001][REG-auth-health-entry-001] 授权健康中心从桌面搜索与移动抽屉均可进入并回读', 'authorization-health', 'loginAndReadToken('],
    ['[REG-auth-synthetic-001] 网关鉴权失败聚合观测须限定巡检范围', 'gateway-failure-health', 'loginGateway('],
    ['[REG-user-error-001] 首页告警不泄漏上游技术细节', 'dashboard-notifications', 'loginAndReadToken('],
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
  const notificationTitle = source.match(/test\('([^']+首页告警不泄漏上游技术细节)'/)?.[1];
  assert.ok(configTitle && observationTitle && authorizationTitle && notificationTitle);
  const observations = [
    { kind: 'authorization-health', title: authorizationTitle, caseIds: ['REG-AUTH-DIAGNOSIS-001', 'REG-AUTH-HEALTH-ENTRY-001'] },
    { kind: 'gateway-failure-health', title: observationTitle, caseIds: ['REG-AUTH-SYNTHETIC-001'] },
    { kind: 'dashboard-notifications', title: notificationTitle, caseIds: ['REG-USER-ERROR-001'] },
  ];
  for (const environment of ['cds', 'production']) {
    for (const observation of observations) {
      let network = 0;
      const annotations = [];
      assert.throws(() => {
        blockUnscopedObservationFixture({ skip: (condition, description) => {
          assert.equal(condition, true);
          annotations.push({ type: 'skip', description });
          throw Error('not-run-before-network');
        } }, environment, observation.kind);
        network += 1;
      }, /not-run-before-network/);
      assert.equal(network, 0);
      assert.match(annotations[0].description, /验收债务.*未执行/);
      assert.match(annotations[0].description, /本轮/);
      const rows = collectPlaywrightCases({ suites: [{ specs: [
        { title: configTitle, tests: [{ results: [{ status: 'passed' }] }] },
        { title: observation.title, tests: [{ results: [{ status: 'skipped', annotations }] }] },
      ] }] }, environment);
      for (const caseId of observation.caseIds) {
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
    '?requestId=${encodeURIComponent(requestId)}&pageSize=10', '/${matched!.id}', '', '',
  ], '实际调用仅精确查询和已匹配详情；其余两个字面量只许用于真实response路径判定');
  assert.equal((source.match(/gatewayApiPolicyPath\(url\.pathname\) === '\/gw\/logs'/g) || []).length, 2,
    '两个无query字面量必须都是页面response路径比较，不能新增裸网络请求');
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

const recordingCleanupSource = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
function actualRecordingCleanupBody() {
  const raw = recordingCleanupSource.split('async function cleanupRecordingIdempotencyFixture(')[1]?.split('\nasync function cleanupShortVideoFixture(')[0];
  assert.ok(raw, '原REC-010必须接入可独立回读三类本轮资源的真实清理函数');
  const body = raw.slice(raw.indexOf(') {') + 3).trim();
  return body.slice(0, body.lastIndexOf('}'))
    .replace('const errors: string[]', 'const errors')
    .replace('const receipt: Record<string, unknown>', 'const receipt')
    .replace(/readEnvelope<[^]*?>\(/g, 'readEnvelope(');
}
function recordingCleanupFixture({ residual = '', readThrows = '', archiveStatus = 'completed', sessionStatus = 'completed', runStatus = 'done', missingRun = false } = {}, body = actualRecordingCleanupBody()) {
  const calls = []; const receipts = [];
  let deleted = false;
  const paths = { store: '/api/document-store/stores/own-store', session: '/api/document-store/recording-uploads/own-session', entry: '/api/document-store/entries/own-entry', run: '/api/document-store/agent-runs/own-run' };
  const respond = (method, path) => {
    assert.ok(Object.values(paths).includes(path), '不得读写其他ID或全局列表');
    calls.push({ method, path });
    if (method === 'GET' && path === paths.session && !deleted) {
      return { status: () => 200, json: async () => ({ success: true, data: { sessionId: 'own-session', status: sessionStatus, archiveStatus, entryId: 'own-entry' } }) };
    }
    if (method === 'GET' && path === paths.run && !deleted) return { status: () => 200, json: async () => ({ success: true, data: { id: 'own-run', storeId: 'own-store', sourceEntryId: 'own-entry', kind: 'transcribe', status: runStatus } }) };
    const kind = Object.keys(paths).find(key => paths[key] === path);
    if (method === 'DELETE' && kind === 'store') deleted = true;
    if (method === 'GET' && kind === readThrows) throw Error('读取失败 token=offline-cleanup-canary');
    return { status: () => method === 'DELETE' ? 200 : kind === residual ? 200 : 404 };
  };
  const page = { request: Object.fromEntries(['get', 'delete'].map(method => [method, async path => respond(method.toUpperCase(), path)])) };
  const info = { attach: async (name, attachment) => { assert.equal(name, 'recording-idempotency-cleanup-receipt'); receipts.push(JSON.parse(attachment.body)); } };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction('page', 'token', 'storeId', 'sessionId', 'entryId', 'deferredRunIds', 'testInfo', 'retryTransientTransport', 'authHeaders', 'stableSmokeCleanupTimeoutMs', 'requiredEnv', 'redactStableSmokeDiagnosticText', 'waitForRecordingIdempotencySettlement', 'readEnvelope', body);
  const action = () => execute(page, 'offline-only', 'own-store', 'own-session', 'own-entry', missingRun ? [] : ['own-run'], info,
    async (_label, operation) => operation(), () => ({}), 100, () => 'stsmk-own-run', redactStableSmokeDiagnosticText,
    options => { let clock = 0; return recordingTools.waitForRecordingIdempotencySettlement({ ...options, timeoutMs: 3, intervalMs: 1, now: () => clock, sleep: async ms => { clock += ms; } }); },
    async response => { assert.equal(response.status(), 200); return (await response.json()).data; });
  return { calls, receipts, paths, action, page, info, execute };
}

test('REG-stsmk-account-scope-001 REC010真实清理函数四类404才绿，run残留或任一读取异常必红且先留回执', async () => {
  for (const options of [{}, ...['store', 'session', 'entry', 'run'].map(residual => ({ residual })), { readThrows: 'session' }, { readThrows: 'run' }]) {
    const f = recordingCleanupFixture(options);
    if (!Object.keys(options).length) await f.action(); else await assert.rejects(f.action, /录音幂等测试清理未闭环/);
    assert.equal(f.receipts.length, 1, '抛错前必须独立记录清理，不靠finally无异常推断');
    const receipt = f.receipts[0];
    assert.equal(receipt.storeId, 'own-store'); assert.equal(receipt.sessionId, 'own-session'); assert.equal(receipt.entryId, 'own-entry');
    for (const kind of ['store', 'session', 'entry', 'run']) assert.ok(f.calls.some(call => call.method === 'GET' && call.path === f.paths[kind]));
    assert.equal(JSON.stringify(receipt).includes('offline-cleanup-canary'), false);
    assert.equal(f.calls.some(call => call.method === 'DELETE' && call.path === f.paths.session), false, '完成会话不可绕过原400取消边界');
    assert.match(receipt.physicalRetentionBoundary, /不可访问.*物理零行/);
    assert.match(receipt.modelCallBoundary, /至多4轮.*网关attempt.*未知/);
    assert.match(receipt.runUniquenessBoundary, /不是独立run唯一性证明.*未关闭/);
    assert.equal(receipt['run:own-runReadbackStatus'], options.readThrows === 'run' ? null : options.residual === 'run' ? 200 : 404);
  }
});

test('REG-stsmk-account-scope-001 REC010须确认已完成归档，pending或completing即使404也不得清理绿', async () => {
  for (const options of [{ archiveStatus: 'pending' }, { archiveStatus: 'archiving' }, { sessionStatus: 'completing' }, { runStatus: 'running' }, { runStatus: 'failed' }, { missingRun: true }]) {
    const f = recordingCleanupFixture(options);
    await assert.rejects(f.action, /录音幂等测试清理未闭环/);
    assert.equal(f.receipts.length, 1);
    assert.ok(f.receipts[0].errors.length > 0);
    assert.ok(f.calls.some(call => call.method === 'DELETE' && call.path === f.paths.store), '风险判据失败后仍清理本轮父库');
    assert.equal(f.calls.some(call => call.method === 'DELETE' && call.path === f.paths.session), false);
  }
});

test('REG-stsmk-account-scope-001 REC010实际finally接线不可丢，删读回判据会复现残留假绿', async () => {
  const raw = recordingCleanupSource.split("test('[REC-010]")[1]?.split("  test('[REC-001]")[0];
  assert.ok(raw);
  const finallyText = raw.split('} finally {')[1];
  assert.ok(finallyText);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const finalizer = new AsyncFunction('page', 'token', 'storeId', 'sessionId', 'entryId', 'deferredRunIds', 'testInfo', 'cleanupRecordingIdempotencyFixture', finallyText.split('\n    }\n  });')[0]);
  const f = recordingCleanupFixture({ residual: 'entry' });
  await assert.rejects(() => finalizer(f.page, 'offline-only', 'own-store', 'own-session', 'own-entry', ['own-run'], f.info,
    (...args) => { assert.deepEqual(args[5], ['own-run']); return f.action(); }), /录音幂等测试清理未闭环/);
  assert.ok(f.calls.some(call => call.path === f.paths.entry && call.method === 'GET'));
  const withoutReadbackPredicate = actualRecordingCleanupBody().replace('if (status !== 404)', 'if (false)');
  assert.notEqual(withoutReadbackPredicate, actualRecordingCleanupBody());
  await recordingCleanupFixture({ residual: 'entry' }, withoutReadbackPredicate).action();
});

test('REG-stsmk-account-scope-001 REC010创建即保存三类身份，原分片和幂等判据/付费边界不减', () => {
  const body = recordingCleanupSource.split("test('[REC-010]")[1].split("  test('[REC-001]")[0];
  for (const name of ['recording-idempotency-store-created', 'recording-idempotency-session-created', 'recording-idempotency-entry-created', 'recording-idempotency-primary-failure']) assert.ok(body.includes(name));
  assert.ok(body.indexOf('recording-idempotency-store-created') < body.indexOf('/recording-uploads`'));
  assert.ok(body.indexOf('recording-idempotency-session-created') < body.indexOf('const midpoint'));
  assert.ok(body.indexOf('recording-idempotency-entry-created') < body.indexOf('const secondComplete'));
  for (const original of ['speechFixture.length / 2', 'data.nextChunkIndex).toBe(index + 1)', 'data.uploadedBytes).toBeGreaterThan(0)', 'nextChunkIndex).toBe(index + 1)', 'duplicate).toBe(true)', 'second.entry.id).toBe(first.entry.id)', 'second.reused).toBe(true)']) assert.ok(body.includes(original), `原核心判据不得削弱：${original}`);
  assert.doesNotMatch(body, /\/transcribe|trigger.*asr|modelId|skip\(/i);
  assert.match(actualRecordingCleanupBody(), /complete可能触发既有默认ASR/);
});
