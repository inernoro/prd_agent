import { describe, expect, it } from 'vitest';
import { buildServerEventQuery } from '../../src/services/server-event-log-store.js';

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
      minSeverity: 'warn',
    })).toEqual({
      source: 'branch-operation-coordinator',
      branchId: 'prd-agent-main',
      $or: [
        { operationId: 'op_123' },
        { 'details.operationId': 'op_123' },
      ],
      severity: { $in: ['warn', 'error'] },
    });
  });
});
