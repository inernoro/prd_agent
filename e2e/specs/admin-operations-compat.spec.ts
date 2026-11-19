import { readFileSync } from 'node:fs';
import { observeNativeAudio, nativeAudioEvidence } from '../fixtures/admin-operations-audio';
import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  installOperationsFixtures,
  target,
  targetName,
  run,
} from "../fixtures/admin-operations.mjs";

const gatewayPortraitAssets = JSON.parse(
  readFileSync(new URL('../fixtures/media/gateway-portrait-cdn.json', import.meta.url), 'utf8'),
) as typeof import('../fixtures/media/gateway-portrait-cdn.json');

test.beforeEach(async ({ browser, page }, testInfo) => {
  page.on("pageerror", (error) =>
    testInfo.annotations.push({
      type: "pageerror",
      description: error.message,
    }),
  );
  testInfo.annotations.push({
    type: "engine-version",
    description: browser.version(),
  });
});

test('普通项目成员不能通过环境接入读取系统服务器列表',async({page})=>{
  await installOperationsFixtures(page);
  await page.route('**/api/auth/status',route=>route.fulfill({json:{authenticated:true,enabled:true,
    user:{name:'项目成员',isSystemOwner:false},approvalCapabilities:{accessRequests:false,operator:false}}}));
  const systemReads:string[]=[];
  page.on('request',request=>{if(new URL(request.url()).pathname==='/api/cds-system/remote-hosts')systemReads.push(request.url());});
  await page.goto(`http://127.0.0.1:5273/release-center?project=${target.projectId}`);
  await expect(page.getByRole('heading',{name:'此页面仅系统所有者可用',exact:true})).toBeVisible();
  expect(systemReads).toEqual([]);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`${viewport.width} 单次批准选择已有固定版本且保留分支最新版本`,async({page})=>{
    await page.setViewportSize(viewport);await installOperationsFixtures(page);
    const stamp=new Date().toISOString(),a='a'.repeat(40),b='b'.repeat(40);let records:any[]=[];const writes:any[]=[];
    await page.route('**/api/releases/center?*',route=>route.fulfill({json:{rows:[{target:{...target,governance:{required:true}},currentVersion:'old',currentCommit:a,healthStatus:'healthy',canRollback:false,latestRun:run}],runs:[run],plans:[]}}));
    await page.route('**/api/releases/targets?*',route=>route.fulfill({json:{targets:[{...target,governance:{required:true}}],archivedTargets:[],remoteHosts:[]}}));
    await page.route('**/api/branches?*',route=>route.fulfill({json:{branches:[{id:'compat-branch',projectId:target.projectId,branch:'compat-branch',githubCommitSha:b,commitSha:b,status:'running'}]}}));
    await page.route('**/api/releases/governance?*',route=>route.fulfill({json:{authorizations:records,attempts:[],mergeBacks:[],deploymentVersions:[{id:'saved-a',branchId:'compat-branch',commitSha:a,createdAt:stamp}]}}));
    await page.route('**/api/releases/targets/compat-target/authorizations',async route=>{
      const body=route.request().postDataJSON();writes.push(body);records=[{...body,id:'fixed-a-approval',projectId:target.projectId,targetId:target.id,branchName:'compat-branch',candidateSha:a,requestedBy:'user:requester:申请人',status:'pending',createdAt:stamp}];await route.fulfill({json:{authorization:records[0]}});
    });
    await page.goto(`http://127.0.0.1:5273/release-center?project=${target.projectId}`);
    const panel=page.getByRole('region',{name:'发布审批与连续调试'});await panel.getByRole('button',{name:'新建申请',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'申请发布批准',exact:true});
    await expect(dialog.getByRole('combobox',{name:'申请分支',exact:true})).toContainText(b.slice(0,12));
    await dialog.getByRole('combobox',{name:'批准发布版本',exact:true}).selectOption('saved-a');
    await dialog.getByRole('textbox',{name:'发布目的',exact:true}).fill('批次固定已验收A而分支已经前进B');
    await dialog.getByRole('button',{name:'提交独立审批',exact:true}).click();await expect(dialog).toBeHidden();
    await expect(panel.getByText('fixed-a-approval',{exact:true})).toHaveCount(0);
    await expect(panel.getByText('saved-a',{exact:true})).toBeVisible();await expect(panel.getByText(a,{exact:true})).toBeVisible();
    expect(writes).toHaveLength(1);expect(writes[0]).toMatchObject({kind:'single',action:'release',deploymentVersionId:'saved-a',branchId:'compat-branch'});
    expect(page.url()).toContain('release-center');
  });
  test(`${viewport.width} 已受理的单次批准仍可撤销且不重新批准`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installOperationsFixtures(page);
    const stamp = new Date().toISOString();
    let authorization = { id:'consumed-single', projectId:target.projectId, targetId:target.id,
      branchId:'compat-branch', kind:'single', action:'rollback', rollbackReleaseId:'approved-history', status:'approved',
      requestedBy:'ai:key:fixture-executor', candidateSha:'a'.repeat(40), mainSha:'b'.repeat(40),
      reason:'已受理运行仍在连接时允许真实操作员撤销批准', createdAt:stamp,
      expiresAt:new Date(Date.now()+3600000).toISOString(), allowedPaths:[], consumedBy:'connecting-run',
      decisions:[{action:'approved',by:'user:independent:独立批准人',at:stamp,reason:'已核对固定版本'}] };
    const writes: Array<{path:string;body:unknown}> = [];
    await page.route('**/api/releases/governance?*', route => route.fulfill({json:{authorizations:[authorization],attempts:[],mergeBacks:[]}}));
    await page.route('**/api/releases/authorizations/consumed-single/revoke', async route => {
      writes.push({path:new URL(route.request().url()).pathname,body:route.request().postDataJSON()});
      authorization = {...authorization,status:'revoked'};
      await route.fulfill({json:{authorization}});
    });
    await page.goto(`http://127.0.0.1:5273/release-center?project=${target.projectId}`);
    const panel=page.getByRole('region',{name:'发布审批与连续调试'});
    await expect(panel.getByText('本次批准已使用',{exact:true})).toBeVisible();
    await expect(panel.getByText('回滚目标记录',{exact:true})).toBeVisible();
    await expect(panel.getByText('approved-history',{exact:true})).toBeVisible();
    await panel.getByRole('button',{name:'刷新记录',exact:true}).click();
    await expect(panel.getByText('已刷新审批记录',{exact:true})).toBeVisible();
    await expect(panel.getByRole('button',{name:'独立批准',exact:true})).toHaveCount(0);
    await expect(panel.getByRole('button',{name:'拒绝',exact:true})).toHaveCount(0);
    await expect(panel.getByRole('button',{name:'撤销授权',exact:true})).toBeVisible();
    await panel.getByRole('textbox',{name:'审批意见',exact:true}).fill('连接期间停止本次发布');
    await panel.getByRole('button',{name:'撤销授权',exact:true}).click();
    await expect(panel.getByText('审批决定已保存',{exact:true})).toBeVisible();
    await expect(panel.getByText('已撤销',{exact:true})).toBeVisible();
    await expect(panel.getByRole('button',{name:'撤销授权',exact:true})).toHaveCount(0);
    expect(writes).toEqual([{path:'/api/releases/authorizations/consumed-single/revoke',body:{reason:'连接期间停止本次发布'}}]);
    expect(authorization.consumedBy).toBe('connecting-run');
  });

  test(`${viewport.width} 所有者可为未绑定主机的项目选择既有服务器，选择本身不创建环境`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installOperationsFixtures(page);
    await page.route('**/api/auth/status', route => route.fulfill({json:{authenticated:true,enabled:true,
      user:{name:'接入管理员',isSystemOwner:true},approvalCapabilities:{accessRequests:false,operator:false}}}));
    let hostReads=0, targetWrites=0;
    await page.route('**/api/cds-system/remote-hosts', route => {
      hostReads++;return route.fulfill({json:{hosts:[{id:'system-only-host',name:'已有隔离服务器',host:'127.0.0.1',
        sshPort:2222,sshUser:'fixture',sshPrivateKeyFingerprint:'fixture-fingerprint',isEnabled:true}]}});
    });
    page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/releases/targets')targetWrites++;});
    await page.goto(`http://127.0.0.1:5273/release-center?project=${target.projectId}`);
    if (viewport.width < 768) await page.getByRole('button',{name:'更多操作',exact:true}).click();
    await expect(page.getByRole('button',{name:'新建环境',exact:true})).toBeEnabled();
    expect(hostReads).toBe(0);
    await page.getByRole('button',{name:'新建环境',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'添加环境',exact:true});
    await dialog.getByRole('button',{name:/已有隔离服务器/}).click();
    await dialog.getByRole('button',{name:/生产域名/}).click();
    await expect(dialog).toContainText('fixture@127.0.0.1:2222');
    expect(hostReads).toBe(1);expect(targetWrites).toBe(0);
    await dialog.getByRole('button',{name:'取消',exact:true}).click();
    await expect(dialog).toBeHidden();expect(targetWrites).toBe(0);
  });

  test(`${viewport.width} 运维授权关闭后同一请求不随心跳抢占，新请求和主动刷新仍可处理`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installOperationsFixtures(page);
    await page.route('**/api/auth/status', async route => route.fulfill({ json: {
      authenticated: true, enabled: true, activeProvider: 'local',
      user: { id: 'fixture-approval-operator', username: 'approval-operator', authProvider: 'local', name: '审批操作员', isSystemOwner: true },
      approvalCapabilities: { accessRequests: false, operator: true },
    } }));
    let reads = 0;
    const pending = [{ id: 'pending-one', opId: 'shell.run', opName: '隔离运维请求', opDanger: 'destructive',
      requestedBy: '其他 Agent', requestedAt: '2026-01-01T00:00:00Z', callerKey: 'fixture', status: 'pending' }];
    const mutations: string[] = [];
    page.on('request', req => {
      if (req.method() !== 'GET' && new URL(req.url()).pathname.startsWith('/api/')) mutations.push(new URL(req.url()).pathname);
    });
    await page.route('**/api/cds-system/operator/requests', async route => {
      reads++;
      await route.fulfill({ json: { pending } });
    });
    // 真实 EventSource 重连及心跳触发组件的正常刷新，不直接改 React 状态。
    await page.route('**/api/cds-events', async route => route.fulfill({
      contentType: 'text/event-stream',
      body: `retry: 100\nevent: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString(), data: {} })}\n\n`,
    }));
    await page.goto(`http://127.0.0.1:5273/release-console?project=${target.projectId}&mode=batch`);
    const dialog = page.getByRole('dialog', { name: '需要你的明确授权', exact: true });
    await expect(dialog).toContainText('其他 Agent');
    await reachable(dialog.getByRole('button', { name: '关闭', exact: true }));
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    const afterCloseReads = reads;
    await expect.poll(() => reads, { timeout: 15000 }).toBeGreaterThanOrEqual(afterCloseReads + 2);
    await expect(dialog).toHaveCount(0);
    await page.getByRole('combobox', { name: '当前项目', exact: true }).click({ trial: true });
    expect(mutations).toEqual([]);
    const beforeNewRequestReads = reads;
    pending.unshift({ ...pending[0], id: 'pending-two', opName: '新的隔离运维请求' });
    await expect.poll(() => reads, { timeout: 15000 }).toBeGreaterThan(beforeNewRequestReads);
    await expect(dialog).toContainText('新的隔离运维请求');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.reload();
    await expect(dialog).toContainText('新的隔离运维请求');
    expect(pending.every(item => item.status === 'pending')).toBe(true);
    expect(mutations).toEqual([]);
  });

  test(`${viewport.width} 授权提醒可稍后处理，预检就绪批次可直接取消`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installOperationsFixtures(page);
    await page.route('**/api/auth/status', async (route) => route.fulfill({ json: {
      authenticated: true, enabled: true, activeProvider: 'local',
      user: { id: 'fixture-approval-operator', username: 'approval-operator', authProvider: 'local', name: '审批操作员', isSystemOwner: true },
      approvalCapabilities: { accessRequests: true, operator: false },
    } }));
    const targets = [target, { ...target, id: 'compat-target-b', name: '隔离目标 B' }];
    let batch = {
      id: 'compat-ready-batch', projectId: target.projectId, versionId: 'compat-version', reportId: 'compat-report',
      branchId: 'compat-branch', branchName: 'compat-branch', commitSha: 'a'.repeat(40), status: 'ready',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      targets: targets.map((item) => ({ targetId: item.id, targetName: item.name, status: 'ready', attempts: [], checks: [] })),
    };
    const mutations: string[] = [];
    page.on('request', (req) => {
      const path = new URL(req.url()).pathname;
      if (req.method() !== 'GET' && path.startsWith('/api/')) mutations.push(path);
    });
    await page.route('**/api/access-requests', async (route) => {
      await route.fulfill({ json: { requests: [{ id: 'unrelated-pending', status: 'pending', kind: 'project', projectId: 'other-project', projectName: '其他项目', agentName: '验收 Agent', purpose: '请保留这条未批准申请', createdAt: '2026-01-01T00:00:00Z' }] } });
    });
    await page.route('**/api/releases/targets*', async (route) => route.fulfill({ json: { targets, archivedTargets: [], remoteHosts: [] } }));
    await page.route('**/api/releases/batches**', async (route) => {
      const req = route.request(), path = new URL(req.url()).pathname;
      if (path.endsWith('/accepted-versions')) return route.fulfill({ json: { versions: [] } });
      if (path.endsWith('/cancel') && req.method() === 'POST') {
        batch = { ...batch, status: 'cancelled', updatedAt: new Date().toISOString(), targets: batch.targets.map((item) => ({ ...item, status: 'cancelled' })) };
        return route.fulfill({ json: { batch } });
      }
      return route.fulfill({ json: path.endsWith('/batches') ? { batches: [batch] } : { batch } });
    });
    await page.goto(`http://127.0.0.1:5273/release-console?project=${target.projectId}&batch=${batch.id}`);
    const floating = page.getByTestId('cds-access-request-floating');
    await expect(floating).toContainText('请保留这条未批准申请');
    await floating.getByRole('button', { name: '稍后在信息中心处理', exact: true }).click();
    await expect(floating).toHaveCount(0);
    expect(mutations).toEqual([]);
    const cancel = page.getByRole('button', { name: '取消批次', exact: true });
    await reachable(cancel);
    await cancel.click();
    await expect(page.getByText('已取消', { exact: true }).first()).toBeVisible();
    expect(mutations).toEqual([`/api/releases/batches/${batch.id}/cancel`]);
    expect(batch.targets.every((item) => item.attempts.length === 0)).toBe(true);
    await page.getByRole('button', { name: '信息中心，1 条待处理', exact: true }).click();
    const inbox = page.getByRole('region', { name: '1 个授权申请需要处理', exact: true });
    await expect(inbox).toContainText('请保留这条未批准申请');
    await expect(inbox.getByRole('button', { name: '批准项目访问', exact: true })).toBeVisible();
    expect(mutations).toEqual([`/api/releases/batches/${batch.id}/cancel`, '/api/notices/read-all']);
  });

  test(`${viewport.width} 取消目标重新发布先确认固定版本，返回不写入且只发布选中目标`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installOperationsFixtures(page);
    const commit = 'a'.repeat(40);
    let batch = {
      id: 'compat-cancelled-batch', projectId: target.projectId, versionId: 'compat-version', reportId: 'compat-report',
      branchId: 'compat-branch', branchName: 'compat-branch', commitSha: commit, status: 'cancelled',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      targets: [target, { ...target, id: 'compat-target-b', name: '隔离目标 B' }].map(item => ({
        targetId: item.id, targetName: item.name, status: 'cancelled',
        attempts: [] as Array<{ id: string; kind: string; runId: string; createdAt: string }>,
        runId: undefined as string | undefined, observedCommitSha: undefined as string | undefined,
      })),
    };
    const mutations: string[] = [];
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (req.method() !== 'GET' && path.startsWith('/api/')) mutations.push(path);
    });
    await page.route('**/api/releases/batches**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/accepted-versions')) return route.fulfill({ json: { versions: [] } });
      if (path.endsWith('/targets/compat-target/retry') && route.request().method() === 'POST') {
        expect(route.request().postDataJSON().idempotencyKey).toMatch(/^[a-zA-Z0-9_-]{8,128}$/);
        batch = { ...batch, status: 'partial_success', targets: batch.targets.map((row, index) => index ? row : {
          ...row, status: 'success', observedCommitSha: commit, runId: 'compat-republished',
          attempts: [{ id: 'republished-once', kind: 'deploy', runId: 'compat-republished', createdAt: new Date().toISOString() }],
        }) };
      }
      return route.fulfill({ json: path.endsWith('/batches') ? { batches: [batch] } : { batch } });
    });
    await page.goto(`http://127.0.0.1:5273/release-console?project=${target.projectId}&batch=${batch.id}`);
    const rows = page.getByRole('list', { name: '各目标发布结果', exact: true }).locator(':scope > li');
    await rows.first().getByRole('button', { name: '重新发布此目标', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: '确认重新发布已取消目标', exact: true });
    await expect(confirm).toContainText(targetName);
    await expect(confirm).toContainText(commit);
    expect(mutations).toEqual([]);
    await reachable(confirm.getByRole('button', { name: '返回', exact: true }));
    await confirm.getByRole('button', { name: '返回', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    expect(mutations).toEqual([]);
    await rows.first().getByRole('button', { name: '重新发布此目标', exact: true }).click();
    const execute = confirm.getByRole('button', { name: '确认重新发布', exact: true });
    await reachable(execute);
    await execute.click();
    await expect(rows.first()).toContainText('本批次部署 1 次');
    await expect(rows.first().getByRole('button', { name: '重新发布此目标', exact: true })).toHaveCount(0);
    await expect(rows.nth(1).getByRole('button', { name: '重新发布此目标', exact: true })).toBeVisible();
    expect(batch.targets.map(row => row.attempts.length)).toEqual([1, 0]);
    await page.reload();
    await expect(rows.first()).toContainText('本批次部署 1 次');
    expect(mutations).toEqual([`/api/releases/batches/${batch.id}/targets/compat-target/retry`]);
  });
}
test.afterEach(async ({}, testInfo) => {
  expect(testInfo.annotations.filter((a) => a.type === "pageerror")).toEqual(
    [],
  );
});

