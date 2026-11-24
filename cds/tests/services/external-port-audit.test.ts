import { describe, expect, it, vi } from 'vitest';
import {
  evaluateExternalPortAudit,
  externalPortAuditConfigFromEnv,
  runExternalPortAudit,
} from '../../src/services/external-port-audit.js';

describe('宿主公网端口外部扫描', () => {
  it('只有 22、80、443 同时开放才通过', () => {
    expect(evaluateExternalPortAudit('ipv6', [443, 22, 80, 80], new Date('2026-08-17T00:00:00Z')))
      .toMatchObject({ passed: true, openPorts: [22, 80, 443] });
    expect(evaluateExternalPortAudit('ipv4', [22, 443, 12345], new Date('2026-08-17T00:00:00Z')))
      .toMatchObject({ passed: false, unexpectedOpenPorts: [12345], missingRequiredPorts: [80] });
  });

  it('扫描端点必须由部署环境动态配置', () => {
    expect(externalPortAuditConfigFromEnv({})).toBeNull();
    expect(externalPortAuditConfigFromEnv({ CDS_EXTERNAL_PORT_AUDIT_BASE_URL: 'https://scanner.invalid/' }))
      .toMatchObject({ baseUrl: 'https://scanner.invalid', intervalMs: 86_400_000 });
  });

  it('真实协议按指定网络族启动、轮询并校验完整端口集合', async () => {
    const responses = [
      { statusCode: 200, body: { status: 'queued' } },
      { statusCode: 200, body: { status: 'running' } },
      { statusCode: 200, body: { status: 'complete', ports_open: [{ port: 22 }, { port: 80 }, { port: 443 }], duration_ms: 12 } },
    ];
    const request = vi.fn(async () => responses.shift()!);
    const clock = [0, 1, 2, 3].map((seconds) => new Date(`2026-08-17T00:00:0${seconds}Z`));
    const result = await runExternalPortAudit({
      config: { baseUrl: 'https://scanner.invalid', intervalMs: 1 },
      family: 'ipv6',
      request,
      now: () => clock.shift() || new Date('2026-08-17T00:00:04Z'),
      sleep: async () => undefined,
    });
    expect(result).toMatchObject({ family: 'ipv6', passed: true, openPorts: [22, 80, 443], durationMs: 12 });
    expect(request.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      ['POST', 'ipv6'], ['GET', 'ipv6'], ['GET', 'ipv6'],
    ]);
  });
});
