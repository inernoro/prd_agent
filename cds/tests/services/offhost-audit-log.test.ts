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
});