for (const route of ['release-console', 'release-center']) {
  test(`${route} 失效项目不能冒用首项或读取别的发布上下文`, async ({ page }) => {
    const invalidRequests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/') && (url.searchParams.get('project') === 'missing-project' || url.searchParams.get('projectId') === 'missing-project' || url.pathname.includes('/missing-project/'))) invalidRequests.push(url.pathname);
    });
    await installOperationsFixtures(page);
    if (route === 'release-console') await page.addInitScript(() => { (window as Window & { __CDS_PREVIEW_INSTANCE__?: boolean }).__CDS_PREVIEW_INSTANCE__ = true; });
    await page.goto(`http://127.0.0.1:5273/${route}?project=missing-project&mode=batch`);
    const project = page.getByRole('combobox', { name: route === 'release-console' ? '当前项目' : '项目', exact: true });
    await expect(page.getByRole('alert')).toContainText('项目不在此实例中');
    await expect(project).toHaveValue('');
    if (route === 'release-console') await expect(page.getByRole('note')).toContainText('不能执行真实发布');
    expect(invalidRequests).toEqual([]);
    const validProjectId = await project.locator('option:not([value=""])').first().getAttribute('value');
    expect(validProjectId).toBeTruthy();
    await project.selectOption(validProjectId!);
    await expect(project).toHaveValue(validProjectId!);
    await expect.poll(() => new URL(page.url()).searchParams.get('project')).toBe(validProjectId);
    if (route === 'release-console') await expect(page.getByRole('heading', { name: '选择版本与目标', exact: true })).toBeVisible();
    else await expect(page.getByRole('button', { name: '新建环境', exact: true })).toBeEnabled();
    expect(invalidRequests).toEqual([]);
  });
}
async function reachable(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  await locator.click({ trial: true });
  const r = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, width: innerWidth };
  });
  expect(r.left).toBeGreaterThanOrEqual(-2);
  expect(r.right).toBeLessThanOrEqual(r.width + 2);
}
async function loginGateway(page: Page) {
  await page.goto("http://127.0.0.1:8200/llmgw/login", {
    waitUntil: "domcontentloaded",
  });
  const scene = page.locator(".consciousness-scene");
  const loginArtwork = page.locator(".consciousness-art");
  const theme = await scene.getAttribute("data-portrait-theme");
  expect(["light", "dark"]).toContain(theme);
  const portrait = theme === "light" ? gatewayPortraitAssets.light.opening : gatewayPortraitAssets.dark.closed;
  await expect(loginArtwork).toHaveAttribute("src", portrait.url);
  await expect.poll(() => loginArtwork.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.locator("#llmgw-username").fill("demo");
  await page.locator("#llmgw-password").fill("demo");
  await page.locator("button[type=submit]").click();
  await expect(page.locator(".gateway-entry")).toHaveAttribute("data-phase", "authorized");
  await expect(page).toHaveURL(/\/llmgw\/quickstart$/);
  await expect(page.getByRole("textbox", { name: "我想做什么", exact: true })).toBeEditable();
  await expect(page.getByRole("button", { name: "进入控制台", exact: true })).toHaveCount(0);
  const coverage = await page.locator('.gateway-quickstart-stage').evaluate(stage => {
    const main = stage.closest('main')!.getBoundingClientRect();
    const scene = stage.querySelector('.consciousness-scene')!.getBoundingClientRect();
    const heading = stage.querySelector('h1')!.getBoundingClientRect();
    return { gaps: [scene.left-main.left, scene.top-main.top, main.right-scene.right, main.bottom-scene.bottom], headingInside: heading.top >= scene.top && heading.bottom <= scene.bottom, radius: getComputedStyle(stage).borderRadius };
  });
  expect(coverage.gaps.every(gap => Math.abs(gap) < 2)).toBe(true);
  expect(coverage.headingInside).toBe(true);
  expect(coverage.radius).toBe('0px');
  await expect(page.locator(".lg-console-content")).toBeVisible();
  await expect(page.locator(".lg-console-header")).toBeVisible({ timeout: 12000 });
  await expect(page.locator(".lg-console-header input")).toHaveCount(0);
  await expect(page.locator(".gateway-quickstart-stage textarea")).toHaveCount(1);
  const expandMenu = page.getByRole("button", { name: "展开菜单", exact: true });
  if (await expandMenu.isVisible()) {
    const sidebar = page.locator(".lg-console-sidebar");
    await expect.poll(() => sidebar.evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(64);
    await expandMenu.click();
    await expect.poll(() => sidebar.evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(224);
    await expect(page.getByRole("button", { name: "收起菜单", exact: true })).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("button", { name: "收起菜单", exact: true }).click();
    await expect.poll(() => sidebar.evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(64);
  }
  if (await page.getByLabel("打开导航", { exact: true }).isVisible())
    await page.getByLabel("打开导航", { exact: true }).click();
  await page.locator('nav a[href="/llmgw/logical-models"]').click();
}
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 800, height: 600 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
])
  for (const theme of ["light", "dark"]) {
    test(`${viewport.width} ${theme} 核心管理操作`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await installOperationsFixtures(page);
      await page.addInitScript((t) => {
        localStorage.setItem("cds_theme", t);
        localStorage.setItem("cds_ui_scale", "100");
        localStorage.setItem("llmgw.theme", t);
      }, theme);
      await page.goto("http://127.0.0.1:5273/project-list");
      if (await page.getByLabel("打开导航菜单").isVisible())
        await page.getByLabel("打开导航菜单").click();
      await page.getByRole("link", { name: "发布中心", exact: true }).first().click();
      await expect(page).toHaveURL(/\/release-center/);
      await expect(page.getByRole('region', { name: '线上版本与主干追溯' })).toBeVisible();
      if (!await page.getByRole('link', { name: '发布工作台', exact: true }).filter({ visible: true }).last().isVisible()) {
        await page.getByRole('button', { name: '更多操作', exact: true }).click();
      }
      await page.getByRole('link', { name: '发布工作台', exact: true }).filter({ visible: true }).last().click();
      await expect(page.getByRole('heading', { name: '选择版本与目标', exact: true })).toBeVisible();
      await page.getByRole('navigation', { name: '发布方式' }).getByRole('link', { name: '逐目标发布', exact: true }).click();
      await reachable(page.getByLabel("要发布的版本"));
      await page.getByRole("button", { name: "开始发布", exact: true }).click();
      const confirm = page.getByRole("button", {
        name: `确认发布到 ${targetName}`,
        exact: true,
      });
      await reachable(confirm);
      await confirm.click();
      await expect(
        page.getByText("隔离预检失败", { exact: false }).first(),
      ).toBeVisible();
      await page.getByRole("button", { name: "流水线", exact: true }).click();
      await reachable(page.getByRole("button", { name: "关闭", exact: true }));
      await page.getByRole("button", { name: "关闭", exact: true }).click();
      await page.getByRole("tab", { name: /^失败/ }).click();
      await page
        .getByRole("button", { name: "看日志", exact: true })
        .first()
        .click();
      await expect(
        page.getByText("COMPAT_LOG_END", { exact: true }).last(),
      ).toBeAttached();
      const lastLog = page.locator(".cds-log-line").last();
      await lastLog.scrollIntoViewIfNeeded();
      await expect(lastLog).toBeVisible();
      await expect(lastLog).toContainText("COMPAT_LOG_END");
      expect(
        await lastLog.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.right <= innerWidth + 2;
        }),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath("release-console.png"),
      });
      await testInfo.attach("发布控制台", {
        path: testInfo.outputPath("release-console.png"),
        contentType: "image/png",
      });
      await loginGateway(page);
      await page
        .getByRole("button", { name: "查看", exact: true })
        .first()
        .click();
      const pane = page.getByRole("complementary", { name: "清单详情" });
      await reachable(
        pane.getByRole("button", { name: "升级策略", exact: true }),
      );
      await pane.getByRole("button", { name: "模型配置", exact: true }).click();
      await pane
        .getByRole("button", { name: "指定调用方", exact: true })
        .click();
      const input = page.getByLabel("验收模型 指定的调用方");
      await reachable(input);
      await input.fill("compat.test::chat");
      await reachable(pane.getByRole("button", { name: "保存", exact: true }));
      await pane.getByRole("button", { name: "保存", exact: true }).click();
      await expect(
        page.getByText("1 个调用方不点名时，从现在起走「验收模型」", {
          exact: true,
        }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("logical-models.png"),
      });
      await testInfo.attach("模型配置", {
        path: testInfo.outputPath("logical-models.png"),
        contentType: "image/png",
      });
    });
  }
