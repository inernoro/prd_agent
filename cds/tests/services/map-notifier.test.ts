/**
 * 存活告警 → MAP 站内通知（2026-09-09，规则 degradation-must-alarm 层 4）。
 *
 * 守四件事：
 *   1. canonical 与 MAP 的 BuildCanonicalRequest 逐字节一致——这是**两侧各写一份**的
 *      判据，最容易各自漂移（形状 3），所以用固定向量钉死格式；
 *   2. 签名真的能被 RSA-PSS 公钥验证（等价于 MAP 侧 VerifySignature 的那套参数），
 *      padding 或 saltLength 写错会在线上变成静默的 invalid_signature；
 *   3. 载荷映射：掉线/恢复的级别、幂等键、正文写症状与下一步；
 *   4. index.ts 的接线在场——少这一行，铃装好了但永远不会响，
 *      而这正是本规则要治的病，不能自己先犯。
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateService } from '../../src/services/state.js';
import { NotificationReportRecorder } from '../../src/services/notification-report.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { AlarmEvent } from '../../src/services/alarm-route.js';
import { fileURLToPath } from 'node:url';
import {
  buildCanonicalRequest,
  signCanonical,
  buildNotificationPayload,
  mapNotifierConfigFromEnv,
  DEFAULT_TIMEOUT_MS,
} from '../../src/services/map-notifier.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');

describe('canonical 请求串', () => {
  it('格式与 MAP 的 BuildCanonicalRequest 逐字节一致', () => {
    // 固定向量：METHOD \n path \n timestamp \n nonce \n username \n sha256hex(body)
    // body 的哈希是小写十六进制（C# 侧 Convert.ToHexString(...).ToLowerInvariant()）。
    const canonical = buildCanonicalRequest(
      'post',
      '/api/dashboard/notifications/events',
      1757404800,
      'nonce-1',
      'cds-uptime-bot',
      '{"a":1}',
    );
    // 字面量而不是现算：现算等于「用同一份逻辑验证自己」，锁不住跨语言契约。
    // 这一串同时写死在 C# 侧 CanonicalRequestCrossLanguageContractTests 里，
    // 任一侧改格式，两边都会红。
    const expectedHash = '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862';
    expect(crypto.createHash('sha256').update('{"a":1}', 'utf8').digest('hex')).toBe(expectedHash);

    expect(canonical).toBe(
      [
        'POST',                                   // 方法大写
        '/api/dashboard/notifications/events',
        '1757404800',
        'nonce-1',
        'cds-uptime-bot',
        expectedHash,
      ].join('\n'),
    );
    // 小写十六进制，不是 Base64、不带分隔符
    expect(expectedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('空 body 也按 sha256 哈希，不是空串', () => {
    const canonical = buildCanonicalRequest('POST', '/p', 1, 'n', 'u', '');
    expect(canonical.split('\n')[5]).toBe(
      crypto.createHash('sha256').update('', 'utf8').digest('hex'),
    );
  });
});

describe('签名', () => {
  it('产出的签名能被 RSA-PSS/SHA256 公钥验证（与 MAP 侧同参数）', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const canonical = buildCanonicalRequest('POST', '/p', 1757404800, 'n1', 'u1', '{}');

    const signature = signCanonical(privatePem, canonical);

    // 这段验证逻辑刻意与 MAP 的 VerifySignature 同参数：
    // RSA-PSS + SHA256 + salt=摘要长度。改动任一项，线上会变成静默 401。
    const ok = crypto.verify(
      'sha256',
      Buffer.from(canonical, 'utf8'),
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      },
      Buffer.from(signature, 'base64'),
    );
    expect(ok).toBe(true);
  });

  it('换一个字签名就不成立（证明签的是 canonical 本身）', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const signature = signCanonical(privatePem, 'AAA');

    const ok = crypto.verify(
      'sha256',
      Buffer.from('AAB', 'utf8'),
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      },
      Buffer.from(signature, 'base64'),
    );
    expect(ok).toBe(false);
  });
});

describe('通知载荷', () => {
  const base = {
    targetId: 'monitor@abc',
    targetName: 'LLM Gateway serving',
    projectId: 'prd-agent',
    branchId: 'main',
    message: '探测连续失败',
    consecutiveFailures: 2,
    detectedAt: '2026-09-09T09:00:00.000Z',
  };

  it('检查异常是 warning 级、短句与详情分离；来源与分区固定', () => {
    const p = buildNotificationPayload({ ...base, type: 'uptime.target.down' });
    expect(p.source).toBe('uptime-alert');   // 必须与 MAP SourceCatalog 登记的一致
    expect(p.section).toBe('admin');
    expect(p.level).toBe('warning');
    expect(p.title).toContain('检查异常');
    expect(p.message).toContain('影响范围尚未确认');
    expect(p.message).toContain('查看监控详情');
    expect(p.title).toBe('LLM Gateway serving · 监控检查异常，原因未明 · 环境待确认 系统待确认');
    expect(p.message).not.toContain('下一步');   // 症状 + 下一步，不是只报个错
    expect(p.title).toContain('原因未明');
  });

  it('恢复是 info 级，不带下一步', () => {
    const p = buildNotificationPayload({ ...base, type: 'uptime.target.recovered' });
    expect(p.level).toBe('info');
    expect(p.title).toContain('已恢复');
    expect(p.message).toContain('已满足恢复条件');
    expect(p.message).not.toContain('下一步');
  });

  it('生产主动故障保留严重级别，采集异常与恢复不提权', () => {
    expect(buildNotificationPayload({ ...base, type: 'uptime.target.down', urgency: 'urgent' }).level).toBe('error');
    expect(buildNotificationPayload({ ...base, type: 'uptime.target.down', urgency: 'urgent', assessment: 'observation-unavailable' }).level).toBe('warning');
    expect(buildNotificationPayload({ ...base, type: 'uptime.target.recovered', urgency: 'urgent' }).level).toBe('info');
  });

  it('幂等键区分方向与时刻：同一次翻转可去重，不同次翻转不被合并', () => {
    const down = buildNotificationPayload({ ...base, type: 'uptime.target.down' });
    const again = buildNotificationPayload({ ...base, type: 'uptime.target.down' });
    const recovered = buildNotificationPayload({ ...base, type: 'uptime.target.recovered' });
    const laterDown = buildNotificationPayload({
      ...base,
      type: 'uptime.target.down',
      detectedAt: '2026-09-09T10:00:00.000Z',
    });

    expect(down.dedupKey).toBe(again.dedupKey);
    expect(down.dedupKey).not.toBe(recovered.dedupKey);
    expect(down.dedupKey).not.toBe(laterDown.dedupKey);
  });

  it('有被监控地址时给出可点击动作', () => {
    const p = buildNotificationPayload({
      ...base,
      type: 'uptime.target.down',
      probeUrl: 'https://example.test/healthz',
    });
    expect(p.actionUrl).toBe('https://example.test/healthz');
    expect(p.actionLabel).toBeTruthy();
  });
});

describe('配置解析', () => {
  const full = {
    CDS_MAP_NOTIFY_ENDPOINT: 'https://map.test/api/dashboard/notifications/events',
    CDS_MAP_NOTIFY_KEY_ID: 'k1',
    CDS_MAP_NOTIFY_USERNAME: 'cds-uptime-bot',
    CDS_MAP_NOTIFY_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nAAA\\n-----END PRIVATE KEY-----',
  } as NodeJS.ProcessEnv;

  it('齐全时解析成功，并把字面 \\n 还原成真换行', () => {
    const cfg = mapNotifierConfigFromEnv(full);
    expect(cfg).not.toBeNull();
    // env 里的 PEM 常被写成字面 \n；不还原的话 crypto 会直接抛，铃在第一次告警时才哑
    expect(cfg!.privateKeyPem).toContain('\n');
    expect(cfg!.privateKeyPem).not.toContain('\\n');
    expect(cfg!.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('缺任何一项都返回 null（宁可明说没配，也不半配着跑）', () => {
    for (const key of Object.keys(full)) {
      const partial = { ...full };
      delete partial[key];
      expect(mapNotifierConfigFromEnv(partial), `缺 ${key} 时应为 null`).toBeNull();
    }
  });
});

describe('接线守卫', () => {
  const indexSource = fs.readFileSync(path.join(REPO, 'cds/src/index.ts'), 'utf8');

  it('onAlert 里必须真的把告警投出去 —— 少这一行铃永远不会响', () => {
    const at = indexSource.indexOf('onAlert: async (type, data) => {');
    expect(at, '找不到 uptime 的 onAlert 接线，守卫的取值范围需要跟着改').toBeGreaterThanOrEqual(0);
    const block = indexSource.slice(at, indexSource.indexOf('configurePhoneDispatch(', at));
    expect(block).toContain('cdsEventsBus.publish');
    // 断言「有东西被 send 出去」，而不是某个变量名的字面拼写：
    // 2026-09-14 通知器从启动时定死改成现解析（凭据改完不必重启），
    // 写死 `mapNotifier?.send` 的旧判据当场变红——它锁的是实现写法不是行为
    // （predicate-and-wiring-discipline 形状 4a）。
    expect(block).toContain('sendLegacyAlarm(');
    expect(block).toContain('urgency: data.urgency');
    const sender = indexSource.slice(indexSource.indexOf('const sendLegacyAlarm'), indexSource.indexOf('const alarmBoardUrl'));
    expect(sender).toContain('resolveMapNotifier()');
    expect(sender).toContain('notifier.send(alert)');
  });

  it('未配置凭据时必须把「不会有人被通知」印出来，不许静默禁用', () => {
    expect(indexSource).toContain('[map-notifier] 未配置');
    expect(indexSource).toContain('不会有人被通知');
  });
});

it('MAP 通道实际 HTTP 保留故障与恢复，演练不登记真实故障或提权', async () => {
  const { sendAlarm } = await import('../../src/services/alarm-dispatch.js');
  const received: ReturnType<typeof buildNotificationPayload>[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const channel = { id: 'map-fixture', name: 'MAP', enabled: true, kind: 'map' as const, projects: [], events: [] as [], createdAt: 0, updatedAt: 0,
    map: { endpoint: `http://127.0.0.1:${(server.address() as {port: number}).port}/events`, keyId: 'fixture', username: 'fixture', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } };
  const event = { kind: 'business-down' as const, projectId: 'fixture', targetName: '业务访问', urgency: 'urgent' as const,
    message: '未响应', consecutiveFailures: 3, detectedAt: '2026-10-19T00:00:00Z',
    eventId: 'fixture-event', firstOccurredAt: '2026-10-19T00:00:00Z', lastOccurredAt: '2026-10-19T00:00:00Z', occurrenceCount: 3 };
  try {
    expect((await sendAlarm(channel, event)).ok).toBe(true);
    expect((await sendAlarm(channel, { ...event, assessment: 'observation-unavailable' })).ok).toBe(true);
    expect((await sendAlarm(channel, { ...event, drill: true })).ok).toBe(true);
    expect((await sendAlarm(channel, { ...event, kind: 'business-recovered' })).ok).toBe(true);
    expect(received.map(payload => payload.level)).toEqual(['error', 'warning', 'warning', 'info']);
    expect(received[0].incidentState).toBe('active');
    expect(received[3].incidentState).toBe('recovered');
    expect(received[3].incidentId).toBe(received[0].incidentId);
    const drill = received[2];
    for (const field of ['incidentId', 'incidentState', 'firstOccurredAt', 'lastOccurredAt', 'recoveredAt', 'occurrenceCount', 'requestOutcome']) {
      expect(drill, `演练不应伪造真实故障字段 ${field}`).not.toHaveProperty(field);
    }
    expect(drill.title).toContain('演练');
    expect(drill.message).toContain('演练');
    expect(drill.dedupKey).not.toBe(received[0].dedupKey);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


describe('通知返回具体检查详情', () => {
  it('详情链接优先于内部探测地址，保留原有去重键', () => {
    const payload = buildNotificationPayload({ type: 'uptime.target.down', targetId: 'monitor@x', targetName: '任务', boardUrl: 'https://control.example/status?target=monitor%40x', probeUrl: 'http://127.0.0.1:9900/api/self-check', message: '未通过', consecutiveFailures: 3, detectedAt: '2026-09-24T00:00:00Z' });
    expect(payload.actionUrl).toBe('https://control.example/status?target=monitor%40x');
    expect(payload.actionLabel).toBe('查看问题与处理建议');
    expect(payload.dedupKey).toBe('uptime:monitor@x:down:2026-09-24T00:00:00Z');
  });
});


it.each(['未归档失败', '旧四字段报告'] as const)('真实恢复only归档可投递且不虚构事故计数：%s', async history => {
  const { sendAlarm } = await import('../../src/services/alarm-dispatch.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-recovery-only-'));
  const state = new StateService(path.join(dir, 'state.json'), dir); state.load();
  const recorder = new NotificationReportRecorder(state);
  const received: ReturnType<typeof buildNotificationPayload>[] = [];
  const statuses: number[] = [];
  // 仅模拟 MAP 的incident count校验；不是实际MAP服务或真实用户送达。
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw) as ReturnType<typeof buildNotificationPayload>;
    received.push(payload);
    const status = payload.incidentId && !(Number(payload.occurrenceCount) >= 1) ? 400 : 200;
    if (status === 400) console.info('isolated MAP contract rejection', JSON.stringify({ count: payload.occurrenceCount, incidentId: payload.incidentId, actionUrl: payload.actionUrl }));
    statuses.push(status); res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { success: true } : { success: false, error: { message: 'fixture incident count must be >= 1' } }));
  });
  server.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const channel = { id: 'map-recovery-fixture', name: '本机MAP合同模拟', enabled: true, kind: 'map' as const, projects: [], events: [] as [], createdAt: 0, updatedAt: 0,
    map: { endpoint: `http://127.0.0.1:${(server.address() as {port: number}).port}/api/dashboard/notifications/events`, keyId: 'fixture', username: 'fixture', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } };
  const event: AlarmEvent = { kind: 'business-down', projectId: 'fixture', targetId: 'monitor@owned-service', targetName: '隔离业务监控', incidentId: 'original-probe-incident',
    identity: { subject: { id: 'owned-service', name: '隔离服务', environment: '正式' }, observer: { id: 'owned-observer', name: '隔离观测实例', environment: '正式' } },
    notificationFacts: { system: 'map', environment: 'production', function: '问答' },
    message: '检查未通过', consecutiveFailures: 3, detectedAt: '2026-11-14T00:00:00.000Z' };
  let legacyId: string | undefined;
  try {
    if (history === '旧四字段报告') {
      const archived = await recorder.record(event); legacyId = archived.reportId;
      await state.updateAcceptanceReportAsync(legacyId, { sourcePath: JSON.stringify([event.projectId, event.targetId, event.notificationFacts!.environment, event.identity!.subject.id]) });
    }
    const recovery: AlarmEvent = { ...event, kind: 'business-recovered', message: '检查恢复', consecutiveFailures: 0, detectedAt: '2026-11-14T00:11:00.000Z' };
    const only = await recorder.record(recovery);
    expect(only.occurrenceCount).toBe(0);
    const onlyReport = state.getAcceptanceReport(only.reportId)!;
    expect(onlyReport.monitorEvent!.state).toBe('recovered');
    expect(onlyReport.monitorEvent!.incidentId).toBe(recovery.incidentId);
    expect(onlyReport.monitorEvent!.snapshots[0].detectedAt).toBe(recovery.detectedAt);
    expect(onlyReport.monitorEvent!.snapshots.map(s => s.kind)).toEqual(['business-recovered']);
    if (legacyId) { expect(only.reportId).not.toBe(legacyId); expect(state.getAcceptanceReport(legacyId)!.monitorEvent!.state).toBe('open'); }
    const content = await state.readAcceptanceReportContentAsync(only.reportId);
    expect(content).toContain('告警发生 0 次');
    const href = content.match(/\[查看同一监控目标\]\(([^)]+)\)/)![1];
    const boardUrl = new URL(href, 'https://preview.invalid').href;
    expect(new URL(boardUrl).searchParams.get('target')).toBe(event.targetId);
    expect(new URL(boardUrl).searchParams.get('incident')).toBe(recovery.incidentId);
    expect(new URL(boardUrl).searchParams.get('detectedAt')).toBe(recovery.detectedAt);
    const result = await sendAlarm(channel, { ...recovery, ...only }, { boardUrl });
    expect(result.ok, `本机合同接收状态 ${statuses.join(',')}`).toBe(true);
    expect(statuses).toEqual([200]);
    const payload = received[0];
    for (const field of ['incidentId', 'incidentState', 'firstOccurredAt', 'lastOccurredAt', 'recoveredAt', 'occurrenceCount', 'requestOutcome']) expect(payload).not.toHaveProperty(field);
    expect(payload).toMatchObject({ source: 'uptime-alert', section: 'admin', level: 'info', actionUrl: boardUrl });
    expect(payload.title).toContain('已恢复'); expect(payload.message).toContain('已满足恢复条件');
    expect(payload).not.toHaveProperty('targetUserId');
    expect((await sendAlarm(channel, { ...recovery, ...only }, { boardUrl })).ok).toBe(true);
    expect(received[1].dedupKey).toBe(payload.dedupKey);
    expect(only.occurrenceCount).toBe(0);
    const failed: AlarmEvent = { ...event, incidentId: 'current-probe-incident', detectedAt: '2026-11-14T00:20:00.000Z' };
    const savedFailure = await recorder.record(failed);
    expect(savedFailure.occurrenceCount).toBe(1);
    const normalContent = await state.readAcceptanceReportContentAsync(savedFailure.reportId);
    const normalHref = normalContent.match(/\[查看同一监控目标\]\(([^)]+)\)/)![1];
    const normalBoardUrl = new URL(normalHref, 'https://preview.invalid').href;
    expect((await sendAlarm(channel, { ...failed, ...savedFailure }, { boardUrl: normalBoardUrl })).ok).toBe(true);
    const recovered: AlarmEvent = { ...recovery, incidentId: failed.incidentId, detectedAt: '2026-11-14T00:31:00.000Z' };
    const savedRecovery = await recorder.record(recovered);
    expect(savedRecovery.occurrenceCount).toBe(1); expect(savedRecovery.eventId).toBe(savedFailure.eventId);
    expect((await sendAlarm(channel, { ...recovered, ...savedRecovery }, { boardUrl: normalBoardUrl })).ok).toBe(true);
    expect(received[2]).toMatchObject({ incidentState: 'active', occurrenceCount: 1 });
    expect(received[3]).toMatchObject({ incidentId: received[2].incidentId, incidentState: 'recovered', occurrenceCount: 1, firstOccurredAt: failed.detectedAt, lastOccurredAt: failed.detectedAt, recoveredAt: recovered.detectedAt });
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await state.flush(); await flushAllJsonStateStores(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
