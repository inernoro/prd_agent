import { devices, expect, test, type APIRequestContext, type APIResponse, type Page, type Response, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { buildStableSmokeAuthHeaders } from '../utils/stableSmokeSignature';

type BusinessCatalog = {
  featureLines: Array<{
    id: string;
    label: string;
    entryPath: string;
    entrySmoke: boolean;
  }>;
};

const specDir = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(
  resolve(specDir, '../../.claude/skills/stable-smoke/reference/business-function-catalog.json'),
  'utf8',
)) as BusinessCatalog;
const speechFixture = Buffer.from(readFileSync(
  resolve(specDir, '../fixtures/stable-smoke-speech.m4a.b64'),
  'utf8',
).trim(), 'base64');
// 巡检身份必须持有的管理权限；SSOT 是后端 StableSmokeIdentityPolicy，由跨语言契约测试钉死两边一致。
const identityPermissionPolicy = JSON.parse(readFileSync(
  resolve(specDir, '../fixtures/stable-smoke-required-permissions.json'),
  'utf8',
)) as { superPermission: string; requiredPermissions: string[] };
const requiredIdentityPermissions = identityPermissionPolicy.requiredPermissions;
// 与后端 StableSmokeIdentityPolicy.MissingPermissions 同口径：持有 super 的账号视为矩阵权限齐全。
const missingIdentityPermissions = (effective: string[]) => (
  effective.includes(identityPermissionPolicy.superPermission)
    ? []
    : requiredIdentityPermissions.filter((permission) => !effective.includes(permission))
);

type TicketResponse = {
  success: boolean;
  data?: { loginUrl?: string; ticketId?: string; expiresAt?: string };
  error?: { code?: string; message?: string };
};

type ApiEnvelope<T> = {
  success: boolean;
  data: T;
  error?: { code?: string; message?: string };
};

type BusinessModelPool = {
  code: string;
  isDefault?: boolean;
  resolutionType?: string;
  models: Array<{
    modelId: string;
    platformId: string;
    healthStatus?: string;
  }>;
};

type AuthSession = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

const modules = catalog.featureLines
  .filter((feature) => feature.entrySmoke)
  .map((feature) => ({ key: feature.id, label: feature.label, path: feature.entryPath }));

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少 ${name}，无法执行合成登录冒烟测试。`);
  return value;
}

function syntheticLoginCode(loginUrl: string) {
  const url = new URL(loginUrl, 'https://stable-smoke.invalid');
  return new URLSearchParams(url.hash.replace(/^#/, '')).get('code');
}

async function issueTicket(request: APIRequestContext, returnUrl: string) {
  const bodyText = JSON.stringify({ returnUrl, expiresInSeconds: 180 });
  const response = await request.post('/api/v1/auth/synthetic/ticket', {
    headers: {
      'Content-Type': 'application/json',
      ...buildStableSmokeAuthHeaders({
        method: 'POST',
        url: '/api/v1/auth/synthetic/ticket',
        body: bodyText,
        username: requiredEnv('STABLE_SMOKE_USER'),
        aiAccessKey: process.env.STABLE_SMOKE_AI_ACCESS_KEY?.trim(),
        keyId: process.env.STABLE_SMOKE_SIGNING_KEY_ID?.trim(),
        privateKey: process.env.STABLE_SMOKE_SIGNING_PRIVATE_KEY?.trim(),
      }),
    },
    data: bodyText,
  });
  const body = await response.json() as TicketResponse;
  expect(response.status(), body.error?.message || '生成合成登录入口失败').toBe(200);
  expect(body.success, body.error?.message || '生成合成登录入口失败').toBe(true);
  expect(body.data?.loginUrl).toMatch(/^\/synthetic-login#code=/);
  expect(syntheticLoginCode(body.data?.loginUrl || '')).toBeTruthy();
  return body.data?.loginUrl || '';
}

async function issueTicketDetails(request: APIRequestContext, returnUrl: string) {
  const bodyText = JSON.stringify({ returnUrl, expiresInSeconds: 180 });
  const response = await request.post('/api/v1/auth/synthetic/ticket', {
    headers: {
      'Content-Type': 'application/json',
      ...buildStableSmokeAuthHeaders({
        method: 'POST',
        url: '/api/v1/auth/synthetic/ticket',
        body: bodyText,
        username: requiredEnv('STABLE_SMOKE_USER'),
        aiAccessKey: process.env.STABLE_SMOKE_AI_ACCESS_KEY?.trim(),
        keyId: process.env.STABLE_SMOKE_SIGNING_KEY_ID?.trim(),
        privateKey: process.env.STABLE_SMOKE_SIGNING_PRIVATE_KEY?.trim(),
      }),
    },
    data: bodyText,
  });
  const body = await response.json() as TicketResponse;
  expect(response.status(), body.error?.message || '生成合成登录入口失败').toBe(200);
  expect(body.success, body.error?.message || '生成合成登录入口失败').toBe(true);
  return body.data!;
}

function testingAuthHeaders(method: 'POST' | 'DELETE', url: string) {
  return buildStableSmokeAuthHeaders({
    method,
    url,
    body: '',
    username: requiredEnv('STABLE_SMOKE_USER'),
    aiAccessKey: process.env.STABLE_SMOKE_AI_ACCESS_KEY?.trim(),
    keyId: process.env.STABLE_SMOKE_SIGNING_KEY_ID?.trim(),
    privateKey: process.env.STABLE_SMOKE_SIGNING_PRIVATE_KEY?.trim(),
  });
}

async function setLegacyStorageFixture(page: Page, siteId: string, prepare: boolean) {
  const path = `/api/v1/auth/synthetic/testing/web-pages/${siteId}/legacy-entry`;
  const response = prepare
    ? await page.request.post(path, { headers: testingAuthHeaders('POST', path) })
    : await page.request.delete(path, { headers: testingAuthHeaders('DELETE', path) });
  const body = await response.json() as ApiEnvelope<{
    prepared?: boolean;
    restored?: boolean;
    contentVersionChanged?: boolean;
  }>;
  expect(response.ok(), body.error?.message || '旧存储稳定冒烟夹具切换失败').toBe(true);
  expect(body.success, body.error?.message || '旧存储稳定冒烟夹具切换失败').toBe(true);
  expect(prepare ? body.data.prepared : body.data.restored).toBe(true);
  if (prepare) expect(body.data.contentVersionChanged, '旧存储夹具必须击穿正文快照缓存').toBe(true);
}

async function expectAnonymousShareAnswer(
  request: APIRequestContext,
  shareToken: string,
  siteId: string,
  marker: string,
  storagePath: 'current' | 'legacy',
) {
  const ask = await request.post(`/api/web-pages/shares/view/${shareToken}/ask/stream`, {
    headers: { Accept: 'text/event-stream' },
    data: { siteId, question: '页面中的正文标记是什么？' },
    timeout: 120_000,
  });
  const stream = await ask.text();
  expect(ask.status(), `${storagePath} storage: ${stream}`).toBe(200);
  expect(ask.headers()['content-type']).toContain('text/event-stream');
  expect(stream).toContain('event: phase');
  expect(stream).toContain('event: typing');
  expect(stream).toContain('event: done');
  expect(readSseTypingText(stream), `${storagePath} storage answer`).toContain(marker);
  expect(stream).not.toContain('ASK_NO_CONTENT');
  expect(stream).not.toContain('event: error');
}

async function loginAndReadToken(page: Page, request: APIRequestContext, returnUrl = '/') {
  const loginUrl = await issueTicket(request, returnUrl);
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForURL((url) => url.pathname !== '/synthetic-login', { timeout: 30_000 });
  await expect.poll(async () => page.evaluate(() => {
    const raw = window.localStorage.getItem('prd-admin-auth');
    if (!raw) return '';
    try {
      return JSON.parse(raw)?.state?.token || '';
    } catch {
      return '';
    }
  }), { message: '等待合成会话写入浏览器认证状态', timeout: 10_000 }).not.toBe('');
  const storedToken = await page.evaluate(() => {
    const raw = window.localStorage.getItem('prd-admin-auth');
    return raw ? JSON.parse(raw)?.state?.token || '' : '';
  });
  expect(storedToken, '合成会话未写入浏览器认证状态').not.toBe('');
  await dismissBlockingTutorial(page);
  return storedToken;
}

async function readStableAuthSnapshot(page: Page) {
  let snapshot = '';
  await expect.poll(async () => {
    snapshot = await page.evaluate(() => window.localStorage.getItem('prd-admin-auth') || '').catch(() => '');
    return snapshot;
  }, {
    message: '等待页面导航稳定并读取认证快照',
    timeout: 10_000,
    intervals: [100, 200, 400, 800],
  }).not.toBe('');
  return snapshot;
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function readEnvelope<T>(response: Awaited<ReturnType<APIRequestContext['get']>>) {
  const body = await response.json() as ApiEnvelope<T>;
  expect(response.ok(), body.error?.message || '业务接口调用失败').toBe(true);
  expect(body.success, body.error?.message || '业务接口调用失败').toBe(true);
  return body.data;
}

function expectUserReadable(message: string) {
  expect(message).not.toMatch(/\b(?:HTTP\s*\d{3}|token|provider|stack trace|at\s+\w+\.\w+\()/i);
  expect(message).toMatch(/请|重试|检查|选择|重新|稍后/);
}

function downloadFileName(contentDisposition: string) {
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
  if (utf8?.[1]) return decodeURIComponent(utf8[1]);
  const basic = /filename="?([^";]+)"?/i.exec(contentDisposition);
  return basic?.[1] || '';
}

type ImageModelPool = {
  id: string;
  code: string;
  name: string;
  isDefault?: boolean;
  resolutionType?: string;
  models: Array<{ healthStatus?: string }>;
};

type ImageRunDetail = {
  run: {
    id: string;
    status: string;
    total: number;
    done: number;
    failed: number;
    imageRefs?: Array<{
      refId: number;
      assetSha256: string;
      url: string;
      label: string;
      role?: string;
    }>;
  };
  items: Array<{
    status: string;
    prompt?: string;
    requestedSize?: string;
    effectiveSize?: string;
    base64?: string;
    url?: string;
    errorMessage?: string;
  }>;
};

type UploadArtifactItem = {
  id: string;
  requestId: string;
  kind: string;
  sha256: string;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
  cosUrl: string;
};

type GatewayOffering = {
  id: string;
  targetId: string;
  targetKind?: string;
  protocol?: string | null;
  endpointPath?: string | null;
  upstreamModelId?: string | null;
  enabled: boolean;
  priority: number;
  healthStatus?: number;
  notes?: string | null;
};

type GatewayUpstreamModel = {
  id: string;
  name?: string | null;
  platformId?: string | null;
  protocol?: string | null;
  enabled?: boolean;
};

/** 多图引用只能走这些保留参考图语义的图片协议；聊天协议会把图片当文本丢掉（REG-multi-image-001）。 */
const referencePreservingImageProtocols = ['openrouter-image', 'openai', 'openai-compatible'];
const gatewayFailoverBackupNote = 'stable-smoke-failover-backup';
// GW-007 故障注入写进 Offering 的 Endpoint 前缀：机读标记，也是硬中断后识别「上一轮遗留注入态」的唯一依据。
// 注入路径自带原值：`stable-smoke-<kind>-failure/<时间戳>[-<序号>]~<base64url(原 Endpoint)>`，
// 硬中断后不需要任何外部记录就能把它精确还原（网关只要求相对路径、无控制字符、无反斜杠、不超过 500 字符）。
const gatewayInjectedEndpointPattern = /^stable-smoke-(?:primary|all)-failure\//;
const isGatewayInjectedEndpoint = (offering: GatewayOffering) => gatewayInjectedEndpointPattern.test(offering.endpointPath || '');
// 只认本夹具写入的精确格式（标记开头、紧跟冒号），管理员在别的 Offering 备注里顺带提到这串字也不会被当成夹具。
const isGatewayFailoverBackup = (offering: GatewayOffering) => (offering.notes || '').trimStart().startsWith(`${gatewayFailoverBackupNote}:`);
// 网关对 Endpoint 的上限是 500 字符：原值经 base64url 放大后装不下时退回不带原值的旧格式，
// 硬中断后只能靠相同路由契约的捐出方还原（或人工处理），但故障注入本身照常执行，不会因为路径太长而验不了切换。
const gatewayEndpointPathLimit = 500;
const buildGatewayInjectedEndpoint = (kind: 'primary' | 'all', originalEndpointPath: string, index?: number) => {
  const stem = `stable-smoke-${kind}-failure/${Date.now()}${index === undefined ? '' : `-${index}`}`;
  const embedded = `${stem}~${Buffer.from(originalEndpointPath, 'utf8').toString('base64url')}`;
  return embedded.length <= gatewayEndpointPathLimit ? embedded : stem;
};
const decodeGatewayInjectedEndpoint = (endpointPath: string): string | null => {
  const match = /^stable-smoke-(?:primary|all)-failure\/[^~]*~([A-Za-z0-9_-]*)$/.exec(endpointPath);
  return match ? Buffer.from(match[1], 'base64url').toString('utf8') : null;
};
const sameGatewayRoutingContract = (left: GatewayOffering, right: GatewayOffering) => (
  left.targetId === right.targetId
  && (left.targetKind || 'model') === (right.targetKind || 'model')
  && (left.protocol || '') === (right.protocol || '')
  && (left.upstreamModelId || '') === (right.upstreamModelId || '')
);

type GatewayFixtureRecovery = {
  logicalId: string;
  offeringId: string;
  targetId: string;
  from: string;
  to: string;
  /** embedded：从注入路径自带的原值还原；donor：按完全相同路由契约的另一条 Offering 还原；unrecoverable：两者都没有，未改动，需人工处理。 */
  source: 'embedded' | 'donor' | 'unrecoverable';
};

/**
 * GW-007 遗留注入态自愈（issue #1536）。
 * 全路故障注入之后 worker 若被硬杀，主路与带标记的备用 Offering 都会带着 `stable-smoke-*-failure/` Endpoint
 * 留在网关上：健康仍为 0 时下一轮会把坏 Endpoint 记成基线，健康到 2 时又会在补备用时与既有 targetId 撞车。
 * 这里在选择 / 补备用之前先扫一遍，按优先级还原：
 *   1. 注入路径自带的原值（本 PR 起的注入格式，精确还原，主路与备用都适用）；
 *   2. 路由契约（targetKind / targetId / protocol / upstreamModelId）完全相同的另一条未注入 Offering 的 Endpoint；
 *   3. 都没有：不写任何猜测值（网关每次更新都会生成新的不可变版本，写错就永久替换了原契约），
 *      标记 unrecoverable 交给调用方失败并报出需要人工处理的记录。
 * 更新 Endpoint 会让网关把健康计数清零（GW-006 的判据），所以恢复后它重新成为可用上游。
 * 只改注入态的记录，其它 Offering 一字不碰；重复执行是幂等的。
 */
async function recoverInjectedGatewayOfferings(
  request: APIRequestContext,
  gateway: { baseUrl: string; headers: Record<string, string> },
  items: GatewayLogicalModel[],
): Promise<GatewayFixtureRecovery[]> {
  const recovered: GatewayFixtureRecovery[] = [];
  for (const item of items) {
    for (const offering of item.offerings) {
      if (!isGatewayInjectedEndpoint(offering)) continue;
      const from = offering.endpointPath || '';
      const embedded = decodeGatewayInjectedEndpoint(from);
      const donor = embedded === null
        ? items
          .flatMap((other) => other.offerings.filter((candidate) => (
            candidate.id !== offering.id
            && !isGatewayInjectedEndpoint(candidate)
            && sameGatewayRoutingContract(candidate, offering)
          )))
          .sort((left, right) => Number(right.enabled) - Number(left.enabled))[0]
        : undefined;
      const source: GatewayFixtureRecovery['source'] = embedded !== null ? 'embedded' : donor ? 'donor' : 'unrecoverable';
      if (source === 'unrecoverable') {
        recovered.push({ logicalId: item.id, offeringId: offering.id, targetId: offering.targetId, from, to: '', source });
        continue;
      }
      const endpointPath = embedded !== null ? embedded : (donor!.endpointPath || '');
      const response = await request.put(`${gateway.baseUrl}/gw/logical-models/${item.id}/offerings/${offering.id}`, {
        headers: gateway.headers,
        data: { endpointPath, priority: offering.priority },
      });
      const body = await response.json() as ApiEnvelope<GatewayOffering>;
      expect(response.ok(), body.error?.message || `恢复遗留注入态 Offering ${offering.id} 失败`).toBe(true);
      expect(body.data.endpointPath || '').toBe(endpointPath);
      recovered.push({ logicalId: item.id, offeringId: offering.id, targetId: offering.targetId, from, to: endpointPath, source });
      Object.assign(offering, body.data);
    }
  }
  return recovered;
}

const describeGatewayRecovery = (items: GatewayFixtureRecovery[]) => items
  .map((item) => `${item.logicalId}/${item.offeringId}: ${item.from} -> ${item.to || '(协议默认)'} [${item.source}]`)
  .join('; ');

/** 把传入的（读取时只取启用中的）逻辑模型上仍在启用的带标记备用停掉（GW-007 之外它们只能是停用），返回处理过的记录描述。 */
async function disableStrayGatewayBackups(
  request: APIRequestContext,
  gateway: { baseUrl: string; headers: Record<string, string> },
  items: GatewayLogicalModel[],
): Promise<string[]> {
  const handled: string[] = [];
  for (const item of items) {
    for (const offering of item.offerings) {
      if (!offering.enabled || !isGatewayFailoverBackup(offering)) continue;
      const response = await request.put(`${gateway.baseUrl}/gw/logical-models/${item.id}/offerings/${offering.id}/enabled`, {
        headers: gateway.headers,
        data: { enabled: false },
      });
      const body = await response.json() as ApiEnvelope<GatewayOffering>;
      expect(response.ok(), body.error?.message || `停用遗留备用 Offering ${offering.id} 失败`).toBe(true);
      Object.assign(offering, body.data);
      handled.push(`${item.id}/${offering.id}`);
    }
  }
  return handled;
}

type GatewayUpstreamIndex = { upstreamIds: Set<string>; upstreamById: Map<string, GatewayUpstreamModel> };

async function readGatewayUpstreamIndex(
  request: APIRequestContext,
  gateway: { baseUrl: string; headers: Record<string, string> },
): Promise<GatewayUpstreamIndex> {
  const response = await request.get(`${gateway.baseUrl}/gw/models?enabled=true`, { headers: gateway.headers });
  const body = await response.json() as ApiEnvelope<{ items: GatewayUpstreamModel[] }>;
  expect(response.ok(), body.error?.message || '无法读取网关模型目录').toBe(true);
  return {
    upstreamIds: new Set(body.data.items.map((item) => item.id)),
    upstreamById: new Map(body.data.items.map((item) => [item.id, item])),
  };
}

const isLiveGatewayUpstream = (offering: GatewayOffering, index: GatewayUpstreamIndex) => (
  offering.enabled
  && offering.healthStatus !== 2
  && index.upstreamIds.has(offering.targetId)
);

/**
 * 给只有单上游的逻辑模型补一条带标记的备用 Offering：从同类型其它逻辑模型挑一条在用的真实上游
 * （优先同平台），照抄它的路由契约创建，priority 比主路低 10，正常流量不会走到它。创建即启用；
 * 找不到捐出方返回 undefined。GW-007 与自愈回归用例共用这一份，谁先跑到谁建，另一方复用。
 */
async function provisionTaggedFailoverBackup(
  request: APIRequestContext,
  gateway: { baseUrl: string; headers: Record<string, string> },
  items: GatewayLogicalModel[],
  index: GatewayUpstreamIndex,
  preferred: GatewayLogicalModel,
  primary: GatewayOffering,
): Promise<GatewayOffering | undefined> {
  const primaryPlatform = index.upstreamById.get(primary.targetId)?.platformId || '';
  // 逻辑模型上已经绑过的上游（含停用、未打标记的）都不能再挑：网关对未被替代的同 target 记录判重复。
  const usedTargets = new Set(preferred.offerings.map((offering) => offering.targetId));
  const donor = items
    .filter((item) => item.enabled && item.modelType === preferred.modelType && item.id !== preferred.id)
    .flatMap((item) => item.offerings.filter((offering) => isLiveGatewayUpstream(offering, index)))
    .filter((offering) => {
      if (usedTargets.has(offering.targetId)) return false;
      usedTargets.add(offering.targetId);
      return true;
    })
    .sort((left, right) => (
      Number((index.upstreamById.get(right.targetId)?.platformId || '') === primaryPlatform)
      - Number((index.upstreamById.get(left.targetId)?.platformId || '') === primaryPlatform)
    ))[0];
  if (!donor) return undefined;
  const created = await request.post(`${gateway.baseUrl}/gw/logical-models/${preferred.id}/offerings`, {
    headers: gateway.headers,
    data: {
      targetKind: donor.targetKind || 'model',
      targetId: donor.targetId,
      // 路由契约照抄捐出方：它在自己的逻辑模型上就是这么跑通的。
      protocol: donor.protocol || undefined,
      endpointPath: donor.endpointPath || undefined,
      upstreamModelId: donor.upstreamModelId || undefined,
      priority: primary.priority + 10,
      weight: 100,
      notes: `${gatewayFailoverBackupNote}: 稳定冒烟 GW-007 备用上游，验收后停用，可复用`,
    },
  });
  const createdBody = await created.json() as ApiEnvelope<GatewayOffering>;
  expect(created.ok(), createdBody.error?.message || `为 ${preferred.publicId} 创建备用 Offering 失败`).toBe(true);
  return createdBody.data;
}

type GatewayLogicalModel = {
  id: string;
  publicId: string;
  modelType: string;
  routingStrategy: string;
  enabled: boolean;
  offerings: GatewayOffering[];
};

type GatewayLogItem = {
  id: string;
  requestId: string;
  logicalModelPublicId?: string | null;
  offeringId?: string | null;
  provider?: string | null;
  model?: string | null;
  status: string;
  statusCode?: number | null;
  isFallback?: boolean | null;
  protocol?: string | null;
};

type GatewayLogDetail = GatewayLogItem & {
  requestBodyRedacted?: string | null;
  answerText?: string | null;
  imageSuccessCount?: number | null;
  providerAttempts: Array<{
    order: number;
    provider?: string | null;
    model?: string | null;
    status: string;
    statusCode?: number | null;
    error?: string | null;
  }>;
  routerTrace: {
    logicalModelPublicId?: string | null;
    offeringId?: string | null;
    isFallback: boolean;
    steps: Array<{ order: number; stage: string; status: string }>;
  };
  error?: string | null;
};

type IsoBox = {
  type: string;
  dataStart: number;
  end: number;
};

function readIsoBoxes(buffer: Buffer, start = 0, end = buffer.length) {
  const boxes: IsoBox[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) throw new Error(`MP4 ${type} 扩展头不完整`);
      const extended = buffer.readBigUInt64BE(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`MP4 ${type} 数据块过大`);
      size = Number(extended);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) throw new Error(`MP4 ${type} 数据块长度无效`);
    boxes.push({ type, dataStart: offset + headerSize, end: offset + size });
    offset += size;
  }
  if (offset !== end) throw new Error('MP4 容器末尾存在不完整数据');
  return boxes;
}

function inspectMp4(buffer: Buffer) {
  const top = readIsoBoxes(buffer);
  const moov = top.find((box) => box.type === 'moov');
  expect(top.some((box) => box.type === 'ftyp'), '视频缺少 MP4 文件类型头').toBe(true);
  expect(top.some((box) => box.type === 'mdat'), '视频缺少 MP4 媒体数据').toBe(true);
  expect(moov, '视频缺少 MP4 元数据').toBeTruthy();
  const moovChildren = readIsoBoxes(buffer, moov!.dataStart, moov!.end);
  const mvhd = moovChildren.find((box) => box.type === 'mvhd');
  expect(mvhd, '视频缺少 MP4 时长元数据').toBeTruthy();
  const version = buffer[mvhd!.dataStart];
  const timescaleOffset = mvhd!.dataStart + (version === 1 ? 20 : 12);
  const durationOffset = mvhd!.dataStart + (version === 1 ? 24 : 16);
  const timescale = buffer.readUInt32BE(timescaleOffset);
  const durationUnits = version === 1
    ? Number(buffer.readBigUInt64BE(durationOffset))
    : buffer.readUInt32BE(durationOffset);
  const handlers = moovChildren
    .filter((box) => box.type === 'trak')
    .flatMap((track) => readIsoBoxes(buffer, track.dataStart, track.end))
    .filter((box) => box.type === 'mdia')
    .flatMap((media) => readIsoBoxes(buffer, media.dataStart, media.end))
    .filter((box) => box.type === 'hdlr')
    .map((handler) => buffer.toString('ascii', handler.dataStart + 8, handler.dataStart + 12));
  return {
    durationSeconds: timescale > 0 ? durationUnits / timescale : 0,
    videoTracks: handlers.filter((handler) => handler === 'vide').length,
    audioTracks: handlers.filter((handler) => handler === 'soun').length,
  };
}

function inspectDeterministicPauseResumeWav(buffer: Buffer) {
  expect(buffer.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(buffer.subarray(8, 12).toString('ascii')).toBe('WAVE');
  expect(buffer.subarray(36, 40).toString('ascii')).toBe('data');
  const sampleRate = buffer.readUInt32LE(24);
  const dataLength = buffer.readUInt32LE(40);
  expect(sampleRate).toBe(8_000);
  expect(dataLength).toBe(buffer.length - 44);
  const samples = new Int16Array(
    buffer.buffer,
    buffer.byteOffset + 44,
    dataLength / Int16Array.BYTES_PER_ELEMENT,
  );
  const estimateFrequency = (start: number, end: number) => {
    let crossings = 0;
    let previous = samples[start] ?? 0;
    for (let index = start + 1; index < end; index += 1) {
      const current = samples[index] ?? 0;
      if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) crossings += 1;
      previous = current;
    }
    return crossings * sampleRate / (2 * (end - start));
  };
  const middle = Math.floor(samples.length / 2);
  return {
    beforePauseHz: estimateFrequency(0, middle),
    afterResumeHz: estimateFrequency(middle, samples.length),
  };
}

function crc32(input: Buffer) {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function solidPngDataUrl(red: number, green: number, blue: number, size = 256) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x += 1) {
    row[1 + x * 3] = red;
    row[2 + x * 3] = green;
    row[3 + x * 3] = blue;
  }
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function zipStore(entries: Array<{ name: string; content: string }>) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.content, 'utf8');
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function docxFixture(text: string) {
  return zipStore([
    { name: '[Content_Types].xml', content: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', content: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', content: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>` },
  ]);
}