test("320 双倍字号模型配置回归", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await installOperationsFixtures(page);
  await loginGateway(page);
  await page.addStyleTag({
    content:
      ".lg-collection-page { --fs-body: 28px; --fs-secondary: 26px; --fs-heading: 32px; --fs-caption: 24px; }",
  });
  await page.getByRole("button", { name: "查看", exact: true }).first().click();
  const pane = page.getByRole("complementary", { name: "清单详情" });
  await reachable(pane.getByRole("button", { name: "升级策略", exact: true }));
  expect(
    await pane.evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(1);
  await pane.getByRole("button", { name: "模型配置", exact: true }).click();
  await pane.getByRole("button", { name: "指定调用方", exact: true }).click();
  await reachable(page.getByLabel("验收模型 指定的调用方"));
  await reachable(pane.getByRole("button", { name: "保存", exact: true }));
});
async function keyboardViewport(page: Page) {
  await page.evaluate(() => {
    const viewport = new EventTarget();
    Object.assign(viewport, {
      width: 390,
      height: 300,
      offsetTop: 120,
      offsetLeft: 0,
      scale: 1,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
    window.dispatchEvent(new Event("resize"));
  });
}
async function insideKeyboardViewport(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.click({ trial: true });
  const r = await locator.boundingBox();
  expect(r).not.toBeNull();
  expect(r!.y).toBeGreaterThanOrEqual(120);
  expect(r!.y + r!.height).toBeLessThanOrEqual(421);
}
for (const theme of ["light", "dark"])
  test(`${theme} 可视区域缩小与共享弹窗`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const fixture = await installOperationsFixtures(page);
    await page.addInitScript((t) => {
      localStorage.setItem("cds_theme", t);
      localStorage.setItem("llmgw.theme", t);
    }, theme);
    // 发布中心是共享 Dialog 的另一个实际使用方。
    await page.goto(
      "http://127.0.0.1:5273/release-center?project=fixture-project",
    );
    await page.getByRole("button", { name: "环境与配置", exact: true }).click();
    await page.getByRole("button", { name: "添加环境", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await keyboardViewport(page);
    await insideKeyboardViewport(
      dialog.getByRole("button", { name: "关闭", exact: true }),
    );
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await loginGateway(page);
    await page.getByRole("button", { name: "查看", exact: true }).click();
    const pane = page.getByRole("complementary", { name: "清单详情" });
    await pane.getByRole("button", { name: "模型配置", exact: true }).click();
    await pane.getByRole("button", { name: "删除", exact: true }).click();
    const prompt = page.getByRole("dialog");
    await expect(prompt).toBeVisible();
    await keyboardViewport(page);
    await prompt.getByLabel("确认请输入 publicId").fill("compat-model");
    await insideKeyboardViewport(
      prompt.getByRole("button", { name: "删除", exact: true }),
    );
    await insideKeyboardViewport(
      prompt.getByRole("button", { name: "取消", exact: true }),
    );
    await prompt.getByRole("button", { name: "取消", exact: true }).click();
    expect(
      fixture.writes.some((x: { method: string }) => x.method === "DELETE"),
    ).toBe(false);
  });
for (const theme of ["light", "dark"])
  test(`${theme} 共享详情其他使用方和长调用日志`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const fixture = await installOperationsFixtures(page);
    await page.addInitScript(
      (t) => localStorage.setItem("llmgw.theme", t),
      theme,
    );
    await loginGateway(page);
    async function nav(path: string) {
      if (await page.getByLabel("打开导航", { exact: true }).isVisible())
        await page.getByLabel("打开导航", { exact: true }).click();
      await page.locator(`nav a[href="/llmgw/${path}"]`).click();
    }
    await nav("platforms");
    const providerEntry = page.getByRole("button", { name: "尚未接入模型", exact: false });
    await providerEntry.click();
    let pane = page.getByRole("complementary", { name: "清单详情" });
    await pane.getByRole("button", { name: "连接配置", exact: true }).click();
    await reachable(
      pane.getByRole("button", { name: "编辑连接", exact: true }),
    );
    await pane.getByRole("button", { name: "返回上游清单", exact: true }).click();
    await expect(providerEntry).toBeFocused();
    await nav("service-keys");
    await page
      .getByRole("button", { name: "1 个调用用途", exact: true })
      .first()
      .click();
    pane = page.getByRole("complementary", { name: "清单详情" });
    await pane.getByRole("button", { name: "轮换与使用", exact: true }).click();
    await pane.getByRole("button", { name: "撤销", exact: true }).click();
    const revoke = page.getByRole("dialog");
    await reachable(revoke.getByRole("button", { name: "取消", exact: true }));
    await revoke.getByRole("button", { name: "取消", exact: true }).click();
    expect(fixture.writes.some((write) => write.method === "DELETE")).toBe(
      false,
    );
    await reachable(
      pane.getByRole("button", { name: "关闭详情", exact: true }),
    );
    await pane.getByRole("button", { name: "关闭详情", exact: true }).click();
    await nav("logs");
    const requestRow = page.getByRole("button").filter({
      has: page.getByRole("link", { name: "compat-model", exact: true }),
    });
    await expect(requestRow).toHaveCount(1);
    await requestRow.click({ position: { x: 5, y: 5 } });
    const detail = page.getByRole("dialog", { name: "请求详情" });
    await expect(detail).toBeVisible();
    await detail.getByRole("tab", { name: "请求与响应", exact: true }).click();
    await expect(
      detail.getByText(/request-long-request/).first(),
    ).toBeVisible();
    await detail.getByRole("tab", { name: "审计", exact: true }).click();
    await reachable(
      detail.getByRole("button", { name: "关闭详情", exact: true }),
    );
    await detail.getByRole("button", { name: "关闭详情", exact: true }).click();
    fixture.setError(true);
    await nav("logical-models");
    await expect(page.getByRole("alert")).toContainText("加载失败，请重试");
    fixture.setError(false);
    await nav("logs");
    await nav("logical-models");
    await expect(
      page.getByRole("button", { name: "查看", exact: true }),
    ).toBeVisible();
  });
for (const theme of ["light", "dark"]) {
  test(`320 ${theme} CDS 双倍字号完整确认目标`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await installOperationsFixtures(page);
    await page.addInitScript((t) => localStorage.setItem("cds_theme", t), theme);
    await page.goto("http://127.0.0.1:5273/project-list");
    await page.getByLabel("打开导航菜单").click();
    await page.getByRole("link", { name: "发布中心", exact: true }).click();
    await expect(page).toHaveURL(/\/release-center/);
    await expect(page.getByRole('region', { name: '线上版本与主干追溯' })).toBeVisible();
    if (!await page.getByRole('link', { name: '发布工作台', exact: true }).filter({ visible: true }).last().isVisible()) {
      await page.getByRole('button', { name: '更多操作', exact: true }).click();
    }
    await page.getByRole('link', { name: '发布工作台', exact: true }).filter({ visible: true }).last().click();
    await expect(page.getByRole('heading', { name: '选择版本与目标', exact: true })).toBeVisible();
    await page.getByRole('navigation', { name: '发布方式' }).getByRole('link', { name: '逐目标发布', exact: true }).click();
    await expect(page.getByLabel("要发布的版本")).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await reachable(page.getByLabel("要发布的版本"));
    await page.getByRole("button", { name: "开始发布", exact: true }).click();
    const confirm = page.getByRole("button", {
      name: `确认发布到 ${targetName}`,
      exact: true,
    });
    const target = page.getByRole("region", { name: "本次发布目标", exact: true });
    await expect(target).toHaveText(targetName);
    await target.scrollIntoViewIfNeeded();
    const targetLayout = await target.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return { width: el.clientWidth, height: el.clientHeight, bottom: el.scrollTop + el.clientHeight, fullHeight: el.scrollHeight, viewport: innerHeight };
    });
    expect(targetLayout.height).toBeLessThanOrEqual(targetLayout.viewport * 0.4 + 1);
    expect(targetLayout.bottom).toBeGreaterThanOrEqual(targetLayout.fullHeight - 1);
    await reachable(confirm);
    const layout = await confirm.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const label = el.querySelector("span")!;
      const text = label.getBoundingClientRect();
      return {
        buttonHeight: rect.height,
        textWidth: text.width,
        fontSize: parseFloat(getComputedStyle(label).fontSize),
        viewportHeight: innerHeight,
      };
    });
    // 横向不溢出、trial click 成功仍可能是逐字竖排的多屏按钮。
    expect(layout.buttonHeight).toBeLessThan(layout.viewportHeight - 32);
    expect(layout.textWidth).toBeGreaterThanOrEqual(layout.fontSize * 4);
    await testInfo.attach("大字确认布局", {
      body: JSON.stringify(layout), contentType: "application/json",
    });
    expect(
      await confirm.evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("large-text-confirm.png") });
    await testInfo.attach("完整确认目标", {
      path: testInfo.outputPath("large-text-confirm.png"), contentType: "image/png",
    });
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "开始发布", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "开始发布", exact: true }).click();
    await confirm.click();
    await expect(page.getByText("隔离预检失败", { exact: false }).first()).toBeVisible();
  });
}
test("390 隔离发布成功闭环", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await installOperationsFixtures(page);
  fixture.setPreflightPass(true);
  await page.goto("http://127.0.0.1:5273/project-list");
  await page.getByLabel("打开导航菜单").click();
  await page.getByRole("link", { name: "发布中心", exact: true }).click();
  await expect(page).toHaveURL(/\/release-center/);
  await expect(page.getByRole('region', { name: '线上版本与主干追溯' })).toBeVisible();
  if (!await page.getByRole('link', { name: '发布工作台', exact: true }).filter({ visible: true }).last().isVisible()) {
    await page.getByRole('button', { name: '更多操作', exact: true }).click();
  }
  await page.getByRole('link', { name: '发布工作台', exact: true }).filter({ visible: true }).last().click();
  await expect(page.getByRole('heading', { name: '选择版本与目标', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: '发布方式' }).getByRole('link', { name: '逐目标发布', exact: true }).click();
  await page.getByRole("button", { name: "开始发布", exact: true }).click();
  const confirm = page.getByRole("button", {
    name: `确认发布到 ${targetName}`,
    exact: true,
  });
  await reachable(confirm);
  await confirm.click();
  const output = page
    .locator(".cds-log-line")
    .filter({ hasText: "COMPAT_RELEASE_SUCCESS" });
  await output.scrollIntoViewIfNeeded();
  await expect(output).toBeVisible();
  expect(
    fixture.writes.filter((write) =>
      write.path.endsWith("/branches/compat-branch/runs"),
    ),
  ).toEqual([
    {
      path: "/api/releases/branches/compat-branch/runs",
      method: "POST",
      body: { targetId: "compat-target", previewUrl: "https://example.test", expectedCommitSha: run.commitSha },
    },
  ]);
});

