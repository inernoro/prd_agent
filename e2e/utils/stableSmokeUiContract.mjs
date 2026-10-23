import { randomUUID } from 'node:crypto';

function contract(condition, message, classification = 'test/ui-contract') {
  if (!condition) throw new Error(`[${classification}] ${message}`);
}

/** Public community content is outside this run even when its API is anonymous. */
export async function blockPublicCommunityReads(surface) {
  await surface.route('**/api/submissions/public**', route => route.abort('blockedbyclient'));
}

/** Compare the source-proven console mount; never rewrite the browser's request. */
export function gatewayApiPolicyPath(pathname) {
  return pathname.replace(/^\/llmgw(?=\/gw(?:\/|$))/, '');
}

/** API login stays at the configured root; production's public UI is mounted separately. */
export function resolveGatewayUiBaseUrl(baseUrl, environment) {
  contract(['cds', 'production'].includes(environment), '控制台入口须绑定已登记环境');
  let api;
  try { api = new URL(baseUrl); } catch { contract(false, '控制台缺少有效API入口'); }
  contract(api.protocol === 'https:' && !api.username && !api.password
    && api.pathname === '/' && !api.search && !api.hash,
  '网关API必须使用已配置的无凭据HTTPS根入口，不能猜测其他挂载');
  // exec_dep.sh public surface + llmgw/web runtimeBase are guarded by the same test.
  return environment === 'production' ? `${api.origin}/llmgw` : api.origin;
}

/** Block real out-of-run background reads, without replacing them with fake success. */
export async function blockUnscopedBackgroundReads(surface) {
  await blockPublicCommunityReads(surface);
  await surface.route(url => gatewayApiPolicyPath(url.pathname) === '/gw/logical-models/usage'
    || url.pathname === '/api/dashboard/notifications', route => route.abort('blockedbyclient'));
}

/** Real log UI may read only an exact current request and its API-verified detail. */
export async function installGatewayLogReadScope(surface, { baseUrl, requestId, verifiedLog }) {
  let gateway;
  try { gateway = new URL(baseUrl); } catch { contract(false, '日志UI缺少有效网关入口', 'test/resource-scope'); }
  contract(gateway.protocol === 'https:' && !gateway.username && !gateway.password,
    '日志UI必须使用无凭据的HTTPS网关入口', 'test/resource-scope');
  contract(typeof requestId === 'string' && /^[a-f0-9]{32}-\d+-\d+$/i.test(requestId),
    '日志UI必须绑定本轮真实图片任务requestId，空探针不能代替调用', 'test/resource-scope');
  contract(verifiedLog?.requestId === requestId && typeof verifiedLog.id === 'string'
    && /^[a-z0-9_-]{1,128}$/i.test(verifiedLog.id)
    && !['meta', 'summary', 'timeseries', 'sessions'].includes(verifiedLog.id),
    '日志UI详情必须来自同一requestId已精确回读的真实日志', 'test/resource-scope');
  const detailPath = `/gw/logs/${encodeURIComponent(verifiedLog.id)}`;
  await surface.route(url => /^\/gw\/logs(?:\/|$)/.test(gatewayApiPolicyPath(url.pathname)), async route => {
    const request = route.request();
    const url = new URL(request.url());
    const policyPath = gatewayApiPolicyPath(url.pathname);
    const ids = url.searchParams.getAll('requestId');
    const exactList = policyPath === '/gw/logs' && ids.length === 1 && ids[0] === requestId;
    const verifiedDetail = policyPath === detailPath && url.search === '';
    if (request.method() === 'GET' && url.origin === gateway.origin && (exactList || verifiedDetail)) {
      await route.continue();
    } else {
      // meta has no requestId contract; summaries and sessions are not needed here.
      // Abort before network, never fetch historical data or synthesize success.
      await route.abort('blockedbyclient');
    }
  });
  return { requestId, logId: verifiedLog.id };
}

/** Retired pool cardinality cannot prove the active ASR logical route. */
export function blockRetiredAsrPoolAudit(test, environment) {
  contract(['cds', 'production'].includes(environment), 'ASR验收必须绑定已登记环境', 'test/api-contract');
  test.skip(true, '验收债务：已退场模型池的主备数量不是真实ASR路由，本项未执行。须接入实际逻辑默认与Offering、原录音真实requestId、独立reference、持久化及清理合同后按原REG恢复；旧失败保留，不代表已证明ASR产品或主备故障，也不得借配置绿关闭。');
}

