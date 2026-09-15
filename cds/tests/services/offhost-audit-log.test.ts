import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OffHostAuditLogSink, offHostAuditConfigFromEnv } from '../../src/services/offhost-audit-log.js';
import type { ServerEventLogSink } from '../../src/services/server-event-log-store.js';

describe('离机审计日志', () => {
  it('缺配置时明确禁用', () => {
    expect(offHostAuditConfigFromEnv({ R2_ENDPOINT: 'https://storage.invalid' })).toBeNull();
  });

  it('每条事件使用唯一对象并完成大小与 checksum 校验', async () => {
    const local: unknown[] = [];
    const primary: ServerEventLogSink = { record: (row) => { local.push(row); } };
    let uploaded = Buffer.alloc(0);
    const urls: string[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      urls.push(String(input));
      if (init?.method === 'PUT') {
        uploaded = Buffer.from(init.body as Buffer);
        return new Response('', { status: 200 });
      }
      return new Response('', {
        status: 200,
        headers: {
          'content-length': String(uploaded.byteLength),
          'x-amz-meta-sha256': crypto.createHash('sha256').update(uploaded).digest('hex'),
        },
      });
    };
    const sink = new OffHostAuditLogSink({
      primary,
      config: {
        endpoint: 'https://storage.invalid', bucket: 'audit', prefix: 'unused',
        accessKeyId: 'access-id', secretAccessKey: 'secret-key',
      },
      prefix: 'audit/events',
      fetchImpl: fetchImpl as typeof fetch,
    });
    sink.record({
      category: 'system', severity: 'info', source: 'operator-console',
      action: 'operator.request.approved', message: 'approved',
      details: { token: 'must-not-leak', actor: 'admin' },
      ts: '2026-08-17T01:02:03Z',
    });
    await sink.flush();
    expect(local).toHaveLength(1);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('/audit/events/2026/08/17/');
    const payload = uploaded.toString('utf8');
    expect(payload).toContain('operator.request.approved');
    expect(payload).not.toContain('must-not-leak');
    expect(sink.pendingCount).toBe(0);
  });

  // 2026-09-08 宿主过载复盘：线上连续失败 54256 次，每条事件都撞一次上传并各写一条
  // 错误事件（每秒 2 条）。熔断后只留本地、限频上报、探路成功再恢复。
  describe('熔断', () => {
    const config = {
      endpoint: 'https://storage.invalid', bucket: 'audit', prefix: 'unused',
      accessKeyId: 'access-id', secretAccessKey: 'secret-key',
    };
    const event = (n: number) => ({
      category: 'system' as const, severity: 'info' as const, source: 'test',
      action: `test.event.${n}`, message: `e${n}`,
    });

    it('连续失败到阈值即打开：之后的事件只落本地、不再上传，失败事件限频', async () => {
      let now = 1_000_000;
      const local: Array<{ action: string; message?: string; details?: Record<string, unknown> }> = [];
      const primary: ServerEventLogSink = { record: (row) => { local.push(row as never); } };
      let puts = 0;
      const fetchImpl = async (): Promise<Response> => { puts += 1; return new Response('', { status: 500 }); };
      const sink = new OffHostAuditLogSink({
        primary, config, prefix: 'audit/events',
        fetchImpl: fetchImpl as typeof fetch,
        now: () => now,
        breakerOpenAfter: 3,
        breakerRetryMs: 5 * 60_000,
        failureEventMinIntervalMs: 60_000,
      });
      for (let i = 0; i < 3; i += 1) {
        sink.record(event(i));
        await sink.flush();
      }
      expect(puts).toBe(3);
      const failures = local.filter((r) => r.action === 'offhost.audit.write.failed');
      // 第 1 次失败一条 + 第 3 次（打开熔断）必发一条；第 2 次被 60s 限频压掉。
      expect(failures).toHaveLength(2);
      expect(failures[1].details).toMatchObject({ consecutiveFailures: 3, breakerOpen: true });
      expect(sink.breakerState()).toMatchObject({ open: true, consecutiveFailures: 3, skippedWhileOpen: 0 });

      // 熔断期间：只落本地，不再发起上传，也不再写失败事件。
      for (let i = 10; i < 30; i += 1) sink.record(event(i));
      await sink.flush();
      expect(puts).toBe(3);
      expect(local.filter((r) => r.action.startsWith('test.event.'))).toHaveLength(23);
      expect(local.filter((r) => r.action === 'offhost.audit.write.failed')).toHaveLength(2);
      expect(sink.breakerState().skippedWhileOpen).toBe(20);

      // 到探路时刻：放一条上传，失败则继续熔断并再延后。
      now += 5 * 60_000 + 1;
      sink.record(event(99));
      await sink.flush();
      expect(puts).toBe(4);
      expect(sink.breakerState().open).toBe(true);
    });

    it('熔断打开前已排队的事件轮到上传时再判一次，不再逐条撞 R2；到点只放一条半开探路（Codex P1）', async () => {
      let now = 3_000_000;
      const local: Array<{ action: string }> = [];
      const primary: ServerEventLogSink = { record: (row) => { local.push(row as never); } };
      let puts = 0;
      // 每次上传都卡 10ms 再失败：事件来得比失败快，队列里会积压。
      const fetchImpl = async (): Promise<Response> => {
        puts += 1;
        await new Promise((r) => setTimeout(r, 10));
        return new Response('', { status: 500 });
      };
      const sink = new OffHostAuditLogSink({
        primary, config, prefix: 'audit/events',
        fetchImpl: fetchImpl as typeof fetch,
        now: () => now, breakerOpenAfter: 3, breakerRetryMs: 60_000, failureEventMinIntervalMs: 0,
      });
      for (let i = 0; i < 50; i += 1) sink.record(event(i)); // 同步一次性入队 50 条
      await sink.flush();
      // 只有前 3 条真的上传（打开熔断），其余 47 条在轮到自己时被熔断拦下。
      expect(puts).toBe(3);
      expect(sink.breakerState()).toMatchObject({ open: true, skippedWhileOpen: 47 });

      // 到探路时刻一次性再入队 20 条：只放 1 条半开探路，其余 19 条跳过。
      now += 60_001;
      for (let i = 100; i < 120; i += 1) sink.record(event(i));
      await sink.flush();
      expect(puts).toBe(4);
      expect(sink.breakerState()).toMatchObject({ open: true, skippedWhileOpen: 47 + 19 });
    });

    it('探路成功即关闭熔断并补一条恢复事件（带跳过数）', async () => {
      let now = 2_000_000;
      let healthy = false;
      let uploaded = Buffer.alloc(0);
      const local: Array<{ action: string; details?: Record<string, unknown> }> = [];
      const primary: ServerEventLogSink = { record: (row) => { local.push(row as never); } };
      const fetchImpl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (!healthy) return new Response('', { status: 500 });
        if (init?.method === 'PUT') {
          uploaded = Buffer.from(init.body as Buffer);
          return new Response('', { status: 200 });
        }
        return new Response('', {
          status: 200,
          headers: {
            'content-length': String(uploaded.byteLength),
            'x-amz-meta-sha256': crypto.createHash('sha256').update(uploaded).digest('hex'),
          },
        });
      };
      const sink = new OffHostAuditLogSink({
        primary, config, prefix: 'audit/events',
        fetchImpl: fetchImpl as typeof fetch,
        now: () => now, breakerOpenAfter: 2, breakerRetryMs: 1000, failureEventMinIntervalMs: 0,
      });
      sink.record(event(1)); await sink.flush();
      sink.record(event(2)); await sink.flush();
      expect(sink.breakerState().open).toBe(true);
      sink.record(event(3));
      sink.record(event(4));
      expect(sink.breakerState().skippedWhileOpen).toBe(2);

      healthy = true;
      now += 1001;
      sink.record(event(5));
      await sink.flush();
      expect(sink.breakerState()).toMatchObject({ open: false, consecutiveFailures: 0, skippedWhileOpen: 0 });
      const recovered = local.find((r) => r.action === 'offhost.audit.write.recovered');
      expect(recovered?.details).toEqual({ skippedWhileOpen: 2 });
    });
  });
});