test('网关对话在临界宽度保持首项可点并可折叠侧栏', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installOperationsFixtures(page, { quickstart: true });
  await page.goto('http://127.0.0.1:8200/llmgw/login');
  await page.locator('#llmgw-username').fill('demo');
  await page.locator('#llmgw-password').fill('demo');
  await page.getByRole('button', { name: '开始身份确认', exact: true }).click();
  await expect(page).toHaveURL(/\/quickstart$/);
  const header = page.locator('.lg-console-header');
  const sidebar = page.getByRole('complementary', { name: '主导航', exact: true });
  const dialogue = sidebar.getByRole('link', { name: '对话', exact: true });
  await expect(header).toHaveCSS('left', '224px');
  await dialogue.click({ trial: true });
  await sidebar.getByRole('button', { name: '收起菜单', exact: true }).click();
  await expect(header).toHaveCSS('left', '64px');
  await expect(sidebar).toHaveCSS('width', '64px');
  await dialogue.click({ trial: true });
  await page.setViewportSize({ width: 860, height: 800 });
  await expect(header).toHaveCSS('left', '0px');
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await dialogue.click();
  await expect(page.getByRole('button', { name: '打开导航', exact: true })).toHaveAttribute('aria-expanded', 'false');
});

test('慢加载日景超过首屏保护时限后仍按电影收尾', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  await installOperationsFixtures(page, { quickstart: true });
  let releaseMedia!: () => void;
  const mediaGate = new Promise<void>(resolve => { releaseMedia = resolve; });
  await page.route(gatewayPortraitAssets.light.motion.url, async route => {
    await mediaGate;
    await route.continue();
  });
  try {
    await page.goto('http://127.0.0.1:8200/llmgw/login', { waitUntil: 'domcontentloaded' });
    await page.locator('#llmgw-username').fill('demo');
    await page.locator('#llmgw-password').fill('demo');
    await page.getByRole('button', { name: '开始身份确认', exact: true }).click();
    await expect(page).toHaveURL(/\/quickstart$/);
    const arrivingAt = Date.now();
    const movie = page.locator('video.portrait-motion');
    await expect(movie).toHaveJSProperty('currentTime', 0);
    await page.waitForTimeout(3450);
    releaseMedia();
    await page.waitForFunction(() => {
      const video = document.querySelector<HTMLVideoElement>('video.portrait-motion');
      return video && video.currentTime >= 7.15 && !video.ended;
    });
    expect(Date.now() - arrivingAt).toBeGreaterThan(10000);
    const root = page.locator('html');
    await expect(root).toHaveAttribute('data-entry-arriving', '');
    await expect(movie).toHaveJSProperty('ended', true);
    await expect(root).not.toHaveAttribute('data-entry-arriving', '');
  } finally {
    releaseMedia();
  }
});

