import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createCodeReviewsRouter } from '../../src/routes/code-reviews.js';
import type { StateService } from '../../src/services/state.js';
import type { CodeReviewService } from '../../src/services/code-review.js';
import type { CodeReviewTask } from '../../src/shared/code-review.js';

describe('用户 Key REST 权限', () => {
  it('拒绝同项目另一把凭据消费、身份伪造与跨项目读取，允许原所有者查询与重试', async () => {
    let keyId = 'one', projectId = 'a';
    const task: CodeReviewTask = { id: 'task', projectId: 'a', title: 'test', sourceType: 'zip', sourceName: 'test.zip', excludePatterns: [],
      status: 'failed', phase: 'test', progress: { totalFiles: 1, scannedFiles: 0 }, createdBy: 'test', createdAt: '', updatedAt: '', ownerScope: 'test', delivery: { status: 'not_requested' },
      userKeyBinding: { id: 'binding', owner: 'project-key:a:one', keyId: 'provider-key', model: 'model', provider: 'openai', fingerprint: 'fingerprint', tokenLimit: 30000 } };
    const usage = vi.fn(async () => ({ task: { inputTokens: 100, outputTokens: 10 } }));
    const retry = vi.fn(async () => task);
    const state = { getProject: (id: string) => ({ id }) } as unknown as StateService;
    const service = { get: () => task, retry, deps: { userKeys: { configured: () => true, usage } } } as unknown as CodeReviewService;
    const app = express(); app.use((req, _res, next) => { Object.assign(req, { cdsProjectKey: { projectId, keyId } }); next(); });
    app.use('/api', createCodeReviewsRouter({ state, service }));
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/code-reviews/task`;
    try {
      expect((await fetch(base + '/usage')).status).toBe(200); expect(usage).toHaveBeenCalledTimes(1);
      keyId = 'two'; expect((await fetch(base + '/usage', { headers: { 'X-AI-Impersonate': 'one', 'X-User-Id': 'one' } })).status).toBe(403);
      expect((await fetch(base + '/retry', { method: 'POST' })).status).toBe(403); expect(retry).not.toHaveBeenCalled();
      keyId = 'one'; projectId = 'b'; expect((await fetch(base + '/usage')).status).toBe(403); expect(usage).toHaveBeenCalledTimes(1);
      projectId = 'a'; expect((await fetch(base + '/retry', { method: 'POST' })).status).toBe(200); expect(retry).toHaveBeenCalledTimes(1);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
