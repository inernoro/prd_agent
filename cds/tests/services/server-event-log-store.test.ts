import { describe, expect, it } from 'vitest';
import { buildServerEventQuery, compactServerEventValue, normalizeLogText } from '../../src/services/server-event-log-store.js';

describe('ServerEventLogStore query builder', () => {
  it('matches operationId in both new top-level field and legacy details.operationId', () => {
    expect(buildServerEventQuery({ operationId: 'op_123' })).toEqual({
      $or: [
        { operationId: 'op_123' },
        { 'details.operationId': 'op_123' },
      ],
    });
  });

  it('keeps other filters while adding the operationId compatibility lookup', () => {
    expect(buildServerEventQuery({
      source: 'branch-operation-coordinator',
      branchId: 'prd-agent-main',
      operationId: 'op_123',
      operationKind: 'deploy',
      operationTrigger: 'webhook',
      operationActor: 'system:webhook',
      operationSource: 'api.deploy-branch',
      commitSha: 'abcdef1',
      minSeverity: 'warn',
    })).toEqual({
      source: 'branch-operation-coordinator',
      branchId: 'prd-agent-main',
      operationKind: 'deploy',
      operationTrigger: 'webhook',
      operationActor: 'system:webhook',
      operationSource: 'api.deploy-branch',
      commitSha: 'abcdef1',
      $or: [
        { operationId: 'op_123' },
        { 'details.operationId': 'op_123' },
      ],
      severity: { $in: ['warn', 'error'] },
    });
  });

  it('truncates long log bodies before they can become oversized Mongo documents', () => {
    const hugeLog = Array.from({ length: 40_000 }, (_, index) => `line-${index}=secret-value`).join('\n');
    const normalized = normalizeLogText(hugeLog, 200);

    expect(normalized.byteLength).toBe(Buffer.byteLength(hugeLog, 'utf8'));
    expect(normalized.lineCount).toBe(40_000);
    expect(Buffer.byteLength(normalized.text || '', 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect(normalized.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('caps nested object fan-out and array length before Mongo insert', () => {
    const noisyObject = Object.fromEntries(
      Array.from({ length: 250 }, (_, index) => [`field_${index}`, `value_${index}`]),
    );
    const compacted = compactServerEventValue({
      details: noisyObject,
      items: Array.from({ length: 250 }, (_, index) => ({ index, token: `secret-${index}` })),
    }) as Record<string, unknown>;

    const details = compacted.details as Record<string, unknown>;
    const items = compacted.items as unknown[];
    expect(Object.keys(details)).toHaveLength(101);
    expect(details.__cds_truncated_keys).toBe('150 object key(s) omitted');
    expect(items).toHaveLength(101);
    expect(items.at(-1)).toBe('[cds server event log truncated: 150 array item(s) omitted]');
    expect(JSON.stringify(compacted)).not.toContain('secret-0');
  });

  it('caps nested object depth before Mongo insert', () => {
    let nested: Record<string, unknown> = { leaf: 'ok' };
    for (let i = 0; i < 12; i += 1) nested = { child: nested };

    const compacted = compactServerEventValue(nested);
    expect(JSON.stringify(compacted)).toContain('max depth reached');
  });
});
