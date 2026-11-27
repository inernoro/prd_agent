import { MongoClient, type Db } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import {
  buildServerEventQuery,
  compactServerEventValue,
  enrichServerEventRecord,
  normalizeLogText,
  ServerEventLogStore,
} from '../../src/services/server-event-log-store.js';
import { runWithAgentOperationContext } from '../../src/services/agent-operation-context.js';

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

  it('can query consecutive observation windows without counting the boundary twice', () => {
    const since = '2026-11-27T00:00:00Z';
    const before = '2026-12-04T00:00:00Z';
    expect(buildServerEventQuery({ since, before, source: 'artifact-verification' })).toEqual({
      source: 'artifact-verification', ts: { $gte: new Date(since), $lt: new Date(before) },
    });
  });

  it('retains verification operations for 14 days independently of the general log quota and TTL', async () => {
    const general = { createIndex: vi.fn(), insertOne: vi.fn(), countDocuments: vi.fn().mockResolvedValue(0) };
    const cursor = { sort: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), toArray: vi.fn().mockResolvedValue([]) };
    const verification = { createIndex: vi.fn(), insertOne: vi.fn(), find: vi.fn().mockReturnValue(cursor) };
    const collection = vi.fn((name: string) => name === 'custom_events' ? general : verification);
    const connect = vi.spyOn(MongoClient.prototype, 'connect').mockResolvedValue({} as MongoClient);
    const db = vi.spyOn(MongoClient.prototype, 'db').mockReturnValue({ collection } as unknown as Db);
    const close = vi.spyOn(MongoClient.prototype, 'close').mockResolvedValue();
    const store = new ServerEventLogStore({ uri: 'mongodb://127.0.0.1:1', collectionName: 'custom_events', retentionDays: 1 });
    try {
      await store.init();
      expect(collection).toHaveBeenCalledWith('custom_events_artifact_verification');
      expect(general.createIndex).toHaveBeenCalledWith({ ts: 1 }, { name: 'ttl_ts', expireAfterSeconds: 86_400 });
      expect(verification.createIndex).toHaveBeenCalledWith({ ts: 1 }, { name: 'ttl_ts', expireAfterSeconds: 14 * 86_400 });
      store.record({ category: 'system', severity: 'info', source: 'artifact-verification', action: 'artifact-verification.attempt', operationId: 'op_1' });
      await store.flush();
      expect(verification.insertOne).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'op_1' }));
      expect(general.insertOne).not.toHaveBeenCalled();
      expect(general.countDocuments).not.toHaveBeenCalled();
      await store.findRecent({ source: 'artifact-verification', projectId: 'map', since: '2026-11-27T00:00:00Z' });
      expect(verification.find).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'map', source: 'artifact-verification' }));
    } finally {
      await store.close();
      connect.mockRestore();
      db.mockRestore();
      close.mockRestore();
    }
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

  it('enriches mutation events from the central operation context', () => {
    const enriched = runWithAgentOperationContext({
      requestId: 'req_event_1',
      operationId: 'op_event_1',
      identity: {
        identityVersion: 1,
        confidence: 'declared',
        agentSessionId: 'session-event-1',
        operationReason: 'safe reason',
      },
    }, () => enrichServerEventRecord({
      category: 'system',
      severity: 'info',
      source: 'api-mutation',
      action: 'api.request.completed',
    }));

    expect(enriched).toMatchObject({
      requestId: 'req_event_1',
      operationId: 'op_event_1',
      agentIdentity: {
        identityVersion: 1,
        confidence: 'declared',
        agentSessionId: 'session-event-1',
      },
    });
  });
});