function pptxFixture(text: string) {
  return zipStore([
    { name: '[Content_Types].xml', content: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>' },
    { name: '_rels/.rels', content: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>' },
    { name: 'ppt/presentation.xml', content: '<?xml version="1.0"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>' },
    { name: 'ppt/_rels/presentation.xml.rels', content: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>' },
    { name: 'ppt/slides/slide1.xml', content: `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>` },
  ]);
}

async function createVisualWorkspace(page: Page, token: string, suffix: string) {
  const attemptId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const response = await page.request.post('/api/visual-agent/image-master/workspaces', {
    headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${suffix}-${attemptId}` },
    data: { title: `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${suffix}-${attemptId}`, scenarioType: 'image-gen' },
  });
  return readEnvelope<{ workspace: { id: string } }>(response);
}

async function waitForImageRun(page: Page, token: string, runId: string, timeoutMs = 180_000) {
  const statuses: string[] = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await page.request.get(`/api/visual-agent/image-gen/runs/${runId}?includeItems=true&includeImages=false`, {
      headers: authHeaders(token),
    });
    const detail = await readEnvelope<ImageRunDetail>(response);
    if (!statuses.includes(detail.run.status)) statuses.push(detail.run.status);
    if (/Completed|Failed|Cancelled/i.test(detail.run.status)) return { detail, statuses };
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
  }
  throw new Error(`图片生成等待超时，请检查任务 ${runId} 的运行状态`);
}

async function expectDeleteSucceeded(response: APIResponse | Response, context: string) {
  const raw = await response.text();
  let body: ApiEnvelope<{ deleted: boolean }> | undefined;
  try {
    body = JSON.parse(raw) as ApiEnvelope<{ deleted: boolean }>;
  } catch {
    // 下面的统一断言会带上原始响应，避免 JSON 解析异常掩盖服务端状态。
  }
  const diagnostic = `${context}：HTTP ${response.status()}；${body?.error?.code || 'NO_ERROR_CODE'}；${body?.error?.message || raw || '空响应'}`;
  expect(response.ok(), diagnostic).toBe(true);
  expect(body?.success, diagnostic).toBe(true);
  expect(body?.data?.deleted, diagnostic).toBe(true);
}

async function loginGateway(request: APIRequestContext) {
  const baseUrl = requiredEnv('STABLE_SMOKE_GW_BASE_URL');
  // 本地排障用：已经拿到的控制台会话令牌直接复用（例如 MAP 管理员一键登录换来的），不再走签名或口令。
  const presetToken = process.env.STABLE_SMOKE_GW_TOKEN?.trim();
  if (presetToken) {
    return { baseUrl, headers: { Authorization: `Bearer ${presetToken}` } };
  }
  const signingKeyId = process.env.STABLE_SMOKE_SIGNING_KEY_ID?.trim();
  const signingPrivateKey = process.env.STABLE_SMOKE_SIGNING_PRIVATE_KEY?.trim();
  if (signingKeyId && signingPrivateKey) {
    const ticketBody = '{}';
    const ticket = await request.post('/api/v1/auth/synthetic/gateway-ticket', {
      headers: {
        'Content-Type': 'application/json',
        ...buildStableSmokeAuthHeaders({
          method: 'POST',
          url: '/api/v1/auth/synthetic/gateway-ticket',
          body: ticketBody,
          username: requiredEnv('STABLE_SMOKE_USER'),
          keyId: signingKeyId,
          privateKey: signingPrivateKey,
        }),
      },
      data: ticketBody,
    });
    const ticketEnvelope = await ticket.json() as ApiEnvelope<{ code: string }>;
    expect(ticket.ok(), ticketEnvelope.error?.message || '生成模型网关巡检入口失败').toBe(true);
    expect(ticketEnvelope.success, ticketEnvelope.error?.message || '生成模型网关巡检入口失败').toBe(true);
    expect(ticketEnvelope.data.code).toBeTruthy();

    const exchange = await request.post(`${baseUrl}/gw/auth/stable-smoke-sso`, {
      data: { code: ticketEnvelope.data.code },
    });
    const exchangeEnvelope = await exchange.json() as ApiEnvelope<{ token: string; mustChangePassword: boolean }>;
    expect(exchange.ok(), exchangeEnvelope.error?.message || '模型网关巡检短票据登录失败').toBe(true);
    expect(exchangeEnvelope.success, exchangeEnvelope.error?.message || '模型网关巡检短票据登录失败').toBe(true);
    expect(exchangeEnvelope.data.token).toBeTruthy();
    expect(exchangeEnvelope.data.mustChangePassword).toBe(false);
    return {
      baseUrl,
      headers: { Authorization: `Bearer ${exchangeEnvelope.data.token}` },
    };
  }

  const login = await request.post(`${baseUrl}/gw/auth/login`, {
    data: {
      username: requiredEnv('STABLE_SMOKE_GW_USER'),
      password: requiredEnv('STABLE_SMOKE_GW_PASSWORD'),
    },
  });
  const body = await login.json() as ApiEnvelope<{ token: string; mustChangePassword: boolean }>;
  expect(login.ok(), body.error?.message || '模型网关专用账号登录失败').toBe(true);
  expect(body.success, body.error?.message || '模型网关专用账号登录失败').toBe(true);
  expect(body.data.token).toBeTruthy();
  expect(body.data.mustChangePassword).toBe(false);
  return {
    baseUrl,
    headers: { Authorization: `Bearer ${body.data.token}` },
  };
}

async function waitForGatewayLog(
  request: APIRequestContext,
  requestId: string,
  timeoutMs = 30_000,
) {
  const gateway = await loginGateway(request);
  let matched: GatewayLogItem | undefined;
  await expect.poll(async () => {
    const response = await request.get(
      `${gateway.baseUrl}/gw/logs?requestId=${encodeURIComponent(requestId)}&pageSize=10`,
      { headers: gateway.headers },
    );
    if (!response.ok()) return '';
    const body = await response.json() as ApiEnvelope<{ items: GatewayLogItem[] }>;
    matched = body.success
      ? body.data.items.find((item) => (
        item.requestId === requestId
        && Boolean(item.logicalModelPublicId)
        && !/gateway-auth/i.test(item.provider || '')
      ))
      : undefined;
    return matched && !/running|pending/i.test(matched.status) ? matched.id : '';
  }, {
    message: `等待网关按 requestId 写入审计日志：${requestId}`,
    timeout: timeoutMs,
    intervals: [500, 1_000, 2_000],
  }).not.toBe('');

  const detailResponse = await request.get(`${gateway.baseUrl}/gw/logs/${matched!.id}`, {
    headers: gateway.headers,
  });
  const detailBody = await detailResponse.json() as ApiEnvelope<GatewayLogDetail>;
  expect(detailResponse.ok(), detailBody.error?.message || '网关请求日志详情不可用').toBe(true);
  expect(detailBody.success, detailBody.error?.message || '网关请求日志详情不可用').toBe(true);
  expect(detailBody.data.requestId).toBe(requestId);
  return detailBody.data;
}

async function assertImageArtifact(page: Page, detail: ImageRunDetail) {
  expect(detail.run.status).toBe('Completed');
  expect(detail.run.done).toBe(detail.run.total);
  expect(detail.run.failed).toBe(0);
  expect(detail.items.length).toBeGreaterThan(0);
  const item = detail.items[0];
  expect(item.errorMessage || '').toBe('');
  expect(item.effectiveSize || item.requestedSize).toMatch(/^\d+x\d+$/);
  if (item.url) {
    const image = await page.request.get(item.url);
    expect(image.ok()).toBe(true);
    expect(image.headers()['content-type'] || '').toMatch(/^image\//);
    expect((await image.body()).byteLength).toBeGreaterThan(512);
  } else {
    expect(Buffer.from(item.base64 || '', 'base64').byteLength).toBeGreaterThan(512);
  }
}

async function readGeneratedImageBytes(page: Page, detail: ImageRunDetail) {
  const item = detail.items[0];
  if (item.url) {
    const response = await page.request.get(item.url);
    expect(response.ok(), '生成图片对象必须可读取').toBe(true);
    return { bytes: await response.body(), mime: response.headers()['content-type'] || 'image/png' };
  }
  return { bytes: Buffer.from(item.base64 || '', 'base64'), mime: 'image/png' };
}

async function measureReferenceColorCoverage(page: Page, detail: ImageRunDetail) {
  const { bytes, mime } = await readGeneratedImageBytes(page, detail);
  return page.evaluate(async ({ base64, contentType }) => {
    const image = new Image();
    image.src = `data:${contentType};base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(image.naturalWidth, 512);
    canvas.height = Math.min(image.naturalHeight, 512);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('浏览器无法读取生成图片像素');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let blue = 0;
    let yellow = 0;
    let red = 0;
    let visible = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const r = pixels[index];
      const g = pixels[index + 1];
      const b = pixels[index + 2];
      if (pixels[index + 3] < 32) continue;
      visible += 1;
      if (b > 100 && b > r * 1.3 && b > g * 1.15) blue += 1;
      if (r > 120 && g > 95 && b < Math.min(r, g) * 0.72) yellow += 1;
      if (r > 120 && r > g * 1.35 && r > b * 1.25) red += 1;
    }
    return {
      blue: blue / Math.max(1, visible),
      yellow: yellow / Math.max(1, visible),
      red: red / Math.max(1, visible),
    };
  }, { base64: bytes.toString('base64'), contentType: mime });
}

function detectImageMime(buffer: Buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  throw new Error('下载文件不是受支持的 PNG、JPEG 或 WebP 图片');
}

function extensionForImageMime(mime: string) {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  return '';
}

async function decodeDownloadedImageDimensions(page: Page, buffer: Buffer, mime: string) {
  return page.evaluate(async ({ base64, contentType }) => {
    const image = new Image();
    image.src = `data:${contentType};base64,${base64}`;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  }, { base64: buffer.toString('base64'), contentType: mime });
}

async function probeImageRunSse(
  page: Page,
  token: string,
  runId: string,
  afterSeq: number,
  stopMode: 'active' | 'next',
) {
  return page.evaluate(async ({ streamPath, bearer, resumeAfter, mode }) => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    const ids: number[] = [];
    const eventTypes: string[] = [];
    let heartbeats = 0;
    let contentType = '';
    let stoppedAfterActiveEvent = false;
    let receivedNextEvent = false;
    let buffer = '';

    try {
      const response = await fetch(`${streamPath}?afterSeq=${resumeAfter}`, {
        headers: { Authorization: `Bearer ${bearer}`, Accept: 'text/event-stream' },
        cache: 'no-store',
        signal: controller.signal,
      });
      contentType = response.headers.get('content-type') || '';
      if (!response.ok || !response.body) {
        return { ok: false, status: response.status, contentType, ids, eventTypes, heartbeats, stoppedAfterActiveEvent };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let shouldStop = false;
      while (!shouldStop) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done }).replaceAll('\r\n', '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.startsWith(':')) {
            heartbeats += 1;
            if (mode === 'next' && receivedNextEvent) shouldStop = true;
          } else {
            const lines = frame.split('\n');
            const id = Number(lines.find((line) => line.startsWith('id:'))?.slice(3).trim() || 0);
            const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
            let eventType = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || '';
            let status = '';
            try {
              const payload = JSON.parse(data) as { type?: unknown; status?: unknown };
              eventType = String(payload.type || eventType);
              status = String(payload.status || '');
            } catch {
              // SSE 数据不一定都是 JSON；event 名仍可用于连续性判断。
            }
            if (id > 0) ids.push(id);
            if (eventType) eventTypes.push(eventType);
            const active = /runStart|imageStart|progress/i.test(eventType) || /Queued|Running/i.test(status);
            if (id > resumeAfter) receivedNextEvent = true;
            if (id > resumeAfter && mode === 'active' && active) {
              stoppedAfterActiveEvent = active;
              shouldStop = true;
              break;
            }
            if (mode === 'next' && receivedNextEvent && heartbeats > 0) {
              shouldStop = true;
              break;
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
        if (chunk.done) break;
      }
      if (shouldStop) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
      }
      return { ok: true, status: response.status, contentType, ids, eventTypes, heartbeats, stoppedAfterActiveEvent };
    } catch (error) {
      if (controller.signal.aborted && ids.length > 0) {
        return { ok: true, status: 200, contentType, ids, eventTypes, heartbeats, stoppedAfterActiveEvent };
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }, {
    streamPath: `/api/visual-agent/image-gen/runs/${runId}/stream`,
    bearer: token,
    resumeAfter: afterSeq,
    mode: stopMode,
  });
}

async function decodeGeneratedImageDimensions(page: Page, item: ImageRunDetail['items'][number]) {
  const source = item.url || (item.base64?.startsWith('data:')
    ? item.base64
    : item.base64 ? `data:image/png;base64,${item.base64}` : '');
  expect(source, '图片任务完成后必须返回可解码产物').toBeTruthy();
  return page.evaluate(async (src) => {
    const image = new Image();
    image.src = src;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  }, source);
}

async function waitForTranscriptRun(page: Page, token: string, runId: string, timeoutMs = 180_000) {
  const statuses: string[] = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await page.request.get(`/api/transcript-agent/runs/${runId}`, { headers: authHeaders(token) });
    expect(response.ok()).toBe(true);
    const run = await response.json() as { status: string; progress: number; error?: string };
    if (!statuses.includes(run.status)) statuses.push(run.status);
    if (run.status === 'completed') return { run, statuses };
    if (run.status === 'failed') throw new Error(run.error || '录音转写失败，请检查 ASR 服务状态后重试');
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
  }
  throw new Error('录音转写等待超时，请检查任务状态后重试');
}

async function openModule(
  page: Page,
  request: APIRequestContext,
  module: (typeof modules)[number],
  testInfo: TestInfo,
) {
  const errors: string[] = [];
  const failedImages: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|ResizeObserver/i.test(message.text())) {
      errors.push(message.text());
    }
  });
  // 图片资源加载失败在控制台里不是 error，只能从网络层与 <img> 自身的解码结果判断。
  // 2026-09-14：首页默认头像（对象存储上 3 MB 的 nohead.png）加载失败两次，旧判据一条都没抓到。
  page.on('requestfailed', (failed) => {
    if (failed.resourceType() !== 'image') return;
    const reason = failed.failure()?.errorText || 'failed';
    if (/ERR_ABORTED/i.test(reason)) return;
    failedImages.push(`${failed.url()} (${reason})`);
  });
  // 404 / 5xx 是「完成的响应」而不是 requestfailed，图片照样是碎的，必须单独记下来。
  page.on('response', (response) => {
    if (response.request().resourceType() !== 'image') return;
    const status = response.status();
    if (status >= 400) failedImages.push(`${response.url()} (HTTP ${status})`);
  });

  await applySandboxHostStubs(page);
  const loginUrl = await issueTicket(request, module.path);
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForURL((url) => url.pathname.startsWith(module.path), { timeout: 30_000 });
  await expect(page.locator('body')).not.toBeEmpty();
  await expect(page.locator('body')).not.toContainText('合成测试登录未完成');
  await page.waitForTimeout(800);
  await dismissBlockingTutorial(page);
  expect(errors, `${module.label} 页面出现前端运行错误`).toEqual([]);
  await expectNoBrokenImages(page, module.label, failedImages);

  const screenshot = await page.screenshot({ fullPage: true });
  await testInfo.attach(`${module.key}-${testInfo.project.name}`, {
    body: screenshot,
    contentType: 'image/png',
  });
}

/**
 * 页面上的每一张图都必须真的解出来：网络层没有失败请求，DOM 里没有 complete 却 0 宽的 <img>。
 * 等待上限 8 秒——默认头像这类静态资源超过这个时间还没到，本身就是要报出来的问题。
 */
