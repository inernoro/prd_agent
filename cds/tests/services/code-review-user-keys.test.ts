import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodeReviewUserKeys } from '../../src/services/code-review-user-keys.js';
import { CodeReviewEngine } from '../../src/services/code-review-engine.js';
import { CodeReviewService } from '../../src/services/code-review.js';
import { publicCodeReviewTask } from '../../src/shared/code-review.js';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { buildZip } from '../../src/utils/zip.js';
const identity = { owner: 'human:one', projectId: 'a', taskId: 'task' };
const config = { CDS_CODE_REVIEW_GATEWAY_URL: 'https://gateway.test', CDS_CODE_REVIEW_GATEWAY_SERVICE_KEY: 'issuer-secret' };
const binding = { bindingId: 'binding', keyId: 'key', provider: 'openai', model: 'model', fingerprint: 'fingerprint', tokenLimit: 200000 };
const input = { provider: 'openai' as const, model: 'model', apiKey: 'private-test-key' };
let clean: (() => Promise<void>) | undefined;
afterEach(async () => { await clean?.(); clean = undefined; });
describe('用户 Key 独立任务通道', () => {
  it.each(['openai', 'anthropic', 'openrouter', 'deepseek'] as const)('只向固定网关发送 %s 绑定，任务只保存引用', async provider => {
    const events: unknown[] = []; const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('X-Code-Review-Service-Key')).toBe('issuer-secret');
      expect(JSON.parse(String(init?.body))).toMatchObject({ ...identity, ...input, provider });
      expect(init?.redirect).toBe('error'); return Response.json({ ...binding, provider });
    });
    const client = new CodeReviewUserKeys(() => config, fetchImpl as typeof fetch);
    const result = await client.bind({ ...input, provider }, identity, async e => { events.push(e); });
    expect(result).toEqual({ id: 'binding', owner: identity.owner, ...Object.fromEntries(Object.entries({ ...binding, provider }).filter(([key]) => key !== 'bindingId')) });
    expect(JSON.stringify(result)).not.toContain(input.apiKey); expect(events).toHaveLength(1);
  });
  it('拒绝未配置通道、非法 Key 和身份漂移，不返回平台配置', async () => {
    await expect(new CodeReviewUserKeys(() => ({})).bind(input, identity, async () => {})).rejects.toThrow('未配置');
    const fetchImpl = vi.fn(async () => Response.json({ token: 'cruk_test', model: 'other-model' }));
    const client = new CodeReviewUserKeys(() => config, fetchImpl as typeof fetch);
    await expect(client.bind({ ...input, apiKey: '' }, identity, async () => {})).rejects.toThrow('无效');
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(client.engineConfig({ ...binding, id: 'binding', owner: identity.owner }, 'a', async () => {})).rejects.toThrow('未使用平台凭据');
  });
  it('旧引擎缺少任务隔离能力时，在创建项目和上传源码前拒绝', async () => {
    const calls: string[] = [];
    const engine = new CodeReviewEngine({ baseUrl: 'https://engine.test', token: 'engine-token', fetchImpl: (async url => {
      calls.push(String(url)); return Response.json({});
    }) as typeof fetch });
    await expect(engine.run({ taskId: 'one', zip: buildZip([{ name: 'a.ts', data: 'const a=1;' }]), excludePatterns: [], signal: new AbortController().signal,
      userKeyConfig: { baseUrl: 'https://gw.test/byok/v1', token: 'cruk_test', model: 'model' }, onProgress: async () => {}, audit: async () => {} })).rejects.toThrow('不支持用户 Key');
    expect(calls).toEqual(['https://engine.test/api/v1/scan/capabilities']);
  });
  it('密文绑定持久化，重启后沿用同一绑定；绑定不可用时引擎不会启动', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-review-'));
    const state = new StateService(path.join(dir, 'state.json')); state.load();
    state.addProject({ id: 'a', name: 'a', slug: 'a', kind: 'manual', dockerNetwork: 'a', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const blobs = new Map<string, Buffer>(); const run = vi.fn();
    const client = new CodeReviewUserKeys(() => config, (async url => String(url).endsWith('/bind') ? Response.json(binding) : Response.json({ error: 'revoked' }, { status: 401 })) as typeof fetch);
    const deps = { state, engine: { run }, userKeys: client, autoStart: false, ownerScope: 'test', publicBaseUrl: 'https://cds.test', mail: { configured: () => false, send: vi.fn() },
      inputs: { configured: () => true, put: async (id: string, _project: string, bytes: Buffer) => { blobs.set(id, bytes); return id; }, get: async (id: string) => blobs.get(id)! } };
    const service = new CodeReviewService(deps);
    clean = async () => { service.stop(); await state.flush(); await flushAllJsonStateStores(); await fs.rm(dir, { recursive: true, force: true }); };
    const task = await service.submit({ projectId: 'a', sourceType: 'zip', zip: buildZip([{ name: 'a.ts', data: 'const a=1;' }]), createdBy: 'human', credentialOwner: identity.owner, userKey: input });
    const publicTask = publicCodeReviewTask(task); expect(publicTask).not.toHaveProperty('userKeyBinding');
    expect(publicTask.modelCredential?.source).toBe('user'); expect(JSON.stringify(state.getCodeReviewTask(task.id))).not.toContain(input.apiKey);
    const cold = new StateService(path.join(dir, 'state.json')); cold.load(); expect(cold.getCodeReviewTask(task.id)?.userKeyBinding?.id).toBe('binding');
    await service.pump(); expect(service.get(task.id).status).toBe('failed'); expect(run).not.toHaveBeenCalled();
  });
});