/** Both inspection identities must stop before reading unscoped global observations. */
export function blockUnscopedObservationFixture(test, environment, observation) {
  const reasons = {
    'dashboard-notifications': '验收债务：首页通知列表含全局及非本轮历史内容，当前接口没有本轮runId范围；原用户错误断言保留但未执行，不读取后再过滤，不伪造通知响应。',
    'authorization-health': '验收债务：授权健康端点返回全局近期鉴权日志，未限定本轮身份或请求；当前巡检范围下未执行。补具备本轮范围的只读观测契约后按原case复验，不代表已证明读取他人数据或产品越权。',
    'gateway-failure-health': '验收债务：网关失败聚合端点返回全局登录观测，身份哈希也不等于本轮巡检范围；本项未执行。补具备本轮范围的只读观测契约后按原REG复验，不得借配置检查通过关闭。',
  };
  contract(['cds', 'production'].includes(environment) && Object.hasOwn(reasons, observation),
    '巡检全局观测必须绑定已登记环境与原观测项', 'test/resource-scope');
  test.skip(true, reasons[observation]);
}

/** Exact empty lookup only; this probe must never count as a real model call. */
export async function readGatewayNoCallLogProbe(request, { baseUrl, headers, runId, nonce = randomUUID() }) {
  contract(typeof runId === 'string' && /^stsmk-[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(runId),
    '日志空探针必须绑定本轮有效 stsmk- 标识，禁止无范围读取', 'test/resource-scope');
  contract(typeof nonce === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(nonce),
    '日志空探针必须使用独立随机标识', 'test/resource-scope');
  const requestId = `${runId}:no-call-audit:${nonce}`;
  const query = new URLSearchParams({ requestId, pageSize: '1' });
  const response = await request.get(`${baseUrl.replace(/\/+$/, '')}/gw/logs?${query}`, { headers });
  contract(response.ok(), '日志端点鉴权或精确空查询不可用', 'test/api-contract');
  const body = await response.json();
  contract(body?.success === true && Array.isArray(body.data?.items),
    '日志空查询必须返回真实 items 列表契约', 'test/api-contract');
  contract(body.data.items.length === 0 && body.data.total === 0 && body.data.pageSize === 1,
    '日志空查询返回了意外记录或未遵守精确查询契约，停止且不得回退裸列表', 'test/resource-scope');
  return {
    requestId, items: [], total: 0, pageSize: 1, modelCalls: 0,
    proofBoundary: '仅日志端点鉴权与精确空查询，不证明任何真实模型调用',
  };
}

// Usernames currently reject hyphens in the application. Do not silently replace
// the authorized stsmk- namespace with stsmk_ to make a fixture fit that API.
// Such tests need a separately provisioned isolated identity, not a wider runner.
export function assertScopedSyntheticUsername(username, runId) {
  contract(typeof runId === 'string' && /^stsmk-[a-z0-9-]+$/i.test(runId)
    && typeof username === 'string' && username.startsWith(`${runId}-`),
  '临时账号不属于本轮 stsmk- 资源范围；停止账号创建和权限修改，需预置独立隔离身份', 'test/resource-scope');
}

/** Stop legacy fixtures before they can broaden production inspection privileges. */
export function blockUnsafeProductionFixture(test, environment, caseId) {
  const reasons = {
    'LIT-004': '验收债务：正式改写须走真实页面；旧夹具签发临时 Agent API Key 并直接替换正文，不能证明真实改写。未执行，不增加凭据权限。',
    'LIT-007': '验收债务：正式只观察自然模型失败；旧用例伪造SSE失败，不能证明正式模型不可用时的恢复。没有本轮自然样本，零创建未执行。',
    'REC-009': '验收债务：正式只观察自然转录失败；旧用例把转录响应替换为503，不是正式业务结果。没有本轮自然样本，零创建未执行。',
    'REC-004': '验收债务：旧恢复用例直接写浏览器保险箱并通过API创建会话，不是实际开录/后台路径；正式须用真人路径和完整session/entry/run清理合同，零创建未执行。',
    'VIDEO-006': '验收债务：正式只观察自然单镜失败；旧用例伪造整条run及成功镜头，不能证明真实成片和恢复。没有本轮自然样本，零创建未执行。',
    'CORE-008': '验收债务：历史LearnedTips空状态需独立预置身份；旧用例调用testing端点重置长期账号进度，不属于本轮前缀资源，正式零修改未执行。',
    'MVIS-010': '验收债务：正式只观察自然失败；禁止构造不存在的参考图创建失败任务。未发现本轮自然失败证据，本项未执行。',
  };
  contract(Object.hasOwn(reasons, caseId), '正式危险夹具须绑定已登记的原用例');
  if (environment === 'production') test.skip(true, reasons[caseId]);
}

/** Validate the real rendered default avatar and its independently downloaded bytes. */
export function validateReadOnlyAvatarAsset(snapshot) {
  let source;
  let pageOrigin;
  try {
    pageOrigin = new URL(snapshot?.pageUrl).origin;
    source = new URL(snapshot?.source, snapshot?.pageUrl);
  } catch {
    contract(false, '头像证据缺少真实页面或图片地址');
  }
  contract(source.origin === pageOrigin && source.pathname === '/avatars/nohead.webp', '默认头像必须使用同源轻量 WebP，不能退回对象存储旧图');
  contract(snapshot.complete === true && snapshot.width > 0 && snapshot.height > 0, '页面默认头像必须真实解码，碎图或未加载不能通过');
  contract(snapshot.status === 200 && /^image\/webp(?:;|$)/i.test(snapshot.mime || ''), '默认头像必须下载为真实 WebP 图片');
  contract(Number.isInteger(snapshot.byteLength) && snapshot.byteLength > 0 && snapshot.byteLength < 32 * 1024, '默认头像字节数须非空且小于32KB');
  return { source: source.href, width: snapshot.width, height: snapshot.height, byteLength: snapshot.byteLength };
}

export function getQuickEditInput(page) {
  return page.getByRole('textbox', {name:'快捷编辑描述',exact:true})
    .or(page.getByPlaceholder('Describe your edit here', {exact:true}))
    .and(page.locator(':visible'));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function uniqueVisible(locator, description, timeout) {
  await locator.waitFor({ state: 'visible', timeout });
  contract(await locator.count() === 1, `${description}必须唯一且可见`);
  return locator;
}

/** Structural login evidence only: this does not assert a successful login or issue a credential. */
export function validateMapLoginSnapshot(snapshot) {
  contract(snapshot?.headingCount === 1 && snapshot?.hasBrand === true, '登录页须展示唯一的欢迎标题与 MAP 品牌');
  const hasPasswordForm = snapshot.usernameCount + snapshot.passwordCount + snapshot.submitCount > 0;
  const completePasswordForm = snapshot.usernameCount === 1 && snapshot.passwordCount === 1 && snapshot.submitCount === 1;
  contract(!hasPasswordForm || completePasswordForm, '账号、密码与进入控制台须组成同一个完整表单');
  contract(completePasswordForm || snapshot.ssoCount > 0, '登录页没有可用的账号表单或 SSO 入口');
  return { authenticationMethods: [completePasswordForm ? 'password' : null, snapshot.ssoCount > 0 ? 'sso' : null].filter(Boolean) };
}

export async function getMapLoginTarget(page, { timeout = 20_000 } = {}) {
  contract(new URL(page.url()).pathname === '/login', '须在真实登录页检查登录入口');
  const heading = page.getByRole('heading', { name: '欢迎回来', exact: true }).and(page.locator(':visible'));
  await uniqueVisible(heading, '登录欢迎标题', timeout);
  // Both deployed and current LoginPage render GlassCard without a test id. The nearest
  // ancestor containing authentication controls is the card, not a screenshot-wide body fallback.
  const target = heading.locator('xpath=ancestor::div[.//input[@autocomplete="username"] or .//a][1]');
  await uniqueVisible(target, '登录卡片', timeout);
  const snapshot = await target.evaluate((element) => {
    const visible = (node) => {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const nodes = (selector) => [...element.querySelectorAll(selector)].filter(visible);
    return {
      headingCount: nodes('h1').filter((node) => node.textContent.trim() === '欢迎回来').length,
      hasBrand: element.textContent.includes('MAP Admin'),
      usernameCount: nodes('input[autocomplete="username"]').length,
      passwordCount: nodes('input[autocomplete="current-password"]').length,
      submitCount: nodes('button').filter((node) => node.textContent.trim() === '进入控制台').length,
      // LoginPage intentionally uses href="#" plus an onClick bridge; aria-disabled=false
      // is its configured-entry contract, not the presence of an externally navigable href.
      ssoCount: nodes('a[href][aria-disabled="false"]').filter((node) => /SSO|米多星球|登录/i.test(`${node.textContent} ${node.title}`)).length,
    };
  });
  return { target, ...validateMapLoginSnapshot(snapshot) };
}

/** Audit a real API identity; this is not a substitute for the visual journey's configured default. */
export function selectGatewayImageLogicalModel(items) {
  contract(Array.isArray(items), '逻辑模型响应缺少列表', 'test/api-contract');
  const candidates = items.filter((item) => item?.enabled === true
    && typeof item.id === 'string' && item.id.trim() && typeof item.publicId === 'string' && item.publicId.trim()
    && Array.isArray(item.offerings) && item.offerings.some((offering) => offering?.enabled === true)
    && (/image|generation/i.test(item.modelType || '')
      || (Array.isArray(item.capabilities) && item.capabilities.some((value) => /image|text2img|img2img/i.test(value)))));
  contract(candidates.length > 0, '未找到已启用且含已启用 Offering 的图片逻辑模型', 'configuration/gateway');
  const selected = candidates.find((item) => item.isDefaultForType === true) || candidates[0];
  contract(items.filter((item) => item.publicId === selected.publicId).length === 1, '逻辑模型 publicId 重复，无法绑定唯一真实配置', 'configuration/gateway');
  return selected;
}

/** Opens read-only UI detail via real controls; never edits routes, enables providers, or submits a form. */
export async function openGatewayLogicalModelDetails(page, logical, { timeout = 30_000 } = {}) {
  contract(new URL(page.url()).pathname.endsWith('/logical-models'), '须从模型清单页面打开路由详情');
  contract(typeof logical?.publicId === 'string' && logical.publicId.trim(), '须提供真实 API 的 publicId');
  const publicId = logical.publicId;
  const list = page.locator('.lg-logical-model-list').and(page.locator(':visible'));
  await uniqueVisible(list, '逻辑模型清单', timeout);
  const search = list.getByRole('searchbox', { name: '搜索模型名称或公开标识', exact: true });
  const searchCount = await search.count();
  contract(searchCount <= 1, '模型清单搜索入口重复');
  const layout = searchCount === 1 ? 'collection-pane' : 'inline';
  if (layout === 'collection-pane') {
    await search.fill(publicId); // Search resets pagination, including models beyond the first ten.
    const filter = list.getByRole('combobox', { name: '清单状态筛选', exact: true });
    if (await filter.count() === 1) await filter.selectOption('');
  }
  const identity = layout === 'collection-pane'
    ? page.locator('code').filter({ hasText: new RegExp(`^${escapeRegExp(publicId)}$`) })
    : page.getByText(new RegExp(`^${escapeRegExp(publicId)}\\s+·`));
  const row = list.locator('.lg-logical-model-grid:not(.lg-logical-model-heading)').filter({ has: identity });
  await uniqueVisible(row, `真实模型 ${publicId} 的清单行`, timeout);
  const open = row.getByRole('button', { name: layout === 'collection-pane' ? '查看' : '展开', exact: true });
  if (await open.count() === 1) await open.click();
  const collapse = row.getByRole('button', { name: '收起', exact: true });
  await uniqueVisible(collapse, `模型 ${publicId} 的展开状态`, timeout);
  contract(await collapse.getAttribute('aria-expanded') === 'true', '模型详情未处于实际展开状态');
  const detail = layout === 'collection-pane'
    ? page.getByRole('complementary', { name: '清单详情', exact: true }) : row.locator('..');
  await uniqueVisible(detail, `模型 ${publicId} 的详情`, timeout);
  if (layout === 'collection-pane') {
    const detailIdentity = detail.locator('header code').filter({ hasText: new RegExp(`^${escapeRegExp(publicId)}$`) });
    await uniqueVisible(detailIdentity, '详情模型标识', timeout);
    const routesTab = detail.getByRole('button', { name: '上游线路', exact: true });
    await uniqueVisible(routesTab, '上游线路页签', timeout);
    contract(await routesTab.getAttribute('aria-pressed') === 'true', '路由详情未展示上游线路页签');
  }
  const routeDetails = detail.locator('.lg-logical-model-route-detail');
  await routeDetails.first().waitFor({ state: 'visible', timeout });
  contract(await routeDetails.count() > 0, '模型已展开但没有真实 Offering 明细');
  return { list, row, detail, routeDetails, layout, publicId };
}