async function expectNoBrokenImages(page: Page, label: string, failedImages: string[]) {
  // 懒加载且还没滚进视口的图片浏览器根本不会去取，不算「没加载完」；
  // SVG 没有固有尺寸时 naturalWidth 也可能是 0，不能只拿它当碎图判据——改问浏览器 decode() 有没有成功。
  const readImageState = () => page.evaluate(async () => {
    const inViewport = (image: HTMLImageElement) => {
      const rect = image.getBoundingClientRect();
      return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    };
    const isSvg = (image: HTMLImageElement) => /\.svg(?:[?#].*)?$|^data:image\/svg/i.test(image.currentSrc || image.src || '');
    const pending = Array.from(document.images)
      .filter((image) => !image.complete && (image.loading !== 'lazy' || inViewport(image)))
      .map((image) => image.currentSrc || image.src);
    const broken: string[] = [];
    for (const image of Array.from(document.images)) {
      if (!image.complete || image.naturalWidth !== 0 || (image.getAttribute('src') || '').length === 0) continue;
      const source = image.currentSrc || image.src;
      if (!isSvg(image)) {
        broken.push(source);
        continue;
      }
      try {
        await image.decode();
      } catch {
        broken.push(source);
      }
    }
    return { pending, broken };
  });
  await expect.poll(
    async () => (await readImageState()).pending.length,
    { message: `${label} 页面图片在 8 秒内全部结束加载`, timeout: 8_000 },
  ).toBe(0).catch(() => undefined);
  const { broken: brokenImages, pending: stillLoading } = await readImageState();
  expect(
    [...failedImages, ...brokenImages.map((url) => `${url} (浏览器解码为 0 宽，页面上是碎图)`), ...stillLoading.map((url) => `${url} (8 秒后仍未加载完成)`)],
    `${label} 页面存在加载失败的图片资源`,
  ).toEqual([]);
}

/**
 * CDS 反代注入的分支小部件不是产品的一部分。手机视口下旧版小部件是一整条徽章，正好压在录音面板的
 * 「暂停录音」「结束录音并转成文字」上（2026-09-15 复测：点击被 #cds-widget 拦截）。录音旅程验的是产品，
 * 先把它关掉；新版小部件会自己收成圆钮，移动端入口用例单独验它。
 */
async function dismissCdsPreviewWidget(page: Page) {
  const dismiss = page.locator('#cds-widget button[data-action="dismiss"]');
  if (await dismiss.count()) {
    await dismiss.first().click({ force: true }).catch(() => undefined);
    await expect(page.locator('#cds-widget')).toHaveCount(0);
  }
}

/**
 * 沙箱排障用：出口代理会重新终结 TLS，浏览器信任库里没有那张 CA 时，页面里第三方绝对外链
 * （如 Cloudflare 注入的 beacon 脚本）会报 ERR_CERT_AUTHORITY_INVALID，把与被测功能无关的噪音
 * 记成「前端运行错误」。设置 STABLE_SMOKE_STUB_HOSTS=host1,host2 后，这些域名的请求由空响应代替。
 * 正式巡检不设置该变量，任何外链失败照旧计入。
 */
async function applySandboxHostStubs(page: Page) {
  const hosts = (process.env.STABLE_SMOKE_STUB_HOSTS || '').split(',').map((item) => item.trim()).filter(Boolean);
  for (const host of hosts) {
    await page.route((url) => url.hostname === host, (route) => route.fulfill({
      status: 200,
      contentType: route.request().resourceType() === 'script' ? 'application/javascript' : 'text/plain',
      body: '',
    }));
  }
}

async function dismissBlockingTutorial(page: Page) {
  const learned = page.getByRole('button', { name: '我已学会' });
  await learned.waitFor({ state: 'visible', timeout: 2_500 }).catch(() => undefined);
  if (await learned.isVisible().catch(() => false)) {
    await learned.click();
    await expect(learned, '关闭教程后不应继续遮挡视觉创作结果').toBeHidden();
  }
}

async function openQuickRecord(page: Page, request: APIRequestContext) {
  const token = await loginAndReadToken(page, request, '/document-store');
  await page.goto('/document-store?quickRecord=1', { waitUntil: 'domcontentloaded' });
  await dismissBlockingTutorial(page);
  await dismissCdsPreviewWidget(page);
  return token;
}

type StableHostedSite = {
  id: string;
  title: string;
  folder?: string | null;
  siteUrl: string;
};

type StableWebFolder = {
  id: string;
  name: string;
};

async function uploadStableHostedSite(page: Page, token: string, title: string) {
  const marker = `${title}-正文标记`;
  // 用实体编码的 # 覆盖浏览器会解码、源码扫描器容易漏判的真实锚点形态。
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body><a id="jump" href="&#35;target">跳到验收锚点</a><div style="height:900px"></div><section id="target">${marker}</section></body></html>`;
  const response = await page.request.post('/api/web-pages/upload', {
    headers: authHeaders(token),
    multipart: {
      file: { name: `${title}.html`, mimeType: 'text/html', buffer: Buffer.from(html, 'utf8') },
      title,
    },
  });
  return {
    site: await readEnvelope<StableHostedSite>(response),
    marker,
  };
}

async function deleteStableHostedSite(page: Page, token: string, siteId: string) {
  const response = await page.request.delete(`/api/web-pages/${siteId}`, { headers: authHeaders(token) });
  expect(response.ok(), '稳定冒烟站点清理失败').toBe(true);
  expect((await response.json() as ApiEnvelope<{ deleted: boolean }>).data.deleted).toBe(true);
  expect((await page.request.get(`/api/web-pages/${siteId}`, { headers: authHeaders(token) })).status()).toBe(404);
}

function readSseTypingText(stream: string) {
  return stream
    .replaceAll('\r\n', '\n')
    .split('\n\n')
    .flatMap((frame) => {
      const lines = frame.split('\n');
      const eventType = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
      if (eventType !== 'typing') return [];
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      try {
        const payload = JSON.parse(data) as { text?: unknown };
        return typeof payload.text === 'string' ? [payload.text] : [];
      } catch {
        return [];
      }
    })
    .join('');
}

test.describe('稳定冒烟：双环境合成登录与模块入口', () => {
  test('[CORE-001] 首页与入口静态资源可用', async ({ page }) => {
    const resourceFailures: string[] = [];
    page.on('response', (item) => {
      const url = new URL(item.url());
      if (url.origin === new URL(page.url()).origin
        && /\.(?:[cm]?[jt]sx?|css)$/.test(url.pathname)
        && !item.ok()) {
        resourceFailures.push(`${item.status()} ${item.url()}`);
      }
    });
    const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
    expect(response?.status(), '首页 HTML 必须成功返回').toBe(200);
    expect(response?.headers()['content-type'], '首页必须返回 HTML').toContain('text/html');
    await page.waitForTimeout(1_500);

    const entryAssets = await page.locator('script[src], link[rel="stylesheet"][href]').evaluateAll((elements) => (
      elements
        .map((element) => element instanceof HTMLScriptElement ? element.src : (element as HTMLLinkElement).href)
        .filter((value) => {
          const url = new URL(value);
          return url.origin === window.location.origin && /\.(?:[cm]?[jt]sx?|css)$/.test(url.pathname);
        })
    ));
    expect(
      entryAssets.some((url) => /\.(?:[cm]?[jt]sx?)$/.test(new URL(url).pathname)),
      '首页缺少可执行入口脚本',
    ).toBe(true);
    const hasApplicationStyles = await page.locator('link[rel="stylesheet"][href], style[data-vite-dev-id]').evaluateAll((elements) => (
      elements.some((element) => {
        if (element instanceof HTMLLinkElement) {
          const url = new URL(element.href);
          return url.origin === window.location.origin && /\.css$/.test(url.pathname);
        }
        return element instanceof HTMLStyleElement && Boolean(element.textContent?.trim());
      })
    ));
    expect(
      hasApplicationStyles,
      '首页缺少应用样式：生产构建应加载同源 CSS，Vite 开发模式应注入 data-vite-dev-id 样式',
    ).toBe(true);

    for (const assetUrl of entryAssets) {
      const asset = await page.request.get(assetUrl);
      expect(asset.status(), `入口资源不可用：${assetUrl}`).toBe(200);
      expect((await asset.body()).byteLength, `入口资源为空：${assetUrl}`).toBeGreaterThan(0);
      const contentType = asset.headers()['content-type'] || '';
      if (/\.(?:[cm]?[jt]sx?)$/.test(new URL(assetUrl).pathname)) {
        expect(contentType, `入口脚本类型错误：${assetUrl}`).toMatch(/javascript|typescript/i);
      } else {
        expect(contentType, `入口 CSS 类型错误：${assetUrl}`).toMatch(/text\/css/i);
      }
    }

    await expect(page.locator('#root'), '入口脚本必须成功渲染应用根节点').not.toBeEmpty();
    expect(resourceFailures).toEqual([]);
  });

  test('[REG-user-error-001] 首页告警不泄漏上游技术细节', async ({ page, request }) => {
    const notificationsLoaded = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/dashboard/notifications',
      { timeout: 15_000 },
    );
    await loginAndReadToken(page, request, '/');
    const notificationResponse = await notificationsLoaded;
    expect(notificationResponse.ok(), '首页通知列表加载失败').toBe(true);
    const body = page.locator('body');
    await expect(body).not.toContainText(/上游信息|Key limit exceeded|openrouter|\/keys\//i);
  });

  test('[CORE-007] 一次性票据只能消费一次且会话不可续期', async ({ request }) => {
    const ticket = await issueTicketDetails(request, '/');
    const code = syntheticLoginCode(ticket.loginUrl!);
    expect(code).toBeTruthy();

    const first = await request.post('/api/v1/auth/synthetic/exchange', { data: { code } });
    const firstBody = await first.json() as ApiEnvelope<AuthSession>;
    expect(first.status(), firstBody.error?.message).toBe(200);
    expect(firstBody.success).toBe(true);
    expect(firstBody.data.accessToken).toBeTruthy();
    expect(firstBody.data.refreshToken).toBe('');
    expect(firstBody.data.expiresIn).toBeLessThanOrEqual(30 * 60);

    const second = await request.post('/api/v1/auth/synthetic/exchange', { data: { code } });
    const secondBody = await second.json() as ApiEnvelope<never>;
    expect(second.status()).toBe(401);
    expect(secondBody.success).toBe(false);
    expectUserReadable(secondBody.error?.message || '');
  });

  test('[CORE-008][REG-tutorial-progress-001] 历史空进度用户可完成教程且重复提交幂等', { tag: '@cleanup' }, async ({ page, request }) => {
    const token = await loginAndReadToken(page, request, '/document-store');
    const sourceId = 'document-store-page-guide';
    const resetProgress = async () => {
      const response = await page.request.delete(`/api/daily-tips/testing/learned/${sourceId}`, {
        headers: authHeaders(token),
      });
      const body = await response.json() as ApiEnvelope<{ reset: boolean; sourceId: string }>;
      expect(response.status(), body.error?.message || '教程测试进度清理失败').toBe(200);
      expect(body.success, body.error?.message || '教程测试进度清理失败').toBe(true);
      expect(body.data).toEqual({ reset: true, sourceId });
    };

    await resetProgress();
    const emptyProgress = await readEnvelope<{
      items: Array<{ sourceId: string; learned: boolean }>;
    }>(await page.request.get('/api/daily-tips/progress', { headers: authHeaders(token) }));
    expect(emptyProgress.items.find((item) => item.sourceId === sourceId)?.learned).toBe(false);

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await page.request.post('/api/daily-tips/seed-document-store-page-guide/mark-learned', {
          headers: authHeaders(token),
        });
        const body = await response.json() as ApiEnvelope<{
          learned: { sourceId: string; version: number; tier: string };
        }>;
        expect(response.status(), body.error?.message || '教程完成状态保存失败').toBe(200);
        expect(body.success, body.error?.message || '教程完成状态保存失败').toBe(true);
        expect(body.data.learned.sourceId).toBe(sourceId);
      }
      const progress = await readEnvelope<{
        items: Array<{ sourceId: string; learned: boolean }>;
      }>(await page.request.get('/api/daily-tips/progress', { headers: authHeaders(token) }));
      expect(progress.items.find((item) => item.sourceId === sourceId)?.learned).toBe(true);
    } finally {
      await resetProgress();
    }
  });

  test('[WEB-001][WEB-002][WEB-003][WEB-006][WEB-007] 创建空文件夹并高亮拖入站点后刷新保持归属', { tag: '@cleanup' }, async ({ page, request }, testInfo) => {
    test.setTimeout(120_000);
    const token = await loginAndReadToken(page, request, '/web-pages');
    const runKey = `stsmk-${Date.now().toString(36)}-folder`;
    let siteId = '';
    let folderId = '';
    let recreatedFolderId = '';
    try {
      const uploaded = await uploadStableHostedSite(page, token, `${runKey}-site`);
      siteId = uploaded.site.id;

      await page.goto('/web-pages', { waitUntil: 'domcontentloaded' });
      await dismissBlockingTutorial(page);
      await expect(page.locator('[data-tour-id="webpages-library-rail"]')).toBeVisible();
      await page.locator('[data-tour-id="webpages-create-folder"]').click();
      await page.getByRole('textbox', { name: '文件夹名称' }).fill(runKey);
      const createdResponse = page.waitForResponse((response) => (
        new URL(response.url()).pathname === '/api/web-folders' && response.request().method() === 'POST'
      ));
      await page.getByRole('button', { name: '创建', exact: true }).click();
      const createdHttp = await createdResponse;
      const createdBody = await createdHttp.json() as ApiEnvelope<StableWebFolder>;
      expect(createdHttp.ok(), createdBody.error?.message || '创建稳定冒烟文件夹失败').toBe(true);
      expect(createdBody.success, createdBody.error?.message || '创建稳定冒烟文件夹失败').toBe(true);
      const created = createdBody.data;
      folderId = created.id;

      await page.locator('[data-tour-id="webpages-create-folder"]').click();
      await page.getByRole('textbox', { name: '文件夹名称' }).fill(runKey);
      await page.getByRole('button', { name: '创建', exact: true }).click();
      await expect(page.getByText('文件夹已存在', { exact: true })).toBeVisible();
      const foldersAfterDuplicate = await readEnvelope<{ items: StableWebFolder[] }>(
        await page.request.get('/api/web-folders', { headers: authHeaders(token) }),
      );
      expect(
        foldersAfterDuplicate.items.filter((folder) => folder.name === runKey),
        '同名文件夹重复创建后只能保留一条持久记录',
      ).toHaveLength(1);

      const concurrentPayload = {
        name: runKey,
        generatorType: 'none',
        generateTarget: 'web',
      };
      const concurrentCreates = await Promise.all([
        page.request.post('/api/web-folders', { headers: authHeaders(token), data: concurrentPayload }),
        page.request.post('/api/web-folders', { headers: authHeaders(token), data: concurrentPayload }),
      ]);
      const concurrentFolders = await Promise.all(
        concurrentCreates.map((response) => readEnvelope<StableWebFolder>(response)),
      );
      expect(new Set(concurrentFolders.map((folder) => folder.id)).size, '并发创建必须返回同一文件夹').toBe(1);
      expect(concurrentFolders[0].id).toBe(folderId);
      const foldersAfterConcurrentCreate = await readEnvelope<{ items: StableWebFolder[] }>(
        await page.request.get('/api/web-folders', { headers: authHeaders(token) }),
      );
      expect(
        foldersAfterConcurrentCreate.items.filter((folder) => folder.name === runKey),
        '并发 API 创建后仍只能存在一条持久记录',
      ).toHaveLength(1);

      const legacySpelling = runKey.toUpperCase();
      const assignedLegacyFolder = await page.request.put(`/api/web-pages/${siteId}`, {
        headers: authHeaders(token),
        data: { folder: legacySpelling },
      });
      expect(assignedLegacyFolder.ok(), '构造历史文件夹拼写失败').toBe(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await dismissBlockingTutorial(page);
      const canonicalTarget = page.locator('[data-tour-id="webpages-folder-drop-target"]').filter({ hasText: runKey });
      await expect(canonicalTarget, '持久名与历史大小写变体必须合并为一项').toHaveCount(1);
      await expect(canonicalTarget.locator('.web-folder-drop-target__count')).toHaveText('1');
      const clearedLegacyFolder = await page.request.put(`/api/web-pages/${siteId}`, {
        headers: authHeaders(token),
        data: { folder: '' },
      });
      expect(clearedLegacyFolder.ok(), '历史文件夹拼写夹具清理失败').toBe(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await dismissBlockingTutorial(page);

      const renamedName = `${runKey}-renamed`;
      const renamedFolder = await readEnvelope<StableWebFolder>(
        await page.request.put(`/api/web-folders/${folderId}`, {
          headers: authHeaders(token),
          data: { ...concurrentPayload, name: renamedName },
        }),
      );
      expect(renamedFolder.id, '重命名不能改变文件夹身份').toBe(folderId);
      expect(renamedFolder.name).toBe(renamedName);

      const recreatedOriginal = await readEnvelope<StableWebFolder>(
        await page.request.post('/api/web-folders', {
          headers: authHeaders(token),
          data: concurrentPayload,
        }),
      );
      recreatedFolderId = recreatedOriginal.id;
      expect(recreatedFolderId, '重命名后原名称必须可以重新创建').not.toBe(folderId);
      const deletedRecreated = await page.request.delete(`/api/web-folders/${recreatedFolderId}`, {
        headers: authHeaders(token),
      });
      expect(deletedRecreated.ok(), '重命名回归夹具清理失败').toBe(true);
      recreatedFolderId = '';

      const restoredName = await readEnvelope<StableWebFolder>(
        await page.request.put(`/api/web-folders/${folderId}`, {
          headers: authHeaders(token),
          data: concurrentPayload,
        }),
      );
      expect(restoredName.id, '恢复名称不能改变文件夹身份').toBe(folderId);
      expect(restoredName.name).toBe(runKey);

      const sharedRenameName = `${runKey}-parallel-same`;
      await Promise.all([0, 1].map(() => page.request.put(`/api/web-folders/${folderId}`, {
        headers: authHeaders(token),
        data: { ...concurrentPayload, name: sharedRenameName },
      })));
      const sharedNameCreate = await readEnvelope<StableWebFolder>(
        await page.request.post('/api/web-folders', {
          headers: authHeaders(token),
          data: { ...concurrentPayload, name: sharedRenameName },
        }),
      );
      expect(sharedNameCreate.id, '同名并发重命名不能释放赢家的名称占用').toBe(folderId);
      await readEnvelope<StableWebFolder>(
        await page.request.put(`/api/web-folders/${folderId}`, {
          headers: authHeaders(token),
          data: concurrentPayload,
        }),
      );

      const renameCandidates = [`${runKey}-parallel-a`, `${runKey}-parallel-b`];
      await Promise.all(renameCandidates.map((name) => page.request.put(`/api/web-folders/${folderId}`, {
        headers: authHeaders(token),
        data: { ...concurrentPayload, name },
      })));
      const foldersAfterRenameRace = await readEnvelope<{ items: StableWebFolder[] }>(
        await page.request.get('/api/web-folders', { headers: authHeaders(token) }),
      );
      const folderAfterRenameRace = foldersAfterRenameRace.items.find((folder) => folder.id === folderId);
      expect(folderAfterRenameRace, '并发重命名后文件夹不能丢失').toBeTruthy();
      expect(renameCandidates).toContain(folderAfterRenameRace!.name);
      const losingName = renameCandidates.find((name) => name !== folderAfterRenameRace!.name)!;
      const recreatedLosingName = await readEnvelope<StableWebFolder>(
        await page.request.post('/api/web-folders', {
          headers: authHeaders(token),
          data: { ...concurrentPayload, name: losingName },
        }),
      );
      recreatedFolderId = recreatedLosingName.id;
      expect(recreatedFolderId, '并发重命名失败方不能留下幽灵名称占用').not.toBe(folderId);
      const deletedRaceFixture = await page.request.delete(`/api/web-folders/${recreatedFolderId}`, {
        headers: authHeaders(token),
      });
      expect(deletedRaceFixture.ok(), '并发重命名回归夹具清理失败').toBe(true);
      recreatedFolderId = '';

      const restoredAfterRace = await readEnvelope<StableWebFolder>(
        await page.request.put(`/api/web-folders/${folderId}`, {
          headers: authHeaders(token),
          data: concurrentPayload,
        }),
      );
      expect(restoredAfterRace.id, '并发重命名后恢复名称不能改变文件夹身份').toBe(folderId);
      expect(restoredAfterRace.name).toBe(runKey);

      const folderTarget = page.locator('[data-tour-id="webpages-folder-drop-target"]').filter({ hasText: runKey });
      await expect(folderTarget).toBeVisible();
      await expect(folderTarget.locator('.web-folder-drop-target__count')).toHaveText('0');
      await page.getByRole('button', { name: '全部', exact: true }).click();

      const card = page.locator('[data-tour-id="webpages-card"]').filter({ hasText: `${runKey}-site` }).first();
      await expect(card).toBeVisible();
      const cardBox = await card.boundingBox();
      const folderBox = await folderTarget.boundingBox();
      expect(cardBox, '网页卡片缺少可拖拽区域').toBeTruthy();
      expect(folderBox, '文件夹缺少拖拽目标区域').toBeTruthy();
      await page.mouse.move(cardBox!.x + cardBox!.width / 2, cardBox!.y + Math.min(40, cardBox!.height / 2));
      await page.mouse.down();
      await page.mouse.move(cardBox!.x + cardBox!.width / 2 + 12, cardBox!.y + 56, { steps: 4 });
      await page.mouse.move(folderBox!.x + folderBox!.width / 2, folderBox!.y + folderBox!.height / 2, { steps: 12 });

      await expect(folderTarget).toHaveAttribute('data-dock-hover', 'true');
      await expect(folderTarget.getByText('松开移入', { exact: true })).toBeVisible();
      const targetStyle = await folderTarget.evaluate((element) => {
        const style = getComputedStyle(element);
        return { boxShadow: style.boxShadow, borderColor: style.borderColor, transform: style.transform };
      });
      expect(targetStyle.boxShadow).not.toBe('none');
      expect(targetStyle.borderColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(targetStyle.transform).not.toBe('none');
      await testInfo.attach('web-folder-drop-highlight', { body: await page.screenshot(), contentType: 'image/png' });
      await page.mouse.up();

      await expect.poll(async () => {
        const site = await readEnvelope<StableHostedSite>(
          await page.request.get(`/api/web-pages/${siteId}`, { headers: authHeaders(token) }),
        );
        return site.folder;
      }, { message: '拖拽后站点归属未写入文件夹', timeout: 15_000 }).toBe(runKey);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await dismissBlockingTutorial(page);
      const persisted = page.locator('[data-tour-id="webpages-folder-drop-target"]').filter({ hasText: runKey });
      await expect(persisted).toBeVisible();
      await expect(persisted.locator('.web-folder-drop-target__count')).toHaveText('1');
    } finally {
      if (siteId) await deleteStableHostedSite(page, token, siteId);
      if (recreatedFolderId) {
        await page.request.delete(`/api/web-folders/${recreatedFolderId}`, { headers: authHeaders(token) });
      }
      if (folderId) {
        const deleted = await page.request.delete(`/api/web-folders/${folderId}`, { headers: authHeaders(token) });
        expect(deleted.ok(), '稳定冒烟文件夹清理失败').toBe(true);
        const folders = await readEnvelope<{ items: StableWebFolder[] }>(
          await page.request.get('/api/web-folders', { headers: authHeaders(token) }),
        );
        expect(folders.items.some((folder) => folder.id === folderId)).toBe(false);
      }
    }
  });

  test('[WEB-004][WEB-005][WEB-006] 分享页片段留在 srcDoc 且页面提问可读正文', { tag: '@cleanup' }, async ({ page, request }, testInfo) => {
    const environment = requiredEnv('STABLE_SMOKE_ENVIRONMENT');
    test.setTimeout(environment === 'cds' ? 300_000 : 180_000);
    const token = await loginAndReadToken(page, request, '/web-pages');
    const runKey = `stsmk-${Date.now().toString(36)}-share`;
    let siteId = '';
    let shareId = '';
    let legacyFixturePrepared = false;
    try {
      const uploaded = await uploadStableHostedSite(page, token, runKey);
      siteId = uploaded.site.id;
      await readEnvelope(await page.request.put(`/api/web-pages/${siteId}/ask/config`, {
        headers: authHeaders(token),
        data: {
          enabled: true,
          allowAnonymous: true,
          dailyLimit: 0,
        },
      }));
      const share = await readEnvelope<{ id: string; token: string; shareUrl: string }>(
        await page.request.post('/api/web-pages/share', {
          headers: authHeaders(token),
          data: {
            siteId,
            shareType: 'single',
            title: runKey,
            expiresInDays: 30,
            visibility: 'public',
            forceNew: true,
          },
        }),
      );
      shareId = share.id;

      await page.goto(share.shareUrl, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('#root').getByText(runKey, { exact: true }).first()).toBeVisible();
      await expect.poll(() => page.frames().some((frame) => frame.url().startsWith('about:srcdoc')), {
        message: '分享页未进入 srcDoc 预览路径',
        timeout: 20_000,
      }).toBe(true);
      const frame = page.frames().find((item) => item.url().startsWith('about:srcdoc'))!;
      const anchor = frame.locator('#jump');
      await expect(anchor).toHaveAttribute('href', 'about:srcdoc#target');
      const unexpectedNavigations: string[] = [];
      page.on('request', (item) => {
        if (item.isNavigationRequest() && !item.url().startsWith('about:srcdoc')) {
          unexpectedNavigations.push(item.url());
        }
      });
      await anchor.click();
      await expect.poll(() => frame.url()).toBe('about:srcdoc#target');
      await expect(frame.locator('#target')).toBeInViewport();
      expect(unexpectedNavigations, '片段点击不应向对象存储目录发起导航').toEqual([]);
      await testInfo.attach('web-share-srcdoc-anchor', { body: await page.screenshot(), contentType: 'image/png' });

      await expectAnonymousShareAnswer(request, share.token, siteId, uploaded.marker, 'current');

      if (environment === 'cds') {
        legacyFixturePrepared = true;
        await setLegacyStorageFixture(page, siteId, true);
        await expectAnonymousShareAnswer(request, share.token, siteId, uploaded.marker, 'legacy');
      }
    } finally {
      if (siteId && legacyFixturePrepared) {
        await setLegacyStorageFixture(page, siteId, false);
      }
      if (shareId) {
        const revoked = await page.request.delete(`/api/web-pages/shares/${shareId}?reason=stable-smoke-cleanup`, {
          headers: authHeaders(token),
        });
        expect(revoked.ok(), '稳定冒烟分享清理失败').toBe(true);
      }
      if (siteId) await deleteStableHostedSite(page, token, siteId);
    }
  });

  test('[CORE-003][REG-auth-identity-permissions-001] 巡检身份持有矩阵所需的全部管理权限', async ({ page, request }) => {
    // 2026-09-14：自动开号只给了 Agent 体验者角色，录音、文件、短视频、会话权限四个模块三十余项
    // 在业务动作之前就被权限中间件挡成「无权限」。这里先把外因说清楚，后面的旅程才有资格失败。
    const token = await loginAndReadToken(page, request, '/');
    const me = await readEnvelope<{
      username: string;
      systemRoleKey?: string | null;
      effectivePermissions: string[];
    }>(await page.request.get('/api/authz/me', { headers: authHeaders(token) }));
    const missing = missingIdentityPermissions(me.effectivePermissions);
    expect(
      missing,
      `巡检账号 ${me.username}（系统角色 ${me.systemRoleKey || '无'}）缺少矩阵所需权限：${missing.join('、')}。`
      + '外因：账号由签名认证自动开号时只带了 Agent 体验者角色；修复后的后端会在下一次签名认证时按 StableSmokeIdentityPolicy 补齐，'
      + '若仍缺失，说明部署的后端版本早于该修复，或该部署把 ManagePermissions 显式关闭了。',
    ).toEqual([]);
  });

  test('[CORE-002][CORE-003] 合成会话刷新恢复且受限用户入口和直达均被隔离', { tag: '@cleanup' }, async ({ page, request }) => {
    const adminToken = await loginAndReadToken(page, request, '/');
    const allowed = await page.request.get('/api/authz/me', { headers: authHeaders(adminToken) });
    expect(allowed.ok()).toBe(true);

    const anonymous = await request.get('/api/authz/me');
    expect([401, 403]).toContain(anonymous.status());

    const beforeReload = await readStableAuthSnapshot(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).not.toContainText('请重新登录');
    const afterReload = await readStableAuthSnapshot(page);
    expect(afterReload).toBe(beforeReload);

    const username = `stsmk_noauth_${Date.now().toString(36)}`;
    const password = `StsmkOnly_${Date.now()}_A9`;
    let restrictedUserId = '';
    try {
      const created = await readEnvelope<{
        userId: string;
        username: string;
      }>(await page.request.post('/api/users', {
        headers: {
          ...authHeaders(adminToken),
          'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-restricted-user-${username}`,
        },
        data: {
          username,
          password,
          displayName: '稳定冒烟受限用户',
          role: 'DEV',
        },
      }));
      restrictedUserId = created.userId;
      expect(created.username).toBe(username);

      const authz = await readEnvelope<{
        effectiveSystemRoleKey: string;
        permAllow: string[];
        permDeny: string[];
      }>(await page.request.put(`/api/authz/users/${restrictedUserId}/authz`, {
        headers: authHeaders(adminToken),
        data: {
          systemRoleKey: 'none',
          permAllow: ['access'],
          permDeny: ['users.read', 'users.write'],
        },
      }));
      expect(authz.effectiveSystemRoleKey).toBe('none');
      expect(authz.permAllow).toContain('access');
      expect(authz.permDeny).toEqual(expect.arrayContaining(['users.read', 'users.write']));

      const login = await readEnvelope<{
        accessToken: string;
        refreshToken: string;
        sessionKey: string;
        user: {
          userId: string;
          username: string;
          displayName: string;
          role: string;
        };
      }>(await request.post('/api/v1/auth/login', {
        data: { username, password, clientType: 'desktop' },
      }));
      await page.waitForTimeout(1_100);
      const renewed = await readEnvelope<{
        accessToken: string;
        refreshToken: string;
        sessionKey: string;
        user: { userId: string; username: string };
      }>(await request.post('/api/v1/auth/refresh', {
        data: {
          refreshToken: login.refreshToken,
          userId: login.user.userId,
          clientType: 'desktop',
          sessionKey: login.sessionKey,
        },
      }));
      expect(renewed.accessToken).not.toBe(login.accessToken);
      expect(renewed.refreshToken).toBe(login.refreshToken);
      expect(renewed.sessionKey).toBe(login.sessionKey);
      expect(renewed.user).toMatchObject({ userId: restrictedUserId, username });
      const restrictedToken = renewed.accessToken;
      const restrictedMe = await readEnvelope<{
        effectivePermissions: string[];
        isRoot: boolean;
        permissionFingerprint: string;
        cdnBaseUrl?: string;
      }>(await request.get('/api/authz/me', { headers: authHeaders(restrictedToken) }));
      expect(restrictedMe.isRoot).toBe(false);
      expect(restrictedMe.effectivePermissions).not.toContain('users.read');
      const restrictedMenu = await readEnvelope<{
        items: Array<{ path: string }>;
      }>(await request.get('/api/authz/menu-catalog', { headers: authHeaders(restrictedToken) }));
      expect(restrictedMenu.items.map((item) => item.path)).not.toContain('/users');

      await page.evaluate(({ loginState, me }) => {
        window.localStorage.setItem('prd-admin-auth', JSON.stringify({
          state: {
            isAuthenticated: true,
            user: loginState.user,
            token: loginState.accessToken,
            refreshToken: loginState.refreshToken,
            sessionKey: loginState.sessionKey,
            permissions: me.effectivePermissions,
            permissionsLoaded: true,
            isRoot: false,
            menuCatalog: [],
            menuCatalogLoaded: false,
            cdnBaseUrl: me.cdnBaseUrl || '',
            permFingerprint: me.permissionFingerprint || '',
          },
          version: 0,
        }));
      }, { loginState: { ...login, ...renewed }, me: restrictedMe });
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('a[href="/users"]')).toHaveCount(0);

      const directApi = await request.get('/api/users', { headers: authHeaders(restrictedToken) });
      expect(directApi.status()).toBe(403);
      await page.goto('/users', { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('无权限访问', { exact: true })).toBeVisible();
      await expect(page.getByText('缺少权限：users.read', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '用户管理' })).toHaveCount(0);
    } finally {
      if (restrictedUserId) {
        const expired = await page.request.post(`/api/users/${restrictedUserId}/force-expire`, {
          headers: authHeaders(adminToken),
          data: { targets: ['admin', 'desktop'] },
        });
        expect(expired.ok(), '受限用户会话回收失败').toBe(true);
        const deleted = await page.request.post('/api/users/bulk-delete', {
          headers: authHeaders(adminToken),
          data: { userIds: [restrictedUserId] },
        });
        expect((await readEnvelope<{ deletedCount: number }>(deleted)).deletedCount).toBe(1);
        expect((await page.request.get(`/api/users/${restrictedUserId}`, {
          headers: authHeaders(adminToken),
        })).status()).toBe(404);
      }
    }
  });

  test('[COMMON-001] 专用前缀资源可创建、回读并清理', { tag: '@cleanup' }, async ({ page, request }) => {
    const token = await loginAndReadToken(page, request);
    const title = `stsmk-${Date.now()}-common`;
    let workspaceId = '';
    try {
      const created = await page.request.post('/api/transcript-agent/workspaces', {
        headers: authHeaders(token),
        data: { title },
      });
      expect(created.ok()).toBe(true);
      const workspace = await created.json() as { id: string; title: string };
      workspaceId = workspace.id;
      expect(workspace.title).toBe(title);

      const readBack = await page.request.get(`/api/transcript-agent/workspaces/${workspaceId}`, {
        headers: authHeaders(token),
      });
      expect((await readBack.json()).title).toBe(title);
    } finally {
      if (workspaceId) {
        const deleted = await page.request.delete(`/api/transcript-agent/workspaces/${workspaceId}`, {
          headers: authHeaders(token),
        });
        expect(deleted.status()).toBe(204);
        const missing = await page.request.get(`/api/transcript-agent/workspaces/${workspaceId}`, {
          headers: authHeaders(token),
        });
        expect(missing.status()).toBe(404);
      }
    }
  });

  test('[FILE-001][FILE-002][FILE-006][FILE-007][FILE-009][FILE-010] 文件格式、下载、重复与清理', { tag: '@cleanup' }, async ({ page, request }) => {
    const token = await loginAndReadToken(page, request, '/transcript-agent');
    const runKey = `stsmk-${Date.now()}`;
    let storeId = '';
    const createdEntryIds: string[] = [];
    const createdFileUrls: string[] = [];
    try {
      const createStore = await page.request.post('/api/document-store/stores', {
        headers: authHeaders(token),
        data: { name: `${runKey}-文件解析`, description: '稳定冒烟专用，执行后自动清理', isPublic: false },
      });
      const store = await readEnvelope<{ id: string; name: string }>(createStore);
      storeId = store.id;

      const expectedText = `${runKey} 中文文件解析基准内容`;
      const allFixtures = [
        { suffix: 'txt', mime: 'text/plain', buffer: Buffer.from(expectedText, 'utf8'), expected: expectedText },
        { suffix: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docxFixture(expectedText), expected: expectedText },
        { suffix: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: pptxFixture(expectedText), expected: expectedText },
        { suffix: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: readFileSync(resolve(specDir, '../../prd-admin/public/templates/product-agent-feature-catalog-test.xlsx')), expected: '' },
        { suffix: 'pdf', mime: 'application/pdf', buffer: readFileSync(resolve(specDir, '../../doc/report.cds-agent-p4-1-remote-preflight-2026-05-19.pdf')), expected: '' },
      ];
      const production = requiredEnv('STABLE_SMOKE_ENVIRONMENT') === 'production';
      const rotationSeed = requiredEnv('STABLE_SMOKE_COMMIT');
      const rotationOffset = [...rotationSeed].reduce((sum, character) => sum + character.charCodeAt(0), 0) % allFixtures.length;
      const fixtures = production
        ? [allFixtures[rotationOffset], allFixtures[(rotationOffset + 1) % allFixtures.length]]
        : allFixtures;
      for (const fixture of fixtures) {
        const expectedFileName = `${runKey}-中文样本.${fixture.suffix}`;
        const upload = await page.request.post(`/api/document-store/stores/${storeId}/upload`, {
          headers: authHeaders(token),
          multipart: {
            file: {
              name: expectedFileName,
              mimeType: fixture.mime,
              buffer: fixture.buffer,
            },
          },
        });
        const uploaded = await readEnvelope<{ entry: { id: string; title: string }; fileUrl: string }>(upload);
        createdEntryIds.push(uploaded.entry.id);
        createdFileUrls.push(uploaded.fileUrl);
        expect(uploaded.entry.title).toContain('中文样本');
        expect(uploaded.fileUrl).toBeTruthy();

        const contentResponse = await page.request.get(`/api/document-store/entries/${uploaded.entry.id}/content`, {
          headers: authHeaders(token),
        });
        const content = await readEnvelope<{ content?: string; hasContent: boolean }>(contentResponse);
        expect(content.hasContent, `${fixture.suffix} 应提取出可读内容`).toBe(true);
        expect((content.content || '').trim().length).toBeGreaterThan(5);
        if (fixture.expected) expect(content.content).toContain(fixture.expected);

        const original = await page.request.get(`/api/document-store/entries/${uploaded.entry.id}/download`, {
          headers: authHeaders(token),
        });
        expect(original.ok()).toBe(true);
        expect(original.headers()['content-type'] || '').toContain(fixture.mime.split(';')[0]);
        expect(downloadFileName(original.headers()['content-disposition'] || '')).toBe(expectedFileName);
        expect((await original.body()).byteLength).toBe(fixture.buffer.byteLength);
      }

      const duplicate = await page.request.post(`/api/document-store/stores/${storeId}/upload`, {
        headers: authHeaders(token),
        multipart: { file: { name: `${runKey}-中文样本.txt`, mimeType: 'text/plain', buffer: Buffer.from(expectedText, 'utf8') } },
      });
      const duplicateData = await readEnvelope<{ entry: { id: string }; fileUrl: string }>(duplicate);
      expect(createdEntryIds).not.toContain(duplicateData.entry.id);
      createdEntryIds.push(duplicateData.entry.id);
      createdFileUrls.push(duplicateData.fileUrl);

    } finally {
      if (storeId) {
        const deleted = await page.request.delete(`/api/document-store/stores/${storeId}`, {
          headers: authHeaders(token),
        });
        const body = await deleted.json() as ApiEnvelope<{ deleted: boolean }>;
        expect(body.success).toBe(true);
        const missing = await page.request.get(`/api/document-store/stores/${storeId}`, {
          headers: authHeaders(token),
        });
        expect(missing.status()).toBe(404);
        for (const entryId of createdEntryIds) {
          expect((await page.request.get(`/api/document-store/entries/${entryId}`, { headers: authHeaders(token) })).status()).toBe(404);
        }
        for (const fileUrl of createdFileUrls) {
          await expect.poll(async () => {
            const separator = fileUrl.includes('?') ? '&' : '?';
            return (await page.request.get(`${fileUrl}${separator}cleanup=${Date.now()}`)).status();
          }, {
            message: `删除知识库后原始文件必须同步清理：${fileUrl}`,
            timeout: 15_000,
          }).toBe(404);
        }
      }
    }
  });

  test('[FILE-004] CDS 损坏文档只返回可恢复提示且不留条目', { tag: '@cleanup' }, async ({ page, request }) => {
    test.skip(requiredEnv('STABLE_SMOKE_ENVIRONMENT') === 'production', '正式环境策略禁止主动上传损坏文档');
    const token = await loginAndReadToken(page, request, '/transcript-agent');
    const runKey = `stsmk-${Date.now()}-corrupt`;
    let storeId = '';
    try {
      const store = await readEnvelope<{ id: string }>(await page.request.post('/api/document-store/stores', {
        headers: authHeaders(token),
        data: { name: runKey, description: '损坏文件前置拒绝测试', isPublic: false },
      }));
      storeId = store.id;
      const corrupt = await page.request.post(`/api/document-store/stores/${storeId}/upload`, {
        headers: authHeaders(token),
        multipart: { file: { name: `${runKey}.docx`, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('not-a-docx') } },
      });
      const corruptBody = await corrupt.json() as ApiEnvelope<never>;
      expect(corrupt.status()).toBe(400);
      expectUserReadable(corruptBody.error?.message || '');
    } finally {
      if (storeId) {
        const deleted = await page.request.delete(`/api/document-store/stores/${storeId}`, { headers: authHeaders(token) });
        expect([200, 204]).toContain(deleted.status());
        expect((await page.request.get(`/api/document-store/stores/${storeId}`, { headers: authHeaders(token) })).status()).toBe(404);
      }
    }
  });

  test('[FILE-005][REG-file-001] 空文件在解析前被拒绝且不留条目', { tag: '@cleanup' }, async ({ page, request }) => {
    const token = await loginAndReadToken(page, request, '/transcript-agent');
    const runKey = `stsmk-${Date.now()}-empty`;
    let storeId = '';
    try {
      const store = await readEnvelope<{ id: string }>(await page.request.post('/api/document-store/stores', {
        headers: authHeaders(token),
        data: { name: runKey, description: '空文件前置拒绝测试', isPublic: false },
      }));
      storeId = store.id;
      const empty = await page.request.post(`/api/document-store/stores/${storeId}/upload`, {
        headers: authHeaders(token),
        multipart: { file: { name: `${runKey}.txt`, mimeType: 'text/plain', buffer: Buffer.alloc(0) } },
      });
      const emptyBody = await empty.json() as ApiEnvelope<never>;
      expect(empty.status()).toBe(400);
      expectUserReadable(emptyBody.error?.message || '');
    } finally {
      if (storeId) {
        const deleted = await page.request.delete(`/api/document-store/stores/${storeId}`, { headers: authHeaders(token) });
        expect([200, 204]).toContain(deleted.status());
        expect((await page.request.get(`/api/document-store/stores/${storeId}`, { headers: authHeaders(token) })).status()).toBe(404);
      }
    }
  });

  test('[FILE-003] 大文件上传期间持续显示文件名和百分比', { tag: '@cleanup' }, async ({ page, request }) => {
    test.setTimeout(90_000);
    const token = await loginAndReadToken(page, request, '/document-store');
    const runKey = `${requiredEnv('STABLE_SMOKE_RUN_ID')}-progress`;
    let storeId = '';
    try {
      const store = await readEnvelope<{ id: string }>(await page.request.post('/api/document-store/stores', {
        headers: authHeaders(token),
        data: { name: runKey, description: '上传进度稳定冒烟，执行后自动清理', isPublic: false },
      }));
      storeId = store.id;
      await page.goto(`/document-store?store=${encodeURIComponent(storeId)}`, { waitUntil: 'domcontentloaded' });
      await dismissBlockingTutorial(page);
      await expect(page.getByText(runKey, { exact: true })).toBeVisible({ timeout: 15_000 });

      let releaseUpload!: () => void;
      const release = new Promise<void>((resolveRelease) => { releaseUpload = resolveRelease; });
      await page.route(`**/api/document-store/stores/${storeId}/upload`, async (route) => {
        await release;
        await route.continue();
      });
      const name = `${runKey}.txt`;
      await page.locator('input[type="file"][accept*=".pdf"]').first().setInputFiles({
        name,
        mimeType: 'text/plain',
        buffer: Buffer.alloc(2 * 1024 * 1024, 65),
      });
      await expect(page.getByText(`正在上传 ${name}`, { exact: true })).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(/^\d+%$/)).toBeVisible();
      releaseUpload();
      await expect(page.getByText(`正在上传 ${name}`, { exact: true })).toBeHidden({ timeout: 30_000 });
    } finally {
      if (storeId) {
        const deleted = await page.request.delete(`/api/document-store/stores/${storeId}`, { headers: authHeaders(token) });
        expect([200, 204]).toContain(deleted.status());
      }
    }
  });

  test('[LIT-001] 文学作品可新建、保存、刷新回读并清理', { tag: '@cleanup' }, async ({ page, request }) => {
    const token = await loginAndReadToken(page, request, '/literary-agent');
    const title = `stsmk-${Date.now()}-文学作品`;
    const article = '稳定冒烟文学创作基准正文。';
    let workspaceId = '';
    try {
      const created = await page.request.post('/api/literary-agent/workspaces', {
        headers: authHeaders(token),
        data: { title, scenarioType: 'article-illustration' },
      });
      const createdData = await readEnvelope<{ workspace: { id: string; title: string } }>(created);
      workspaceId = createdData.workspace.id;

      const updated = await page.request.put(`/api/literary-agent/workspaces/${workspaceId}`, {
        headers: authHeaders(token),
        data: { title, articleContent: article },
      });
      const updatedData = await readEnvelope<{ workspace: { articleContent: string } }>(updated);
      expect(updatedData.workspace.articleContent).toBe(article);

      const detail = await page.request.get(`/api/literary-agent/workspaces/${workspaceId}/detail`, {
        headers: authHeaders(token),
      });
      const detailData = await readEnvelope<{ workspace: { title: string; articleContent: string } }>(detail);
      expect(detailData.workspace.title).toBe(title);
      expect(detailData.workspace.articleContent).toBe(article);
    } finally {
      if (workspaceId) {
        const deleted = await page.request.delete(`/api/literary-agent/workspaces/${workspaceId}`, {
          headers: authHeaders(token),
        });
        expect((await deleted.json() as ApiEnvelope<{ deleted: boolean }>).data.deleted).toBe(true);
        const missing = await page.request.get(`/api/literary-agent/workspaces/${workspaceId}/detail`, {
          headers: authHeaders(token),
        });
        expect(missing.status()).toBe(404);
      }
    }
  });

  test('[LIT-011][GW-010][REG-model-catalog-identity-001] 核心目录健康与文学运行时保持闭环', async ({ page, request }) => {
    const token = await loginAndReadToken(page, request, '/literary-agent');
    const targets = [
      { endpoint: '/api/literary-agent/config/models/chat', appCallerCode: 'literary-agent.content::chat', modelType: 'chat' },
      { endpoint: '/api/literary-agent/config/models/text2img', appCallerCode: 'literary-agent.illustration.text2img::generation', modelType: 'generation' },
      { endpoint: '/api/literary-agent/config/models/img2img', appCallerCode: 'literary-agent.illustration.img2img::generation', modelType: 'generation' },
    ];
    for (const target of targets) {
      const pools = await readEnvelope<BusinessModelPool[]>(await request.get(
        target.endpoint,
        { headers: authHeaders(token) },
      ));
      expect(pools.length, `${target.appCallerCode} 的业务模型目录为空`).toBeGreaterThan(0);
      expect(pools.filter((pool) => pool.isDefault).length, `${target.appCallerCode} 默认模型数量异常`).toBe(1);
      for (const pool of pools) {
        expect(pool.code, `${target.appCallerCode} 缺少稳定 PublicId`).not.toBe('');
        expect(pool.resolutionType).toBe('LogicalModel');
        expect(pool.models).toHaveLength(1);
        expect(pool.models[0]?.modelId).toBe(pool.code);
        expect(pool.models[0]?.platformId).toBe('logical-model');
        expect(['Healthy', 'Degraded']).toContain(pool.models[0]?.healthStatus);
      }
    }

    const deep = await request.get('/api/healthz/deep');
    const deepBody = await deep.json() as {
      checks?: Record<string, Array<{
        observedValue?: number;
        status?: string;
        targetCount?: number;
        catalogEntryCount?: number;
      }>>;
    };
    const contractCheck = deepBody.checks?.['model-catalog:selector-runtime-contract']?.[0];
    expect(deep.ok()).toBe(true);
    expect(contractCheck?.status).toBe('pass');
    expect(contractCheck?.observedValue).toBe(0);
    expect(contractCheck?.targetCount).toBe(5);
    expect(contractCheck?.catalogEntryCount).toBeGreaterThanOrEqual(5);
  });

  test('[LIT-002][LIT-005][LIT-010] 文学配图标记流式生成、保存恢复与清理', { tag: '@cleanup' }, async ({ page, request }) => {
    test.setTimeout(240_000);
    const token = await loginAndReadToken(page, request, '/literary-agent');
    const title = `stsmk-${Date.now()}-文学流式创作`;
    const article = '清晨，城市公园里的蓝色长椅刚被阳光照亮。\n\n一位读者翻开书本，远处的树叶在微风中轻轻摇动。';
    let workspaceId = '';
    try {
      const chatPools = await readEnvelope<BusinessModelPool[]>(await page.request.get(
        '/api/literary-agent/config/models/chat',
        { headers: authHeaders(token) },
      ));
      const defaultChatPool = chatPools.find((pool) => pool.isDefault);
      expect(defaultChatPool?.code, '文学创作对话目录必须有唯一默认 PublicId').toBeTruthy();
      const created = await readEnvelope<{ workspace: { id: string } }>(
        await page.request.post('/api/literary-agent/workspaces', {
          headers: authHeaders(token),
          data: { title, scenarioType: 'article-illustration', articleContent: article },
        }),
      );
      workspaceId = created.workspace.id;
      await readEnvelope<{ workspace: { id: string } }>(await page.request.put(`/api/literary-agent/workspaces/${workspaceId}`, {
        headers: authHeaders(token),
        data: { title, articleContent: article },
      }));
      const streamed = await page.evaluate(async ({ id, accessToken, content, modelId }) => {
        const startedAt = performance.now();
        const response = await fetch(`/api/visual-agent/image-master/workspaces/${id}/article/generate-markers`, {
          method: 'POST',
          headers: {
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'Idempotency-Key': `stable-literary-${id}`,
          },
          body: JSON.stringify({
            articleContent: content,
            userInstruction: '只插入一处配图标记，保持原文不变',
            insertionMode: 'anchor',
            modelId,
          }),
        });
        if (!response.ok || !response.body) {
          return { ok: false, firstChunkMs: -1, firstVisibleProgressMs: -1, chunkCount: 0, text: await response.text() };
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let firstChunkMs = -1;
        let firstVisibleProgressMs = -1;
        let chunkCount = 0;
        let text = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (firstChunkMs < 0) firstChunkMs = performance.now() - startedAt;
          chunkCount += 1;
          text += decoder.decode(value, { stream: true });
          if (firstVisibleProgressMs < 0
            && /"type"\s*:\s*"(?:progress|thinking|delta|status)"/i.test(text)) {
            firstVisibleProgressMs = performance.now() - startedAt;
          }
        }
        return { ok: true, firstChunkMs, firstVisibleProgressMs, chunkCount, text };
      }, { id: workspaceId, accessToken: token, content: article, modelId: defaultChatPool!.code });
      expect(streamed.ok, streamed.text).toBe(true);
      expect(streamed.firstChunkMs).toBeGreaterThanOrEqual(0);
      expect(streamed.firstVisibleProgressMs, '文学创作必须在两秒内出现用户可见进度，心跳不计入').toBeGreaterThanOrEqual(0);
      expect(streamed.firstVisibleProgressMs).toBeLessThan(2_000);
      expect(streamed.chunkCount).toBeGreaterThan(1);
      expect(streamed.text).toContain('"type":"done"');
      expect(streamed.text).not.toContain('"type":"error"');

      const detail = await readEnvelope<{ workspace: { articleContent?: string; articleContentWithMarkers?: string } }>(
        await page.request.get(`/api/literary-agent/workspaces/${workspaceId}/detail`, { headers: authHeaders(token) }),
      );
      expect(detail.workspace.articleContent).toContain('蓝色长椅');
      expect((detail.workspace.articleContentWithMarkers || '').length).toBeGreaterThan(article.length);
    } finally {
      if (workspaceId) {
        const deleted = await page.request.delete(`/api/literary-agent/workspaces/${workspaceId}`, { headers: authHeaders(token) });
        expect((await deleted.json() as ApiEnvelope<{ deleted: boolean }>).data.deleted).toBe(true);
      }
    }
  });

  test('[LIT-008] 长文达到验收基线后保存和回读均不静默截断', { tag: '@cleanup' }, async ({ page, request }) => {
    const token = await loginAndReadToken(page, request, '/literary-agent');
    const production = requiredEnv('STABLE_SMOKE_ENVIRONMENT') === 'production';
    const expectedLength = production ? 4_096 : 64_000;
    const prefix = '稳定冒烟长文边界开篇。\n';
    const suffix = '\n稳定冒烟长文边界收尾。';
    const unit = '这一段用于验证文学作品在保存、刷新和回读时不会被静默截断。';
    const middle = unit.repeat(Math.ceil(expectedLength / unit.length)).slice(
      0,
      expectedLength - prefix.length - suffix.length,
    );
    const article = `${prefix}${middle}${suffix}`;
    const title = `stsmk-${Date.now()}-文学长文边界`;
    let workspaceId = '';
    expect(article.length).toBe(expectedLength);

    try {
      const created = await readEnvelope<{ workspace: { id: string } }>(
        await page.request.post('/api/literary-agent/workspaces', {
          headers: authHeaders(token),
          data: { title, scenarioType: 'article-illustration' },
        }),
      );
      workspaceId = created.workspace.id;
      const updated = await readEnvelope<{ workspace: { articleContent: string } }>(
        await page.request.put(`/api/literary-agent/workspaces/${workspaceId}`, {
          headers: authHeaders(token),
          data: { title, articleContent: article },
        }),
      );
      expect(updated.workspace.articleContent.length).toBe(expectedLength);
      expect(updated.workspace.articleContent).toBe(article);

      const detail = await readEnvelope<{ workspace: { articleContent: string } }>(
        await page.request.get(`/api/literary-agent/workspaces/${workspaceId}/detail`, {
          headers: authHeaders(token),
        }),
      );
      expect(detail.workspace.articleContent.length).toBe(expectedLength);
      expect(detail.workspace.articleContent.startsWith(prefix)).toBe(true);
      expect(detail.workspace.articleContent.endsWith(suffix)).toBe(true);
      expect(detail.workspace.articleContent).toBe(article);
    } finally {
      if (workspaceId) {
        const deleted = await page.request.delete(`/api/literary-agent/workspaces/${workspaceId}`, {
          headers: authHeaders(token),
        });
        expect((await deleted.json() as ApiEnvelope<{ deleted: boolean }>).data.deleted).toBe(true);
      }
    }
  });

  test('[LIT-009] 移动端可输入标题、创建作品并进入编辑页', { tag: '@cleanup' }, async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const token = await loginAndReadToken(page, request, '/literary-agent');
    const title = `${requiredEnv('STABLE_SMOKE_RUN_ID')}-移动文学`;
    let workspaceId = '';
    try {
      await page.locator('[data-tour-id="literary-create"]').click();
      const input = page.getByPlaceholder('未命名');
      await expect(input).toBeVisible();
      await input.fill(title);
      await page.getByRole('button', { name: '创建', exact: true }).click();
      await page.waitForURL(/\/literary-agent\/[^/?#]+/, { timeout: 20_000 });
      workspaceId = new URL(page.url()).pathname.split('/').filter(Boolean).at(-1) || '';
      expect(workspaceId).toBeTruthy();
      await expect(page.locator('body')).toContainText(title);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, '移动端文学创作页面不得横向裁切').toBeLessThanOrEqual(1);
      expect(await page.locator('button:visible, textarea:visible, [contenteditable="true"]:visible').count()).toBeGreaterThan(0);
    } finally {
      if (workspaceId) {
        const deleted = await page.request.delete(`/api/literary-agent/workspaces/${workspaceId}`, {
          headers: authHeaders(token),
        });
        expect((await deleted.json() as ApiEnvelope<{ deleted: boolean }>).data.deleted).toBe(true);
      }
    }
  });

  test('[PARSE-003][REG-short-video-input-001] 非法短视频链接在入口被拒绝并说明恢复动作', async ({ page, request }) => {
    const token = await loginAndReadToken(page, request, '/document-store');
    const response = await page.request.post('/api/short-video-materials/runs', {
      headers: authHeaders(token),
      data: { videoUrl: '这不是链接', title: `${requiredEnv('STABLE_SMOKE_RUN_ID')}-invalid-video` },
    });
    const body = await response.json() as ApiEnvelope<never>;
    expect(response.status()).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error?.message || '').toContain('完整的公开视频链接');
    expectUserReadable(body.error?.message || '');
  });

  test('[VIDEO-004][VIDEO-007][VIDEO-008][VIDEO-010][REG-video-001] 从页面生成最短无音频视频并解码成片', { tag: '@cleanup' }, async ({ page, request }) => {
    test.setTimeout(420_000);
    const token = await loginAndReadToken(page, request, '/video-agent');
    const models = await readEnvelope<Array<{
      id: string;
      healthStatus?: string;
      durations?: number[];
      resolutions?: string[];
      aspectRatios?: string[];
      pricePerCall?: number;
    }>>(await page.request.get('/api/video-agent/models', { headers: authHeaders(token) }));
    const available = models
      .filter((model) => !/unhealthy|disabled|unavailable/i.test(model.healthStatus || ''))
      .sort((left, right) => (left.pricePerCall ?? Number.MAX_SAFE_INTEGER) - (right.pricePerCall ?? Number.MAX_SAFE_INTEGER));
    expect(available.length, '没有可用的视频生成模型').toBeGreaterThan(0);
    const model = available[0];
    const selectedAspect = model.aspectRatios?.includes('16:9') ? '16:9' : model.aspectRatios?.[0] || '16:9';
    const selectedResolution = model.resolutions?.includes('720p') ? '720p' : model.resolutions?.[0] || '720p';
    const prompt = '固定镜头，一只蓝色陶瓷杯放在纯白桌面上，柔和自然光，不要文字，不要人物';
    let runId = '';
    let projectId = '';
    let generatedVideoUrl = '';
    try {
      await page.getByRole('button', { name: '新项目', exact: true }).click();
      await page.getByRole('button', { name: /单镜直出/ }).click();
      await page.getByLabel('项目名称').fill(`${requiredEnv('STABLE_SMOKE_RUN_ID')}-video`);
      await page.getByLabel('文学稿内容').fill(prompt);
      const studio = page.getByTestId('video-project-studio');
      await studio.getByRole('button', { name: '设置', exact: true }).click();
      const settings = studio.getByRole('region', { name: '生成设置' });
      await settings.getByLabel('视频模型').selectOption(model.id);
      await settings.getByLabel('画幅').selectOption(selectedAspect);
      await settings.getByLabel('单镜时长').selectOption(String(Math.min(...(model.durations?.length ? model.durations : [5]))));
      await settings.getByLabel('分辨率').selectOption(selectedResolution);
      const audioToggle = settings.getByRole('checkbox', { name: '同步音频' });
      if (await audioToggle.isChecked()) await audioToggle.uncheck();
      await expect(audioToggle, '稳定冒烟必须明确关闭视频音轨').not.toBeChecked();

      const createResponse = page.waitForResponse((response) => (
        response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/video-agent/runs'
      ));
      await page.getByRole('button', { name: '生成这段视频', exact: true }).click();
      const createRunResponse = await createResponse;
      const createRunBody = await createRunResponse.json() as ApiEnvelope<{ runId: string }>;
      expect(createRunResponse.ok(), createRunBody.error?.message || '页面提交视频任务失败').toBe(true);
      expect(createRunBody.success, createRunBody.error?.message || '页面提交视频任务失败').toBe(true);
      runId = createRunBody.data.runId;
      expect(runId).toBeTruthy();

      const visibleStages = new Set<string>();
      const visibleProgress = new Set<string>();
      const startedAt = Date.now();
      let videoUrl = '';
      while (Date.now() - startedAt < 360_000) {
        const status = await readEnvelope<{
          status: string;
          videoAssetUrl?: string;
          errorMessage?: string;
          currentPhase?: string;
          phaseProgress?: number;
          generateAudio?: boolean;
          projectId?: string;
        }>(await page.request.get(`/api/video-agent/runs/${encodeURIComponent(runId)}`, {
          headers: authHeaders(token),
        }));
        projectId = status.projectId || projectId;
        const stage = page.getByTestId('video-generation-stage');
        if (await stage.isVisible().catch(() => false)) visibleStages.add((await stage.innerText()).trim());
        const progress = page.getByTestId('video-generation-progress');
        if (await progress.isVisible().catch(() => false)) visibleProgress.add((await progress.innerText()).trim());
        if (/Failed|Cancelled/i.test(status.status)) {
          expectUserReadable(status.errorMessage || '视频生成失败，请稍后重试或切换模型');
          throw new Error(status.errorMessage || '视频生成失败，请稍后重试或切换模型');
        }
        if (/Completed/i.test(status.status)) {
          expect(status.generateAudio, '视频任务必须保存无音频配置').toBe(false);
          videoUrl = status.videoAssetUrl || '';
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));
      }
      expect(videoUrl, '视频任务完成后必须返回成片标识').toBeTruthy();
      generatedVideoUrl = videoUrl;
      await expect(page.locator('video'), '完成后页面必须显示可播放视频').toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('已完成', { exact: true }).first(), '页面必须显示生成完成阶段').toBeVisible();
      visibleStages.add('已完成');
      const downloadButton = page.getByRole('button', { name: '下载 MP4' }).first();
      await expect(downloadButton, '完成后页面必须显示下载入口').toBeVisible();
      const browserMedia = await page.locator('video').evaluate(async (element) => {
        const video = element as HTMLVideoElement;
        if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
          await new Promise<void>((resolveLoaded, rejectLoaded) => {
            const timer = window.setTimeout(() => rejectLoaded(new Error('视频元数据加载超时')), 30_000);
            video.addEventListener('loadedmetadata', () => { window.clearTimeout(timer); resolveLoaded(); }, { once: true });
            video.addEventListener('error', () => { window.clearTimeout(timer); rejectLoaded(new Error('视频无法解码')); }, { once: true });
            video.load();
          });
        }
        video.muted = true;
        await video.play();
        await new Promise<void>((resolveFrame) => {
          if ('requestVideoFrameCallback' in video) {
            video.requestVideoFrameCallback(() => resolveFrame());
          } else {
            window.setTimeout(resolveFrame, 500);
          }
        });
        video.pause();
        return { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
      });
      expect(browserMedia.duration, '浏览器解码后视频时长必须大于零').toBeGreaterThan(0);
      expect(browserMedia.width, '浏览器必须解码出有效视频画面').toBeGreaterThan(0);
      expect(browserMedia.height, '浏览器必须解码出有效视频画面').toBeGreaterThan(0);

      const ticketResponsePromise = page.waitForResponse((response) => (
        response.request().method() === 'POST'
        && new URL(response.url()).pathname === `/api/video-agent/runs/${encodeURIComponent(runId)}/download-ticket`
      ));
      // 附件导航会触发 download 而不进入页面 response 事件；用 request 证明真实表单提交。
      const downloadRequestPromise = page.waitForRequest((request) => (
        request.method() === 'POST'
        && new URL(request.url()).pathname === '/api/video-download'
      ));
      const downloadPromise = page.waitForEvent('download');
      await downloadButton.click();

      const ticketResponse = await ticketResponsePromise;
      const ticketBody = await ticketResponse.json() as ApiEnvelope<{ ticket: string; fileName: string }>;
      expect(ticketResponse.ok(), ticketBody.error?.message || '视频下载凭据签发失败').toBe(true);
      expect(ticketBody.success, ticketBody.error?.message || '视频下载凭据签发失败').toBe(true);
      expect(ticketBody.data.ticket, '视频下载凭据不能为空').toBeTruthy();

      const [downloadRequest, download] = await Promise.all([
        downloadRequestPromise,
        downloadPromise,
      ]);
      expect(downloadRequest.postData() || '', '视频下载请求必须携带短时凭据').toContain('ticket=');
      expect(await download.failure(), '浏览器下载过程不得失败').toBeNull();
      expect(download.suggestedFilename()).toBe(`video-${runId}.mp4`);
      const downloadedPath = await download.path();
      expect(downloadedPath, '浏览器必须落下真实 MP4 文件').toBeTruthy();
      expect(new URL(videoUrl).pathname).toMatch(/\.mp4$/i);
      const videoBytes = readFileSync(downloadedPath!);
      expect(videoBytes.byteLength).toBeGreaterThan(1024);
      const container = inspectMp4(videoBytes);
      expect(container.durationSeconds, 'MP4 容器声明的时长必须大于零').toBeGreaterThan(0);
      expect(container.videoTracks, 'MP4 必须包含视频轨').toBeGreaterThan(0);
      expect(container.audioTracks, 'generateAudio=false 时 MP4 不得包含音轨').toBe(0);
      expect(visibleStages.size, `页面只出现了这些视频阶段：${[...visibleStages].join('、')}`).toBeGreaterThanOrEqual(2);
      expect(visibleProgress.size, '生成过程中页面必须至少显示一个真实进度值').toBeGreaterThanOrEqual(1);
    } finally {
      if (runId) {
        const current = await page.request.get(`/api/video-agent/runs/${encodeURIComponent(runId)}`, { headers: authHeaders(token) });
        if (current.ok()) {
          let state = await current.json() as ApiEnvelope<{ status: string; projectId?: string }>;
          projectId = state.data?.projectId || projectId;
          if (!/Completed|Failed|Cancelled/i.test(state.data?.status || '')) {
            await page.request.post(`/api/video-agent/runs/${encodeURIComponent(runId)}/cancel`, { headers: authHeaders(token) });
            const cancelStartedAt = Date.now();
            while (Date.now() - cancelStartedAt < 30_000) {
              await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
              const refreshed = await page.request.get(`/api/video-agent/runs/${encodeURIComponent(runId)}`, { headers: authHeaders(token) });
              if (!refreshed.ok()) break;
              state = await refreshed.json() as ApiEnvelope<{ status: string; projectId?: string }>;
              projectId = state.data?.projectId || projectId;
              if (/Completed|Failed|Cancelled/i.test(state.data?.status || '')) break;
            }
          }
          const cleanup = await page.request.delete(
            `/api/video-agent/runs/${encodeURIComponent(runId)}?deleteEmptyProject=true`,
            { headers: authHeaders(token) },
          );
          const cleanupBody = await cleanup.json() as ApiEnvelope<{
            deleted: boolean;
            projectDeleted: boolean;
            artifactsDeleted: number;
          }>;
          expect(cleanup.ok(), cleanupBody.error?.message || '视频任务清理失败').toBe(true);
          expect(cleanupBody.data.deleted).toBe(true);
          expect(cleanupBody.data.projectDeleted, '页面新建的空视频项目必须随任务回收').toBe(true);
          expect(cleanupBody.data.artifactsDeleted).toBeGreaterThanOrEqual(0);
          expect((await page.request.get(`/api/video-agent/runs/${encodeURIComponent(runId)}`, { headers: authHeaders(token) })).status()).toBe(404);
          if (projectId) {
            expect((await page.request.get(`/api/video-agent/projects/${encodeURIComponent(projectId)}`, { headers: authHeaders(token) })).status()).toBe(404);
          }
          if (generatedVideoUrl && cleanupBody.data.artifactsDeleted > 0) {
            let artifactStatus = 200;
            const deleteStartedAt = Date.now();
            while (Date.now() - deleteStartedAt < 30_000) {
              const separator = generatedVideoUrl.includes('?') ? '&' : '?';
              const artifact = await page.request.get(`${generatedVideoUrl}${separator}cleanup=${Date.now()}`);
              artifactStatus = artifact.status();
              if (!artifact.ok()) break;
              await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
            }
            expect(artifactStatus, '视频任务删除后生成文件仍可访问').toBeGreaterThanOrEqual(400);
          } else if (generatedVideoUrl) {
            const separator = generatedVideoUrl.includes('?') ? '&' : '?';
            const sharedArtifact = await page.request.get(`${generatedVideoUrl}${separator}shared=${Date.now()}`);
            expect(sharedArtifact.ok(), '共享视频产物仍被其他任务引用时不得误删').toBe(true);
          }
        }
      }
    }
  });

  test('[REC-003][REC-007][REC-012] 页面选择音频、显示阶段、真实转写、回读与清理', { tag: '@cleanup' }, async ({ page, request }, testInfo) => {
    test.setTimeout(240_000);
    const token = await loginAndReadToken(page, request, '/document-store');
    const title = `${requiredEnv('STABLE_SMOKE_RUN_ID')}-audio`;
    let storeId = '';
    let entryId = '';
    let runId = '';
    try {
      const store = await readEnvelope<{ id: string }>(await page.request.post('/api/document-store/stores', {
        headers: authHeaders(token),
        data: { name: title, description: '稳定冒烟真实录音转录，执行后自动清理', isPublic: false },
      }));
      storeId = store.id;
      await page.goto(`/document-store?store=${encodeURIComponent(storeId)}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByText(title, { exact: true })).toBeVisible({ timeout: 30_000 });

      const uploadPath = `/api/document-store/stores/${storeId}/upload`;
      let releaseUpload: (() => void) | undefined;
      let markUploadIntercepted: (() => void) | undefined;
      const uploadIntercepted = new Promise<void>((resolve) => { markUploadIntercepted = resolve; });
      await page.route(`**${uploadPath}`, async (route) => {
        await new Promise<void>((resolve) => {
          releaseUpload = resolve;
          markUploadIntercepted?.();
        });
        await route.continue();
      });
      const uploadResponsePromise = page.waitForResponse((response) => (
        response.url().includes(uploadPath) && response.request().method() === 'POST'
      ));
      const transcribeResponsePromise = page.waitForResponse((response) => (
        /\/api\/document-store\/entries\/[^/]+\/transcribe(?:\?|$)/.test(response.url())
        && response.request().method() === 'POST'
      ));
      const fileName = `${requiredEnv('STABLE_SMOKE_RUN_ID')}-speech.m4a`;
      const setFile = page.locator('input[type="file"][accept="audio/*"]').setInputFiles({
        name: fileName,
        mimeType: 'audio/mp4',
        buffer: speechFixture,
      });
      await uploadIntercepted;
      await expect(page.getByText(fileName, { exact: true })).toBeVisible();
      const uploadStep = page.getByTestId('transcribe-step-audio');
      await expect(uploadStep).toHaveAttribute('data-state', 'active');
      await expect(page.getByText('正在上传录音', { exact: true })).toBeVisible();
      await expect(page.getByText(/^\d+%$/).first()).toBeVisible();
      await testInfo.attach('recording-upload-stage', { body: await page.screenshot(), contentType: 'image/png' });

      releaseUpload?.();
      await setFile;
      const uploadResponse = await uploadResponsePromise;
      const uploadBody = await uploadResponse.json() as ApiEnvelope<{
        entry: { id: string; title: string };
      }>;
      expect(uploadResponse.ok(), uploadBody.error?.message || '录音上传失败').toBe(true);
      expect(uploadBody.success, uploadBody.error?.message || '录音上传失败').toBe(true);
      const uploaded = uploadBody.data;
      entryId = uploaded.entry.id;
      expect(uploaded.entry.title).toContain('speech');
      await page.unroute(`**${uploadPath}`);

      const transcribeResponse = await transcribeResponsePromise;
      const transcribeBody = await transcribeResponse.json() as ApiEnvelope<{ runId: string }>;
      expect(transcribeResponse.ok(), transcribeBody.error?.message || '启动录音转录失败').toBe(true);
      expect(transcribeBody.success, transcribeBody.error?.message || '启动录音转录失败').toBe(true);
      runId = transcribeBody.data.runId;
      const transcribeStep = page.getByTestId('transcribe-step-transcribe');
      await expect(transcribeStep).toHaveAttribute('data-state', 'active', { timeout: 30_000 });
      await testInfo.attach('recording-transcribe-stage', { body: await page.screenshot(), contentType: 'image/png' });

      await expect(page.getByText(/录音和原文已保存|查看转录笔记/).first()).toBeVisible({ timeout: 180_000 });
      await expect(uploadStep).toHaveAttribute('data-state', 'done');
      await expect(transcribeStep).toHaveAttribute('data-state', 'done');
      await expect(page.getByTestId('transcribe-step-finish')).toHaveAttribute('data-state', 'done');
      await testInfo.attach('recording-saved-stage', { body: await page.screenshot(), contentType: 'image/png' });

      const run = await readEnvelope<{
        status: string;
        transcriptText?: string;
        outputEntryId?: string;
      }>(await page.request.get(`/api/document-store/agent-runs/${runId}`, { headers: authHeaders(token) }));
      expect(run.status).toBe('done');
      expect((run.transcriptText || '').trim().length).toBeGreaterThan(10);
      expect(run.outputEntryId).toBe(entryId);
      const persisted = await readEnvelope<{ items: Array<{ id: string }> }>(
        await page.request.get(`/api/document-store/stores/${storeId}/entries`, { headers: authHeaders(token) }),
      );
      expect(persisted.items.map((item) => item.id)).toContain(entryId);
    } finally {
      if (storeId) {
        const deleted = await page.request.delete(`/api/document-store/stores/${storeId}`, {
          headers: authHeaders(token),
        });
        expect([200, 204]).toContain(deleted.status());
        expect((await page.request.get(`/api/document-store/stores/${storeId}`, { headers: authHeaders(token) })).status()).toBe(404);
        if (entryId) {
          expect((await page.request.get(`/api/document-store/entries/${entryId}`, { headers: authHeaders(token) })).status()).toBe(404);
        }
        if (runId) {
          expect((await page.request.get(`/api/document-store/agent-runs/${runId}`, { headers: authHeaders(token) })).status()).toBe(404);
        }
      }
    }
  });

  test('[REC-004][REC-005] 路由离开后从保险箱恢复同一后台录音', { tag: '@cleanup' }, async ({ page, request }) => {
    test.setTimeout(120_000);
    const token = await loginAndReadToken(page, request, '/');
    let storeId = '';
    let sessionId = '';
    let entryId = '';
    const storeName = `${requiredEnv('STABLE_SMOKE_RUN_ID')}-recording-recovery`;
    try {
      storeId = (await readEnvelope<{ id: string }>(await page.request.post('/api/document-store/stores', {
        headers: authHeaders(token),
        data: {
          name: storeName,
          description: '稳定冒烟录音后台恢复，执行后自动清理',
          isPublic: false,
        },
      }))).id;
      sessionId = (await readEnvelope<{ sessionId: string }>(await page.request.post(
        `/api/document-store/stores/${storeId}/recording-uploads`,
        {
          headers: authHeaders(token),
          data: { fileName: `${requiredEnv('STABLE_SMOKE_RUN_ID')}-恢复录音.m4a`, mimeType: 'audio/mp4' },
        },
      ))).sessionId;

      const midpoint = Math.ceil(speechFixture.length / 2);
      const chunks = [speechFixture.subarray(0, midpoint), speechFixture.subarray(midpoint)];
      for (let index = 0; index < chunks.length; index += 1) {
        const appended = await page.request.post(`/api/document-store/recording-uploads/${sessionId}/chunks/${index}`, {
          headers: { ...authHeaders(token), 'Content-Type': 'application/octet-stream' },
          data: chunks[index],
        });
        expect(appended.ok()).toBe(true);
      }

      const vaultId = `rec-recovery-${Date.now()}`;
      await page.evaluate(async ({ id, store, serverSession, audioBase64 }) => {
        await new Promise<void>((resolveSeed, rejectSeed) => {
          const open = indexedDB.open('map-recording-vault', 1);
          open.onupgradeneeded = () => {
            const db = open.result;
            if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('chunks')) {
              const chunkStore = db.createObjectStore('chunks', { autoIncrement: true });
              chunkStore.createIndex('sessionId', 'sessionId', { unique: false });
            }
          };
          open.onerror = () => rejectSeed(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const transaction = db.transaction(['meta', 'chunks'], 'readwrite');
            transaction.objectStore('meta').put({
              id,
              mime: 'audio/mp4',
              startedAt: Date.now(),
              storeId: store,
              serverUploadSessionId: serverSession,
            });
            const binary = atob(audioBase64);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
            transaction.objectStore('chunks').add({
              sessionId: id,
              blob: new Blob([bytes], { type: 'audio/mp4' }),
            });
            transaction.oncomplete = () => { db.close(); resolveSeed(); };
            transaction.onerror = () => { db.close(); rejectSeed(transaction.error); };
            transaction.onabort = () => { db.close(); rejectSeed(transaction.error); };
          };
        });
      }, {
        id: vaultId,
        store: storeId,
        serverSession: sessionId,
        audioBase64: speechFixture.toString('base64'),
      });

      await page.goto('/document-store', { waitUntil: 'domcontentloaded' });
      const storeCardHeading = page.getByRole('heading', { name: storeName, exact: true });
      await expect(storeCardHeading).toBeVisible({ timeout: 30_000 });
      const spotlightDismissPanel = page.locator('[aria-label="关闭高亮引导"]:visible').first();
      if (await spotlightDismissPanel.isVisible().catch(() => false)) {
        await spotlightDismissPanel.click({ position: { x: 2, y: 2 } });
        await expect(page.locator('[aria-label="关闭高亮引导"]')).toHaveCount(0);
      }
      const recoveredResponsePromise = page.waitForResponse((response) => (
        new URL(response.url()).pathname === `/api/document-store/recording-uploads/${sessionId}/complete`
        && response.request().method() === 'POST'
      ), { timeout: 60_000 });
      await storeCardHeading.click();
      await expect(page).toHaveURL(new RegExp(`\\?store=${storeId}(?:&|$)`));
      const recoveredResponse = await recoveredResponsePromise;
      const recoveredBody = await recoveredResponse.json() as ApiEnvelope<{
        entry: { id: string; storeId: string };
        reused?: boolean;
      }>;
      expect(recoveredResponse.ok(), recoveredBody.error?.message || '后台录音恢复失败').toBe(true);
      expect(recoveredBody.success, recoveredBody.error?.message || '后台录音恢复失败').toBe(true);
      entryId = recoveredBody.data.entry.id;
      expect(recoveredBody.data.entry.storeId).toBe(storeId);
      await expect(page.getByText('后台录音已完成', { exact: true })).toBeVisible({ timeout: 30_000 });

      const entries = await readEnvelope<{ items: Array<{ id: string }> }>(
        await page.request.get(`/api/document-store/stores/${storeId}/entries`, { headers: authHeaders(token) }),
      );
      expect(entries.items.filter((item) => item.id === entryId)).toHaveLength(1);
      const vaultMetaCount = await page.evaluate(async () => new Promise<number>((resolveCount) => {
        const open = indexedDB.open('map-recording-vault', 1);
        open.onerror = () => resolveCount(-1);
        open.onsuccess = () => {
          const db = open.result;
          const requestCount = db.transaction('meta', 'readonly').objectStore('meta').count();
          requestCount.onsuccess = () => { db.close(); resolveCount(requestCount.result); };
          requestCount.onerror = () => { db.close(); resolveCount(-1); };
        };
      }));
      expect(vaultMetaCount).toBe(0);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByText('发现未完成的录音', { exact: true })).toHaveCount(0);
      const repeated = await readEnvelope<{
        entry: { id: string };
        reused: boolean;
      }>(await page.request.post(`/api/document-store/recording-uploads/${sessionId}/complete`, {
        headers: authHeaders(token),
      }));
      expect(repeated.entry.id).toBe(entryId);
      expect(repeated.reused).toBe(true);
    } finally {
      if (sessionId) {
        await page.request.delete(`/api/document-store/recording-uploads/${sessionId}`, {
          headers: authHeaders(token),
        }).catch(() => undefined);
      }
      if (storeId) {
        const deleted = await page.request.delete(`/api/document-store/stores/${storeId}`, {
          headers: authHeaders(token),
        });
        expect([200, 204]).toContain(deleted.status());
        if (entryId) {
          expect((await page.request.get(`/api/document-store/entries/${entryId}`, { headers: authHeaders(token) })).status()).toBe(404);
        }
      }
    }
  });

  test('[REC-010] 录音分片重复完成幂等且无重复条目', { tag: '@cleanup' }, async ({ page, request }) => {
    test.setTimeout(120_000);
    const token = await loginAndReadToken(page, request, '/document-store');
    let storeId = '';
    let sessionId = '';
    try {
      const createStore = await page.request.post('/api/document-store/stores', {
        headers: authHeaders(token),
        data: {
          name: `${requiredEnv('STABLE_SMOKE_RUN_ID')}-recording`,
          description: '稳定冒烟录音保险箱，执行后自动清理',
          isPublic: false,
        },
      });
      storeId = (await readEnvelope<{ id: string }>(createStore)).id;
      const started = await page.request.post(`/api/document-store/stores/${storeId}/recording-uploads`, {
        headers: authHeaders(token),
        data: { fileName: `${requiredEnv('STABLE_SMOKE_RUN_ID')}.m4a`, mimeType: 'audio/mp4' },
      });
      sessionId = (await readEnvelope<{ sessionId: string }>(started)).sessionId;

      const midpoint = Math.ceil(speechFixture.length / 2);
      const chunks = [speechFixture.subarray(0, midpoint), speechFixture.subarray(midpoint)];
      for (let index = 0; index < chunks.length; index += 1) {
        const appended = await page.request.post(`/api/document-store/recording-uploads/${sessionId}/chunks/${index}`, {
          headers: { ...authHeaders(token), 'Content-Type': 'application/octet-stream' },
          data: chunks[index],
        });
        const data = await readEnvelope<{ nextChunkIndex: number; uploadedBytes: number }>(appended);
        expect(data.nextChunkIndex).toBe(index + 1);
        expect(data.uploadedBytes).toBeGreaterThan(0);

        const restored = await page.request.get(`/api/document-store/recording-uploads/${sessionId}`, {
          headers: authHeaders(token),
        });
        expect((await readEnvelope<{ nextChunkIndex: number }>(restored)).nextChunkIndex).toBe(index + 1);
      }

      const duplicate = await page.request.post(`/api/document-store/recording-uploads/${sessionId}/chunks/0`, {
        headers: { ...authHeaders(token), 'Content-Type': 'application/octet-stream' },
        data: chunks[0],
      });
      expect((await readEnvelope<{ duplicate: boolean }>(duplicate)).duplicate).toBe(true);

      const firstComplete = await page.request.post(`/api/document-store/recording-uploads/${sessionId}/complete`, {
        headers: authHeaders(token),
      });
      const first = await readEnvelope<{ entry: { id: string }; sessionId: string }>(firstComplete);
      const secondComplete = await page.request.post(`/api/document-store/recording-uploads/${sessionId}/complete`, {
        headers: authHeaders(token),
      });
      const second = await readEnvelope<{ entry: { id: string }; reused: boolean }>(secondComplete);
      expect(second.entry.id).toBe(first.entry.id);
      expect(second.reused).toBe(true);
    } finally {
      if (sessionId) {
        await page.request.delete(`/api/document-store/recording-uploads/${sessionId}`, {
          headers: authHeaders(token),
        }).catch(() => undefined);
      }
      if (storeId) {
        const deleted = await page.request.delete(`/api/document-store/stores/${storeId}`, {
          headers: authHeaders(token),
        });
        expect([200, 204]).toContain(deleted.status());
      }
    }
  });

  test('[REC-001][REC-002] 现场录音自动开始且暂停继续保留前后音频', { tag: '@cleanup' }, async ({ page, request, context }) => {
    test.setTimeout(120_000);
    await context.grantPermissions(['microphone']);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      class DeterministicMediaRecorder extends EventTarget {
        static isTypeSupported() { return false; }

        readonly stream: MediaStream;
        readonly mimeType = 'audio/wav';
        readonly audioBitsPerSecond = 128_000;
        readonly videoBitsPerSecond = 0;
        state: RecordingState = 'inactive';
        ondataavailable: ((event: BlobEvent) => void) | null = null;
        onstop: ((event: Event) => void) | null = null;
        onstart: ((event: Event) => void) | null = null;
        onpause: ((event: Event) => void) | null = null;
        onresume: ((event: Event) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        private pausedOnce = false;
        private resumedOnce = false;

        constructor(stream: MediaStream) {
          super();
          this.stream = stream;
        }

        start() {
          this.state = 'recording';
          this.onstart?.(new Event('start'));
        }

        pause() {
          this.pausedOnce = true;
          this.state = 'paused';
          this.onpause?.(new Event('pause'));
        }

        resume() {
          this.resumedOnce = true;
          this.state = 'recording';
          this.onresume?.(new Event('resume'));
        }

        requestData() {}

        stop() {
          if (this.state === 'inactive') return;
          this.state = 'inactive';
          const sampleRate = 8_000;
          const segmentSamples = 3_200;
          const frequencies = this.pausedOnce && this.resumedOnce ? [440, 880] : [440];
          const sampleCount = segmentSamples * frequencies.length;
          const wav = new ArrayBuffer(44 + sampleCount * 2);
          const view = new DataView(wav);
          const writeAscii = (offset: number, value: string) => {
            for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
          };
          writeAscii(0, 'RIFF');
          view.setUint32(4, 36 + sampleCount * 2, true);
          writeAscii(8, 'WAVE');
          writeAscii(12, 'fmt ');
          view.setUint32(16, 16, true);
          view.setUint16(20, 1, true);
          view.setUint16(22, 1, true);
          view.setUint32(24, sampleRate, true);
          view.setUint32(28, sampleRate * 2, true);
          view.setUint16(32, 2, true);
          view.setUint16(34, 16, true);
          writeAscii(36, 'data');
          view.setUint32(40, sampleCount * 2, true);
          frequencies.forEach((frequency, segmentIndex) => {
            for (let index = 0; index < segmentSamples; index += 1) {
              const sample = Math.round(12_000 * Math.sin(2 * Math.PI * frequency * index / sampleRate));
              view.setInt16(44 + (segmentIndex * segmentSamples + index) * 2, sample, true);
            }
          });
          const blob = new Blob([wav], { type: 'audio/wav' });
          queueMicrotask(() => {
            this.ondataavailable?.({ data: blob } as BlobEvent);
            this.onstop?.(new Event('stop'));
          });
        }
      }
      Object.defineProperty(window, 'MediaRecorder', {
        configurable: true,
        value: DeterministicMediaRecorder,
      });
      const analyser = window.AnalyserNode?.prototype;
      if (analyser) {
        analyser.getByteTimeDomainData = function getAudibleTimeDomainData(target: Uint8Array) {
          for (let index = 0; index < target.length; index += 1) target[index] = index % 2 === 0 ? 96 : 160;
        };
      }
    });

    const token = await loginAndReadToken(page, request, '/document-store');
    const storeTitle = `${requiredEnv('STABLE_SMOKE_RUN_ID')}-pause-resume`;
    const capturedChunks: Buffer[] = [];
    let storeId = '';
    let sessionId = '';
    let entryId = '';
    let runId = '';
    try {
      const store = await readEnvelope<{ id: string }>(await page.request.post('/api/document-store/stores', {
        headers: authHeaders(token),
        data: { name: storeTitle, description: '稳定冒烟暂停继续音频边界，执行后自动清理', isPublic: false },
      }));
      storeId = store.id;
      await page.route('**/api/document-store/recording-uploads/*/chunks/*', async (route) => {
        const body = route.request().postDataBuffer();
        if (body) capturedChunks.push(Buffer.from(body));
        await route.continue();
      });
      await page.goto(`/document-store?store=${encodeURIComponent(storeId)}&quickRecord=1`, { waitUntil: 'domcontentloaded' });
      await dismissCdsPreviewWidget(page);
      const recordingState = page.getByTestId('recording-state');
      await expect(recordingState, '进入快捷录音后必须自动开始').toHaveAttribute('data-state', 'recording', { timeout: 20_000 });
      const destination = page.locator('select:visible').filter({
        has: page.locator(`option[value="${storeId}"]`),
      }).first();
      await expect(destination).toBeVisible();
      if (await destination.inputValue() !== storeId) await destination.selectOption(storeId);
      await expect(destination).toHaveValue(storeId);
      const timer = page.getByTestId('recording-elapsed');
      await expect(timer).toBeVisible();
      await expect(timer).toHaveText(/^\d{2}:\d{2}$/);
      await expect.poll(() => timer.textContent(), { timeout: 5_000 }).not.toBe('00:00');

      await page.getByRole('button', { name: '暂停录音' }).click();
      await expect(recordingState).toHaveAttribute('data-state', 'paused');
      const pausedAt = await timer.textContent();
      await page.waitForTimeout(1_200);
      expect(await timer.textContent(), '暂停期间计时不得继续增长').toBe(pausedAt);

      await page.getByRole('button', { name: '继续录音' }).click();
      await expect(recordingState).toHaveAttribute('data-state', 'recording');
      await expect.poll(() => timer.textContent(), { timeout: 5_000 }).not.toBe(pausedAt);

      const completionPromise = page.waitForResponse((response) => (
        /\/api\/document-store\/recording-uploads\/[^/]+\/complete$/.test(new URL(response.url()).pathname)
        && response.request().method() === 'POST'
      ), { timeout: 60_000 });
      await page.getByRole('button', { name: '结束录音并转成文字' }).click();
      const completionResponse = await completionPromise;
      const completionBody = await completionResponse.json() as ApiEnvelope<{
        entry: { id: string; storeId: string };
        sessionId: string;
        deferredTranscriptionRunId?: string | null;
      }>;
      expect(completionResponse.ok(), completionBody.error?.message || '现场录音保存失败').toBe(true);
      expect(completionBody.success, completionBody.error?.message || '现场录音保存失败').toBe(true);
      entryId = completionBody.data.entry.id;
      expect(completionBody.data.entry.storeId).toBe(storeId);
      sessionId = completionBody.data.sessionId;
      runId = completionBody.data.deferredTranscriptionRunId || '';
      expect(capturedChunks.length, '暂停继续录音必须上传至少一个媒体分片').toBeGreaterThan(0);
      const tones = inspectDeterministicPauseResumeWav(Buffer.concat(capturedChunks));
      expect(tones.beforePauseHz).toBeGreaterThan(420);
      expect(tones.beforePauseHz).toBeLessThan(460);
      expect(tones.afterResumeHz).toBeGreaterThan(850);
      expect(tones.afterResumeHz).toBeLessThan(910);
      const persisted = await page.request.get(`/api/document-store/entries/${entryId}`, { headers: authHeaders(token) });
      expect(persisted.ok(), '暂停前后音频上传后必须形成可回读条目').toBe(true);
    } finally {
      if (sessionId) {
        await page.request.delete(`/api/document-store/recording-uploads/${sessionId}`, {
          headers: authHeaders(token),
        }).catch(() => undefined);
      }
      if (storeId) {
        const deleted = await page.request.delete(`/api/document-store/stores/${storeId}`, {
          headers: authHeaders(token),
        });
        expect([200, 204]).toContain(deleted.status());
        expect((await page.request.get(`/api/document-store/stores/${storeId}`, { headers: authHeaders(token) })).status()).toBe(404);
        if (entryId) {
          expect((await page.request.get(`/api/document-store/entries/${entryId}`, { headers: authHeaders(token) })).status()).toBe(404);
        }
        if (runId) {
          expect((await page.request.get(`/api/document-store/agent-runs/${runId}`, { headers: authHeaders(token) })).status()).toBe(404);
        }
      }
    }
  });

  test('[REC-006] CDS 静音录音在上传前给出明确恢复动作', async ({ page, request, context }) => {
    test.skip(requiredEnv('STABLE_SMOKE_ENVIRONMENT') === 'production', '正式环境策略禁止主动运行静音录音');
    test.setTimeout(90_000);
    await context.grantPermissions(['microphone']);
    await page.addInitScript(() => {
      const analyser = window.AnalyserNode?.prototype;
      if (!analyser) return;
      analyser.getByteTimeDomainData = function getSilentTimeDomainData(target: Uint8Array) {
        target.fill(128);
      };
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await openQuickRecord(page, request);

    await expect(page.getByTestId('recording-state')).toHaveAttribute('data-state', 'recording', { timeout: 20_000 });
    await page.waitForTimeout(1_500);
    await page.getByRole('button', { name: '结束录音并转成文字' }).click();
    await expect(page.getByText('整段录音几乎没有检测到声音，转录很可能失败。请确认麦克风没有静音。')).toBeVisible();
    await page.getByRole('button', { name: '放弃本次录音' }).click();
    await expect(page.getByTestId('recording-state'), '放弃后录音面板必须关闭').toBeHidden();
  });

  test('[REC-008] 浏览器不支持录音时直接提供上传音频兜底', async ({ page, request }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: undefined });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await openQuickRecord(page, request);
    await expect(page.getByText('当前浏览器不支持录音', { exact: true })).toBeVisible({ timeout: 20_000 });
    const uploadFallback = page.getByTestId('recording-unavailable-upload');
    await expect(uploadFallback, '不支持录音时必须给上传音频兜底').toBeVisible();
    await expect(uploadFallback).toHaveText(/上传/);
    await page.getByRole('button', { name: '取消录音' }).click();
    await expect(uploadFallback, '取消后录音面板必须关闭').toBeHidden();
  });

  test('[VIS-001][REG-visual-policy-001] 单图模型目录有唯一业务默认且不暴露池', async ({ page, request }) => {
    const token = await loginAndReadToken(page, request, '/visual-agent');
    const response = await page.request.get('/api/visual-agent/image-gen/models', { headers: authHeaders(token) });
    const pools = await readEnvelope<ImageModelPool[]>(response);
    expect(pools.length).toBeGreaterThan(0);
    const defaults = pools.filter((model) => model.isDefault);
    expect(defaults, '视觉创作必须由 MAP 明确配置唯一默认模型').toHaveLength(1);
    expect(defaults[0].models.length, '默认模型不可用属于巡检失败，不能改测其它型号').toBeGreaterThan(0);
    for (const pool of pools) {
      expect(pool.resolutionType).toBe('LogicalModel');
      expect(pool.id).toBeTruthy();
      expect(pool.code).toBeTruthy();
      // 非默认模型停用时仍保留其业务身份供界面禁用展示，不因此自动换型号。
      if (pool.isDefault) {
        expect(pool.models.some((model) => !/unhealthy|disabled/i.test(model.healthStatus || ''))).toBe(true);
      }
    }
  });

  test('[GW-001][GW-002][GW-003][GW-004][REG-llmgw-auth-001][REG-auth-synthetic-001][REG-asr-routing-001] 网关配置与路由可由专用身份审计', async ({ request }) => {
    const { baseUrl, headers } = await loginGateway(request);

    const [context, models, logicalModels, health, authority, logs, poolTypes, asrPools, authFailureHealth] = await Promise.all([
      request.get(`${baseUrl}/gw/auth/context`, { headers }),
      request.get(`${baseUrl}/gw/models?enabled=true`, { headers }),
      request.get(`${baseUrl}/gw/logical-models?enabled=true`, { headers }),
      request.get(`${baseUrl}/gw/key-health`, { headers }),
      request.get(`${baseUrl}/gw/config-authority/report`, { headers }),
      request.get(`${baseUrl}/gw/logs?limit=20`, { headers }),
      request.get(`${baseUrl}/gw/pool-types`, { headers }),
      request.get(`${baseUrl}/gw/pools?modelType=asr&sinceHours=168`, { headers }),
      request.get(`${baseUrl}/gw/auth/failure-health?windowMinutes=10&threshold=3`, { headers }),
    ]);
    for (const response of [context, models, logicalModels, health, authority, logs, poolTypes, asrPools, authFailureHealth]) {
      expect(response.ok(), `网关审计接口 ${response.url()} 不可用`).toBe(true);
    }

    const authFailureBody = await authFailureHealth.json() as ApiEnvelope<{
      status: 'healthy' | 'recovered' | 'warning';
      incidents: Array<{ scope: 'identity' | 'platform'; attempts: number; affectedIdentities: number }>;
      recoveries: Array<{ attempts: number; identityFingerprint: string }>;
      recovery: { browserSession: string; machineIdentity: string; circuitBreaker: string };
    }>;
    expect(authFailureBody.success).toBe(true);
    expect(authFailureBody.data.recovery.browserSession).toBe('single-refresh-single-retry');
    expect(authFailureBody.data.recovery.machineIdentity).toBe('one-time-ticket-auto-provision');
    expect(authFailureBody.data.recovery.circuitBreaker).toBe('manual-disable-role-drift-repeated-failure');
    for (const incident of authFailureBody.data.incidents) {
      expect(incident.attempts).toBeGreaterThanOrEqual(3);
      expect(incident.affectedIdentities).toBeGreaterThanOrEqual(1);
    }
    for (const recovery of authFailureBody.data.recoveries) {
      expect(recovery.attempts).toBeGreaterThanOrEqual(1);
      expect(recovery.identityFingerprint).toMatch(/^[a-f0-9]{12}$/);
    }

    const modelsBody = await models.text();
    const logicalBody = await logicalModels.text();
    expect(modelsBody).not.toMatch(/(?:apiKey|password)"\s*:\s*"(?!\*{3,}|\[masked\]|null|undefined)/i);
    expect(logicalBody).not.toMatch(/(?:apiKey|password)"\s*:\s*"(?!\*{3,}|\[masked\]|null|undefined)/i);
    const logicalJson = JSON.parse(logicalBody) as ApiEnvelope<{ items: Array<{
      publicId?: string;
      modelType?: string;
      enabled?: boolean;
      offerings?: Array<{ protocol?: string; endpointPath?: string; priority?: number; weight?: number }>;
    }> }>;
    expect(logicalJson.success).toBe(true);
    expect(logicalJson.data.items.length).toBeGreaterThan(0);
    for (const logical of logicalJson.data.items) {
      expect(logical.publicId).toBeTruthy();
      expect(logical.modelType).toBeTruthy();
      expect(logical.enabled).toBe(true);
      for (const offering of logical.offerings || []) {
        expect(offering.protocol || '').not.toMatch(/^https?:/i);
        expect(offering.endpointPath || '').not.toMatch(/^https?:|\\/);
        expect(offering.priority ?? 0).toBeGreaterThanOrEqual(0);
        expect(offering.weight ?? 1).toBeGreaterThan(0);
      }
    }

    const poolTypesJson = await poolTypes.json() as ApiEnvelope<{ items: Array<{
      code: string;
      defaultPoolId: string;
      modelCount: number;
      ready: boolean;
    }> }>;
    const asrType = poolTypesJson.data.items.find((item) => item.code === 'asr');
    expect(asrType, '网关必须注册 ASR 类型和默认池').toBeTruthy();
    expect(asrType?.ready, 'ASR 默认池必须处于就绪状态').toBe(true);
    expect(asrType?.modelCount, 'ASR 默认池必须至少有主备两个成员').toBeGreaterThanOrEqual(2);

    const asrPoolsJson = await asrPools.json() as ApiEnvelope<{ items: Array<{
      id: string;
      isDefaultForType: boolean;
      health: string;
      healthyMembers: number;
      models: Array<{ modelId: string; platformId: string; priority: number; healthStatus: number }>;
    }> }>;
    const defaultAsrPool = asrPoolsJson.data.items.find((pool) => pool.id === asrType?.defaultPoolId);
    expect(defaultAsrPool, 'ASR 类型指针必须命中可读取的默认池').toBeTruthy();
    expect(defaultAsrPool?.isDefaultForType).toBe(true);
    expect(defaultAsrPool?.health).not.toBe('unavailable');
    expect(defaultAsrPool?.healthyMembers || 0).toBeGreaterThan(0);
    expect(defaultAsrPool?.models.length || 0).toBeGreaterThanOrEqual(2);
    expect(new Set((defaultAsrPool?.models || []).map((model) => model.modelId)).size).toBeGreaterThanOrEqual(2);
    for (const model of defaultAsrPool?.models || []) {
      expect(model.modelId).toBeTruthy();
      expect(model.platformId).toBeTruthy();
      expect(model.priority).toBeGreaterThan(0);
    }
  });

  test('[GW-006] 路由配置变化后健康状态清零且原配置可恢复', async ({ request }) => {
    test.skip(requiredEnv('STABLE_SMOKE_ENVIRONMENT') === 'production', '正式环境策略禁止主动修改网关路由配置');
    const { baseUrl, headers } = await loginGateway(request);
    const logicalResponse = await request.get(`${baseUrl}/gw/logical-models?enabled=true`, { headers });
    const logicalBody = await logicalResponse.json() as ApiEnvelope<{ items: Array<{
      id: string;
      offerings: Array<{
        id: string;
        endpointPath?: string;
        enabled: boolean;
      }>;
    }> }>;
    expect(logicalResponse.ok(), logicalBody.error?.message || '无法读取网关路由配置').toBe(true);
    const logical = logicalBody.data.items.find((item) => item.offerings.some((offering) => offering.enabled));
    const offering = logical?.offerings.find((item) => item.enabled);
    expect(logical && offering, 'CDS 网关需要至少一条可恢复的启用 Offering').toBeTruthy();

    const originalEndpoint = offering?.endpointPath || '';
    const probeEndpoint = originalEndpoint === 'stable-smoke-health-reset-probe'
      ? 'stable-smoke-health-reset-probe-alt'
      : 'stable-smoke-health-reset-probe';
    let currentOfferingId = offering!.id;
    let changed = false;
    try {
      const update = await request.put(`${baseUrl}/gw/logical-models/${logical!.id}/offerings/${currentOfferingId}`, {
        headers,
        data: { endpointPath: probeEndpoint },
      });
      const updateBody = await update.json() as ApiEnvelope<{
        id: string;
        endpointPath?: string;
        healthStatus: number;
        consecutiveFailures: number;
        consecutiveSuccesses: number;
      }>;
      expect(update.ok(), updateBody.error?.message || '无法验证路由变化后的健康状态清零').toBe(true);
      expect(updateBody.data.endpointPath).toBe(probeEndpoint);
      expect(updateBody.data.healthStatus).toBe(0);
      expect(updateBody.data.consecutiveFailures).toBe(0);
      expect(updateBody.data.consecutiveSuccesses).toBe(0);
      currentOfferingId = updateBody.data.id;
      changed = true;
    } finally {
      if (changed) {
        const restore = await request.put(`${baseUrl}/gw/logical-models/${logical!.id}/offerings/${currentOfferingId}`, {
          headers,
          data: { endpointPath: originalEndpoint },
        });
        const restoreBody = await restore.json() as ApiEnvelope<{ endpointPath?: string; healthStatus: number }>;
        expect(restore.ok(), restoreBody.error?.message || '网关路由配置恢复失败，需要立即人工处理').toBe(true);
        expect(restoreBody.data.endpointPath || '').toBe(originalEndpoint);
        expect(restoreBody.data.healthStatus).toBe(0);
      }
    }
  });

  test('[CORE-006][GW-007][REG-gateway-failover-fixture-001] CDS 主路故障切换、全路故障提示与 requestId 日志可追踪', { tag: '@cleanup' }, async ({ page, request }, testInfo) => {
    test.skip(requiredEnv('STABLE_SMOKE_ENVIRONMENT') === 'production', '正式环境不主动注入网关故障，只在发布门禁观察自然切换');
    test.setTimeout(360_000);
    const token = await loginAndReadToken(page, request, '/visual-agent');
    const gateway = await loginGateway(request);
    const logicalResponse = await request.get(`${gateway.baseUrl}/gw/logical-models?enabled=true`, {
      headers: gateway.headers,
    });
    const logicalBody = await logicalResponse.json() as ApiEnvelope<{ items: GatewayLogicalModel[] }>;
    expect(logicalResponse.ok(), logicalBody.error?.message || '无法读取网关逻辑模型').toBe(true);
    // 带标记备用在一轮 GW-007 之外只能是停用：不论挂在哪个逻辑模型上（包括本轮不会选中的），
    // 启用着的一律先停掉，否则上一轮夭折留下的备用会一直参与 CDS 真实流量的路由。
    // 隔离排在自愈之前：自愈要发多次网关请求，任何一次失败（selfheal10 就遇到过共享 Mongo 断连）
    // 都不能让带着注入态的备用继续在线。
    const straySummary = await disableStrayGatewayBackups(request, gateway, logicalBody.data.items);
    if (straySummary.length > 0) {
      testInfo.annotations.push({ type: 'gateway-fixture-stray-backup', description: straySummary.join('; ') });
      console.warn(`[GW-007] 发现上一轮遗留的已启用备用并已停用：${straySummary.join('; ')}`);
    }
    // 上一轮硬中断遗留的注入态自愈，再做任何判定（issue #1536）；发现了就写进报告，不静默。
    const leftovers = await recoverInjectedGatewayOfferings(request, gateway, logicalBody.data.items);
    if (leftovers.length > 0) {
      const summary = describeGatewayRecovery(leftovers);
      testInfo.annotations.push({ type: 'gateway-fixture-recovery', description: summary });
      console.warn(`[GW-007] 发现上一轮遗留的网关注入态：${summary}`);
    }
    expect(
      leftovers.filter((item) => item.source === 'unrecoverable'),
      '上一轮遗留的注入态既没有自带原值、也找不到相同路由契约的捐出方，不能猜着写：请人工恢复这些 Offering 的 Endpoint 后再跑',
    ).toEqual([]);
    const upstreamIndex = await readGatewayUpstreamIndex(request, gateway);
    const { upstreamIds, upstreamById } = upstreamIndex;

    const pools = await readEnvelope<ImageModelPool[]>(
      await page.request.get('/api/visual-agent/image-gen/models/text2img', { headers: authHeaders(token) }),
    );
    const availableCodes = new Set(
      pools
        .filter((pool) => pool.models.some((model) => !/unhealthy|disabled/i.test(model.healthStatus || '')))
        .map((pool) => pool.code),
    );
    const liveUpstream = (offering: GatewayOffering) => isLiveGatewayUpstream(offering, upstreamIndex);
    const isFailoverBackup = isGatewayFailoverBackup;
    const distinctUpstreams = (item: GatewayLogicalModel) => new Set(item.offerings.filter(liveUpstream).map((offering) => offering.targetId));
    const describeLogical = (item: GatewayLogicalModel) => (
      `${item.publicId}[${item.offerings.filter(liveUpstream).map((offering) => upstreamById.get(offering.targetId)?.name || offering.targetId).join(' / ') || '无可用上游'}]`
    );
    const candidates = logicalBody.data.items
      .filter((item) => item.enabled && availableCodes.has(item.publicId))
      .sort((left, right) => (
        Number(Boolean(pools.find((pool) => pool.code === right.publicId)?.isDefault))
        - Number(Boolean(pools.find((pool) => pool.code === left.publicId)?.isDefault))
      ));
    expect(candidates.length, 'CDS 没有任何业务开放且可用的文生图逻辑模型，无法执行故障切换验收').toBeGreaterThan(0);

    // 双上游判据。矩阵要求「主路故障后备用上游成功」，但 CDS 的业务逻辑模型（image1 / image2）各自只挂一个真实上游，
    // 2026-09-14 那一轮因此直接判「没有两个可用上游」而未执行。没有第二个上游就没有故障切换可验，
    // 所以这里给业务默认逻辑模型临时挂一个同类型逻辑模型已经在用的真实上游作为备用（priority 更低，
    // 正常流量不会走到它），验完即停用。控制台没有删除 Offering 的接口，只能启停：停用后的记录带固定 Notes 标记，
    // 下一轮复用同一条，不会越积越多；上一轮若中途夭折留下已启用的标记记录，本轮也认领并在结束时停用。
    // 备用上游照抄「捐出」它的那条 Offering 的路由契约（协议 / Endpoint / 上游模型名），不能拿主路的协议去配别人的上游。
    let logical: GatewayLogicalModel | undefined;
    let provisionedBackup: GatewayOffering | undefined;
    let offerings: GatewayOffering[] = [];
    const originals = new Map<GatewayOffering, { endpointPath: string; priority: number }>();
    let originalStrategy = '';
    let workspaceId = '';
    const runIds: string[] = [];

    const toggleOffering = async (logicalId: string, offeringId: string, enabled: boolean) => {
      const response = await request.put(`${gateway.baseUrl}/gw/logical-models/${logicalId}/offerings/${offeringId}/enabled`, {
        headers: gateway.headers,
        data: { enabled },
      });
      const body = await response.json() as ApiEnvelope<GatewayOffering>;
      expect(response.ok(), body.error?.message || `备用 Offering ${offeringId} ${enabled ? '启用' : '停用'}失败`).toBe(true);
      expect(body.data.enabled).toBe(enabled);
      return body.data;
    };
    const updateOffering = async (offering: GatewayOffering, endpointPath: string, priority = offering.priority) => {
      const response = await request.put(
        `${gateway.baseUrl}/gw/logical-models/${logical!.id}/offerings/${offering.id}`,
        { headers: gateway.headers, data: { endpointPath, priority } },
      );
      const body = await response.json() as ApiEnvelope<GatewayOffering>;
      expect(response.ok(), body.error?.message || `Offering ${offering.id} 更新失败`).toBe(true);
      expect(body.success, body.error?.message || `Offering ${offering.id} 更新失败`).toBe(true);
      expect(body.data.endpointPath || '').toBe(endpointPath);
      expect(body.data.priority).toBe(priority);
      Object.assign(offering, body.data);
    };
    const updateStrategy = async (routingStrategy: string) => {
      const response = await request.put(`${gateway.baseUrl}/gw/logical-models/${logical!.id}`, {
        headers: gateway.headers,
        data: { routingStrategy },
      });
      const body = await response.json() as ApiEnvelope<GatewayLogicalModel>;
      expect(response.ok(), body.error?.message || '逻辑模型路由策略更新失败').toBe(true);
      expect(body.data.routingStrategy).toBe(routingStrategy);
    };
    const createProbeRun = async (suffix: string) => {
      const response = await page.request.post('/api/visual-agent/image-gen/runs', {
        headers: {
          ...authHeaders(token),
          'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspaceId}-${suffix}`,
        },
        data: {
          platformId: 'logical-model',
          modelId: logical!.publicId,
          responseFormat: 'url',
          maxConcurrency: 1,
          workspaceId,
          appKey: 'visual-agent',
          items: [{
            prompt: '一枚放在纯白背景上的蓝色圆形徽章，产品摄影，不要文字',
            count: 1,
            size: '1024x1024',
          }],
        },
      });
      const run = await readEnvelope<{ runId: string }>(response);
      runIds.push(run.runId);
      return run.runId;
    };

    // 清理作用域从启用 / 创建备用上游之前就开始：中间任何一步失败，finally 都能把备用停回去。
    try {
      logical = candidates.find((item) => distinctUpstreams(item).size >= 2);
      if (logical) {
        // 开始前已把所有启用着的带标记备用停掉，这里通常为空；留着只为防御同名标记被人手工启用的情形。
        provisionedBackup = logical.offerings.find((offering) => offering.enabled && isFailoverBackup(offering));
      } else {
        const preferred = candidates[0];
        const primary = preferred.offerings.filter(liveUpstream).sort((left, right) => left.priority - right.priority)[0];
        expect(primary, `${preferred.publicId} 没有可用的主路上游，无法补双上游夹具`).toBeTruthy();
        // 带标记的备用不论启停都复用：已启用却不健康（上一轮遗留、上游真的坏了）的也先认领，
        // 后面的双上游断言会把「备用不健康」说清楚，而不是走创建路径与既有 targetId 撞车。
        const taggedBackup = preferred.offerings.find((offering) => (
          offering.targetId !== primary!.targetId
          && upstreamIds.has(offering.targetId)
          && isFailoverBackup(offering)
        ));
        if (taggedBackup) {
          // 先登记归属再等待启用：网关启用成功但响应丢失 / 断言失败时，finally 照样能停掉它。
          provisionedBackup = taggedBackup;
          if (!taggedBackup.enabled) provisionedBackup = await toggleOffering(preferred.id, taggedBackup.id, true);
        } else {
          provisionedBackup = await provisionTaggedFailoverBackup(request, gateway, logicalBody.data.items, upstreamIndex, preferred, primary!);
          expect(
            provisionedBackup,
            `无法为 ${preferred.publicId} 补第二个真实上游：同类型逻辑模型没有其它可用上游。`
            + `候选：${candidates.map(describeLogical).join('、')}`,
          ).toBeTruthy();
        }
        preferred.offerings = [
          ...preferred.offerings.filter((offering) => offering.id !== provisionedBackup!.id),
          provisionedBackup!,
        ];
        logical = preferred;
      }
      expect(
        distinctUpstreams(logical!).size,
        `故障切换需要两个不同的真实上游，当前：${describeLogical(logical!)}`,
      ).toBeGreaterThanOrEqual(2);
      offerings = logical!.offerings
        .filter(liveUpstream)
        .sort((left, right) => left.priority - right.priority);
      for (const offering of offerings) {
        originals.set(offering, { endpointPath: offering.endpointPath || '', priority: offering.priority });
      }
      originalStrategy = logical!.routingStrategy;
      workspaceId = (await createVisualWorkspace(page, token, 'gateway-failover')).workspace.id;

      await updateStrategy('priority');
      for (const [index, offering] of offerings.entries()) {
        await updateOffering(offering, originals.get(offering)!.endpointPath, (index + 1) * 10);
        offering.priority = (index + 1) * 10;
      }
      await updateOffering(offerings[0], buildGatewayInjectedEndpoint('primary', originals.get(offerings[0])!.endpointPath), offerings[0].priority);
      const failoverRunId = await createProbeRun('primary-failure');
      const failoverResult = await waitForImageRun(page, token, failoverRunId, 240_000);
      expect(failoverResult.detail.run.status).toBe('Completed');
      await assertImageArtifact(page, failoverResult.detail);
      const failoverLog = await waitForGatewayLog(request, `${failoverRunId}-0-0`);
      expect(failoverLog.logicalModelPublicId).toBe(logical!.publicId);
      expect(failoverLog.providerAttempts.length).toBeGreaterThanOrEqual(2);
      expect(failoverLog.providerAttempts[0].status).toBe('failed');
      expect(failoverLog.providerAttempts.at(-1)?.status).toBe('succeeded');
      expect(
        `${failoverLog.providerAttempts[0].provider}:${failoverLog.providerAttempts[0].model}`,
      ).not.toBe(
        `${failoverLog.providerAttempts.at(-1)?.provider}:${failoverLog.providerAttempts.at(-1)?.model}`,
      );

      await updateOffering(offerings[0], originals.get(offerings[0])!.endpointPath, offerings[0].priority);
      for (const [index, offering] of offerings.entries()) {
        await updateOffering(offering, buildGatewayInjectedEndpoint('all', originals.get(offering)!.endpointPath, index), offering.priority);
      }
      const failedRunId = await createProbeRun('all-failure');
      const failedResult = await waitForImageRun(page, token, failedRunId, 240_000);
      expect(failedResult.detail.run.status).toBe('Failed');
      expect(failedResult.detail.run.failed).toBe(1);
      expect(failedResult.detail.items).toHaveLength(1);
      const userMessage = failedResult.detail.items[0].errorMessage || '';
      expectUserReadable(userMessage);
      expect(userMessage).not.toMatch(/HTTP|token|provider|endpoint|stack|openrouter/i);

      const failedRequestId = `${failedRunId}-0-0`;
      const failedLog = await waitForGatewayLog(request, failedRequestId);
      expect(failedLog.requestId).toBe(failedRequestId);
      expect(failedLog.status).toBe('failed');
      expect(failedLog.providerAttempts.length).toBeGreaterThanOrEqual(2);
      expect(failedLog.providerAttempts.every((attempt) => attempt.status === 'failed')).toBe(true);
      expect(failedLog.logicalModelPublicId).toBe(logical!.publicId);
      expect(failedLog.routerTrace.logicalModelPublicId).toBe(logical!.publicId);
    } finally {
      const restoreResults = await Promise.allSettled(offerings.map((offering) => (
        updateOffering(
          offering,
          originals.get(offering)!.endpointPath,
          originals.get(offering)!.priority,
        )
      )));
      const strategyRestore = originalStrategy ? await Promise.allSettled([updateStrategy(originalStrategy)]) : [];
      // 停用临时备用：不再攒 id——网关每次改路由都会换 id，先按当前列表把所有逻辑模型上启用着的带标记备用
      // （含本轮 owner 上的那条，以及创建请求响应不确定时没登记到的那条）按当前 id 停掉，再自愈注入态；
      // 停用状态随新版本延续，自愈之后不需要再追新 id。隔离排在自愈之前：自愈请求失败也不能让备用在线。
      const backupRestore = await Promise.allSettled([(async () => {
        const response = await request.get(`${gateway.baseUrl}/gw/logical-models?enabled=true`, { headers: gateway.headers });
        const body = await response.json() as ApiEnvelope<{ items: GatewayLogicalModel[] }>;
        expect(response.ok(), body.error?.message || '清理阶段无法重新读取网关逻辑模型').toBe(true);
        await disableStrayGatewayBackups(request, gateway, body.data.items);
        // 主路与备用的 Endpoint 已按 originals 复原；这里再按注入前缀扫一遍，把本轮没登记到的注入态也恢复。
        const leftoverAfterRun = await recoverInjectedGatewayOfferings(request, gateway, body.data.items);
        const unrecoverable = leftoverAfterRun.filter((item) => item.source === 'unrecoverable');
        if (unrecoverable.length > 0) {
          throw new Error(`清理阶段仍有无法还原的注入态 Offering，需要人工恢复 Endpoint：${describeGatewayRecovery(unrecoverable)}`);
        }
      })()]);
      // 工作区与探针 run 的清理也走 allSettled：它们失败时要把服务端的错误原文带出来（此前是 data 为 null
      // 直接抛 TypeError，把服务端的 409 原因和前面真正的断言失败一起遮住了），并且不能挡住网关复原结果的核对。
      const workspaceCleanup = await Promise.allSettled([(async () => {
        if (!workspaceId) return;
        const deleted = await page.request.delete(`/api/visual-agent/image-master/workspaces/${workspaceId}`, {
          headers: {
            ...authHeaders(token),
            'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspaceId}-gateway-failover-delete`,
          },
        });
        const envelope = await deleted.json() as ApiEnvelope<{ deleted: boolean }>;
        expect(
          envelope.data?.deleted,
          `清理故障切换工作区失败：HTTP ${deleted.status()} ${envelope.error?.message || ''}`,
        ).toBe(true);
        for (const runId of runIds) {
          expect((await page.request.get(`/api/visual-agent/image-gen/runs/${runId}`, {
            headers: authHeaders(token),
          })).status()).toBe(404);
        }
      })()]);
      expect(
        [...restoreResults, ...strategyRestore, ...backupRestore, ...workspaceCleanup]
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => String(result.reason?.message || result.reason)),
        '网关故障注入结束后所有 Offering 都必须恢复原 Endpoint，临时备用上游必须停用，工作区与探针 run 必须删除',
      ).toEqual([]);
    }
  });

  test('[REG-gateway-failover-fixture-002] 上一轮硬中断遗留的注入态在下一轮开始前自愈', { tag: '@cleanup' }, async ({ request }) => {
    test.skip(requiredEnv('STABLE_SMOKE_ENVIRONMENT') === 'production', '正式环境不主动修改网关路由配置');
    // issue #1536：人为构造「带标记备用已启用 + Endpoint 停在注入态」的遗留状态，断言自愈把 Endpoint
    // 恢复成捐出方契约、健康计数清零，且重复执行不再有任何改动。
    // 网关的 Offering 每次更新都会生成新版本（旧记录标记 SupersededByOfferingId，再改旧 id 会 409），
    // 所以这里始终以「逻辑模型 + 标记 + targetId」重新定位当前版本，不拿进入前的 id 一路用到底。
    const gateway = await loginGateway(request);
    const readLogical = async () => {
      const response = await request.get(`${gateway.baseUrl}/gw/logical-models?enabled=true`, { headers: gateway.headers });
      const body = await response.json() as ApiEnvelope<{ items: GatewayLogicalModel[] }>;
      expect(response.ok(), body.error?.message || '无法读取网关逻辑模型').toBe(true);
      return body.data.items;
    };
    let owner: GatewayLogicalModel | undefined;
    let backup: GatewayOffering | undefined;
    const put = async (offeringId: string, data: Record<string, unknown>) => {
      const response = await request.put(`${gateway.baseUrl}/gw/logical-models/${owner!.id}/offerings/${offeringId}`, {
        headers: gateway.headers,
        data,
      });
      const body = await response.json() as ApiEnvelope<GatewayOffering>;
      expect(response.ok(), body.error?.message || `Offering ${offeringId} 更新失败`).toBe(true);
      return body.data;
    };
    const setEnabled = async (offeringId: string, enabled: boolean) => {
      const response = await request.put(`${gateway.baseUrl}/gw/logical-models/${owner!.id}/offerings/${offeringId}/enabled`, {
        headers: gateway.headers,
        data: { enabled },
      });
      const body = await response.json() as ApiEnvelope<GatewayOffering>;
      expect(response.ok(), body.error?.message || `Offering ${offeringId} ${enabled ? '启用' : '停用'}失败`).toBe(true);
      return body.data;
    };
    // 从补备用开始就进入清理作用域：创建成功但响应丢失、或紧接着的停用请求失败时，外层 finally 也要把
    // 所有逻辑模型上启用着的带标记备用停掉，不让刚建的备用带着启用态留在 CDS 路由里。
    try {
      const index = await readGatewayUpstreamIndex(request, gateway);
      // 进入时不看备用是否干净，一律先把所有逻辑模型上的注入态自愈、把启用着的带标记备用停掉，再选备用、取快照：
      // 上一轮若只在主路注入之后就夭折，备用是干净的而主路不是，后面的「恰好只处理这一条」断言会被主路的遗留搅掉。
      // 隔离排在自愈之前：自愈的网关请求失败也不能让备用带着注入态继续在线。
      await disableStrayGatewayBackups(request, gateway, await readLogical());
      const pre = await recoverInjectedGatewayOfferings(request, gateway, await readLogical());
      expect(
        pre.filter((item) => item.source === 'unrecoverable'),
        '进入用例时网关上有无法还原的注入态，请先人工恢复这些 Offering 的 Endpoint 再跑',
      ).toEqual([]);
      let items = await readLogical();
      owner = items.find((item) => item.offerings.some(isGatewayFailoverBackup));
      backup = owner?.offerings.find(isGatewayFailoverBackup);
      if (!owner || !backup) {
        // 干净的网关（业务逻辑模型本来就有双上游、GW-007 从未补过备用）：本用例自己造一条带标记备用，
        // 与 GW-007 共用同一份创建逻辑，造完立刻停用；不依赖别的用例先跑，也不跳过。
        const candidates = items
          .filter((item) => item.enabled && item.offerings.some((offering) => isLiveGatewayUpstream(offering, index)))
          .sort((left, right) => left.publicId.localeCompare(right.publicId));
        let created: GatewayOffering | undefined;
        for (const candidate of candidates) {
          const primary = candidate.offerings
            .filter((offering) => isLiveGatewayUpstream(offering, index))
            .sort((left, right) => left.priority - right.priority)[0];
          created = await provisionTaggedFailoverBackup(request, gateway, items, index, candidate, primary);
          if (created) {
            owner = candidate;
            break;
          }
        }
        expect(created, '没有任何逻辑模型能从同类型逻辑模型借到第二个真实上游，无法构造带标记备用').toBeTruthy();
        await setEnabled(created!.id, false);
        items = await readLogical();
        backup = items.find((item) => item.id === owner!.id)?.offerings.find(isGatewayFailoverBackup);
        expect(backup, '刚创建的带标记备用必须能在逻辑模型上读回').toBeTruthy();
      }
      expect(isGatewayInjectedEndpoint(backup!), '自愈之后备用 Offering 不应再是注入态').toBe(false);
      // 路由契约完全相同的捐出方在有的环境里存在、有的不存在（CDS 上备用是 openai 协议、捐出方是协议默认），
      // 旧格式注入路径的两种结局都要验：有捐出方就按它还原，没有就必须原样不动并标记 unrecoverable。
      const donor = items
        .flatMap((item) => item.offerings.filter((offering) => offering.id !== backup!.id && sameGatewayRoutingContract(offering, backup!)))
        .sort((left, right) => Number(right.enabled) - Number(left.enabled))[0];
      // 带标记备用在 GW-007 之外的干净状态永远是「停用」：进入时若是启用的，那只能是上一轮夭折留下的，结束时一并停掉。
      const original = { endpointPath: backup!.endpointPath || '', priority: backup!.priority };
      const readBackup = async () => {
        const current = (await readLogical()).find((item) => item.id === owner!.id)?.offerings
          .find((offering) => isGatewayFailoverBackup(offering) && offering.targetId === backup!.targetId);
        expect(current, '带标记备用 Offering 必须始终留在逻辑模型上').toBeTruthy();
        return current!;
      };

      const poison = async (injectedEndpointPath: string) => {
        // 模拟 worker 在全路故障注入之后被硬杀：备用启用、Endpoint 停在注入态。
        const current = await readBackup();
        const poisoned = await put(current.id, { endpointPath: injectedEndpointPath, priority: original.priority });
        expect(isGatewayInjectedEndpoint(poisoned)).toBe(true);
        await setEnabled(poisoned.id, true);
      };
      const recoverOnce = async () => {
        const recovered = await recoverInjectedGatewayOfferings(request, gateway, await readLogical());
        expect(
          recovered.map((item) => `${item.logicalId}:${item.targetId}`),
          '自愈必须恰好处理这条遗留备用，不碰其它 Offering',
        ).toEqual([`${owner!.id}:${backup!.targetId}`]);
        return recovered[0];
      };

      // 注入路径构造器本身的边界：短路径（含多字节）可逆，超过网关 500 字符上限时退回不带原值的旧格式。
      expect(decodeGatewayInjectedEndpoint(buildGatewayInjectedEndpoint('all', 'v1/图片/generations?x=1', 2))).toBe('v1/图片/generations?x=1');
      expect(decodeGatewayInjectedEndpoint(buildGatewayInjectedEndpoint('primary', ''))).toBe('');
      const longInjected = buildGatewayInjectedEndpoint('all', 'a'.repeat(480), 3);
      expect(longInjected.length).toBeLessThanOrEqual(gatewayEndpointPathLimit);
      expect(gatewayInjectedEndpointPattern.test(longInjected)).toBe(true);
      expect(decodeGatewayInjectedEndpoint(longInjected)).toBeNull();

      try {
        // 情形一：本 PR 起的注入格式自带原值，精确还原，不依赖任何别的 Offering。
        // 原 Endpoint 长到装不进 500 字符时构造器会退回不带原值的格式，那就按情形二的结局断言。
        const embeddedPath = buildGatewayInjectedEndpoint('all', original.endpointPath, 0);
        const embeddable = decodeGatewayInjectedEndpoint(embeddedPath) !== null;
        await poison(embeddedPath);
        const embedded = await recoverOnce();
        const afterEmbedded = await readBackup();
        if (embeddable) {
          expect(embedded.source).toBe('embedded');
          expect(embedded.to).toBe(original.endpointPath);
          expect(isGatewayInjectedEndpoint(afterEmbedded)).toBe(false);
          expect(afterEmbedded.endpointPath || '').toBe(original.endpointPath);
          expect(afterEmbedded.healthStatus ?? 0, 'Endpoint 恢复后健康计数必须清零，否则健康到 2 的备用仍会被排除').toBe(0);
          expect(await recoverInjectedGatewayOfferings(request, gateway, await readLogical()), '自愈必须幂等').toEqual([]);
        } else if (donor) {
          expect(embedded.source).toBe('donor');
          expect(afterEmbedded.endpointPath || '').toBe(donor.endpointPath || '');
        } else {
          expect(embedded.source).toBe('unrecoverable');
          expect(afterEmbedded.endpointPath || '').toBe(embeddedPath);
        }

        // 情形二：旧格式注入路径不带原值。有路由契约完全相同的捐出方就按它还原；没有就一个字都不许改。
        const legacyEndpoint = `stable-smoke-all-failure/leftover-${Date.now()}`;
        await poison(legacyEndpoint);
        const legacy = await recoverOnce();
        const afterLegacy = await readBackup();
        if (donor) {
          expect(legacy.source).toBe('donor');
          expect(legacy.to).toBe(donor.endpointPath || '');
          expect(afterLegacy.endpointPath || '').toBe(donor.endpointPath || '');
          expect(await recoverInjectedGatewayOfferings(request, gateway, await readLogical()), '自愈必须幂等').toEqual([]);
        } else {
          expect(legacy.source, '没有相同路由契约的捐出方时不能拿别的 Endpoint 顶上').toBe('unrecoverable');
          expect(afterLegacy.endpointPath || '', 'unrecoverable 的记录必须原样不动').toBe(legacyEndpoint);
          expect(afterLegacy.enabled, 'unrecoverable 的记录连启停状态都不动，交给人工处理').toBe(true);
        }
      } finally {
        // 顺序恢复并逐步取新版本 id：同一条 Offering 的两次写不并发，也不拿旧 id 去改已被替代的版本。
        const restore = await Promise.allSettled([(async () => {
          // 快照在自愈之后才取，这里再守一道：任何情况下都不许把注入态写回网关。
          if (gatewayInjectedEndpointPattern.test(original.endpointPath)) {
            throw new Error(`快照里的 Endpoint 仍是注入态，拒绝写回：${original.endpointPath}`);
          }
          const latest = await readBackup();
          const restored = await put(latest.id, { endpointPath: original.endpointPath, priority: original.priority });
          await setEnabled(restored.id, false);
        })()]);
        expect(restore.filter((result) => result.status === 'rejected'), '用例结束必须把备用 Offering 恢复到进入前的状态').toEqual([]);
      }
    } finally {
      await disableStrayGatewayBackups(request, gateway, await readLogical());
    }
  });

  test('[CORE-005][VIS-008][REG-visual-error-001] 无效生图请求返回用户可读错误', async ({ page, request }) => {
    const token = await loginAndReadToken(page, request, '/visual-agent');
    const response = await page.request.post('/api/visual-agent/image-gen/runs', {
      headers: authHeaders(token),
      data: { platformId: 'logical-model', modelId: 'invalid', items: [] },
    });
    const body = await response.json() as ApiEnvelope<never>;
    expect(response.status()).toBe(400);
    expect(body.success).toBe(false);
    expectUserReadable(body.error?.message || '');
  });

  for (const module of modules) {
    test(`${module.label}可通过短时测试会话打开`, async ({ page, request }, testInfo) => {
      await openModule(page, request, module, testInfo);
    });
  }

  test('移动端核心入口无横向溢出', async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const module = modules[0];
    await openModule(page, request, module, testInfo);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    // CDS 预览小部件在手机上必须收成紧凑圆钮：2026-09-14 移动首页底部被整条分支徽章压住。
    // 小部件由 CDS 反代注入，改动要等 CDS 自更新后才生效；这里按它暴露的布局态判定，不猜。
    const widget = page.locator('#cds-widget');
    if (await widget.count()) {
      await expect(
        widget,
        'CDS 预览小部件在手机上应在 4 秒后收成紧凑态（data-cds-layout=compact）；仍是整条徽章说明 CDS 尚未自更新到含移动端紧凑态的版本',
      ).toHaveAttribute('data-cds-layout', 'compact', { timeout: 10_000 });
      const box = await widget.boundingBox();
      expect(box, '紧凑态小部件必须可见').not.toBeNull();
      expect(box!.width, '紧凑态小部件宽度不得超过 48px').toBeLessThanOrEqual(48);
      expect(box!.height, '紧凑态小部件高度不得超过 48px').toBeLessThanOrEqual(48);
      await testInfo.attach('mobile-home-compact-widget', { body: await page.screenshot(), contentType: 'image/png' });
    }
  });

  test('[VIS-009][REG-visual-policy-001] 真实触控手机使用业务默认及授权尺寸', { tag: '@cleanup' }, async ({ browser, request }, testInfo) => {
    const context = await browser.newContext({ ...devices['iPhone 13'], baseURL: testInfo.project.use.baseURL });
    const page = await context.newPage();
    const token = await loginAndReadToken(page, request, '/visual-agent');
    const { workspace } = await createVisualWorkspace(page, token, 'mobile-business-policy');
    try {
      const models = await readEnvelope<ImageModelPool[]>(await page.request.get('/api/visual-agent/image-gen/models', { headers: authHeaders(token) }));
      const defaults = models.filter(model => model.isDefault);
      expect(defaults).toHaveLength(1);
      const model = defaults[0];
      const capability = await readEnvelope<{ matched: boolean; sizesByResolution?: Record<string, Array<{size:string;aspectRatio:string}>> }>(
        await page.request.get(`/api/visual-agent/image-gen/adapter-info?modelId=${encodeURIComponent(model.code)}`, { headers: authHeaders(token) }));
      expect(capability.matched).toBe(true);
      await page.goto(`/visual-agent/${workspace.id}`, { waitUntil: 'domcontentloaded' });
      await dismissBlockingTutorial(page);
      expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0);
      await expect(page.getByText(model.name, { exact: true }).first()).toBeVisible();
      const sizes = [...new Map(Object.values(capability.sizesByResolution ?? {}).flat().map(option => [option.size, option])).values()];
      expect(sizes.length).toBeGreaterThan(0);
      for (const size of sizes) await expect(page.getByRole('button', { name: `${size.aspectRatio} · ${size.size}`, exact: true })).toBeAttached();
      await expect(page.getByPlaceholder('描述你想生成的画面…')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await testInfo.attach('mobile-business-model-policy', { body: await page.screenshot(), contentType: 'image/png' });
    } finally {
      const deleted = await page.request.delete(`/api/visual-agent/image-master/workspaces/${workspace.id}`, {
        headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-mobile-delete` },
      });
      await expectDeleteSucceeded(deleted, `删除移动端工作区 ${workspace.id} 失败`);
      await context.close();
    }
  });

  test('[MVIS-012] 移动端参考图、尺寸、输入和移除操作均可触达', { tag: '@cleanup' }, async ({ page, request }, testInfo) => {
    const token = await loginAndReadToken(page, request, '/visual-agent');
    const { workspace } = await createVisualWorkspace(page, token, 'multi-image-mobile-layout');
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/visual-agent/${workspace.id}`, { waitUntil: 'domcontentloaded' });
      await dismissBlockingTutorial(page);
      const reference = solidPngDataUrl(35, 90, 190, 128);
      await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
        name: 'mobile-reference.png',
        mimeType: 'image/png',
        buffer: Buffer.from(reference.split(',')[1], 'base64'),
      });
      await expect(page.getByAltText('参考图')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByPlaceholder('描述要怎么改这张图…')).toBeVisible();
      await expect(page.getByRole('button', { name: '生成', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /^1:1 · \d+x\d+$/ })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await testInfo.attach('multi-image-mobile-input', { body: await page.screenshot(), contentType: 'image/png' });
      await page.getByRole('button', { name: '移除参考图' }).click();
      await expect(page.getByAltText('参考图')).toBeHidden();
    } finally {
      const deleted = await page.request.delete(`/api/visual-agent/image-master/workspaces/${workspace.id}`, {
        headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-mobile-delete` },
      });
      await expectDeleteSucceeded(deleted, `删除移动端参考图工作区 ${workspace.id} 失败`);
    }
  });

  test('[CORE-004][GW-005][GW-008][VIS-002][VIS-005][VIS-007][VIS-010][REG-visual-policy-001] 业务默认模型真实产物、网关路由日志、SSE 恢复、进度布局与清理', { tag: '@cleanup' }, async ({ page, request }, testInfo) => {
    // 生产生图 HTTP 契约允许最长 600 秒。测试总时限额外保留页面验证、审计查询与清理余量，
    // 避免上游仍在合法执行时先由 Playwright 误杀，再把取消/删除冲突误报成模型故障。
    test.setTimeout(720_000);
    const token = await loginAndReadToken(page, request, '/visual-agent');
    const { workspace } = await createVisualWorkspace(page, token, 'single-image');
    const generationPrompt = '一枚放在纯白背景上的蓝色陶瓷杯，产品摄影，柔和自然光，不要文字';
    let runId = '';
    let generatedArtifacts: UploadArtifactItem[] = [];
    try {
      const poolResponse = await page.request.get('/api/visual-agent/image-gen/models/text2img', { headers: authHeaders(token) });
      const pools = await readEnvelope<ImageModelPool[]>(poolResponse);
      const pool = pools.find((item) => item.isDefault);
      expect(pool, 'MAP 未配置业务默认，禁止用第一个可用模型替代').toBeTruthy();
      expect(pool!.models.some((model) => !/unhealthy|disabled/i.test(model.healthStatus || '')), '默认型号不可用').toBe(true);

      const generationStartedAt = Date.now();
      const create = await page.request.post(`/api/visual-agent/image-master/workspaces/${workspace.id}/image-gen/runs`, {
        headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-single-run` },
        data: {
          prompt: generationPrompt,
          userMessageContent: '生成一枚纯白背景上的蓝色陶瓷杯',
          targetKey: `${requiredEnv('STABLE_SMOKE_RUN_ID')}-single-target`,
          platformId: 'logical-model',
          modelId: pool!.code,
          size: '1024x1024',
          responseFormat: 'url',
          x: 0,
          y: 0,
          w: 1001,
          h: 1001,
        },
      });
      const created = await readEnvelope<{ runId: string }>(create);
      runId = created.runId;

      const firstStream = await probeImageRunSse(page, token, runId, 0, 'active');
      expect(firstStream.ok).toBe(true);
      expect(firstStream.contentType).toContain('text/event-stream');
      expect(firstStream.stoppedAfterActiveEvent, '首次 SSE 必须在非终态事件后主动断开').toBe(true);
      expect(firstStream.ids.length).toBeGreaterThan(0);
      const lastObservedSeq = Math.max(...firstStream.ids);
      const activeRun = await readEnvelope<ImageRunDetail>(await page.request.get(
        `/api/visual-agent/image-gen/runs/${runId}?includeItems=true&includeImages=false`,
        { headers: authHeaders(token) },
      ));
      expect(activeRun.run.status, 'SSE 中断必须发生在任务仍处于活跃状态时').toMatch(/Queued|Running/i);

      const resumedStream = await probeImageRunSse(page, token, runId, lastObservedSeq, 'next');
      expect(resumedStream.ok).toBe(true);
      expect(resumedStream.contentType).toContain('text/event-stream');
      expect(resumedStream.ids.some((seq) => seq > lastObservedSeq), '续传必须从 afterSeq 之后收到新事件').toBe(true);
      expect(
        [...firstStream.eventTypes, ...resumedStream.eventTypes].join(','),
        'SSE 中断和续传之间必须存在可见进度连续性',
      ).toMatch(/runStart|imageStart|progress/i);
      expect(
        firstStream.heartbeats + resumedStream.heartbeats > 0
          || firstStream.ids.length + resumedStream.ids.length >= 2,
        'SSE 恢复期间必须收到心跳或连续业务进度事件',
      ).toBe(true);

      await page.goto(`/visual-agent/${workspace.id}`, { waitUntil: 'domcontentloaded' });
      await dismissBlockingTutorial(page);
      const progress = page.getByTestId('generation-progress').first();
      await expect(progress, '真实生图开始后页面必须恢复生成中占位').toBeVisible({ timeout: 15_000 });
      const progressBox = await progress.boundingBox();
      // 等待态的信息现在是底边一行（尺寸 · 阶段 · 剩余时间），不再是浮在画面上的黑胶囊。
      const metaBox = await progress.getByTestId('generation-progress-meta').boundingBox();
      expect(progressBox).not.toBeNull();
      expect(metaBox).not.toBeNull();
      expect(metaBox!.x).toBeGreaterThanOrEqual(progressBox!.x - 1);
      expect(metaBox!.x + metaBox!.width).toBeLessThanOrEqual(progressBox!.x + progressBox!.width + 1);
      // 进度画在画框上：描边任何缩放下都不许退场，它退场进度就没有载体了。
      await expect(progress.locator('.gen-dev__arc'), '等待态必须有画框进度描边').toHaveCount(1);
      await testInfo.attach('single-image-progress', { body: await page.screenshot(), contentType: 'image/png' });

      const completed = await waitForImageRun(page, token, runId, 600_000);
      await testInfo.attach('single-image-latency', {
        body: JSON.stringify({ runId, elapsedMs: Date.now() - generationStartedAt }),
        contentType: 'application/json',
      });
      expect(completed.statuses.length, '轮询必须至少读取到一次有效任务状态').toBeGreaterThanOrEqual(1);
      await assertImageArtifact(page, completed.detail);
      const artifactResult = await readEnvelope<{ items: UploadArtifactItem[] }>(await page.request.get(
        `/api/visual-agent/upload-artifacts?requestId=${encodeURIComponent(`${runId}-0-0`)}`,
        { headers: authHeaders(token) },
      ));
      generatedArtifacts = artifactResult.items.filter((item) => item.kind === 'output_image');
      expect(generatedArtifacts.length, '真实生图必须登记可清理的输出产物').toBeGreaterThan(0);
      const gatewayLog = await waitForGatewayLog(request, `${runId}-0-0`);
      expect(gatewayLog.logicalModelPublicId, '真实生图日志必须记录逻辑模型').toBe(pool!.code);
      expect(gatewayLog.offeringId, '真实生图日志必须记录实际 Offering').toBeTruthy();
      expect(gatewayLog.provider, '真实生图日志必须记录实际 Provider').toBeTruthy();
      expect(gatewayLog.model, '真实生图日志必须记录实际上游模型').toBeTruthy();
      expect(gatewayLog.status).toMatch(/completed|success|succeeded/i);
      expect(gatewayLog.statusCode || 0).toBeGreaterThanOrEqual(200);
      expect(gatewayLog.statusCode || 0).toBeLessThan(300);
      expect(gatewayLog.providerAttempts.length).toBeGreaterThan(0);
      expect(gatewayLog.providerAttempts.at(-1)?.status).toMatch(/completed|success|succeeded/i);
      expect(gatewayLog.routerTrace.logicalModelPublicId).toBe(pool!.code);
      expect(gatewayLog.routerTrace.offeringId).toBeTruthy();
      expect(gatewayLog.routerTrace.steps.length).toBeGreaterThan(0);
      await page.reload({ waitUntil: 'domcontentloaded' });
      const generatedImage = page.getByTestId('canvas-image').first();
      await expect(generatedImage, '任务完成并刷新后画布必须恢复真实图片').toBeVisible({ timeout: 30_000 });
      await expect.poll(
        () => generatedImage.evaluate((image) => (image as HTMLImageElement).naturalWidth),
        { message: '画布图片必须完成浏览器解码', timeout: 30_000 },
      ).toBeGreaterThan(0);
      await generatedImage.evaluate((image) => (image as HTMLImageElement).decode());
      await generatedImage.click();
      const downloadButton = page.getByTitle('下载图片').first();
      await expect(downloadButton, '选中生成图后必须出现真实下载操作').toBeVisible();
      const canvasSource = await generatedImage.getAttribute('src');
      // 浏览器给用户存盘用的名字来自产品写在 <a download> 上的属性；Chromium 在 downloadWillBegin
      // 阶段对 blob 链接只回报占位名 "download"（2026-09-15 用 141 版实测，blob / data 链接皆如此），
      // 所以文件名判据直接读产品写的属性，CDP 的建议名只在它给出真实值时才参与比对。
      await page.evaluate(() => {
        const bucket: Array<{ download: string; href: string }> = [];
        (window as unknown as { __stsmkDownloads: typeof bucket }).__stsmkDownloads = bucket;
        const nativeClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function patchedClick(this: HTMLAnchorElement) {
          bucket.push({ download: this.download, href: this.href.slice(0, 32) });
          return nativeClick.call(this);
        };
      });
      const observedDownloadRequests: string[] = [];
      const recordDownloadRequest = (request: { method(): string; url(): string }) => {
        if (request.method() === 'GET') observedDownloadRequests.push(request.url());
      };
      page.on('request', recordDownloadRequest);
      let downloadResponse;
      let download;
      try {
        const responsePromise = page.waitForResponse((response) => (
          response.request().method() === 'GET'
          && new URL(response.url()).pathname === '/api/visual-agent/image-gen/download'
        ));
        const downloadPromise = page.waitForEvent('download');
        await downloadButton.click({ timeout: 5_000 });
        [downloadResponse, download] = await Promise.all([responsePromise, downloadPromise]);
      } catch (error) {
        const toastText = await page.locator('[data-sonner-toast]').allInnerTexts().catch(() => []);
        throw new Error(
          `点击下载未形成受权下载：src=${canvasSource || 'empty'}；请求=${observedDownloadRequests.slice(-8).join('、') || 'none'}；提示=${toastText.join('、') || 'none'}；原因=${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        page.off('request', recordDownloadRequest);
      }
      expect(downloadResponse.ok(), '生成图下载端点必须成功返回').toBe(true);
      expect(downloadResponse.headers()['content-type'] || '').toMatch(/^image\//i);
      expect(await download.failure()).toBeNull();
      const downloadedPath = await download.path();
      expect(downloadedPath, '浏览器必须产生可读取的下载文件').toBeTruthy();
      const downloadedBytes = readFileSync(downloadedPath!);
      expect(downloadedBytes.byteLength).toBeGreaterThan(512);
      const downloadedMime = detectImageMime(downloadedBytes);
      const expectedExtension = extensionForImageMime(downloadedMime);
      const anchorDownloads = await page.evaluate(() => (
        (window as unknown as { __stsmkDownloads?: Array<{ download: string; href: string }> }).__stsmkDownloads || []
      ));
      expect(anchorDownloads.length, '下载必须通过带 download 属性的同源链接触发').toBeGreaterThan(0);
      const savedName = anchorDownloads.at(-1)!.download;
      expect(savedName, '存盘文件名必须带提示词主体').toContain('蓝色陶瓷杯');
      expect(savedName.toLowerCase().endsWith(expectedExtension), `存盘扩展名必须与实际 MIME 一致：${savedName} / ${downloadedMime}`).toBe(true);
      if (download.suggestedFilename() !== 'download') {
        expect(download.suggestedFilename()).toBe(savedName);
      }
      expect(generatedArtifacts.some((artifact) => artifact.mime === downloadedMime)).toBe(true);
      const downloadedDimensions = await decodeDownloadedImageDimensions(page, downloadedBytes, downloadedMime);
      const requestedDimensions = String(completed.detail.items[0].requestedSize || '').split('x').map(Number);
      expect(downloadedDimensions).toEqual({ width: requestedDimensions[0], height: requestedDimensions[1] });
      await testInfo.attach('single-image-download', { body: downloadedBytes, contentType: downloadedMime });
      await page.waitForTimeout(500);
      await testInfo.attach('single-image-result', { body: await page.screenshot(), contentType: 'image/png' });
    } finally {
      if (runId) {
        const current = await page.request.get(`/api/visual-agent/image-gen/runs/${runId}`, { headers: authHeaders(token) });
        if (current.ok()) {
          const state = await current.json() as ApiEnvelope<ImageRunDetail>;
          if (!/Completed|Failed|Cancelled/i.test(state.data?.run?.status || '')) {
            await page.request.post(`/api/visual-agent/image-gen/runs/${runId}/cancel`, { headers: authHeaders(token) });
            await waitForImageRun(page, token, runId, 30_000).catch(() => undefined);
          }
        }
      }
      const deleted = await page.request.delete(`/api/visual-agent/image-master/workspaces/${workspace.id}`, {
        headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-single-delete` },
      });
      await expectDeleteSucceeded(deleted, `删除真实生图工作区 ${workspace.id} 失败`);
      expect((await page.request.get(`/api/visual-agent/image-master/workspaces/${workspace.id}/detail`, { headers: authHeaders(token) })).status()).toBe(404);
      if (runId) {
        expect((await page.request.get(`/api/visual-agent/image-gen/runs/${runId}`, { headers: authHeaders(token) })).status()).toBe(404);
      }
      for (const artifact of generatedArtifacts) {
        const remaining = await readEnvelope<{ items: UploadArtifactItem[] }>(await page.request.get(
          `/api/visual-agent/upload-artifacts?requestId=${encodeURIComponent(artifact.requestId)}`,
          { headers: authHeaders(token) },
        ));
        expect(remaining.items.some((item) => item.id === artifact.id), '工作区删除后不得残留生成产物记录').toBe(false);
        await expect.poll(async () => {
          try {
            const separator = artifact.cosUrl.includes('?') ? '&' : '?';
            const response = await page.request.get(`${artifact.cosUrl}${separator}deletedProbe=${Date.now()}`);
            return response.status();
          } catch {
            return 0;
          }
        }, {
          message: `工作区删除后底层生成对象必须不可访问：${artifact.sha256}`,
          timeout: 20_000,
          intervals: [500, 1_000, 2_000],
        }).not.toBe(200);
      }
    }
  });

  test('[VIS-004] 方形、横版与竖版三画幅均生成真实比例产物', { tag: '@cleanup' }, async ({ page, request }) => {
    test.setTimeout(300_000);
    const token = await loginAndReadToken(page, request, '/visual-agent');
    const { workspace } = await createVisualWorkspace(page, token, 'single-image-ratio-matrix');
    let runId = '';
    try {
      const poolResponse = await page.request.get('/api/visual-agent/image-gen/models/text2img', { headers: authHeaders(token) });
      const pools = await readEnvelope<ImageModelPool[]>(poolResponse);
      const pool = pools.find((item) => item.models.some((model) => !/unhealthy|disabled/i.test(model.healthStatus || '')));
      expect(pool, '没有可用的文生图逻辑模型').toBeTruthy();
      const allRequested = [
        { size: '1024x1024', orientation: 'square', prompt: '方形产品照，一枚蓝色陶瓷杯，纯白背景，不要文字' },
        { size: '1536x1024', orientation: 'landscape', prompt: '横版产品照，一枚蓝色陶瓷杯，纯白背景，不要文字' },
        { size: '1024x1536', orientation: 'portrait', prompt: '竖版产品照，一枚蓝色陶瓷杯，纯白背景，不要文字' },
      ] as const;
      const production = requiredEnv('STABLE_SMOKE_ENVIRONMENT') === 'production';
      const rotationSeed = requiredEnv('STABLE_SMOKE_COMMIT');
      const rotationIndex = [...rotationSeed]
        .reduce((sum, character) => sum + character.charCodeAt(0), 0) % allRequested.length;
      const requested = production ? [allRequested[rotationIndex]] : allRequested;
      const create = await page.request.post('/api/visual-agent/image-gen/runs', {
        headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-ratio-matrix` },
        data: {
          platformId: 'logical-model',
          modelId: pool!.code,
          responseFormat: 'url',
          maxConcurrency: 1,
          workspaceId: workspace.id,
          appKey: 'visual-agent',
          items: requested.map((item) => ({ prompt: item.prompt, count: 1, size: item.size })),
        },
      });
      runId = (await readEnvelope<{ runId: string }>(create)).runId;
      const completed = await waitForImageRun(page, token, runId, 240_000);
      expect(completed.detail.run.status).toBe('Completed');
      expect(completed.detail.run.total).toBe(requested.length);
      expect(completed.detail.run.done).toBe(requested.length);
      expect(completed.detail.run.failed).toBe(0);
      expect(completed.detail.items).toHaveLength(requested.length);
      for (const [index, item] of completed.detail.items.entries()) {
        expect(item.requestedSize, `第 ${index + 1} 张必须保留请求尺寸`).toBe(requested[index].size);
        const dimensions = await decodeGeneratedImageDimensions(page, item);
        expect(dimensions.width).toBeGreaterThan(0);
        expect(dimensions.height).toBeGreaterThan(0);
        const ratio = dimensions.width / dimensions.height;
        if (requested[index].orientation === 'square') expect(Math.abs(ratio - 1)).toBeLessThan(0.08);
        if (requested[index].orientation === 'landscape') expect(ratio).toBeGreaterThan(1.2);
        if (requested[index].orientation === 'portrait') expect(ratio).toBeLessThan(0.8);
      }
    } finally {
      if (runId) {
        const current = await page.request.get(`/api/visual-agent/image-gen/runs/${runId}`, { headers: authHeaders(token) });
        if (current.ok()) {
          const state = await current.json() as ApiEnvelope<ImageRunDetail>;
          if (!/Completed|Failed|Cancelled/i.test(state.data?.run?.status || '')) {
            await page.request.post(`/api/visual-agent/image-gen/runs/${runId}/cancel`, { headers: authHeaders(token) });
            await waitForImageRun(page, token, runId, 30_000).catch(() => undefined);
          }
        }
      }
      const deleted = await page.request.delete(`/api/visual-agent/image-master/workspaces/${workspace.id}`, {
        headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-ratio-delete` },
      });
      await expectDeleteSucceeded(deleted, `删除画幅矩阵工作区 ${workspace.id} 失败`);
      if (runId) {
        expect((await page.request.get(`/api/visual-agent/image-gen/runs/${runId}`, { headers: authHeaders(token) })).status()).toBe(404);
      }
    }
  });

  test('[VIS-003][REG-image-input-001] JPEG 参考图真实生成及字节、MIME、扩展名一致性', { tag: '@cleanup' }, async ({ page, request }) => {
    test.setTimeout(240_000);
    const token = await loginAndReadToken(page, request, '/visual-agent');
    const { workspace } = await createVisualWorkspace(page, token, 'jpeg-reference');
    let runId = '';
    try {
      // 只生成合成色块，不读取或复用用户图片；正式环境不注入错误声明。
      const jpeg = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 256;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#235abe';
        context.fillRect(0, 0, 256, 256);
        return canvas.toDataURL('image/jpeg');
      });
      const digest = createHash('sha256').update(Buffer.from(jpeg.split(',')[1], 'base64')).digest('hex');
      const upload = await page.request.post(`/api/visual-agent/image-master/workspaces/${workspace.id}/assets`, {
        headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-jpeg` },
        data: {
          data: requiredEnv('STABLE_SMOKE_ENVIRONMENT') === 'production'
            ? jpeg : jpeg.replace('data:image/jpeg;', 'data:image/png;'),
          width: 256, height: 256, prompt: 'JPEG 格式回归合成参考图',
        },
      });
      const { asset } = await readEnvelope<{ asset: { sha256: string; url: string } }>(upload);
      expect(asset.sha256).toBe(digest);
      const pools = await readEnvelope<ImageModelPool[]>(await page.request.get(
        '/api/visual-agent/image-gen/models/vision', { headers: authHeaders(token) },
      ));
      const gateway = await loginGateway(request);
      const { items } = await readEnvelope<{ items: GatewayLogicalModel[] }>(await request.get(
        `${gateway.baseUrl}/gw/logical-models?enabled=true`, { headers: gateway.headers },
      ));
      const logical = items.find((item) => {
        const primary = item.offerings.filter((offering) => offering.enabled)
          .sort((left, right) => left.priority - right.priority)[0];
        return item.enabled && ['openai', 'openai-compatible'].includes(primary?.protocol || '')
          && pools.some((pool) => pool.code === item.publicId
            && pool.models.some((model) => !/unhealthy|disabled/i.test(model.healthStatus || '')));
      });
      expect(logical, 'JPEG 回归必须配置可用的 OpenAI 图生图主路，不能用其他协议成功代替').toBeTruthy();
      const created = await readEnvelope<{ runId: string }>(await page.request.post(
        `/api/visual-agent/image-master/workspaces/${workspace.id}/image-gen/runs`, {
          headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-run` },
          data: {
            prompt: '保留 @img1 的蓝色主色，生成纯白背景上的一只蓝色陶瓷杯，不要文字',
            userMessageContent: '参考 @img1 生成蓝色陶瓷杯',
            targetKey: `${requiredEnv('STABLE_SMOKE_RUN_ID')}-jpeg-target`,
            platformId: 'logical-model', modelId: logical!.publicId,
            size: '1024x1024', responseFormat: 'url',
            imageRefs: [{ refId: 1, assetSha256: asset.sha256, url: asset.url, label: 'JPEG 参考', role: 'target' }],
            x: 0, y: 0, w: 1001, h: 1001,
          },
        },
      ));
      runId = created.runId;
      const completed = await waitForImageRun(page, token, runId);
      await assertImageArtifact(page, completed.detail);
      const log = await waitForGatewayLog(request, `${runId}-0-0`);
      expect(log.logicalModelPublicId).toBe(logical!.publicId);
      expect(['openai', 'openai-compatible']).toContain(log.protocol);
      expect(log.isFallback, '格式错误不能靠切换供应商掩盖').not.toBe(true);
      const wire = JSON.parse(log.requestBodyRedacted || '{}') as {
        content_type?: string; endpoint_path?: string;
        files?: Array<{ mime_type?: string; file_extension?: string; sha256?: string }>;
      };
      expect(wire.content_type).toBe('multipart/form-data');
      expect(wire.endpoint_path).toMatch(/\/images\/edits$/);
      expect(wire.files).toHaveLength(1);
      expect(wire.files?.[0]).toMatchObject({ mime_type: 'image/jpeg', file_extension: '.jpg', sha256: digest });
      expect(log.imageSuccessCount || 0).toBeGreaterThan(0);
    } finally {
      if (runId) {
        const current = await page.request.get(`/api/visual-agent/image-gen/runs/${runId}`, { headers: authHeaders(token) });
        if (current.ok()) {
          const state = await current.json() as ApiEnvelope<ImageRunDetail>;
          if (!/Completed|Failed|Cancelled/i.test(state.data?.run?.status || '')) {
            await page.request.post(`/api/visual-agent/image-gen/runs/${runId}/cancel`, { headers: authHeaders(token) });
            await waitForImageRun(page, token, runId, 30_000).catch(() => undefined);
          }
        }
      }
      const deleted = await page.request.delete(`/api/visual-agent/image-master/workspaces/${workspace.id}`, {
        headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-delete` },
      });
      await expectDeleteSucceeded(deleted, `删除参考图工作区 ${workspace.id} 失败`);
      if (runId) expect((await page.request.get(`/api/visual-agent/image-gen/runs/${runId}`, { headers: authHeaders(token) })).status()).toBe(404);
    }
  });

  test('[MVIS-001][MVIS-002][MVIS-008][MVIS-009][MVIS-011][REG-multi-image-001][REG-multi-image-002] 多图逻辑模型真实生成、语义保真、恢复与清理', { tag: '@cleanup' }, async ({ page, request }, testInfo) => {
    test.setTimeout(240_000);
    const token = await loginAndReadToken(page, request, '/visual-agent');
    const { workspace } = await createVisualWorkspace(page, token, 'multi-image');
    const runIds: string[] = [];
    try {
      const uploadAsset = async (data: string, suffix: string) => {
        const response = await page.request.post(`/api/visual-agent/image-master/workspaces/${workspace.id}/assets`, {
          headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-${suffix}` },
          data: { data, width: 256, height: 256, prompt: suffix },
        });
        return readEnvelope<{ asset: { sha256: string; url: string } }>(response);
      };
      const blueReferenceData = solidPngDataUrl(35, 90, 190);
      const yellowReferenceData = solidPngDataUrl(235, 190, 55);
      const redReferenceData = solidPngDataUrl(210, 55, 75);
      const first = await uploadAsset(blueReferenceData, 'blue-reference');
      const second = await uploadAsset(yellowReferenceData, 'yellow-reference');
      const third = await uploadAsset(redReferenceData, 'red-reference');

      const poolResponse = await page.request.get('/api/visual-agent/image-gen/models/vision', { headers: authHeaders(token) });
      const pools = await readEnvelope<ImageModelPool[]>(poolResponse);
      const healthyPoolCodes = new Set(pools
        .filter((item) => item.models.some((model) => !/unhealthy|disabled/i.test(model.healthStatus || '')))
        .map((item) => item.code));
      const gateway = await loginGateway(request);
      const logicalModels = await readEnvelope<{ items: GatewayLogicalModel[] }>(
        await request.get(`${gateway.baseUrl}/gw/logical-models?enabled=true`, { headers: gateway.headers }),
      );
      const upstreamModels = await readEnvelope<{ items: GatewayUpstreamModel[] }>(
        await request.get(`${gateway.baseUrl}/gw/models?enabled=true`, { headers: gateway.headers }),
      );
      const upstreamById = new Map(upstreamModels.items.map((item) => [item.id, item]));
      // 主路协议：Offering 没显式声明时继承上游模型的协议。
      const primaryProtocol = (item: GatewayLogicalModel) => {
        const primary = item.offerings
          .filter((offering) => offering.enabled)
          .sort((left, right) => left.priority - right.priority)[0];
        if (!primary) return '';
        return (primary.protocol || upstreamById.get(primary.targetId)?.protocol || '').toLowerCase();
      };
      // 业务默认池排最前：2026-08-31 起 MAP 只开放 image1 / image2 两个 OpenAI 图片模型，
      // 多图旅程要验的是「业务默认模型带着参考图真实生成」，不再限定必须是 OpenRouter 主路；
      // 协议只要能把 input_references 或 image[] 原样送到上游即可，具体线上契约在 assertWireReferences 里逐条核。
      const businessCandidates = logicalModels.items
        .filter((item) => item.enabled && healthyPoolCodes.has(item.publicId))
        .sort((left, right) => (
          Number(Boolean(pools.find((pool) => pool.code === right.publicId)?.isDefault))
          - Number(Boolean(pools.find((pool) => pool.code === left.publicId)?.isDefault))
        ));
      const dedicatedLogical = businessCandidates.find((item) => referencePreservingImageProtocols.includes(primaryProtocol(item)));
      expect(
        dedicatedLogical,
        `业务开放的多图逻辑模型里没有一个主路走图片协议（${referencePreservingImageProtocols.join(' / ')}）。`
        + `候选：${businessCandidates.map((item) => `${item.publicId}=${primaryProtocol(item) || '未知协议'}`).join('、') || '无'}`,
      ).toBeTruthy();
      const pool = pools.find((item) => item.code === dedicatedLogical!.publicId);
      expect(pool, 'OpenRouter 多图逻辑模型未进入业务模型目录').toBeTruthy();

      const createMultiRun = async (
        suffix: string,
        prompt: string,
        userMessageContent: string,
        imageRefs: Array<{ refId: number; assetSha256: string; url: string; label: string; role: string }>,
      ) => {
        const create = await page.request.post(`/api/visual-agent/image-master/workspaces/${workspace.id}/image-gen/runs`, {
          headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-${suffix}` },
          data: {
            prompt,
            userMessageContent,
            targetKey: `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${suffix}-target`,
            platformId: 'logical-model',
            modelId: pool!.code,
            size: '1024x1024',
            responseFormat: 'url',
            imageRefs,
            x: 0,
            y: runIds.length * 1040,
            w: 1001,
            h: 1001,
          },
        });
        const createdRunId = (await readEnvelope<{ runId: string }>(create)).runId;
        runIds.push(createdRunId);
        return createdRunId;
      };

      const assertWireReferences = async (runId: string, expectedDataUrls: string[]) => {
        const log = await waitForGatewayLog(request, `${runId}-0-0`);
        expect(log.logicalModelPublicId).toBe(dedicatedLogical!.publicId);
        expect(
          ['openrouter-image', 'openai', 'openai-compatible'],
          '多图逻辑模型只能走保留参考图语义的图片协议',
        ).toContain(log.protocol);
        const requestBody = JSON.parse(log.requestBodyRedacted || '{}') as {
          input_references?: Array<{ type?: string; image_url?: { url?: string } }>;
          content_type?: string;
          endpoint_path?: string;
          file_count?: number;
          files?: Array<{ field?: string; mime_type?: string; size_bytes?: number; sha256?: string }>;
        };
        const expectedReferences = expectedDataUrls.map((dataUrl) => {
          const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
          expect(match, '测试参考图必须是合法的 Base64 data URL').toBeTruthy();
          const digest = createHash('sha256').update(Buffer.from(match![2], 'base64')).digest('hex');
          return { digest, mimeType: match![1], redactedUrl: `[BASE64_IMAGE:${digest}:${match![1]}]` };
        });
        if (log.protocol === 'openrouter-image') {
          const wireReferences = requestBody.input_references || [];
          expect(wireReferences, 'OpenRouter 请求必须保留全部多图引用').toHaveLength(expectedDataUrls.length);
          expect(wireReferences.map((item) => item.type)).toEqual(expectedDataUrls.map(() => 'image_url'));
          expect(wireReferences.map((item) => item.image_url?.url)).toEqual(
            expectedReferences.map((item) => item.redactedUrl),
          );
        } else {
          expect(requestBody.content_type).toBe('multipart/form-data');
          expect(requestBody.endpoint_path).toMatch(/\/images\/edits$/);
          expect(requestBody.file_count, 'OpenAI 备用路由必须发送全部参考图文件').toBe(expectedDataUrls.length);
          expect(requestBody.files?.map((item) => item.field)).toEqual(expectedDataUrls.map(() => 'image[]'));
          expect(requestBody.files?.map((item) => item.mime_type)).toEqual(
            expectedReferences.map((item) => item.mimeType),
          );
          expect(requestBody.files?.map((item) => item.sha256)).toEqual(
            expectedReferences.map((item) => item.digest),
          );
        }
        expect(log.imageSuccessCount || 0).toBeGreaterThan(0);
        expect(log.answerText || '').toMatch(/"data"\s*:\s*\[/);
        expect(log.answerText || '').not.toMatch(/input must have at least|chat\/completions|modalities/i);
        return log;
      };

      const twoRunId = await createMultiRun(
        'two-reference-run',
        '只从 @img1 和 @img2 读取各自主色，不要自行改色；将两种参考主色分别用于极简包装盒的左右面板，纯白背景，不要文字',
        '按顺序参考 @img1 和 @img2 的原始主色生成双色包装盒',
        [
          { refId: 1, assetSha256: first.asset.sha256, url: first.asset.url, label: '蓝色参考', role: 'target' },
          { refId: 2, assetSha256: second.asset.sha256, url: second.asset.url, label: '黄色参考', role: 'style' },
        ],
      );
      const twoCompleted = await waitForImageRun(page, token, twoRunId);
      await assertImageArtifact(page, twoCompleted.detail);
      const twoColorCoverage = await measureReferenceColorCoverage(page, twoCompleted.detail);
      expect(twoColorCoverage.blue, '@img1 未对两图生成结果产生可测的主色影响').toBeGreaterThan(0.002);
      expect(twoColorCoverage.yellow, '@img2 未对两图生成结果产生可测的主色影响').toBeGreaterThan(0.002);
      await assertWireReferences(twoRunId, [blueReferenceData, yellowReferenceData]);
      const restoredTwo = (await readEnvelope<ImageRunDetail>(
        await page.request.get(`/api/visual-agent/image-gen/runs/${twoRunId}?includeItems=true`, { headers: authHeaders(token) }),
      )).run;
      expect(restoredTwo.imageRefs?.map(({ refId, label, role }) => ({ refId, label, role }))).toEqual([
        { refId: 1, label: '蓝色参考', role: 'target' },
        { refId: 2, label: '黄色参考', role: 'style' },
      ]);

      await page.goto(`/visual-agent/${workspace.id}`, { waitUntil: 'domcontentloaded' });
      await dismissBlockingTutorial(page);

      const threeRunId = await createMultiRun(
        'three-reference-run',
        '只从 @img1、@img2 和 @img3 读取各自主色，不要自行改色；将三种参考主色分别用于极简包装盒的三个清晰分区，纯白背景，不要文字',
        '按顺序参考 @img1、@img2 和 @img3 的原始主色生成三分区包装盒',
        [
          { refId: 1, assetSha256: first.asset.sha256, url: first.asset.url, label: '蓝色参考', role: 'target' },
          { refId: 2, assetSha256: second.asset.sha256, url: second.asset.url, label: '黄色参考', role: 'style' },
          { refId: 3, assetSha256: third.asset.sha256, url: third.asset.url, label: '红色参考', role: 'reference' },
        ],
      );

      const activeBeforeRefresh = (await readEnvelope<ImageRunDetail>(
        await page.request.get(`/api/visual-agent/image-gen/runs/${threeRunId}?includeItems=true`, { headers: authHeaders(token) }),
      )).run;
      expect(activeBeforeRefresh.status, '刷新动作必须发生在三图任务仍在运行时').toMatch(/Queued|Running/i);
      expect(activeBeforeRefresh.imageRefs?.map((item) => item.assetSha256)).toEqual([
        first.asset.sha256,
        second.asset.sha256,
        third.asset.sha256,
      ]);

      const createRequestsDuringRestore: string[] = [];
      const recordCreateRequest = (requestItem: import('@playwright/test').Request) => {
        if (requestItem.method() === 'POST'
          && new URL(requestItem.url()).pathname.endsWith(`/workspaces/${workspace.id}/image-gen/runs`)) {
          createRequestsDuringRestore.push(requestItem.url());
        }
      };
      page.on('request', recordCreateRequest);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await dismissBlockingTutorial(page);
      await expect.poll(async () => {
        if (await page.getByTestId('generation-progress').first().isVisible().catch(() => false)) return 'progress';
        return (await readEnvelope<ImageRunDetail>(
          await page.request.get(`/api/visual-agent/image-gen/runs/${threeRunId}?includeItems=true`, { headers: authHeaders(token) }),
        )).run.status;
      }, {
        message: '刷新后必须恢复同一任务的生成进度或已经完成的结果',
        timeout: 30_000,
      }).toMatch(/progress|Completed/i);
      const restoredActive = (await readEnvelope<ImageRunDetail>(
        await page.request.get(`/api/visual-agent/image-gen/runs/${threeRunId}?includeItems=true`, { headers: authHeaders(token) }),
      )).run;
      expect(restoredActive.status, '刷新完成后原三图任务必须仍可恢复').toMatch(/Queued|Running|Completed/i);
      expect(restoredActive.id).toBe(threeRunId);
      expect(restoredActive.imageRefs?.map((item) => item.assetSha256)).toEqual([
        first.asset.sha256,
        second.asset.sha256,
        third.asset.sha256,
      ]);
      expect(createRequestsDuringRestore, '刷新恢复不得偷偷创建新的生图任务').toEqual([]);
      page.off('request', recordCreateRequest);

      if (/Completed/i.test(restoredActive.status)) {
        await expect(page.getByTestId('canvas-image').first(), '刷新期间完成时页面必须恢复生成结果').toBeVisible({ timeout: 30_000 });
      } else {
        await expect(page.getByTestId('generation-progress').first(), '任务仍在运行时页面必须恢复生成进度').toBeVisible();
      }

      const completed = await waitForImageRun(page, token, threeRunId);
      await assertImageArtifact(page, completed.detail);
      const threeColorCoverage = await measureReferenceColorCoverage(page, completed.detail);
      expect(threeColorCoverage.blue, '@img1 未对三图生成结果产生可测的主色影响').toBeGreaterThan(0.002);
      expect(threeColorCoverage.yellow, '@img2 未对三图生成结果产生可测的主色影响').toBeGreaterThan(0.002);
      expect(threeColorCoverage.red, '@img3 未对三图生成结果产生可测的主色影响').toBeGreaterThan(0.002);
      await assertWireReferences(threeRunId, [blueReferenceData, yellowReferenceData, redReferenceData]);
      const afterRefresh = await page.request.get(`/api/visual-agent/image-gen/runs/${threeRunId}?includeItems=true`, { headers: authHeaders(token) });
      const restoredRun = (await readEnvelope<ImageRunDetail>(afterRefresh)).run;
      expect(restoredRun.status).toBe('Completed');
      expect(restoredRun.imageRefs?.map(({ refId, label, role }) => ({ refId, label, role }))).toEqual([
        { refId: 1, label: '蓝色参考', role: 'target' },
        { refId: 2, label: '黄色参考', role: 'style' },
        { refId: 3, label: '红色参考', role: 'reference' },
      ]);

      const messages = await page.request.get(`/api/visual-agent/image-master/workspaces/${workspace.id}/messages`, { headers: authHeaders(token) });
      const messageText = JSON.stringify((await messages.json() as ApiEnvelope<unknown>).data);
      expect(messageText).toContain('@img1');
      expect(messageText).toContain('@img2');
      expect(messageText).toContain('@img3');

      const generatedImage = page.getByTestId('canvas-image').last();
      await expect(generatedImage, '多图生成完成后页面必须恢复真实图片').toBeVisible({ timeout: 30_000 });
      await expect.poll(
        () => generatedImage.evaluate((image) => (image as HTMLImageElement).naturalWidth),
        { message: '多图结果必须完成浏览器解码', timeout: 30_000 },
      ).toBeGreaterThan(0);
      await generatedImage.evaluate((image) => (image as HTMLImageElement).decode());
      await page.waitForTimeout(500);
      await expect(page.getByText('参考', { exact: false }).last()).toBeVisible({ timeout: 15_000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, '桌面端多图引用、结果和输入区不得造成页面横向裁切').toBeLessThanOrEqual(1);
      expect(await page.locator('textarea:visible, [contenteditable="true"]:visible').count()).toBeGreaterThan(0);
      await testInfo.attach('multi-image-result', { body: await page.screenshot(), contentType: 'image/png' });
    } finally {
      for (const runId of runIds) {
        const current = await page.request.get(`/api/visual-agent/image-gen/runs/${runId}`, { headers: authHeaders(token) });
        if (current.ok()) {
          const state = await current.json() as ApiEnvelope<ImageRunDetail>;
          if (!/Completed|Failed|Cancelled/i.test(state.data?.run?.status || '')) {
            await page.request.post(`/api/visual-agent/image-gen/runs/${runId}/cancel`, { headers: authHeaders(token) });
            await waitForImageRun(page, token, runId, 30_000).catch(() => undefined);
          }
        }
      }
      const deleted = await page.request.delete(`/api/visual-agent/image-master/workspaces/${workspace.id}`, {
        headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-multi-delete` },
      });
      await expectDeleteSucceeded(deleted, `删除多图工作区 ${workspace.id} 失败`);
      for (const runId of runIds) {
        expect((await page.request.get(`/api/visual-agent/image-gen/runs/${runId}`, { headers: authHeaders(token) })).status()).toBe(404);
      }
    }
  });

  test('[MVIS-003][MVIS-004] 多图重排与删除后引用顺序正确', { tag: '@cleanup' }, async ({ page, request }, testInfo) => {
    test.setTimeout(300_000);
    const token = await loginAndReadToken(page, request, '/visual-agent');
    const { workspace } = await createVisualWorkspace(page, token, 'multi-image-boundaries');
    const file = (name: string, red: number, green: number, blue: number) => ({
      name,
      mimeType: 'image/png',
      buffer: Buffer.from(solidPngDataUrl(red, green, blue, 32).split(',')[1]!, 'base64'),
    });
    try {
      await page.goto(`/visual-agent/${workspace.id}`, { waitUntil: 'domcontentloaded' });
      await dismissBlockingTutorial(page);
      const picker = page.locator('input[type="file"][accept="image/*"]');
      await expect(picker, '工作区回放完成后才允许上传，避免服务器空快照覆盖新图片').toBeEnabled({ timeout: 30_000 });
      const aFile = file('a.png', 220, 45, 60);
      const bFile = file('b.png', 35, 115, 225);
      const cFile = file('c.png', 45, 185, 90);
      const aSha256 = createHash('sha256').update(aFile.buffer).digest('hex');
      const bSha256 = createHash('sha256').update(bFile.buffer).digest('hex');
      const cSha256 = createHash('sha256').update(cFile.buffer).digest('hex');
      await picker.setInputFiles([aFile, bFile, cFile]);
      await expect(page.getByTestId('canvas-image')).toHaveCount(3, { timeout: 30_000 });
      await expect.poll(async () => {
        const detail = await readEnvelope<{ assets: Array<{ sha256: string }> }>(
          await page.request.get(`/api/visual-agent/image-master/workspaces/${workspace.id}/detail?assetLimit=20`, {
            headers: authHeaders(token),
          }),
        );
        return detail.assets.map((asset) => asset.sha256).sort();
      }, { timeout: 30_000 }).toEqual([aSha256, bSha256, cSha256].sort());
      await expect(page.getByText('同步中', { exact: true })).toHaveCount(0, { timeout: 120_000 });
      await expect(page.locator('[data-testid="canvas-image"][alt="a.png"], [data-testid="canvas-image"][alt="b.png"], [data-testid="canvas-image"][alt="c.png"]')).toHaveCount(3);
      const uploadedDetail = await readEnvelope<{
        assets: Array<{ id: string; sha256: string; url: string }>;
      }>(await page.request.get(`/api/visual-agent/image-master/workspaces/${workspace.id}/detail?assetLimit=20`, {
        headers: authHeaders(token),
      }));
      const deletedAssets = uploadedDetail.assets.filter((asset) => [aSha256, bSha256].includes(asset.sha256));
      expect(deletedAssets).toHaveLength(2);

      await page.locator('[data-tour-id="visual-editor-canvas"]').click({ position: { x: 180, y: 180 } });
      await page.locator('[data-testid="canvas-image"][alt="b.png"]').click();
      await page.locator('[data-testid="canvas-image"][alt="a.png"]').click({ modifiers: ['Shift'] });
      const chips = page.locator('.image-chip-node');
      await expect(chips).toHaveCount(2);
      const chipLabels = await chips.allTextContents();
      expect(chipLabels[0]).toContain('b.png');
      expect(chipLabels[1]).toContain('a.png');

      // 真实生图和线路顺序由 MVIS-001/002/008/009/011 旅程单独验收；本用例只验证编辑器
      // 自身的引用顺序与删除持久化，防止上游额度故障把本地状态回归伪装成超时。
      expect(chipLabels).toEqual(['b.png', 'a.png']);

      await page.locator('[data-testid="canvas-image"][alt="b.png"]').click();
      await page.locator('[data-testid="canvas-image"][alt="a.png"]').click({ modifiers: ['Shift'] });

      const deleteResponses: Response[] = [];
      const captureDeleteResponse = (response: Response) => {
        const url = new URL(response.url());
        if (
          response.request().method() === 'DELETE'
          && url.pathname.startsWith(`/api/visual-agent/image-master/workspaces/${workspace.id}/assets/`)
        ) {
          deleteResponses.push(response);
        }
      };
      page.on('response', captureDeleteResponse);
      const canvasSaveResponsePromise = page.waitForResponse((response) => (
        new URL(response.url()).pathname === `/api/visual-agent/image-master/workspaces/${workspace.id}/canvas`
        && response.request().method() === 'PUT'
        && String(response.request().headers()['idempotency-key'] || '').startsWith('delete_')
      ));
      await page.getByRole('button', { name: '删除选中' }).click();
      await expect(page.getByText('确认删除选中的 2 项？')).toBeVisible();
      await page.getByRole('button', { name: '删除', exact: true }).click();
      await expect(chips).toHaveCount(0);
      await expect(page.locator('[data-testid="canvas-image"][alt="a.png"], [data-testid="canvas-image"][alt="b.png"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="canvas-image"][alt="c.png"]')).toBeVisible();

      await expect.poll(() => deleteResponses.length, { timeout: 30_000 }).toBe(2);
      page.off('response', captureDeleteResponse);
      for (const response of deleteResponses) {
        await expectDeleteSucceeded(response, '多图资产删除失败');
      }
      expect(deleteResponses.map((response) => new URL(response.url()).pathname).sort()).toEqual(
        deletedAssets.map((asset) => `/api/visual-agent/image-master/workspaces/${workspace.id}/assets/${asset.id}`).sort(),
      );

      const canvasSaveResponse = await canvasSaveResponsePromise;
      const canvasSaveBody = await canvasSaveResponse.json() as ApiEnvelope<{ canvas: { payloadJson: string } }>;
      expect(canvasSaveResponse.ok(), canvasSaveBody.error?.message || '删除后画布保存失败').toBe(true);
      expect(canvasSaveBody.success, canvasSaveBody.error?.message || '删除后画布保存失败').toBe(true);
      const savedPayload = canvasSaveBody.data.canvas.payloadJson;
      for (const asset of deletedAssets) {
        expect(savedPayload).not.toContain(asset.id);
        expect(savedPayload).not.toContain(asset.sha256);
        expect(savedPayload).not.toContain(asset.url);
      }

      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('input[type="file"][accept="image/*"]')).toBeEnabled({ timeout: 30_000 });
      await expect(page.locator('[data-testid="canvas-image"][alt="a.png"], [data-testid="canvas-image"][alt="b.png"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="canvas-image"][alt="c.png"]')).toBeVisible({ timeout: 30_000 });
      const reloadedDetail = await readEnvelope<{
        assets: Array<{ id: string; sha256: string; url: string }>;
        canvas: { payloadJson: string } | null;
      }>(await page.request.get(`/api/visual-agent/image-master/workspaces/${workspace.id}/detail?assetLimit=20`, {
        headers: authHeaders(token),
      }));
      const reloadedAssetShas = reloadedDetail.assets.map((asset) => asset.sha256);
      expect(reloadedAssetShas).toContain(cSha256);
      expect(reloadedAssetShas).not.toContain(aSha256);
      expect(reloadedAssetShas).not.toContain(bSha256);
      for (const asset of deletedAssets) {
        expect(reloadedDetail.canvas?.payloadJson || '').not.toContain(asset.id);
        expect(reloadedDetail.canvas?.payloadJson || '').not.toContain(asset.sha256);
        expect(reloadedDetail.canvas?.payloadJson || '').not.toContain(asset.url);
      }

      await page.locator('[data-testid="canvas-image"][alt="c.png"]').click();
      const verificationChips = page.locator('.image-chip-node');
      await expect(verificationChips).toHaveCount(1);
      await expect(verificationChips.first()).toContainText('c.png');

      await testInfo.attach('multi-image-reorder-delete', { body: await page.screenshot(), contentType: 'image/png' });
    } finally {
      const deleted = await page.request.delete(`/api/visual-agent/image-master/workspaces/${workspace.id}`, {
        headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-reorder-delete` },
      });
      await expectDeleteSucceeded(deleted, `多图验收项目 ${workspace.id} 清理失败`);
    }
  });

  test('[MVIS-005][MVIS-006] 多图重复与超限输入给出明确行为', { tag: '@cleanup' }, async ({ page, request }, testInfo) => {
    test.skip(requiredEnv('STABLE_SMOKE_ENVIRONMENT') === 'production', '正式环境策略禁止主动运行重复和超限图片输入');
    test.setTimeout(240_000);
    const token = await loginAndReadToken(page, request, '/visual-agent');
    const { workspace } = await createVisualWorkspace(page, token, 'multi-image-boundaries');
    const png = Buffer.from(solidPngDataUrl(45, 120, 210, 32).split(',')[1]!, 'base64');
    const file = (name: string) => ({ name, mimeType: 'image/png', buffer: png });
    try {
      await page.goto(`/visual-agent/${workspace.id}`, { waitUntil: 'domcontentloaded' });
      await dismissBlockingTutorial(page);
      const picker = page.locator('input[type="file"][accept="image/*"]');
      await expect(picker, '工作区回放完成后才允许上传，避免服务器空快照覆盖新图片').toBeEnabled({ timeout: 30_000 });

      await picker.setInputFiles([file('dup1.png'), file('dup2.png')]);
      await expect(page.getByTestId('canvas-image')).toHaveCount(2, { timeout: 30_000 });
      await expect(page.getByText('已把 2 张图片加入画板。你可以选中其中一张作为首帧，或用 @imgN 引用多张图。')).toBeVisible();
      await expect(page.locator('[data-testid="canvas-image"][alt="dup1.png"]')).toHaveCount(1);
      await expect(page.locator('[data-testid="canvas-image"][alt="dup2.png"]')).toHaveCount(1);

      await picker.setInputFiles(Array.from({ length: 21 }, (_, index) => file(`limit-${String(index + 1).padStart(2, '0')}.png`)));
      await expect(page.getByText('一次最多上传 20 张，已保留前 20 张；其余图片未上传，请分批添加')).toBeVisible();
      await expect(page.getByTestId('canvas-image')).toHaveCount(22, { timeout: 60_000 });
      await expect(page.locator('[data-testid="canvas-image"][alt="limit-21.png"]')).toHaveCount(0);
      await expect(page.getByText('同步中', { exact: true })).toHaveCount(0, { timeout: 120_000 });
      await testInfo.attach('multi-image-boundaries', { body: await page.screenshot(), contentType: 'image/png' });
    } finally {
      const deleted = await page.request.delete(`/api/visual-agent/image-master/workspaces/${workspace.id}`, {
        headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-boundaries-delete` },
      });
      await expectDeleteSucceeded(deleted, `删除多图边界工作区 ${workspace.id} 失败`);
    }
  });

  test('[MVIS-010] 多图引用失败只显示结果与恢复动作', { tag: '@cleanup' }, async ({ page, request }, testInfo) => {
    test.setTimeout(180_000);
    const token = await loginAndReadToken(page, request, '/visual-agent');
    const { workspace } = await createVisualWorkspace(page, token, 'multi-image-readable-error');
    let runId = '';
    try {
      const valid = await readEnvelope<{ asset: { sha256: string; url: string } }>(
        await page.request.post(`/api/visual-agent/image-master/workspaces/${workspace.id}/assets`, {
          headers: {
            ...authHeaders(token),
            'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-readable-valid-ref`,
          },
          data: { data: solidPngDataUrl(35, 90, 190), width: 256, height: 256, prompt: '有效参考图' },
        }),
      );
      const pools = await readEnvelope<ImageModelPool[]>(
        await page.request.get('/api/visual-agent/image-gen/models/vision', { headers: authHeaders(token) }),
      );
      const pool = pools.find((item) => item.models.some((model) => !/unhealthy|disabled/i.test(model.healthStatus || '')));
      expect(pool, '没有可用的多图视觉逻辑模型').toBeTruthy();
      const prompt = '参考 @img1 和 @img2 生成一张构图测试图';
      const created = await readEnvelope<{ runId: string }>(
        await page.request.post(`/api/visual-agent/image-master/workspaces/${workspace.id}/image-gen/runs`, {
          headers: {
            ...authHeaders(token),
            'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-readable-error-run`,
          },
          data: {
            prompt,
            userMessageContent: prompt,
            targetKey: `${requiredEnv('STABLE_SMOKE_RUN_ID')}-readable-error-target`,
            platformId: 'logical-model',
            modelId: pool!.code,
            size: '1024x1024',
            responseFormat: 'url',
            imageRefs: [
              { refId: 1, assetSha256: valid.asset.sha256, url: valid.asset.url, label: '有效参考图', role: 'target' },
              { refId: 2, assetSha256: 'e'.repeat(64), url: '', label: '不可用参考图', role: 'style' },
            ],
            x: 0,
            y: 0,
            w: 1001,
            h: 1001,
          },
        }),
      );
      runId = created.runId;
      const terminal = await waitForImageRun(page, token, runId);
      expect(terminal.detail.run.status).toBe('Failed');
      const errorMessage = terminal.detail.items[0]?.errorMessage || '';
      expect(errorMessage).toContain('@img2');
      expect(errorMessage).toContain('其他输入已保留');
      expectUserReadable(errorMessage);
      expect(errorMessage).not.toMatch(/HTTP|token|provider|offering|endpoint|protocol|stack|exception/i);

      await page.goto(`/visual-agent/${workspace.id}`, { waitUntil: 'domcontentloaded' });
      await dismissBlockingTutorial(page);
      const visibleError = page.getByText(/参考图 @img2 无法使用/);
      await expect(visibleError).toBeVisible({ timeout: 30_000 });
      await expect(visibleError).toContainText('其他输入已保留');
      await testInfo.attach('multi-image-readable-error', { body: await page.screenshot(), contentType: 'image/png' });
    } finally {
      const deleted = await page.request.delete(`/api/visual-agent/image-master/workspaces/${workspace.id}`, {
        headers: {
          ...authHeaders(token),
          'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-readable-error-delete`,
        },
      });
      await expectDeleteSucceeded(deleted, `删除可读错误工作区 ${workspace.id} 失败`);
      if (runId) {
        expect((await page.request.get(`/api/visual-agent/image-gen/runs/${runId}`, {
          headers: authHeaders(token),
        })).status()).toBe(404);
      }
    }
  });

  test('[MVIS-007] 损坏引用指出具体图片并保留其他输入', { tag: '@cleanup' }, async ({ page, request }, testInfo) => {
    test.skip(requiredEnv('STABLE_SMOKE_ENVIRONMENT') === 'production', '正式环境策略禁止主动运行损坏图片引用');
    test.setTimeout(180_000);
    const token = await loginAndReadToken(page, request, '/visual-agent');
    const { workspace } = await createVisualWorkspace(page, token, 'multi-image-broken-reference');
    let runId = '';
    try {
      const assetResponse = await page.request.post(`/api/visual-agent/image-master/workspaces/${workspace.id}/assets`, {
        headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-valid-ref` },
        data: { data: solidPngDataUrl(35, 90, 190), width: 256, height: 256, prompt: '有效参考图' },
      });
      const valid = await readEnvelope<{ asset: { sha256: string; url: string } }>(assetResponse);
      const pools = await readEnvelope<ImageModelPool[]>(
        await page.request.get('/api/visual-agent/image-gen/models/vision', { headers: authHeaders(token) }),
      );
      const pool = pools.find((item) => item.models.some((model) => !/unhealthy|disabled/i.test(model.healthStatus || '')));
      expect(pool, '没有可用的多图视觉逻辑模型').toBeTruthy();
      const prompt = '参考 @img1 和 @img2 生成一张构图测试图';
      const create = await page.request.post(`/api/visual-agent/image-master/workspaces/${workspace.id}/image-gen/runs`, {
        headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-broken-ref-run` },
        data: {
          prompt,
          userMessageContent: prompt,
          targetKey: `${requiredEnv('STABLE_SMOKE_RUN_ID')}-broken-ref-target`,
          platformId: 'logical-model',
          modelId: pool!.code,
          size: '1024x1024',
          responseFormat: 'url',
          imageRefs: [
            { refId: 1, assetSha256: valid.asset.sha256, url: valid.asset.url, label: '有效参考图', role: 'target' },
            { refId: 2, assetSha256: 'f'.repeat(64), url: '', label: '已损坏参考图', role: 'style' },
          ],
          x: 0,
          y: 0,
          w: 1001,
          h: 1001,
        },
      });
      runId = (await readEnvelope<{ runId: string }>(create)).runId;
      const terminal = await waitForImageRun(page, token, runId);
      expect(terminal.detail.run.status).toBe('Failed');
      const errorMessage = terminal.detail.items[0]?.errorMessage || '';
      expect(errorMessage).toContain('@img2');
      expect(errorMessage).toContain('其他输入已保留');
      expectUserReadable(errorMessage);

      const messages = await page.request.get(`/api/visual-agent/image-master/workspaces/${workspace.id}/messages`, { headers: authHeaders(token) });
      const messageData = (await messages.json() as ApiEnvelope<{
        messages: Array<{ role: string; content: string }>;
      }>).data;
      expect(messageData.messages.some((message) => message.role === 'User' && message.content === prompt)).toBe(true);
      const storedError = messageData.messages.find((message) => message.role === 'Assistant' && message.content.startsWith('[GEN_ERROR]'));
      expect(storedError, '损坏引用失败消息必须持久化').toBeTruthy();
      const storedErrorPayload = JSON.parse(storedError!.content.slice('[GEN_ERROR]'.length)) as { msg: string; prompt: string };
      expect(storedErrorPayload.prompt).toBe(prompt);
      expect(storedErrorPayload.msg).toContain('@img2');
      expect(storedErrorPayload.msg).toContain('其他输入已保留');

      await page.goto(`/visual-agent/${workspace.id}`, { waitUntil: 'domcontentloaded' });
      await dismissBlockingTutorial(page);
      await expect(page.getByText(/参考图 @img2 无法使用/)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/其他输入已保留/)).toBeVisible();
      await testInfo.attach('multi-image-broken-reference', { body: await page.screenshot(), contentType: 'image/png' });
    } finally {
      const deleted = await page.request.delete(`/api/visual-agent/image-master/workspaces/${workspace.id}`, {
        headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-broken-ref-delete` },
      });
      await expectDeleteSucceeded(deleted, `删除失效引用工作区 ${workspace.id} 失败`);
      if (runId) {
        expect((await page.request.get(`/api/visual-agent/image-gen/runs/${runId}`, { headers: authHeaders(token) })).status()).toBe(404);
      }
    }
  });
});
