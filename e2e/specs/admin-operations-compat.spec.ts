import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  installOperationsFixtures,
  target,
  targetName,
} from "../fixtures/admin-operations.mjs";
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
      authenticated: true, enabled: true, user: { name: '审批操作员', isSystemOwner: true },
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
      authenticated: true, enabled: true, user: { name: '审批操作员', isSystemOwner: true },
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
  await page.locator("#llmgw-username").fill("demo");
  await page.locator("#llmgw-password").fill("demo");
  await page.locator("button[type=submit]").click();
  await expect(page.locator(".lg-console-content")).toBeVisible();
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
    await page
      .getByRole("button", { name: "接入模型", exact: false })
      .click();
    let pane = page.getByRole("complementary", { name: "清单详情" });
    await pane.getByRole("button", { name: "连接配置", exact: true }).click();
    await reachable(
      pane.getByRole("button", { name: "编辑连接", exact: true }),
    );
    await pane.getByRole("button", { name: "关闭详情", exact: true }).click();
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
    await page
      .getByRole("button", { name: /11-12 00:00 compat-model/ })
      .click({ position: { x: 5, y: 5 } });
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
      body: { targetId: "compat-target", previewUrl: "https://example.test" },
    },
  ]);
});

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