for (const width of [390, 1440])
  for (const theme of ["light", "dark"] as const) {
    test(`${width} ${theme} 电影式接入全流程与账户组织布局`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const { writes } = await installOperationsFixtures(page, { quickstart: true });
      await observeNativeAudio(page);
      await page.addInitScript(t => {
        // Seed only the cold start; reload must exercise the user's persisted choice.
        if (!sessionStorage.getItem("compat-entry-theme-seeded")) {
          localStorage.setItem("llmgw.theme", t);
          sessionStorage.setItem("compat-entry-theme-seeded", "1");
        }
      }, theme);
      await page.goto("http://127.0.0.1:8200/llmgw/login");
      await page.locator("#llmgw-username").fill("demo");
      await page.locator("#llmgw-password").fill("demo");
      await page.getByRole("button", { name: "开始身份确认", exact: true }).click();
      await expect(page).toHaveURL(/\/quickstart$/);
      await expect(page.locator(".lg-console-header")).toBeVisible({ timeout: 12000 });

      await page.waitForLoadState("networkidle");
      await page.reload();
      const firstNavigation = page.locator(".lg-console-sidebar nav a").first();
      await expect(firstNavigation).toHaveAttribute("aria-label", "对话");
      await expect(firstNavigation).toHaveAttribute("href", /\/quickstart$/);
      await expect(page.locator(".gateway-identity-card")).toHaveCount(0);
      await expect(page.locator(".consciousness-ghost > span")).toHaveText("LLM Gateway");
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      const userMenu = page.locator("details.lg-user-menu");
      const userToggle = page.getByLabel("打开用户菜单", { exact: true });
      const setTheme = async (next: keyof typeof gatewayPortraitAssets) => {
        await userToggle.click();
        await page.getByRole("button", { name: next === "light" ? "切换浅色" : "切换深色", exact: true }).click();
        await expect(userMenu).not.toHaveAttribute("open", "");
        await expect(page.locator("html")).toHaveAttribute("data-theme", next);
        await expect(page.locator(".gateway-quickstart-stage")).toHaveCSS("color-scheme", next);
        await expect(page.locator(".consciousness-scene")).toHaveAttribute("data-portrait-theme", next);
        await expect(page.locator(".consciousness-art")).toHaveAttribute("src", gatewayPortraitAssets[next].open.url);
        await expect(page.locator(".consciousness-mist")).toHaveCount(0);
      };
      const navigateTo = async (name: string) => {
        if (await page.getByLabel("打开导航", { exact: true }).isVisible()) await page.getByLabel("打开导航", { exact: true }).click();
        await page.locator(".lg-console-sidebar nav").getByRole("link", { name, exact: true }).click();
        await page.waitForLoadState("networkidle");
      };
      const otherTheme = theme === "light" ? "dark" : "light";
      const originalInk = await page.locator(".gateway-intent-heading").evaluate(el => getComputedStyle(el).color);
      await setTheme(otherTheme);
      expect(await page.locator(".gateway-intent-heading").evaluate(el => getComputedStyle(el).color)).not.toBe(originalInk);
      await navigateTo("概览");
      await expect(page.locator("html")).toHaveAttribute("data-theme", otherTheme);
      await navigateTo("对话");
      await page.waitForLoadState("networkidle");
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", otherTheme);
      await expect(page.locator(".gateway-quickstart-stage")).toHaveCSS("color-scheme", otherTheme);
      await setTheme(theme);
      await userToggle.click();
      await page.locator(".lg-user-popover").getByLabel("切换组织", { exact: true }).click();
      const organizations = page.locator("details.gateway-account-organizations");
      await expect(organizations).toHaveAttribute("open", "");
      await expect(userMenu).toHaveAttribute("open", "");
      await page.locator(".lg-console-brand > span:last-child").click();
      await expect(userMenu).not.toHaveAttribute("open", "");
      await expect(organizations).not.toHaveAttribute("open", "");
      await userToggle.click();
      await page.keyboard.press("Escape");
      await expect(userMenu).not.toHaveAttribute("open", "");
      await expect(userToggle).toBeFocused();
      await page.locator(".gateway-entry-help > summary").click();
      await page.locator(".lg-console-brand > span:last-child").click();
      await expect(page.locator(".gateway-entry-help")).not.toHaveAttribute("open", "");
      const hoverTarget = page.locator(".gateway-intent-starters button").first();
      const idleBackground = await hoverTarget.evaluate(el => getComputedStyle(el).backgroundColor);
      await hoverTarget.hover();
      await expect.poll(() => hoverTarget.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(idleBackground);
      await page.mouse.move(0, 0);
      const starters = page.getByRole("group", { name: "从一个想法开始" });
      await expect(starters.getByRole("button")).toHaveCount(4);
      const draftCalls = () => writes.filter(write => write.path === "/app-callers/draft").length;
      const before = draftCalls();
      await expect(page.getByText('智能建议费用由平台承担', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: '手动接入', exact: true }).click();
      await expect(page.getByRole('textbox', { name: '应用标识（英文）', exact: true })).toBeVisible();
      expect(draftCalls()).toBe(before);
      await page.getByRole('button', { name: '使用智能建议（会调用模型，费用由平台承担）', exact: true }).click();
      await expect(page.getByRole('textbox', { name: '我想做什么', exact: true })).toBeVisible();
      expect(draftCalls()).toBe(before);
      await starters.getByRole("button", { name: "搭建知识库助手", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "我想做什么", exact: true })).toHaveValue(/团队知识库助手/);
      expect(draftCalls()).toBe(before);
      await page.locator(".gateway-entry-help > summary").click();
      await expect(page.locator(".gateway-entry-help-body")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await page.getByRole("button", { name: "试试这句", exact: true }).click();
      await expect(page.locator(".gateway-entry-help")).not.toHaveAttribute("open", "");
      await page.getByRole("button", { name: "准备接入", exact: true }).click();
      await expect(page.getByRole("heading", { name: "确认你的接入", exact: true })).toBeVisible();
      await page.waitForLoadState("networkidle");
      await page.reload();
      await page.locator(".gateway-entry-resume button").click();
      await expect(page.getByRole("textbox", { name: "我想做什么", exact: true })).toHaveValue(/产品文档.*售后同事/);
      expect(draftCalls()).toBe(before + 1);
      const sound = page.locator(".gateway-chrome-sound");
      await expect(sound).toHaveAttribute("data-audio-status", "pending");
      if (await sound.getAttribute("data-audio-status") === "ready") await sound.click();
      await sound.click();
      try {
        await expect(sound).toHaveAttribute("data-audio-status", "ready");
      } finally {
        const evidence = await nativeAudioEvidence(page);
        console.log("Layout native audio evidence:", testInfo.title, JSON.stringify(evidence));
        await testInfo.attach("layout-native-audio", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
      }
      await sound.click();
      await expect(sound).toHaveAttribute("data-audio-status", "muted");
      await page.getByLabel("打开用户菜单", { exact: true }).click();
      await page.locator(".lg-user-popover").getByLabel("切换组织", { exact: true }).click();
      const account = page.locator(".lg-user-popover");
      await expect(account.getByRole("menu", { name: "可用组织" })).toBeVisible();
      const menuBounds = await account.evaluate(el => {
        const list = el.querySelector(".gateway-account-organization-list")!.getBoundingClientRect();
        const menu = el.getBoundingClientRect();
        const name = el.querySelector(".gateway-account-organizations > summary > span")!;
        return { inside: list.left >= menu.left && list.right <= menu.right, overflow: el.scrollWidth > el.clientWidth, nameWidth: name.getBoundingClientRect().width, nameBackground: getComputedStyle(name).backgroundColor };
      });
      expect(menuBounds.inside).toBe(true);
      expect(menuBounds.overflow).toBe(false);
      expect(menuBounds.nameWidth).toBeGreaterThan(100);
      expect(menuBounds.nameBackground).toBe("rgba(0, 0, 0, 0)");
      await testInfo.attach("account-organization", { body: await page.screenshot(), contentType: "image/png" });
      await page.getByLabel("打开用户菜单", { exact: true }).click();

      const assertScene = async (step: string) => {
        await expect(page.locator(".gateway-flow-frame")).toHaveAttribute("data-step", step);
        await expect(page.locator(".gateway-flow-frame")).toHaveCSS("transform", "none");
        const artwork = page.locator(".consciousness-art");
        await expect(artwork).toHaveAttribute("src", gatewayPortraitAssets[theme].open.url);
        await expect.poll(() => artwork.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
        const state = await page.locator(".gateway-quickstart-stage").evaluate(stage => {
          const scene = stage.querySelector(".consciousness-scene")!.getBoundingClientRect(), main = stage.closest("main")!.getBoundingClientRect();
          const surface = stage.querySelector(".lg-qs-step-card, .lg-qs-key-hero");
          return { gaps: [scene.left - main.left, scene.top - main.top, main.right - scene.right, main.bottom - scene.bottom], blur: surface ? getComputedStyle(surface).backdropFilter : "", overflow: document.documentElement.scrollWidth > innerWidth };
        });
        expect(state.gaps.every(gap => Math.abs(gap) < 2)).toBe(true);
        expect(state.overflow).toBe(false);
        expect(state.blur).toContain("blur");
        await testInfo.attach(step, { body: await page.screenshot(), contentType: "image/png" });
      };
      await page.getByRole("textbox", { name: "我想做什么", exact: true }).fill("为团队知识库接入问答助手");
      await page.getByRole("textbox", { name: "我想做什么", exact: true }).press("Enter");
      await expect(page.getByRole("button", { name: "下一步", exact: true })).toBeEnabled();
      await assertScene("draft");
      await page.getByRole("button", { name: "下一步", exact: true }).click();
      await page.getByRole('textbox', { name: '应用标识（英文）', exact: true }).fill('knowledge-assistant');
      await page.getByRole("radio", { name: "知识库团队", exact: true }).click();
      await page.getByRole("textbox", { name: "月预算（美元）", exact: true }).fill("25");
      await assertScene("owner");
      const advancedGap = await page.locator(".lg-qs-create-footer").evaluate(el => {
        const summary = el.parentElement!.querySelector(".lg-explainer > summary")!;
        return el.getBoundingClientRect().top - summary.getBoundingClientRect().bottom;
      });
      expect(advancedGap).toBeGreaterThanOrEqual(0);
      await page.getByRole("button", { name: "修改建议", exact: true }).click();
      await expect(page.getByText("team.knowledge::chat", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "下一步", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "月预算（美元）", exact: true })).toHaveValue("25");
      await page.getByRole("button", { name: "创建密钥", exact: true }).click();
      await expect(page.getByText("gwk_fixture_visual_only_not_a_credential", { exact: true })).toBeVisible();
      await assertScene("result");
      await expect(page.getByText(/未访问上游。/)).toBeVisible();
      const governance = writes.find(w => w.path === "/app-callers/fixture-caller" && w.method === "PUT")!.body as { monthlyBudgetUsd: number; budgetReservationUsd: number };
      expect(governance.monthlyBudgetUsd).toBe(25);
      expect(governance.budgetReservationUsd).toBeGreaterThan(0);
      expect(writes.filter(w => w.path === "/service-keys" && w.method === "POST")).toHaveLength(1);
      await page.getByRole("tab", { name: "cURL", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "试跑要发送的内容", exact: true })).toBeVisible();
      await assertScene("result");
      await page.getByRole("tab", { name: "提示词", exact: true }).click();
      await expect(page.getByRole("radiogroup", { name: "调用方式" })).toBeVisible();
      await page.waitForLoadState("networkidle");
      await page.reload();
      await expect(page.locator(".gateway-intent-starters")).toBeVisible();
      await expect(page.locator(".gateway-entry-resume button")).toHaveCount(0);
    });
  }

