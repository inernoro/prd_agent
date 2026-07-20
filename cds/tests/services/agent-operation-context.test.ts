import { describe, expect, it } from 'vitest';
import {
  establishAgentOperationContext,
  parseAgentOperatorIdentity,
} from '../../src/services/agent-operation-context.js';
import { redactHeaders } from '../../src/services/http-log-store.js';

describe('progressive Agent operator identity', () => {
  it('keeps legacy requests compatible and generates correlation ids', () => {
    const responseHeaders = new Map<string, string>();
    const context = establishAgentOperationContext({
      headers: {
        'x-ai-access-key': 'never-log-this',
        'x-cds-operation-id': 'caller-spoofed-operation',
      },
      cdsRequestId: 'legacy-request',
      res: { setHeader: (name: string, value: string) => responseHeaders.set(name, value) },
    });

    expect(context.requestId).toBe('legacy-request');
    expect(context.operationId).toMatch(/^op_[a-f0-9]{16}$/);
    expect(context.operationId).not.toBe('caller-spoofed-operation');
    expect(context.identity).toEqual({ identityVersion: 0, confidence: 'legacy' });
    expect(responseHeaders.get('X-CDS-Request-Id')).toBe('legacy-request');
    expect(responseHeaders.get('X-CDS-Operation-Id')).toBe(context.operationId);
  });

  it('does not rewrite correlation headers after a streaming response starts', () => {
    const context = establishAgentOperationContext({
      headers: {},
      res: {
        headersSent: true,
        setHeader: () => { throw new Error('headers already sent'); },
      },
    });

    expect(context.requestId).toMatch(/^req_[a-f0-9]{16}$/);
    expect(context.operationId).toMatch(/^op_[a-f0-9]{16}$/);
    expect(context.identity).toEqual({ identityVersion: 0, confidence: 'legacy' });
  });

  it('records valid declared identity without promoting it to verified', () => {
    const identity = parseAgentOperatorIdentity({
      'x-cds-agent-session-id': 'cdscli_a1b2c3',
      'x-codex-thread-id': '019f7c2d-ae4c-78a2-b440-df70dc1312c7',
      'x-codex-turn-id': '019f7ed6-350b-7e42-8716-2edbda7dbd2d',
      'x-cds-skill-name': 'cds-release',
      'x-cds-skill-version': '0.10.0',
      'x-cds-operation-reason': 'collect audit identity',
    });

    expect(identity).toMatchObject({
      identityVersion: 1,
      confidence: 'declared',
      agentSessionId: 'cdscli_a1b2c3',
      skillName: 'cds-release',
      skillVersion: '0.10.0',
      operationReason: 'collect audit identity',
    });
    expect(JSON.stringify(identity)).not.toContain('verified');
  });

  it('drops overlong and control-character values without returning an error', () => {
    const identity = parseAgentOperatorIdentity({
      'x-cds-agent-session-id': 'x'.repeat(129),
      'x-codex-thread-id': 'thread\nspoofed',
      'x-cds-skill-version': '1.0.0',
    });

    expect(identity.identityVersion).toBe(1);
    expect(identity.confidence).toBe('declared');
    expect(identity.agentSessionId).toBeUndefined();
    expect(identity.threadId).toBeUndefined();
    expect(identity.skillVersion).toBe('1.0.0');
    expect(identity.invalidFields).toEqual(['agentSessionId', 'threadId']);
  });

  it('masks secrets in operationReason before they reach audit storage', () => {
    const identity = parseAgentOperatorIdentity({
      'x-cds-operation-reason': 'deploy with token=super-secret-token-value',
    });

    expect(identity.operationReason).not.toContain('super-secret-token-value');
    expect(identity.operationReason).toContain('[masked]');

    expect(redactHeaders({
      'x-cds-agent-session-id': 'session-that-must-use-the-identity-summary',
      'x-cds-operation-reason': 'token=raw-secret-value',
    })).toEqual({
      'x-cds-agent-session-id': '[redacted]',
      'x-cds-operation-reason': '[redacted]',
    });
  });
});