for (const routePath of ['release-console', 'release-center']) {
  for (const width of [1440, 390]) {
    test(`${routePath} ${width} 项目列表失败后刷新在原页面恢复且仍校验项目`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await installOperationsFixtures(page);
      let projectReads = 0;
      const centerProjects: string[] = [], writes: string[] = [];
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname === '/api/releases/center') centerProjects.push(url.searchParams.get('project') || '');
        if (url.pathname.startsWith('/api/') && request.method() !== 'GET') writes.push(url.pathname);
      });
      await page.route('**/api/projects', async route => {
        projectReads++;
        await route.fulfill(projectReads === 1
          ? { status: 503, json: { error: '项目清单暂不可用' } }
          : { json: { projects: [{ id: target.projectId, name: '重试后可选的项目' }] } });
      });
      await page.goto(`http://127.0.0.1:5273/${routePath}?project=${target.projectId}`);
      await expect(page.getByText('项目清单暂不可用').first()).toBeVisible();
      expect(centerProjects).toEqual([]);
      await page.evaluate(() => { Object.assign(window, { __projectRetryPageAlive: true }); });
      if (width === 390) await page.getByRole('button', { name: '更多操作', exact: true }).click();
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      if (width === 390) await page.keyboard.press('Escape');
      await expect.poll(() => projectReads, { timeout: 8000 }).toBe(2);
      await expect.poll(() => centerProjects.length).toBeGreaterThan(0);
      expect(centerProjects.every(project => project === target.projectId)).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, '__projectRetryPageAlive'))).toBe(true);
      await expect(page.getByRole('combobox', {
        name: routePath === 'release-center' ? '项目' : '当前项目', exact: true,
      })).toHaveValue(target.projectId);
      expect(writes).toEqual([]);
    });
  }
}

test('账务角色普通登录默认落在可访问概览', async ({ page }) => {
  await installOperationsFixtures(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/auth/login', route => route.fulfill({json:{success:true,data:{token:'fixture',username:'billing-user',expiresAt:new Date(Date.now()+3600000).toISOString(),mustChangePassword:false,tenant:{id:'t1',name:'验收租户',isInternal:true,role:'billing',teamIds:[]}}}}));
  await page.goto('http://127.0.0.1:8200/llmgw/login');
  await page.locator('#llmgw-username').fill('billing-user');
  await page.locator('#llmgw-password').fill('fixture-only');
  await page.getByRole('button',{name:'开始身份确认',exact:true}).click();
  await expect(page).toHaveURL(/\/llmgw\/?$/);
  await expect(page.getByText('当前角色不包含此页面')).toHaveCount(0);
  await expect(page.locator('.lg-console-sidebar nav a').first()).toHaveAttribute('href',/\/llmgw\/?$/);
});
